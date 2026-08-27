'use strict';

// Steps 16-17 — crash resilience + backup integrity.
// SIGKILL a writer mid-flight, then boot: integrity_check must be ok and all
// players intact (WAL). snapshotTo → gzip → gunzip → the restored db must open
// and contain the latest committed data.
//   node test/sqlite.resilience.test.js
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync('/tmp/kill16-');
const ENV = { ...process.env, KYRIZ_ECONOMY_JSON: path.join(tmp, 'economy.json'), KYRIZ_ECONOMY_DB: path.join(tmp, 'economy.db') };
let pass = 0, fail = 0;
const ok = (c, l) => { if (c) pass++; else { fail++; console.error('  FAIL:', l); } };

const seed = {};
for (let i = 0; i < 20; i++) {
  seed['u' + i] = { username: 'p' + i, balance: 100000 + i, level: 3, xp: 0, xpNeeded: 1000, totalWins: i, totalLosses: 0, totalEarned: 100000, totalLost: 0, lastDaily: null, registeredAt: '2026-01-01T00:00:00Z' };
}
fs.writeFileSync(ENV.KYRIZ_ECONOMY_JSON, JSON.stringify(seed));
execFileSync('node', ['-e', "require('./utils/economyManager')"], { cwd: ROOT, env: ENV });

const child = spawn('node', ['-e', `
  const e = require('./utils/economyManager');
  let i = 0;
  setInterval(() => {
    const u = e.readPlayer('u' + (i % 20));
    u.balance += 7; u.username = 'p' + (i % 20) + 'x' + i;
    e.writePlayer('u' + (i % 20), u);
    i++;
    if (i >= 60) process.exit(0);
  }, 5);
`], { cwd: ROOT, env: ENV });
setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, 120); // kill mid-writes

child.on('exit', () => {
  const out = execFileSync('node', ['-e', `
    const e = require('./utils/economyManager');
    const D = require('better-sqlite3')(process.env.KYRIZ_ECONOMY_DB, { readonly: true });
    const ic = D.pragma('integrity_check')[0].integrity_check;
    console.log(JSON.stringify({ n: Object.keys(e.readAllPlayers()).length, ic }));
    D.close();
  `], { cwd: ROOT, env: ENV }).toString();
  const r = JSON.parse(out.trim().split('\n').pop());
  ok(r.ic === 'ok', `integrity_check ok after SIGKILL mid-writes (${r.ic})`);
  ok(r.n === 20, `20 players intact after kill (got ${r.n})`);

  // Step 17: snapshot → gzip → gunzip → restored db valid + current
  execFileSync('node', ['-e', `
    (async () => {
      const e = require('./utils/economyManager');
      const zlib = require('zlib'); const fs = require('fs');
      await e.snapshotTo(${JSON.stringify(path.join(tmp, 'snap.db'))});
      fs.writeFileSync(${JSON.stringify(path.join(tmp, 'snap.db.gz'))}, zlib.gzipSync(fs.readFileSync(${JSON.stringify(path.join(tmp, 'snap.db'))})));
      console.log('snap ok');
    })();
  `], { cwd: ROOT, env: ENV });
  const raw = require('zlib').gunzipSync(fs.readFileSync(path.join(tmp, 'snap.db.gz')));
  fs.writeFileSync(path.join(tmp, 'restored.db'), raw);
  const D = require('better-sqlite3')(path.join(tmp, 'restored.db'), { readonly: true });
  const n = D.prepare('SELECT COUNT(*) AS c FROM players').get().c;
  const sample = D.prepare('SELECT username, balance FROM players WHERE user_id = ?').get('u5');
  D.close();
  ok(n === 20, `restored-from-gz db has 20 players (got ${n})`);
  ok(!!sample && typeof sample.balance === 'number', 'restored db readable (u5 present, balance numeric)');

  console.log(`\n${fail === 0 ? '✅' : '❌'} sqlite.resilience — Pass: ${pass} | Fail: ${fail}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
});
