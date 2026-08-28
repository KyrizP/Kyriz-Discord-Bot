'use strict';

// ============================================================
// economyManager — SQLite persistence (migration spec v1.4).
//
// Storage: better-sqlite3 (synchronous, single connection).
// Schema: hybrid — flat columns for queried fields (leaderboard),
// JSON columns for nested data, `extra` catch-all for future
// fields, 5 materialized ranking columns fed by battleEngine
// extractors (single source of truth — spec §3.1).
//
// Boot contract (spec §5, CHECK-FIRST OPEN-LAST): all file-state
// inspection happens via fs BEFORE `new Database()` is ever
// called — a THROW path must never leave a half-created db file
// behind. The db is opened only after the branch is decided.
//
// Legacy JSON: auto-migrated ONCE at first boot (claim-rename →
// transactional DDL+INSERT → rename .pre-sqlite). economy.json is
// never modified; corrupt/empty sources are preserved (.corrupt-/
// .suspect-) and the boot REFUSES rather than running empty.
//
// Every exported function preserves the legacy return shapes
// (spec §4) — consumers depend on them for embeds.
// ============================================================

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { extractBattleRanking, extractAbyssRanking } = require('./battleEngine');

// ---- Paths (env-aware — spec §4). Tests/gladi MUST set BOTH vars; a lone
// KYRIZ_ECONOMY_DB is a production misconfiguration and refuses to boot. ----
const DEFAULT_DB = path.join(__dirname, '..', 'data', 'economy.db');
const DEFAULT_JSON = path.join(__dirname, '..', 'data', 'economy.json');
const DB_PATH = process.env.KYRIZ_ECONOMY_DB || DEFAULT_DB;
const JSON_SRC = process.env.KYRIZ_ECONOMY_JSON || DEFAULT_JSON;
const DB_ENV_SET = process.env.KYRIZ_ECONOMY_DB != null;
const JSON_ENV_SET = process.env.KYRIZ_ECONOMY_JSON != null;

// Derived-path rule (spec §4): ALL migration artifacts are siblings of the
// env-resolved source paths — never hardcoded data/economy.* literals.
const MIG_PATH = JSON_SRC + '.migrating';
const PRE_PATH = JSON_SRC + '.pre-sqlite';
const BACKUP_DIR = path.join(path.dirname(DB_PATH), 'backups');
const BACKUP_KEEP = 14;

console.log(`[economy] DB=${DB_PATH} JSON=${JSON_SRC} (override: ${DB_ENV_SET || JSON_ENV_SET ? 'yes' : 'no'})`);
if (DB_ENV_SET && !JSON_ENV_SET) {
  throw new Error('[economy] KYRIZ_ECONOMY_DB is set without KYRIZ_ECONOMY_JSON — half configuration. Set both (sandbox) or neither (production).');
}
if (DB_ENV_SET && JSON_ENV_SET) {
  console.warn('[economy] SANDBOX MODE — both env overrides active. Never run production this way.');
}

