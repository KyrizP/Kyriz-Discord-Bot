'use strict';

// ============================================================
// sqlite.parity — golden-master parity harness (plan Step 9).
// Legacy JSON economyManager (verbatim fixture) vs new SQLite
// module, driven through IDENTICAL operation sequences in one
// process. Deterministic: seeded Math.random, reset between runs.
//
// (a) Round-trip (canonical normalizer, extra catch-all, __proto__
//     craft, rowid stability via a readonly connection)
// (b) Operation replay — API-surface economics incl. superadmin
//     contracts and transfer triple-skip
// (c) Materialized-order: battle LB + abyss LB (rows/order/
//     zero-skip) vs legacy computation on the same fixture data
// ============================================================

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const FIX_LEGACY = path.join(__dirname, 'fixtures', 'legacy', 'economyManager.js');
const FIX_SHA = path.join(__dirname, 'fixtures', 'legacy', 'SHA256');

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; }
  else { fail++; console.error('  ❌ FAIL: ' + label); }
}

// ---- Fixture integrity: stale fixture = FAIL, never SKIP ----
const wantSha = fs.readFileSync(FIX_SHA, 'utf8').split('\n')[0].trim();
const gotSha = crypto.createHash('sha256').update(fs.readFileSync(FIX_LEGACY)).digest('hex');
if (wantSha !== gotSha) {
  console.error(`❌ FIXTURE STALE — SHA mismatch. Re-snapshot: git show <recorded-HEAD>:utils/economyManager.js > ${FIX_LEGACY}`);
  process.exit(1);
}
ok(true, 'fixture hash match');

// ---- Seeded RNG ----
const REAL_RANDOM = Math.random;
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ---- Canonical normalizer (spec §3) ----
function normalizePlayer(p) {
  const out = { ...p };
  out.inventory = out.inventory || {};
  out.activeBoosts = out.activeBoosts || {};
  out.cosmetics = out.cosmetics || {};
  out.transferData = out.transferData || {};
  out.isAdmin = !!out.isAdmin;
  if (out.lastDaily === undefined) out.lastDaily = null;
  return out;
}
function normalizeAll(dict) {
  const out = {};
  for (const [uid, p] of Object.entries(dict || {})) out[uid] = normalizePlayer(p);
  return out;
}
// Wall-clock timestamps (registeredAt etc.) differ between the two runs by
// milliseconds — behaviorally irrelevant. Scrub full ISO timestamps before
// comparing; date-only strings (lastDaily) are deterministic and kept.
function scrubTimes(s) {
  return s.replace(/"\d{4}-\d{2}-\d{2}T[^"]*"/g, '"<TS>"');
}
// Key ORDER is not semantic (legacy inserts isAdmin late; the store emits a
// fixed column order). Canonical stringify: recursively sorted keys.
function canon(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(canon);
  const o = {};
  for (const k of Object.keys(v).sort()) o[k] = canon(v[k]);
  return o;
}

// ---- Sandboxes ----
process.env.SUPERADMIN_ID = '999000999000999000'; // required by superadmin branches
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-'));
const legacyData = path.join(tmp, 'legacy-data');
fs.mkdirSync(legacyData, { recursive: true });
// Legacy module resolves its data via __dirname/../data — copy VERBATIM fixture
// into a layout dir so that path is the sandbox (no edits to fixture content).
const legacyHome = path.join(tmp, 'legacy-home');
fs.mkdirSync(path.join(legacyHome, 'utils'), { recursive: true });
fs.mkdirSync(path.join(legacyHome, 'data'), { recursive: true });
fs.copyFileSync(FIX_LEGACY, path.join(legacyHome, 'utils', 'economyManager.js'));
// New module via BOTH env vars (spec §4: sandbox mode)
const newDb = path.join(tmp, 'new-economy.db');
const newJson = path.join(tmp, 'new-economy.json');
process.env.KYRIZ_ECONOMY_JSON = newJson;
process.env.KYRIZ_ECONOMY_DB = newDb;

