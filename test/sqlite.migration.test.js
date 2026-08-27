'use strict';

// Step 13 migration matrix — run directly (uses its own sandbox):
//   node test/sqlite.migration.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mig13-'));
const JSON_F = path.join(tmp, 'economy.json');
const DB_F = path.join(tmp, 'economy.db');

const good = JSON.stringify({
  m1: { username: 'p1', balance: 777, level: 5, xp: 3, xpNeeded: 1200, totalWins: 2, totalLosses: 1, totalEarned: 900, totalLost: 100, lastDaily: '2026-08-20', registeredAt: '2026-02-02T00:00:00Z', isAdmin: true, inventory: { lucky_token: 2 }, cosmetics: { title: 'title_drake_slayer', owned: ['title_drake_slayer'] }, transferData: { date: '2026-08-20', sentTotal: 5, sentCount: 1, receivedTotal: 0 }, battle: { activeClass: 'mage', kryptonite: 42, bag: { g1: 1 }, uniqueItems: {}, pvpWins: 1, pvpLosses: 0, presets: {}, characters: { mage: { charName: 'Merlin', charLevel: 9, equipment: {}, bestDepth: 12, scoreAchievedAt: '2026-03-03T00:00:00Z' } }, abyss: { stars: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0], rewarded: [true], milestones: {} } } },
  m2: { username: 'p2', balance: 1000, level: 1, xp: 0, xpNeeded: 400, totalWins: 0, totalLosses: 0, totalEarned: 0, totalLost: 0, lastDaily: null, registeredAt: '2026-02-03T00:00:00Z' },
});

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) pass++; else { fail++; console.error('  FAIL:', l); } };

function node(script) {
  return execFileSync('node', ['-e', script], {
    cwd: ROOT,
    env: { ...process.env, KYRIZ_ECONOMY_JSON: JSON_F, KYRIZ_ECONOMY_DB: DB_F },
  }).toString();
}

// T1: migrate → deep-equal per player (normalizer kedua sisi, spec §3)
fs.writeFileSync(JSON_F, good);
const out1 = node(`
  const e = require('./utils/economyManager');
  const src = JSON.parse(require('fs').readFileSync(${JSON.stringify(JSON_F + '.pre-sqlite')}, 'utf8'));
  const all = e.readAllPlayers();
  const norm = (p) => { p.inventory = p.inventory || {}; p.activeBoosts = p.activeBoosts || {}; p.cosmetics = p.cosmetics || {}; p.transferData = p.transferData || {}; p.isAdmin = !!p.isAdmin; if (p.lastDaily === undefined) p.lastDaily = null; return p; };
  const can = (o) => { if (o === null || typeof o !== 'object') return o; if (Array.isArray(o)) return o.map(can); const r = {}; for (const k of Object.keys(o).sort()) r[k] = can(o[k]); return r; };
  const N = {}, S = {};
  for (const [k, v] of Object.entries(all)) N[k] = norm(v);
  for (const [k, v] of Object.entries(src)) S[k] = norm(JSON.parse(JSON.stringify(v)));
  console.log(JSON.stringify({ count: Object.keys(all).length, eq: JSON.stringify(can(N)) === JSON.stringify(can(S)) }));
`);
const r1 = JSON.parse(out1.trim().split('\n').pop());
ok(r1.count === 2, 'migrated 2 players');
ok(r1.eq === true, 'deep-equal after normalizer (battle/inventory/cosmetics/admin included)');
ok(fs.existsSync(JSON_F + '.pre-sqlite'), '.pre-sqlite born beside fixture (derived-path rule)');

// T2: double-boot does not re-migrate
const out2 = node(`const e = require('./utils/economyManager'); console.log(JSON.stringify({ n: Object.keys(e.readAllPlayers()).length }));`);
ok(JSON.parse(out2.trim().split('\n').pop()).n === 2, 'boot-2 keeps 2 players, no re-migrate');

// T3: materialized columns correct from battle data
const out3 = node(`
  const D = require('better-sqlite3')(${JSON.stringify(DB_F)}, { readonly: true });
  console.log(JSON.stringify(D.prepare('SELECT user_id,best_depth,battle_score,abyss_best_floor,abyss_total_stars FROM players').all()));
  D.close();
`);
const rows = JSON.parse(out3.trim().split('\n').pop());
const m1 = rows.find((r) => r.user_id === 'm1');
const m2 = rows.find((r) => r.user_id === 'm2');
ok(m1 && m1.best_depth === 12 && m1.battle_score > 0, 'materialized battle: depth 12, score > 0');
ok(m1 && m1.abyss_best_floor === 1 && m1.abyss_total_stars === 1, 'materialized abyss: floor 1, stars 1');
ok(m2 && m2.battle_score === 0 && m2.abyss_best_floor === 0, 'charless m2: zeros');

// T4: state matrix (already probed in Step 1b — re-verified here for the record)
// (a) refuse-fresh: db+json gone, .pre-sqlite present → THROW
fs.rmSync(DB_F, { force: true }); fs.rmSync(DB_F + '-wal', { force: true }); fs.rmSync(DB_F + '-shm', { force: true });
fs.rmSync(JSON_F, { force: true }); // leave only .pre-sqlite
let threw = false;
try { node(`require('./utils/economyManager')`); } catch { threw = true; }
ok(threw, 'refuse-fresh: .pre-sqlite without db+json → THROW');

// (b) resume: .migrating (stale) without db → migrates
fs.rmSync(JSON_F + '.pre-sqlite', { force: true });
fs.writeFileSync(JSON_F + '.migrating', good);
const stale = new Date(Date.now() - 120000).toISOString().replace(/[:.]/g, '-').split('.')[0];
try { fs.utimesSync(JSON_F + '.migrating', new Date(Date.now() - 120000), new Date(Date.now() - 120000)); } catch {}
const out4 = node(`const e = require('./utils/economyManager'); console.log(Object.keys(e.readAllPlayers()).length);`);
ok(out4.trim().split('\n').pop() === '2', 'resume from stale .migrating → 2 players');
ok(fs.existsSync(JSON_F + '.pre-sqlite'), '.migrating promoted to .pre-sqlite after resume');

console.log(`\n${fail === 0 ? '✅' : '❌'} sqlite.migration — Pass: ${pass} | Fail: ${fail}`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
