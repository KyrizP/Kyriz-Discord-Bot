'use strict';

// Step 14 gladi — dress rehearsal against REAL server data (server-economy.json,
// copied into a sandbox NAMED economy.json exactly like the live server).
// Repo data is never touched (post-condition asserted).
//   node test/sqlite.gladi.test.js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'data', 'server-economy.json');
const tmp = '/tmp/gladi';
let pass = 0, fail = 0;
const ok = (c, l) => { if (c) pass++; else { fail++; console.error('  FAIL:', l); } };

const stat = (p) => { try { const s = fs.statSync(p); return s.size + ':' + s.mtimeMs; } catch { return 'absent'; } };
const beforeEcon = stat(path.join(ROOT, 'data', 'economy.json'));
const beforeSnap = stat(SRC);

fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });
fs.copyFileSync(SRC, path.join(tmp, 'data', 'economy.json'));

const run = (js) => execFileSync('node', ['-e', js], {
  cwd: ROOT,
  env: { ...process.env, KYRIZ_ECONOMY_JSON: path.join(tmp, 'data', 'economy.json'), KYRIZ_ECONOMY_DB: path.join(tmp, 'data', 'economy.db') },
}).toString();

const CMP = `
  const e = require('./utils/economyManager');
  const fs = require('fs');
  const src = JSON.parse(fs.readFileSync(process.env.KYRIZ_ECONOMY_JSON + '.pre-sqlite', 'utf8'));
  const all = e.readAllPlayers();
  const norm = (p) => { p.inventory = p.inventory || {}; p.activeBoosts = p.activeBoosts || {}; p.cosmetics = p.cosmetics || {}; p.transferData = p.transferData || {}; p.isAdmin = !!p.isAdmin; if (p.lastDaily === undefined) p.lastDaily = null; return p; };
  const can = (o) => { if (o === null || typeof o !== 'object') return o; if (Array.isArray(o)) return o.map(can); const r = {}; for (const k of Object.keys(o).sort()) r[k] = can(o[k]); return r; };
  const N = {}, S = {};
  for (const [k, v] of Object.entries(all)) N[k] = norm(v);
  for (const [k, v] of Object.entries(src)) S[k] = norm(JSON.parse(JSON.stringify(v)));
  let diffs = 0; const who = [];
  for (const k of Object.keys(S)) if (JSON.stringify(can(N[k])) !== JSON.stringify(can(S[k]))) { diffs++; who.push(k); }
  console.log(JSON.stringify({ migrated: Object.keys(all).length, source: Object.keys(src).length, diffs, who: who.slice(0, 5) }));
`;

// Run 1: full migration + deep-equal vs the .pre-sqlite born in the sandbox
const out1 = run(CMP);
const r1 = JSON.parse(out1.trim().split('\n').pop());
ok(r1.migrated === 48, `migrated 48 players (got ${r1.migrated})`);
ok(r1.source === 48, `source has 48 players (got ${r1.source})`);
ok(r1.diffs === 0, `deep-equal 48/48 after normalizer (${r1.diffs} diffs: ${JSON.stringify(r1.who)})`);
ok(fs.existsSync(path.join(tmp, 'data', 'economy.json.pre-sqlite')), '.pre-sqlite born in sandbox (beside economy.json, derived-path rule)');

// Run 2: fresh process, same env → no re-migration, still 48
const out2 = run(`const e = require('./utils/economyManager'); console.log(Object.keys(e.readAllPlayers()).length);`);
ok(out2.trim().split('\n').pop() === '48', 'process-2: 48 players, no re-migrate');

// POST-CONDITION: repo data untouched (mtime+size)
ok(stat(path.join(ROOT, 'data', 'economy.json')) === beforeEcon, 'repo data/economy.json untouched');
ok(stat(SRC) === beforeSnap, 'server-economy.json snapshot untouched');

console.log(`\n${fail === 0 ? '✅' : '❌'} sqlite.gladi — Pass: ${pass} | Fail: ${fail}`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
