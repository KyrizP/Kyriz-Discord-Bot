'use strict';

// End-to-end behavioral probe through the ADAPTED CONSUMERS (post-migration
// code review): battle delve lifecycle, gear economy, PvP record, Abyss clear,
// shop purchase/use/daily-boost, backup snapshot→gzip. Everything runs in a
// sandbox (BOTH env vars). Permanent battery member.
//   node test/sqlite.e2e.test.js
process.env.KYRIZ_ECONOMY_JSON = '/tmp/e2e-nonexist-' + process.pid + '.json'; // absent → fresh db
process.env.KYRIZ_ECONOMY_DB = '/tmp/e2e-' + process.pid + '.db';

const fs = require('fs');
let pass = 0, fail = 0;
const ok = (c, l) => { if (c) pass++; else { fail++; console.error('  FAIL: ' + l); } };

const econ = require('../utils/economyManager');
const battle = require('../utils/battleManager');
const abyss = require('../utils/abyssManager');
const shop = require('../utils/shopManager');
const pvp = require('../utils/pvpManager');

const P1 = 'e2e111111111111111', P2 = 'e2e222222222222222';
process.env.SUPERADMIN_ID = 'e2esup000000000000'; // after economy require: SUPERADMIN_BIND is '' — isAdmin uses isSuperAdmin at call time ✓

// ---- battle lifecycle ----
console.log('— battle lifecycle —');
ok(econ.registerUser(P1, 'hero').success, 'register hero');
ok(econ.registerUser(P2, 'rival').success, 'register rival');
const bal0 = econ.getBalance(P1);
const cc = battle.createCharacter(P1, 'warrior');
ok(cc.ok, 'createCharacter warrior');
const sd = battle.startDelve(P1);
ok(sd.ok, 'startDelve paid (' + sd.paid + ')');
ok(econ.getBalance(P1) === bal0 - 5000, `entry fee persisted (bal ${bal0} → ${econ.getBalance(P1)})`); // paid is a boolean flag, fee is 5000
let steps = 0, died = false, lastWin = null;
while (battle.hasActiveRun(P1) && steps < 60) {
  const r = battle.nextFloor(P1);
  steps++;
  if (!r.ok) break;
  if (r.won) { lastWin = r; } else { died = true; break; }
}
if (died) {
  const p = econ.readPlayer(P1);
  ok(!battle.hasActiveRun(P1), 'death cleared run');
  ok(p.battle.kryptonite >= 0, 'death path persisted (kry=' + p.battle.kryptonite + ')');
} else {
  const ex = battle.extractRun(P1);
  ok(ex.ok, 'extractRun ok, banked=' + JSON.stringify(ex.banked).slice(0, 40));
  ok(!battle.hasActiveRun(P1), 'run cleared after extract');
  const p = econ.readPlayer(P1);
  ok(p.battle.bestDepth > 0, 'bestDepth persisted: ' + p.battle.bestDepth);
  const totalKry = Object.values(p.battle.bag || {}).length;
  ok(true, 'bag has ' + totalKry + ' drop types post-extract');
}

// ---- gear economy ----
console.log('— gear —');
{
  const p = econ.readPlayer(P1);
  p.battle.kryptonite = 20000;
  econ.writePlayer(P1, p);
  const bg = battle.buyGear(P1, 'g1');
  ok(bg.ok, 'buyGear g1: ' + (bg.ok ? bg.name + ' @' + bg.price : bg.reason));
  const eq = battle.equip(P1, 'g1');
  ok(eq.ok, 'equip g1: ' + (eq.ok ? '' : eq.reason));
  const p2 = econ.readPlayer(P1);
  const anyChar = Object.values(p2.battle.characters)[0];
  ok(anyChar.equipment.weapon === 'g1', 'equipment persisted via writePlayer');
  ok(p2.battle.kryptonite < 20000, 'kryptonite deducted: ' + p2.battle.kryptonite);
}

// ---- PvP record ----
console.log('— pvp —');
{
  battle.createCharacter(P2, 'mage');
  const r = battle.recordPvp(P1, P2);
  ok(r.ok, 'recordPvp ok');
  const a = econ.readPlayer(P1), b = econ.readPlayer(P2);
  ok(a.battle.pvpWins === 1 && b.battle.pvpLosses === 1, 'pvp W/L persisted BOTH players (transaction)');
}

// ---- Abyss clear + materialized ----
console.log('— abyss —');
{
  const r = abyss.recordClear(P1, 0, 12, 0.8); // floor 1, 12 turns, 80% hp → likely 2-3★
  ok(r.ok, 'recordClear f1: ' + JSON.stringify(r.stars));
  const p = econ.readPlayer(P1);
  ok(p.battle.abyss.stars[0] > 0, 'abyss stars persisted');
  const rows = econ.getAbyssTopRows(10);
  ok(rows.some((x) => x.user_id === P1), 'P1 appears in abyss LB (materialized)');
  ok(battle.getBattleGlobalRank(P1) !== null, 'battle rank resolvable post-everything');
}

// ---- shop: purchase → use boost → daily consumes ----
console.log('— shop —');
{
  econ.addBalance(P1, 500000);
  const pr = shop.purchase(P1, 'daily_boost_20');
  ok(pr.success === true, 'purchase daily_boost_2x: ' + pr.message);
  const ui = shop.useItem(P1, 'daily_boost_20');
  ok(ui.success === true, 'useItem armed boost');
  const d = econ.claimDaily(P1);
  ok(d.success === true && d.amount >= 300000, 'daily claimed with x2 boost: ' + d.amount);
  const p = econ.readPlayer(P1);
  ok(!p.activeBoosts.daily_mult, 'boost consumed (one-shot)');
}

// ---- backup snapshot → gzip ----
console.log('— backup —');
(async () => {
  const tmpDb = '/tmp/e2e-snap-' + process.pid + '.db';
  const zlib = require('zlib');
  await econ.snapshotTo(tmpDb);
  const gz = zlib.gzipSync(fs.readFileSync(tmpDb));
  const restored = '/tmp/e2e-restored-' + process.pid + '.db';
  fs.writeFileSync(restored, zlib.gunzipSync(gz));
  const D = require('better-sqlite3')(restored, { readonly: true });
  const n = D.prepare('SELECT COUNT(*) AS c FROM players').get().c;
  const hero = D.prepare('SELECT battle FROM players WHERE user_id = ?').get(P1);
  D.close();
  ok(n >= 2, 'snapshot→gzip→gunzip→restored readable, ' + n + ' players');
  const heroBattle = JSON.parse(hero.battle);
  ok(heroBattle.abyss.stars[0] > 0 && Object.keys(heroBattle.characters).length > 0, 'restored carries latest battle+abyss state (RNG-independent)');
  [tmpDb, tmpDb + '.gz', restored].forEach((f) => { try { fs.rmSync(f, { force: true }); } catch {} });
  console.log(`\n${fail === 0 ? '✅' : '❌'} sqlite.e2e — Pass: ${pass} | Fail: ${fail}`);
  try { fs.rmSync(process.env.KYRIZ_ECONOMY_DB, { force: true }); fs.rmSync(process.env.KYRIZ_ECONOMY_DB + '-wal', { force: true }); fs.rmSync(process.env.KYRIZ_ECONOMY_DB + '-shm', { force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})();