// ---- The replay sequence (identical for both implementations) ----
function runSequence(econ, rng) {
  Math.random = rng;
  const SUP = process.env.SUPERADMIN_ID;
  const A = '111aaa111111111111', B = '222bbb222222222222', C = '333ccc333333333333';
  const log = [];
  // Player-shaped returns are compared in the CANONICAL form (spec §3: readPlayer
  // materializes optional fields — consumers all guard with || {}, so absent vs {}
  // is behaviorally identical by contract).
  const rec = (label, v) => {
    const norm = (v && typeof v === 'object' && typeof v.username === 'string' && 'balance' in v) ? normalizePlayer(v) : v;
    log.push([label, v === undefined ? '<undefined>' : scrubTimes(JSON.stringify(canon(norm)))]);
  };

  rec('reg-A', econ.registerUser(A, 'alice'));
  rec('reg-A-dup', econ.registerUser(A, 'alice'));
  rec('reg-B', econ.registerUser(B, 'bob'));
  rec('reg-C', econ.registerUser(C, 'carol'));
  rec('add-A-50k', econ.addBalance(A, 50000));
  rec('add-A-30k', econ.addBalance(A, 30000));
  rec('rem-A-180k-fail', econ.removeBalance(A, 180000));
  rec('rem-A-20k', econ.removeBalance(A, 20000));
  rec('bal-A', econ.getBalance(A));
  rec('bal-missing', econ.getBalance('444ddd444444444444'));
  rec('isReg-SUP', econ.isRegistered(SUP));
  rec('isReg-A', econ.isRegistered(A));
  rec('isReg-missing', econ.isRegistered('444ddd444444444444'));
  rec('claim-A', econ.claimDaily(A));
  rec('claim-A-double', econ.claimDaily(A));
  rec('claim-SUP', econ.claimDaily(SUP));
  rec('claim-missing', econ.claimDaily('444ddd444444444444'));
  rec('tf-A-B-10k', econ.transfer(A, B, 10000));
  rec('tf-A-B-overmax', econ.transfer(A, B, 3000000));
  rec('tf-A-B-zero', econ.transfer(A, B, 0));
  rec('tf-A-missing-rcpt', econ.transfer(A, '444ddd444444444444', 1000));
  rec('tf-missing-snd', econ.transfer('444ddd444444444444', B, 1000));
  rec('tf-A-B-insuf', econ.transfer(A, B, 999999999));
  rec('tf-SUP-C-1M', econ.transfer(SUP, C, 1000000)); // triple-skip branch
  rec('xp-A-900', econ.addXP(A, 900)); // cross level-up (needs 400)
  rec('xp-SUP', econ.addXP(SUP, 500));
  rec('xp-missing', econ.addXP('444ddd444444444444', 500));
  rec('win-A', (econ.recordWin(A), null));
  rec('loss-B', (econ.recordLoss(B), null));
  rec('win-missing', (econ.recordWin('444ddd444444444444'), null));
  rec('upd-B-same', (econ.updateUsername(B, 'bob'), null)); // skip-write branch
  rec('upd-B-new', (econ.updateUsername(B, 'bobby'), null));
  rec('upd-SUP-autocreate', (econ.updateUsername(SUP, 'TheOwner'), null));
  rec('get-SUP', econ.getUser(SUP));
  rec('get-A', econ.getUser(A));
  rec('get-missing', econ.getUser('444ddd444444444444'));
  rec('admin-A', (econ.setAdmin(A, 'alice', 5000000), null));
  rec('isAdmin-A', econ.isAdmin(A));
  rec('remAdmin-A', (econ.removeAdmin(A), null));
  rec('isAdmin-A-after', econ.isAdmin(A));
  rec('lb', econ.getLeaderboard(10));
  rec('allPlayers', (econ.getAllPlayers().map((p) => p.userId + ':' + p.balance + ':' + p.username + ':' + (p.isAdmin === true))).sort());
  rec('rank-A', econ.getGlobalRank(A));
  rec('rank-C', econ.getGlobalRank(C));
  rec('rank-missing', econ.getGlobalRank('444ddd444444444444'));
  Math.random = REAL_RANDOM;
  return log;
}

function dump(econ) {
  return econ.readEconomy ? econ.readEconomy() : econ.readAllPlayers();
}

// ---- Run legacy ----
const legacyDataFile = path.join(legacyHome, 'data', 'economy.json');
fs.writeFileSync(legacyDataFile, '{}'); // empty start — legacy treats as fresh
const legacy = require(legacyHome + '/utils/economyManager.js');
const legacyLog = runSequence(legacy, makeRng(0xC0FFEE));
const legacyFinal = normalizeAll(dump(legacy));

// ---- Run new (fresh process state via deleteCache + fresh db) ----
delete require.cache[require.resolve(ROOT + '/utils/economyManager.js')];
try { fs.rmSync(newJson, { force: true }); } catch {} // fresh install = file ABSENT ('{}' present = .suspect refuse, spec §5)
const econ = require(ROOT + '/utils/economyManager.js');
const newLog = runSequence(econ, makeRng(0xC0FFEE));
const newFinal = normalizeAll(dump(econ));

