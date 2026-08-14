'use strict';
// botState persistence tests. Run: node test/botState.test.js
// Operates on the real data/botState.json path — snapshots & restores it.
const fs = require('fs');
const path = require('path');
const MOD = path.join(__dirname, '..', 'utils', 'botState.js');
const FILE = path.join(__dirname, '..', 'data', 'botState.json');
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : (fail++, console.log('  ❌ ' + m)); };

const snapshot = fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8') : null;
const fresh = () => { delete require.cache[require.resolve(MOD)]; return require(MOD); };

// ---- missing file → live-safe defaults ----
fs.rmSync(FILE, { force: true });
let bs = fresh();
ok(bs.state.maintenance.active === false, 'missing file → maintenance OFF (live-safe default)');
ok(bs.state.bansos.active === false && bs.state.bansos.claimedUsers.length === 0, 'missing file → no active bansos');
ok(Array.isArray(bs.state.patch.versions) && bs.state.patch.versions.length > 0, 'missing file → seeded patch notes');
ok(bs.state.patch.channelId === null && bs.state.patch.messageId === null, 'no stored announcement initially');

// ---- roundtrip: mutate → save → "restart" (fresh require) → intact ----
bs.state.maintenance = { active: true, message: 'Deploys incoming' };
bs.state.bansos = { active: true, amount: 500000, message: 'Sorry!', claimedUsers: ['u1', 'u2'] };
bs.state.patch.versions.push({ version: 2, date: '2026-08-15', title: 'v2.2', lines: ['a', 'b'] });
bs.state.patch.channelId = 'ch1';
bs.state.patch.messageId = 'msg1';
bs.save();
bs = fresh();
ok(bs.state.maintenance.active === true && bs.state.maintenance.message === 'Deploys incoming', 'restart → maintenance stays ON with message');
ok(bs.state.bansos.active === true && bs.state.bansos.amount === 500000, 'restart → bansos stays active');
ok(bs.state.bansos.claimedUsers.includes('u1') && bs.state.bansos.claimedUsers.includes('u2'), 'restart → claimers intact (no double-claim after restart)');
ok(bs.state.patch.versions.length === 2 && bs.state.patch.versions[1].title === 'v2.2', 'restart → patch versions intact');
ok(bs.state.patch.channelId === 'ch1' && bs.state.patch.messageId === 'msg1', 'restart → announcement ids intact (edit-not-repost)');

// ---- bansos semantics: a new round resets claimers (handled by game.js, state mirrors it) ----
bs.state.bansos = { active: true, amount: 100, message: 'round 2', claimedUsers: [] };
bs.save();
bs = fresh();
ok(bs.state.bansos.claimedUsers.length === 0 && bs.state.bansos.message === 'round 2', 'new bansos round → empty claimers');

// ---- corrupt file → defaults, no throw ----
fs.writeFileSync(FILE, '{not json');
bs = fresh();
ok(bs.state.maintenance.active === false, 'corrupt file → safe defaults (no crash)');

// ---- cleanup: restore pre-test state ----
if (snapshot === null) fs.rmSync(FILE, { force: true });
else fs.writeFileSync(FILE, snapshot);

console.log('\n' + (fail === 0 ? '✅ SEMUA TEST LULUS' : '❌ ADA TEST GAGAL'));
console.log('Pass: ' + pass + ' | Fail: ' + fail);
process.exit(fail === 0 ? 0 : 1);