// ============================================================
// Schema (spec §3)
// ============================================================

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS players (
  user_id       TEXT PRIMARY KEY,
  username      TEXT NOT NULL,
  balance       INTEGER NOT NULL DEFAULT 100000,
  level         INTEGER NOT NULL DEFAULT 1,
  xp            INTEGER NOT NULL DEFAULT 0,
  xp_needed     INTEGER NOT NULL DEFAULT 400,
  total_wins    INTEGER NOT NULL DEFAULT 0,
  total_losses  INTEGER NOT NULL DEFAULT 0,
  total_earned  INTEGER NOT NULL DEFAULT 0,
  total_lost    INTEGER NOT NULL DEFAULT 0,
  last_daily    TEXT,
  registered_at TEXT NOT NULL,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  inventory     TEXT NOT NULL DEFAULT '{}',
  active_boosts TEXT NOT NULL DEFAULT '{}',
  cosmetics     TEXT NOT NULL DEFAULT '{}',
  transfer_data TEXT NOT NULL DEFAULT '{}',
  battle        TEXT,
  extra         TEXT NOT NULL DEFAULT '{}',
  best_depth        INTEGER NOT NULL DEFAULT 0,
  battle_score      INTEGER NOT NULL DEFAULT 0,
  score_achieved_at TEXT NOT NULL DEFAULT '9999',
  abyss_best_floor  INTEGER NOT NULL DEFAULT 0,
  abyss_total_stars INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_balance ON players(balance DESC);
CREATE INDEX IF NOT EXISTS idx_level ON players(level DESC);
CREATE INDEX IF NOT EXISTS idx_battle_rank ON players(best_depth DESC, battle_score DESC, score_achieved_at ASC);
CREATE INDEX IF NOT EXISTS idx_abyss_rank ON players(abyss_best_floor DESC, abyss_total_stars DESC);
CREATE TABLE IF NOT EXISTS poker_escrow (
  game_id   TEXT NOT NULL,
  user_id   TEXT NOT NULL,
  buy_in    INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (game_id, user_id)
);
`;

// camelCase ↔ snake_col mapping. is_admin coerces back to boolean on read.
const FLAT_MAP = [
  ['username', 'username'], ['balance', 'balance'], ['level', 'level'], ['xp', 'xp'],
  ['xpNeeded', 'xp_needed'], ['totalWins', 'total_wins'], ['totalLosses', 'total_losses'],
  ['totalEarned', 'total_earned'], ['totalLost', 'total_lost'], ['lastDaily', 'last_daily'],
  ['registeredAt', 'registered_at'],
];
const JSON_MAP = [
  ['inventory', 'inventory'], ['activeBoosts', 'active_boosts'], ['cosmetics', 'cosmetics'],
  ['transferData', 'transfer_data'], ['battle', 'battle'],
];
const KNOWN_KEYS = new Set([...FLAT_MAP.map((x) => x[0]), 'isAdmin', ...JSON_MAP.map((x) => x[0])]);

const UPSERT_SQL = `
INSERT INTO players (
  user_id, username, balance, level, xp, xp_needed, total_wins, total_losses,
  total_earned, total_lost, last_daily, registered_at, is_admin,
  inventory, active_boosts, cosmetics, transfer_data, battle, extra,
  best_depth, battle_score, score_achieved_at, abyss_best_floor, abyss_total_stars
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(user_id) DO UPDATE SET
  username=excluded.username, balance=excluded.balance, level=excluded.level, xp=excluded.xp,
  xp_needed=excluded.xp_needed, total_wins=excluded.total_wins, total_losses=excluded.total_losses,
  total_earned=excluded.total_earned, total_lost=excluded.total_lost, last_daily=excluded.last_daily,
  registered_at=excluded.registered_at, is_admin=excluded.is_admin, inventory=excluded.inventory,
  active_boosts=excluded.active_boosts, cosmetics=excluded.cosmetics, transfer_data=excluded.transfer_data,
  battle=excluded.battle, extra=excluded.extra, best_depth=excluded.best_depth,
  battle_score=excluded.battle_score, score_achieved_at=excluded.score_achieved_at,
  abyss_best_floor=excluded.abyss_best_floor, abyss_total_stars=excluded.abyss_total_stars
`;

// ============================================================
// Boot state inspection (pure fs — runs BEFORE any Database open)
// ============================================================

function siblingArtifacts() {
  const res = { pre: false, mig: false, corrupt: false, suspect: false, walOrphan: false, backups: false };
  try {
    const dir = path.dirname(JSON_SRC);
    const base = path.basename(JSON_SRC);
    for (const f of fs.readdirSync(dir)) {
      if (f === base + '.pre-sqlite' || f.startsWith(base + '.pre-sqlite.')) res.pre = true;
      if (f === base + '.migrating') res.mig = true;
      if (f.startsWith(base + '.migrating.corrupt-') || f.startsWith(base + '.corrupt-')) res.corrupt = true;
      if (f.startsWith(base + '.migrating.suspect-') || f.startsWith(base + '.suspect-')) res.suspect = true;
    }
  } catch { /* dir absent — clean */ }
  // A -wal next to its OWN db is normal (WAL working file). It is only an
  // "orphan" — a data-existed signal — when the main db file is MISSING.
  try { res.walOrphan = !fs.existsSync(DB_PATH) && fs.existsSync(DB_PATH + '-wal'); } catch {}
  try {
    res.backups = fs.readdirSync(BACKUP_DIR).some((f) => f.startsWith('economy-') && f.endsWith('.db'));
  } catch { /* no backups dir */ }
  return res;
}

function parseJsonSource() {
  // Returns {status: 'absent'|'corrupt'|'suspect'|'ok', data?}. THROW-path helper:
  // corrupt/suspect sources are preserved (renamed) — never boot on guesses.
  let raw;
  try {
    raw = fs.readFileSync(JSON_SRC, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') return { status: 'absent' };
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const savedAs = JSON_SRC + '.corrupt-' + stamp;
    try { fs.renameSync(JSON_SRC, savedAs); } catch { /* read-only fs — still throw */ }
    console.error(`[DATA SAFETY] ${path.basename(JSON_SRC)} is CORRUPT — bytes preserved at ${savedAs}. Refusing to run on an empty database.`);
    return { status: 'corrupt', error: err };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length === 0) {
    // A present-but-empty '{}' is ALWAYS an anomaly (real first deploys have no
    // file at all) — the 2026-08-17 wipe class. Preserve + refuse.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const savedAs = JSON_SRC + '.suspect-' + stamp;
    try { fs.renameSync(JSON_SRC, savedAs); } catch {}
    console.error(`[DATA SAFETY] ${path.basename(JSON_SRC)} is EMPTY ('{}') — preserved at ${savedAs}. Refusing to migrate an empty player set.`);
    return { status: 'suspect', error: new Error('economy.json empty') };
  }
  return { status: 'ok', data: parsed };
}

function checkMigratingLiveness() {
  try {
    if (Date.now() - fs.statSync(MIG_PATH).mtimeMs >= 30000) return; // stale — safe to touch
  } catch { return; } // vanished — nothing to race
  waitForLiveMigrating();
}

function waitForLiveMigrating(mtimeMs) {
  // .migrating fresher than 30s → another process may be mid-migration. Wait,
  // recheck, give up loudly (spec §5). Sync sleep — boot-time only.
  for (let i = 0; i < 10; i++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
    try {
      const st = fs.statSync(MIG_PATH);
      if (Date.now() - st.mtimeMs > 30000) return; // went stale — safe to resume
    } catch { return; } // vanished — migration finished elsewhere
  }
  throw new Error('[economy] economy.json.migrating is being written by another process — refusing to race it. Retry in a moment.');
}

// ============================================================
// initDb — the spec §5 decision tree. CHECK-FIRST, OPEN-LAST.
// ============================================================

function initDb() {
  const dbExists = fs.existsSync(DB_PATH);
  const art = siblingArtifacts();

  if (dbExists) {
    const db = new Database(DB_PATH); // file exists — safe to open
    applyPragmas(db);
    const integrity = db.pragma('integrity_check');
    if (!integrity || !integrity[0] || integrity[0].integrity_check !== 'ok') {
      db.close();
      throw new Error('[economy] integrity_check FAILED — db is corrupt. Recovery: stop bot, restore data/backups/economy-<latest>.db or the daily .db.gz (see plan Step 21b).');
    }
    const hasTable = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='players'").get();
    const count = hasTable ? db.prepare('SELECT COUNT(*) AS c FROM players').get().c : 0;

    if (!hasTable || count === 0) {
      if (art.pre) { db.close(); throw new Error('[economy] db is EMPTY but economy.json.pre-sqlite exists — refusing to run empty. Recovery: restore .pre-sqlite → economy.json, or the latest backup.'); }
      if (art.corrupt || art.suspect || art.walOrphan) { db.close(); throw new Error('[economy] db is EMPTY but preserved data artifacts exist (' + JSON.stringify(art) + ') — refusing to run empty. Investigate data/ before restarting.'); }
      if (art.mig) {
        // Crashed migration, pre-commit: db was created at open, transaction
        // rolled back — provably data-free. Liveness first: a FRESH .migrating
        // may belong to a live process mid-migration (whose half-open empty db
        // looks exactly like this) — never delete files under a live writer.
        checkMigratingLiveness();
        console.warn('[economy] empty db + economy.json.migrating → crashed migration detected. Re-running migration from .migrating.');
        db.close();
        removeDbFiles();
        return migrateFrom(MIG_PATH);
      }
      // Clean empty db (e.g. interrupted first boot): create schema, ready.
      db.exec(SCHEMA_SQL);
      logReady(db, count);
      return db;
    }

    if (count > 0) {
      if (art.mig) {
        checkMigratingLiveness(); // no swallow — a live writer must abort this boot
        // Data is already committed — archive the leftover (never delete).
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const orphan = MIG_PATH + '.orphan-' + stamp;
        try { fs.renameSync(MIG_PATH, orphan); console.warn('[MIGRATION] leftover .migrating archived (data already in db): ' + orphan); } catch {}
      }
      if (fs.existsSync(JSON_SRC)) {
        console.warn('[economy] economy.json present next to a populated economy.db — the JSON is IGNORED (restore ≠ merge). Remove it, or follow the rollback runbook if you meant to roll back.');
      }
      // Idempotent schema apply on EVERY boot of an existing db — CREATE TABLE
      // IF NOT EXISTS makes this a no-op for current tables, and it is how NEW
      // tables (e.g. poker_escrow, added after this db was born) get created.
      // Without this, adding a table later crashes every existing db at boot.
      db.exec(SCHEMA_SQL);
      logReady(db, count);
      return db;
    }
  }

  // ---- db does NOT exist (nothing above opened/created anything yet) ----
  if (art.mig) {
    checkMigratingLiveness();
    console.warn('[economy] resuming interrupted migration from economy.json.migrating');
    return migrateFrom(MIG_PATH); // resume — skips the claim-rename
  }

  const src = parseJsonSource();
  if (src.status === 'corrupt') throw src.error;
  if (src.status === 'suspect') throw src.error;
  if (src.status === 'ok') {
    // Claim-rename: atomic. Losers (ENOENT) wait + recheck — never resume blindly.
    try {
      fs.renameSync(JSON_SRC, MIG_PATH);
    } catch (err) {
      if (err.code === 'ENOENT') {
        // Someone else claimed it (or we raced a restore). Re-check for a db.
        for (let i = 0; i < 10 && !fs.existsSync(DB_PATH); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
        if (fs.existsSync(DB_PATH)) return initDb(); // re-enter the db-exists path
        throw err;
      }
      throw err;
    }
    return migrateFrom(MIG_PATH);
  }

  // JSON absent — the ONLY legitimate fresh-boot is a pristine first deploy.
  if (art.pre || art.mig || art.corrupt || art.suspect || art.walOrphan || art.backups) {
    throw new Error('[economy] no economy.db and no economy.json, but pre-existing data artifacts found (' + JSON.stringify(art) + ') — REFUSING to boot empty. Recovery: rename economy.json.pre-sqlite → economy.json, or restore a backup.');
  }
  const db = new Database(DB_PATH); // pristine first deploy — create
  applyPragmas(db);
  db.exec(SCHEMA_SQL);
  console.log('[economy] fresh database created (first deploy)');
  logReady(db, 0);
  return db;
}

function applyPragmas(db) {
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
}

function removeDbFiles() {
  for (const p of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) {
    try { fs.rmSync(p, { force: true }); } catch { /* best effort */ }
  }
}

function logReady(db, count) {
  console.log(`[economy] ready — ${count} players in db`);
}

// ============================================================
// Migration (spec §5.1) — transactional DDL+INSERT, never-clobber
// ============================================================

function migrateFrom(migFile) {
  let raw;
  try {
    raw = fs.readFileSync(migFile, 'utf-8');
  } catch (err) {
    throw new Error('[MIGRATION] cannot read ' + migFile + ': ' + err.message);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const savedAs = migFile + '.corrupt-' + stamp;
    try { fs.renameSync(migFile, savedAs); } catch {}
    console.error(`[DATA SAFETY] migration source is CORRUPT — bytes preserved at ${savedAs}. Refusing to migrate.`);
    throw err;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length === 0) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const savedAs = migFile + '.suspect-' + stamp;
    try { fs.renameSync(migFile, savedAs); } catch {}
    console.error(`[DATA SAFETY] migration source is EMPTY — preserved at ${savedAs}. Refusing to migrate an empty player set.`);
    throw new Error('migration source empty');
  }

  const entries = Object.entries(parsed);
  const db = new Database(DB_PATH);
  applyPragmas(db);
  const migrate = db.transaction(() => {
    db.exec(SCHEMA_SQL); // transactional DDL — schema+data commit atomically
    const insert = db.prepare(UPSERT_SQL);
    for (const [uid, obj] of entries) insert.run(...playerRowValues(uid, obj));
    const c = db.prepare('SELECT COUNT(*) AS c FROM players').get().c;
    if (c !== entries.length) throw new Error(`[MIGRATION] count verify failed: ${c}/${entries.length} — rolling back`);
  });
  try {
    migrate();
  } catch (err) {
    db.close();
    removeDbFiles(); // rolled back — provably empty, safe to remove
    throw err; // .migrating stays intact for the next retry
  }

  // NEVER-CLOBBER: archive an existing .pre-sqlite instead of overwriting it.
  if (fs.existsSync(PRE_PATH)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    try { fs.renameSync(PRE_PATH, PRE_PATH + '.' + stamp); } catch {}
  }
  fs.renameSync(migFile, PRE_PATH);
  console.log(`[MIGRATION] JSON → SQLite complete: ${entries.length} players migrated`);
  logReady(db, entries.length);
  return db;
}

// ============================================================
// Row ↔ player-object conversion
// ============================================================

function rowToPlayer(row) {
  const p = {};
  for (const [js, col] of FLAT_MAP) p[js] = row[col];
  p.isAdmin = !!row.is_admin;
  for (const [js, col] of JSON_MAP) {
    if (js === 'battle') {
      if (row.battle !== null && row.battle !== undefined) p.battle = JSON.parse(row.battle);
      // battle absent stays absent (spec §3 round-trip rule)
    } else {
      p[js] = JSON.parse(row[col] || '{}') || {}; // canonical materialized default
    }
  }
  const extra = JSON.parse(row.extra || '{}');
  // Spread ONLY (own-property assignment) — Object.assign onto a live object
  // or a recursive deep-merge would let crafted `__proto__`/`constructor` keys
  // pollute prototypes (spec §4 writePlayer contract).
  return { ...p, ...extra };
}

function playerRowValues(userId, obj) {
  // writePlayer's numeric/shape guard — the synthetic superadmin profile
  // (Infinity/'?') must never be written back (spec §4).
  if (!obj || typeof obj !== 'object') throw new Error('writePlayer: invalid player object for ' + userId);
  if (typeof obj.username !== 'string' || !obj.username) throw new Error('writePlayer: username must be a non-empty string (' + userId + ')');
  if (typeof obj.balance !== 'number' || !Number.isFinite(obj.balance)) throw new Error('writePlayer: balance must be a finite number (' + userId + ')');

  const ranking = extractBattleRanking(obj.battle, obj.registeredAt);
  const abyss = extractAbyssRanking(obj.battle);
  const extra = {};
  for (const k of Object.keys(obj)) {
    if (!KNOWN_KEYS.has(k)) extra[k] = obj[k];
  }
  const vals = [userId, obj.username, obj.balance, obj.level ?? 1, obj.xp ?? 0, obj.xpNeeded ?? 400,
    obj.totalWins ?? 0, obj.totalLosses ?? 0, obj.totalEarned ?? 0, obj.totalLost ?? 0,
    obj.lastDaily ?? null, obj.registeredAt, obj.isAdmin ? 1 : 0,
    JSON.stringify(obj.inventory ?? {}), JSON.stringify(obj.activeBoosts ?? {}),
    JSON.stringify(obj.cosmetics ?? {}), JSON.stringify(obj.transferData ?? {}),
    obj.battle === undefined || obj.battle === null ? null : JSON.stringify(obj.battle),
    JSON.stringify(extra),
    ranking.bestDepth, ranking.battleScore, ranking.scoreAchievedAt, abyss.bestFloor, abyss.totalStars];
  return vals;
}

// ============================================================
// Eager init + prepared statements
// ============================================================

// Unset SUPERADMIN_ID must exclude NOBODY (legacy: `id !== undefined` never
// matches). Binding undefined would become SQL NULL and `user_id != NULL` is
// NULL — silently excluding every row.
const SUPERADMIN_BIND = process.env.SUPERADMIN_ID || '';

const db = initDb();
if (!db.open) throw new Error('[economy] database failed to open');

const S = {
  get: db.prepare('SELECT * FROM players WHERE user_id = ?'),
  count: db.prepare('SELECT COUNT(*) AS c FROM players'),
  upsert: db.prepare(UPSERT_SQL),
  rename: db.prepare('UPDATE players SET username = ? WHERE user_id = ?'),
  addBal: db.prepare('UPDATE players SET balance = balance + ?, total_earned = total_earned + ? WHERE user_id = ?'),
  subBal: db.prepare('UPDATE players SET balance = balance - ?, total_lost = total_lost + ? WHERE user_id = ?'),
  getBal: db.prepare('SELECT balance FROM players WHERE user_id = ?'),
  leaderboard: db.prepare('SELECT user_id, username, balance, level, cosmetics FROM players WHERE user_id != ? AND is_admin = 0 ORDER BY balance DESC, rowid ASC LIMIT ?'),
  allPlayers: db.prepare('SELECT * FROM players WHERE user_id != ? ORDER BY balance DESC, rowid ASC'),
  rank: db.prepare(`SELECT COUNT(*) + 1 AS r FROM players WHERE user_id != ? AND is_admin = 0 AND (balance > ? OR (balance = ? AND rowid < (SELECT rowid FROM players WHERE user_id = ?)))`),
  battleTop: db.prepare('SELECT user_id FROM players WHERE battle_score > 0 ORDER BY best_depth DESC, battle_score DESC, score_achieved_at ASC, rowid ASC LIMIT ?'),
  insertEscrow: db.prepare('INSERT INTO poker_escrow (game_id, user_id, buy_in) VALUES (?, ?, ?)'),
  deleteEscrow: db.prepare('DELETE FROM poker_escrow WHERE game_id = ?'),
  selectEscrows: db.prepare('SELECT game_id, user_id, buy_in FROM poker_escrow'),
  win: db.prepare('UPDATE players SET total_wins = total_wins + 1 WHERE user_id = ?'),
  loss: db.prepare('UPDATE players SET total_losses = total_losses + 1 WHERE user_id = ?'),
  allRows: db.prepare('SELECT * FROM players'),
  battleRankTriple: db.prepare(`SELECT best_depth AS bd, battle_score AS bs, score_achieved_at AS saa FROM players WHERE user_id = ?`),
  battleRankCount: db.prepare(`SELECT COUNT(*) + 1 AS r FROM players WHERE battle_score > 0 AND (
    best_depth > :bd OR (best_depth = :bd AND battle_score > :bs) OR (best_depth = :bd AND battle_score = :bs AND score_achieved_at < :saa))`),
};

// ============================================================
// New per-player API (spec §4)
// ============================================================

function readPlayer(userId) {
  const row = S.get.get(userId);
  return row ? rowToPlayer(row) : null;
}

function writePlayer(userId, playerObj) {
  S.upsert.run(...playerRowValues(userId, playerObj));
}

function readAllPlayers() {
  const out = {};
  for (const row of S.allRows.all()) out[row.user_id] = rowToPlayer(row);
  return out;
}

function withTransaction(fn) {
  // Native wrapper: TypeErrors on async functions (fail-loud), auto-rollback
  // on throw (spec §4). fn must be fully synchronous — no awaits inside.
  if (fn.constructor.name === 'AsyncFunction') {
    throw new TypeError('withTransaction: fn must be synchronous (spec §4) — awaits between read and write break atomicity');
  }
  return db.transaction(fn)();
}

function snapshotTo(destPath) {
  // WAL-aware consistent copy for the DM backup path. Returns the Promise —
  // caller MUST .catch (loud failure rule).
  return db.backup(destPath);
}

// ============================================================
// Superadmin check
// ============================================================

function isSuperAdmin(userId) {
  return userId === process.env.SUPERADMIN_ID;
}

// ============================================================
// Admin management
// ============================================================

function isAdmin(userId) {
  if (isSuperAdmin(userId)) return true;
  const p = readPlayer(userId);
  return !!(p && p.isAdmin);
}

function setAdmin(userId, username, bonusAmount = 10000000) {
  const p = readPlayer(userId);
  if (!p) {
    writePlayer(userId, {
      username, balance: bonusAmount, level: 1, xp: 0, xpNeeded: 400, totalWins: 0, totalLosses: 0,
      totalEarned: bonusAmount, totalLost: 0, lastDaily: null, registeredAt: new Date().toISOString(), isAdmin: true,
    });
    return { success: true, newBalance: bonusAmount };
  }
  p.isAdmin = true;
  p.balance += bonusAmount;
  p.totalEarned += bonusAmount;
  writePlayer(userId, p);
  return { success: true, newBalance: p.balance };
}

function removeAdmin(userId) {
  const p = readPlayer(userId);
  if (p) {
    p.isAdmin = false;
    writePlayer(userId, p);
  }
}

// ============================================================
// User management
// ============================================================

function isRegistered(userId) {
  if (isSuperAdmin(userId)) return true;
  return !!S.get.get(userId);
}

function registerUser(userId, username) {
  if (S.get.get(userId)) {
    return { success: false, message: 'User is already registered.' };
  }
  writePlayer(userId, {
    username, balance: 100000, level: 1, xp: 0, xpNeeded: 400, // Level 1->2 needs 400 XP
    totalWins: 0, totalLosses: 0, totalEarned: 0, totalLost: 0,
    lastDaily: null, registeredAt: new Date().toISOString(),
  });
  return { success: true, message: 'User registered successfully.' };
}

function getUser(userId) {
  if (isSuperAdmin(userId)) {
    // Bypass perks stay hardcoded (Infinity etc.), but the NAME must come from
    // the real entry — a hardcoded 'Superadmin' leaked into every admin panel.
    const entry = readPlayer(userId);
    return {
      username: (entry && entry.username) || 'Superadmin',
      balance: Infinity,
      level: '?',
      xp: '?',
      xpNeeded: '?',
      totalWins: 0,
      totalLosses: 0,
      totalEarned: 0,
      totalLost: 0,
      lastDaily: null,
      registeredAt: (entry && entry.registeredAt) || null,
      isSuperAdmin: true,
    };
  }
  return readPlayer(userId);
}

function updateUsername(userId, username) {
  const p = readPlayer(userId);
  if (!p) {
    // Superadmin bypasses T&C registration — create their row with the REAL
    // username (kills the battle placeholder at its source). Regular users are
    // created by registerUser; never here.
    if (!isSuperAdmin(userId)) return;
    writePlayer(userId, { username, balance: 0, level: 1, xp: 0, xpNeeded: 400, totalWins: 0, totalLosses: 0,
      totalEarned: 0, totalLost: 0, lastDaily: null, registeredAt: new Date().toISOString() });
    return;
  }
  if (p.username === username) return; // skip-write when unchanged (hot path)
  S.rename.run(username, userId);
}

// ============================================================
// Balance operations
// ============================================================

function addBalance(userId, amount) {
  if (isSuperAdmin(userId)) return { success: true, newBalance: Infinity };
  if (!S.get.get(userId)) return { success: false, newBalance: 0 };
  S.addBal.run(amount, amount, userId);
  return { success: true, newBalance: S.getBal.get(userId).balance };
}

function removeBalance(userId, amount) {
  if (isSuperAdmin(userId)) return { success: true, message: 'OK', newBalance: Infinity };
  const bal = S.getBal.get(userId);
  if (!bal) return { success: false, message: 'User not found.', newBalance: 0 };
  if (bal.balance < amount) {
    return { success: false, message: 'Insufficient balance.', newBalance: bal.balance };
  }
  S.subBal.run(amount, amount, userId);
  return { success: true, message: 'OK', newBalance: S.getBal.get(userId).balance };
}

function getBalance(userId) {
  if (isSuperAdmin(userId)) return Infinity;
  const row = S.getBal.get(userId);
  return row ? row.balance : 0;
}

// ============================================================
// Transfer limits (pure logic — unchanged from legacy)
// ============================================================

const MAX_DAILY_TRANSFERS = 3;

function getWIBDate() {
  const wibOffset = 7 * 60 * 60 * 1000;
  const wibNow = new Date(Date.now() + wibOffset);
  return wibNow.toISOString().split('T')[0];
}

function getDailySendLimit(level) {
  level = level ?? 1;
  if (level < 3) return 0;
  if (level <= 4) return 500000;
  if (level <= 9) return 1000000;
  if (level <= 14) return 2000000;
  if (level <= 19) return 3000000;
  if (level <= 49) return 4500000;
  return 6000000;
}

function getDailyReceiveLimit(level) {
  level = level ?? 1;
  if (level <= 2) return 500000;
  if (level <= 4) return 1000000;
  if (level <= 9) return 2000000;
  if (level <= 14) return 3000000;
  if (level <= 19) return 5000000;
  if (level <= 49) return 7500000;
  return 10000000;
}

function getTransferData(user) {
  // Mutating getter (legacy contract): takes a USER OBJECT, initializes/resets
  // transferData on WIB date rollover. Callers persist via writePlayer.
  const today = getWIBDate();
  if (!user.transferData || user.transferData.date !== today) {
    user.transferData = {
      date: today,
      sentTotal: 0,
      sentCount: 0,
      receivedTotal: 0,
    };
  }
  return user.transferData;
}

function checkTransferLimits(fromId, toId, amount) {
  if (isSuperAdmin(fromId)) return { allowed: true, message: 'OK' };

  const sender = readPlayer(fromId);
  const receiver = readPlayer(toId);
  if (!sender) return { allowed: false, message: 'Sender not found.' };
  if (!receiver) return { allowed: false, message: 'Recipient is not registered yet.' };

  // Admin bebas limit sendiri; limit penerima NORMAL tetap berlaku (anti-muling).
  if (!isAdmin(fromId)) {
    const senderLevel = sender.level ?? 1;
    const sendLimit = getDailySendLimit(senderLevel);
    if (sendLimit === 0) {
      return { allowed: false, message: `You need to be **Level 3** or higher to transfer. You are currently Level ${senderLevel}.` };
    }
    const senderData = getTransferData(sender);
    if (senderData.sentCount >= MAX_DAILY_TRANSFERS) {
      return { allowed: false, message: `You have reached the daily transfer limit (**${MAX_DAILY_TRANSFERS}x/day**). Try again tomorrow.` };
    }
    const remainingSend = sendLimit - senderData.sentTotal;
    if (amount > remainingSend) {
      return {
        allowed: false,
        message: `Daily send limit exceeded.\nYour limit: **${sendLimit.toLocaleString()}**/day (Level ${sender.level})\nSent today: **${senderData.sentTotal.toLocaleString()}**\nRemaining: **${remainingSend.toLocaleString()}**`,
      };
    }
  }

  if (!isAdmin(toId)) {
    const receiverLevel = receiver.level ?? 1;
    const receiveLimit = getDailyReceiveLimit(receiverLevel);
    const receiverData = getTransferData(receiver);
    const remainingReceive = receiveLimit - receiverData.receivedTotal;
    if (amount > remainingReceive) {
      return {
        allowed: false,
        message: `Recipient has reached their daily receive limit (**${receiveLimit.toLocaleString()}**/day).\nThey can still receive: **${remainingReceive.toLocaleString()}**`,
      };
    }
  }

  return { allowed: true, message: 'OK' };
}

// ============================================================
// Transfer (spec §4 superadmin triple-skip contract)
// ============================================================

const MAX_TRANSFER = 2_000_000;

function transfer(fromId, toId, amount) {
  if (amount <= 0) return { success: false, message: 'Amount must be greater than 0.' };
  if (amount > MAX_TRANSFER) return { success: false, message: `Maximum transfer is 💎 ${MAX_TRANSFER.toLocaleString()} Kryztal.` };

  const sender = readPlayer(fromId);
  const receiver = readPlayer(toId);

  if (!isSuperAdmin(fromId)) {
    if (!sender) return { success: false, message: 'Sender not found.' };
    if (sender.balance < amount) return { success: false, message: 'Insufficient balance.' };
  }
  if (!receiver) return { success: false, message: 'Recipient is not registered yet.' };

  return withTransaction(() => {
    // Deduct from sender (TRIPLE-SKIP for superadmin sender: no deduct, no
    // sender tracking, no receiver receivedTotal — legacy contract, keeps
    // bansos from eating the receiver's daily receive limit).
    if (!isSuperAdmin(fromId)) {
      sender.balance -= amount;
      sender.totalLost += amount;
    }
    receiver.balance += amount;
    receiver.totalEarned += amount;
    if (!isSuperAdmin(fromId)) {
      const senderData = getTransferData(sender);
      senderData.sentTotal += amount;
      senderData.sentCount += 1;
      const receiverData = getTransferData(receiver);
      receiverData.receivedTotal += amount;
    }
    if (!isSuperAdmin(fromId)) writePlayer(fromId, sender);
    writePlayer(toId, receiver);
    return { success: true, message: 'Transfer successful.' };
  });
}

// ============================================================
// XP & Leveling
// ============================================================

function addXP(userId, amount) {
  if (isSuperAdmin(userId)) return { leveledUp: false, newLevel: 0, xp: 0, xpNeeded: 0 };
  const user = readPlayer(userId);
  if (!user) return { leveledUp: false, newLevel: 0, xp: 0, xpNeeded: 0 };

  user.xp += amount;
  let leveledUp = false;
  let levelsGained = 0;
  let totalReward = 0;

  while (user.xp >= user.xpNeeded) {
    user.xp = 0; // XP resets on level up (keep legacy semantics)
    user.level += 1;
    user.xpNeeded = (user.level + 1) * 200;
    const reward = 150000 + Math.floor(Math.pow(Math.random(), 2) * 350000);
    user.balance += reward;
    user.totalEarned += reward;
    totalReward += reward;
    leveledUp = true;
    levelsGained += 1;
  }
  writePlayer(userId, user);
  return {
    leveledUp,
    levelsGained,
    newLevel: user.level,
    xp: user.xp,
    xpNeeded: user.xpNeeded,
    rewardTotal: totalReward,
  };
}

function recordWin(userId) {
  if (isSuperAdmin(userId)) return;
  S.win.run(userId); // no-op on a missing row — matches legacy tolerance
}

function recordLoss(userId) {
  if (isSuperAdmin(userId)) return;
  S.loss.run(userId); // no-op on a missing row — matches legacy tolerance
}

// ============================================================
// Daily reward
// ============================================================

function claimDaily(userId) {
  if (isSuperAdmin(userId)) {
    return { success: true, message: 'Daily claimed.', amount: 0, isSuperAdmin: true };
  }
  const user = readPlayer(userId);
  if (!user) return { success: false, message: 'User not found.', amount: 0 };

  const now = new Date();
  const wibOffset = 7 * 60 * 60 * 1000;
  const wibNow = new Date(now.getTime() + wibOffset);
  const today = wibNow.toISOString().split('T')[0];

  if (user.lastDaily === today) {
    const wibMidnight = new Date(Date.UTC(
      wibNow.getUTCFullYear(), wibNow.getUTCMonth(), wibNow.getUTCDate() + 1, 0, 0, 0, 0
    ));
    const nextResetUTC = new Date(wibMidnight.getTime() - wibOffset);
    const diff = nextResetUTC - now;
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    const timeStr = (hours === 0 && minutes === 0)
      ? 'less than a minute'
      : `**${hours}h ${minutes}m**`;
    return {
      success: false,
      message: `You already claimed your daily reward today. Come back in ${timeStr}.`,
      amount: 0,
    };
  }

  let dailyAmount = Math.floor(Math.random() * 350001) + 150000;

  // Apply queued daily boost from shop, then consume it (one-shot).
  const boosts = user.activeBoosts || {};
  if (boosts.daily_mult) {
    dailyAmount = Math.floor(dailyAmount * boosts.daily_mult);
    delete boosts.daily_mult;
  }

  user.balance += dailyAmount;
  user.totalEarned += dailyAmount;
  user.lastDaily = today;
  writePlayer(userId, user);

  return { success: true, message: 'Daily claimed.', amount: dailyAmount };
}

// ============================================================
// Leaderboard / players
// ============================================================

function getLeaderboard(limit = 10) {
  return S.leaderboard.all(SUPERADMIN_BIND, limit).map((r) => ({
    userId: r.user_id,
    username: r.username,
    balance: r.balance,
    level: r.level,
    cosmetics: (r.cosmetics && r.cosmetics !== '{}') ? JSON.parse(r.cosmetics) : null,
  }));
}

function getAllPlayers() {
  return S.allPlayers.all(SUPERADMIN_BIND).map((row) => ({ userId: row.user_id, ...rowToPlayer(row) }));
}

function getGlobalRank(userId) {
  // Legacy contract: admins (like superadmin) are UNRANKED — the ranked pool
  // excludes them, so their own profile must show 'Unranked', not a rank
  // computed against a pool they're not in.
  const row = S.get.get(userId);
  if (!row || row.is_admin) return null;
  return S.rank.get(SUPERADMIN_BIND, row.balance, row.balance, userId).r;
}

// ============================================================
// Backups (spec §6 — WAL-aware, never on empty)
// ============================================================

function backupEconomy() {
  try {
    const count = S.count.get().c;
    if (count === 0) {
      console.error('[DATA SAFETY] refusing to snapshot/prune on empty db — existing backups preserved until a human confirms this is intentional');
      return null;
    }
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 17); // minute resolution
    const destName = 'economy-' + stamp + '.db';
    const destPath = path.join(BACKUP_DIR, destName);
    const existing = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith('economy-')).sort();
    if (existing.includes(destName)) return null; // same minute — skip
    const p = db.backup(destPath); // WAL-aware consistent copy (Promise)
    p.then(() => {
      console.log('[DATA] rolling backup complete: ' + destPath); // success logged at completion, not before
      let keep = existing.filter((f) => f.endsWith('.db')); // prune only SQLite-era snapshots
      while (keep.length + 1 > BACKUP_KEEP) {
        try { fs.rmSync(path.join(BACKUP_DIR, keep.shift())); } catch { /* already gone */ }
      }
    }).catch((err) => {
      console.error('[DATA SAFETY] rolling backup FAILED:', err.message);
    });
    return destPath;
  } catch (e) {
    console.error('[DATA SAFETY] backup failed:', e.message);
    return null;
  }
}

// ---- Battle materialized helpers (spec §3.1: global LB + rank read the
// materialized columns; battle_score > 0 doubles as the has-character marker) ----

function getBattleTopIds(limit) {
  return S.battleTop.all(limit).map((r) => r.user_id);
}

function readPlayersByIds(ids) {
  if (!ids.length) return {};
  const out = {};
  const placeholders = ids.map(() => '?').join(',');
  for (const row of db.prepare(`SELECT * FROM players WHERE user_id IN (${placeholders})`).all(...ids)) {
    out[row.user_id] = rowToPlayer(row);
  }
  return out;
}

function getAbyssTopRows(limit) {
  // Materialized (spec §3.1 + plan Step 5): zero-progress players filtered out
  // to match the legacy zero-skip; NO admin filter (matches legacy).
  return db.prepare('SELECT user_id, username, abyss_best_floor AS highest, abyss_total_stars AS totalStars FROM players WHERE abyss_best_floor > 0 OR abyss_total_stars > 0 ORDER BY abyss_best_floor DESC, abyss_total_stars DESC, rowid ASC LIMIT ?').all(limit);
}

function getBattleRank(userId) {
  // Competition rank over the legacy triple (players strictly better + 1);
  // full ties share a rank (documented deliberate change, spec §11).
  const mine = S.battleRankTriple.get(userId);
  if (!mine || mine.bs === 0) return null;
  return S.battleRankCount.get({ bd: mine.bd, bs: mine.bs, saa: mine.saa }).r;
}

// ---- Poker escrow (spec §2.6): atomic join/settle on THIS connection ----
// removeBalance RETURNS {success:false} on insufficient — it does NOT throw.
// The join tx must check and throw manually or the rollback never fires and a
// player joins without paying. (verified economyManager:584-588)

function pokerJoinTransaction(gameId, userId, buyIn) {
  const tx = db.transaction(() => {
    const result = removeBalance(userId, buyIn);
    if (!result.success) throw new Error(result.message || 'Insufficient balance.');
    S.insertEscrow.run(gameId, userId, buyIn);
  });
  tx();
}

function pokerSettleTransaction(gameId, payouts) {
  const tx = db.transaction(() => {
    S.deleteEscrow.run(gameId);
    for (const [userId, amount] of payouts) {
      if (amount > 0) {
        // Verify-or-throw: addBalance returns {success:false} SILENTLY on an
        // unregistered id. In a money-critical settle, a silent fail would eat
        // chips — rollback keeps escrow alive → boot recovery retries later.
        // Superadmin is unaffected (early-return success).
        const r = addBalance(userId, amount);
        if (!r.success) throw new Error('poker settle: credit failed for ' + userId);
      }
    }
  });
  tx();
}

function getActivePokerEscrows() {
  return S.selectEscrows.all();
}

function closeDatabase() {
  // SIGTERM/SIGINT hook — checkpoints WAL into the main file so -wal holds
  // nothing committed while the bot rests (plan Step 7).
  try { db.close(); } catch { /* already closed */ }
}

module.exports = {
  isSuperAdmin,
  isAdmin,
  setAdmin,
  removeAdmin,
  isRegistered,
  registerUser,
  getUser,
  updateUsername,
  addBalance,
  removeBalance,
  getBalance,
  transfer,
  addXP,
  recordWin,
  recordLoss,
  claimDaily,
  getLeaderboard,
  checkTransferLimits,
  getDailySendLimit,
  getDailyReceiveLimit,
  getTransferData,
  getAllPlayers,
  getGlobalRank,
  backupEconomy,
  readPlayer,
  writePlayer,
  readAllPlayers,
  withTransaction,
  snapshotTo,
  getBattleTopIds,
  pokerJoinTransaction,
  pokerSettleTransaction,
  getActivePokerEscrows,
  readPlayersByIds,
  getAbyssTopRows,
  getBattleRank,
  closeDatabase,
  DB_PATH,
};