// ---- (b) compare logs ----
console.log('— operation replay —');
ok(legacyLog.length === newLog.length, `log length ${legacyLog.length} vs ${newLog.length}`);
let logDiffs = 0;
for (let i = 0; i < Math.max(legacyLog.length, newLog.length); i++) {
  const [ll, lv] = legacyLog[i] || ['<none>', ''];
  const [nl, nv] = newLog[i] || ['<none>', ''];
  if (ll !== nl || lv !== nv) {
    // Known deliberate divergence (spec §11, documented): tie-semantics —
    // competition rank (COUNT+1) vs legacy findIndex position on EQUAL balances.
    if (ll === 'lb' || (ll.startsWith('rank') && lv !== nv)) { /* surfaced below */ }
    logDiffs++;
    if (logDiffs <= 5) console.error(`  diff @${i} [${ll}]: legacy=${lv.slice(0, 140)} new=${nv.slice(0, 140)}`);
  }
}
ok(logDiffs === 0, `return-value parity (${logDiffs} diffs)`);

// ---- (b2) compare final state (canonical) ----
console.log('— final state —');
const lIds = Object.keys(legacyFinal).sort(), nIds = Object.keys(newFinal).sort();
ok(JSON.stringify(lIds) === JSON.stringify(nIds), `player sets equal (${lIds} vs ${nIds})`);
let stateDiffs = 0;
for (const uid of lIds) {
  const a = scrubTimes(JSON.stringify(canon(legacyFinal[uid]))), b = scrubTimes(JSON.stringify(canon(newFinal[uid])));
  if (a !== b) { stateDiffs++; console.error(`  state diff ${uid}:\n    legacy=${a.slice(0, 200)}\n    new   =${b.slice(0, 200)}`); }
}
ok(stateDiffs === 0, `final states deep-equal after normalizer (${stateDiffs} diffs)`);

// ---- (a) round-trip on the new module ----
console.log('— round-trip —');
{
  const uid = '111aaa111111111111';
  const src = normalizePlayer(newFinal[uid]);
  econ.writePlayer(uid, src);
  const back = econ.readPlayer(uid);
  ok(JSON.stringify(back) === JSON.stringify(src), 'readPlayer(writePlayer(normalize(obj))) deep-equal');

  // extra catch-all: unknown field survives
  const withExtra = { ...src, customFutureFlag: { ohai: 1 } };
  econ.writePlayer(uid, withExtra);
  ok(econ.readPlayer(uid).customFutureFlag !== undefined && econ.readPlayer(uid).customFutureFlag.ohai === 1, 'unknown field survives via extra');

  // __proto__ craft: no prototype pollution, isAdmin not shadowed
  const crafted = { ...src, ['__proto__']: { isAdmin: true } };
  const before = Object.getPrototypeOf(econ.readPlayer(uid));
  econ.writePlayer(uid, crafted);
  const after = econ.readPlayer(uid);
  ok(Object.getPrototypeOf(after) === Object.prototype || Object.getPrototypeOf(after) === before, 'prototype untouched by crafted extra');
  ok(!after.hasOwnProperty('__proto__') || after.isAdmin === src.isAdmin, 'crafted __proto__ does not flip isAdmin');

  // battle NULL → key absent; lastDaily null present; is_admin boolean
  const noBattle = { ...src }; delete noBattle.battle;
  econ.writePlayer(uid, noBattle);
  ok(!('battle' in econ.readPlayer(uid)), 'battle NULL → key absent');
  ok(typeof econ.readPlayer(uid).isAdmin === 'boolean', 'isAdmin reads back boolean');

  // rowid stability across writePlayer (readonly side connection)
  const Database = require('better-sqlite3');
  const ro = new Database(newDb, { readonly: true });
  const r1 = ro.prepare('SELECT user_id, rowid FROM players').all().sort((x, y) => x.user_id.localeCompare(y.user_id));
  econ.writePlayer(uid, econ.readPlayer(uid));
  econ.writePlayer('222bbb222222222222', econ.readPlayer('222bbb222222222222'));
  const r2 = ro.prepare('SELECT user_id, rowid FROM players').all().sort((x, y) => x.user_id.localeCompare(y.user_id));
  ok(JSON.stringify(r1) === JSON.stringify(r2), 'rowid stable across writePlayer (no INSERT OR REPLACE churn)');
  ro.close();
}

// ---- (c) materialized-order: battle LB + abyss LB ----
console.log('— materialized order —');
{
  const battle = require(ROOT + '/utils/battleManager.js');
  const mk = (depth, level, cls, at) => ({
    username: 'p', balance: 1, level: 1, xp: 0, xpNeeded: 400, totalWins: 0, totalLosses: 0,
    totalEarned: 0, totalLost: 0, lastDaily: null, registeredAt: at,
    battle: { activeClass: cls, kryptonite: 0, bag: {}, uniqueItems: {}, pvpWins: 0, pvpLosses: 0, presets: {},
      characters: { [cls]: { charName: 'c', charLevel: level, equipment: {}, bestDepth: depth, scoreAchievedAt: at } } },
  });
  const dict = {
    P1: mk(80, 50, 'warrior', '2026-01-01T00:00:00Z'),
    P2: mk(80, 40, 'mage', '2026-01-02T00:00:00Z'),    // tie depth → score decides
    P3: mk(80, 40, 'mage', '2026-01-01T00:00:00Z'),    // full-ish tie → achievedAt decides
    P4: mk(30, 10, 'rogue', '2026-01-03T00:00:00Z'),
    P5: { username: 'nobjc', balance: 1, level: 1, xp: 0, xpNeeded: 400, totalWins: 0, totalLosses: 0, totalEarned: 0, totalLost: 0, lastDaily: null, registeredAt: '2026-01-04T00:00:00Z' }, // charless — excluded
  };
  // legacy-style computation (pure fn, takes dict)
  const legacyBoard = battle.getBattleLeaderboardFor(dict, 100, null, null).map((r) => r.userId + ':' + r.bestDepth + ':' + r.score + ':' + r.scoreAchievedAt);
  // write into the new store, then read through the materialized path
  for (const [uid, p] of Object.entries(dict)) econ.writePlayer(uid, p);
  const newBoard = battle.getBattleLeaderboard(100).map((r) => r.userId + ':' + r.bestDepth + ':' + r.score + ':' + (r.scoreAchievedAt || '9999'));
  ok(JSON.stringify(legacyBoard) === JSON.stringify(newBoard), `battle LB order+values (${legacyBoard} vs ${newBoard})`);
  ok(!newBoard.some((x) => x.startsWith('P5:')), 'charless player excluded from battle LB');

  // rank (no ties among ranked for exact compare; ties → competition semantics)
  ok(battle.getBattleGlobalRank('P1') === 1, 'battle rank P1 = 1');
  ok(battle.getBattleGlobalRank('P4') === 4, 'battle rank P4 = 4');
  ok(battle.getBattleGlobalRank('P5') === null, 'charless rank = null');

  // abyss LB: same stars data through both paths
  const stars = (arr) => ({ username: 'a', balance: 1, level: 1, xp: 0, xpNeeded: 400, totalWins: 0, totalLosses: 0,
    totalEarned: 0, totalLost: 0, lastDaily: null, registeredAt: '2026-01-05T00:00:00Z',
    battle: { activeClass: 'warrior', kryptonite: 0, bag: {}, uniqueItems: {}, pvpWins: 0, pvpLosses: 0, presets: {},
      characters: { warrior: { charName: 'c', charLevel: 5, equipment: {}, bestDepth: 1 } }, abyss: { stars: arr, rewarded: [], milestones: {} } } });
  const abyssDict = {
    Q1: stars([3, 3, 2, 0, 0, 0, 0, 0, 0, 0]),
    Q2: stars([3, 3, 3, 1, 0, 0, 0, 0, 0, 0]),
    Q3: stars([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), // zero-progress — skipped
    Q4: stars([1, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
  };
  const legacyAbyss = [];
  for (const [uid, u] of Object.entries(abyssDict)) {
    const arr2 = u.battle.abyss.stars;
    const total = arr2.reduce((s, x) => s + x, 0);
    let highest = 0; arr2.forEach((s, i) => { if (s > 0) highest = i + 1; });
    if (highest === 0 && total === 0) continue;
    legacyAbyss.push(uid + ':' + highest + ':' + total);
  }
  legacyAbyss.sort((x, z) => parseInt(z.split(':')[1]) - parseInt(x.split(':')[1]) || parseInt(z.split(':')[2]) - parseInt(x.split(':')[2]));
  for (const [uid, p] of Object.entries(abyssDict)) econ.writePlayer(uid, p);
  const econMod = require(ROOT + '/utils/economyManager.js');
  const newAbyss = econMod.getAbyssTopRows(10).map((r) => r.user_id + ':' + r.highest + ':' + r.totalStars);
  ok(JSON.stringify(legacyAbyss) === JSON.stringify(newAbyss), `abyss LB rows+order+zero-skip (${legacyAbyss} vs ${newAbyss})`);
  ok(!newAbyss.some((x) => x.startsWith('Q3:')), 'zero-progress player excluded');
}

console.log(`\n${fail === 0 ? '✅' : '❌'} sqlite.parity — Pass: ${pass} | Fail: ${fail}`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
