'use strict';
// Battle engine unit tests + balance sim gate. Run: node test/battleEngine.test.js
const E = require('../utils/battleEngine');
const { CLASSES } = require('../utils/battleConfig');
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : (fail++, console.log('  ❌ ' + m)); };

// ---------- computeStats ----------
let s = E.computeStats(1, 'warrior', {});
ok(s.hp === 100 && s.atk === 12 && s.spd === 6, 'warrior lvl1 base exact');
let s10 = E.computeStats(10, 'warrior', {});
ok(s10.hp === 280, 'warrior lvl10 hp = 280 (100 + 20*9)');
ok(s10.atk === 35, 'warrior lvl10 atk = 35 (rounded from 34.5)');
ok(s10.hp > E.computeStats(10, 'mage', {}).hp, 'warrior tankier than mage same lvl');
let withGear = E.computeStats(1, 'warrior', { weapon: 'g1' });
ok(withGear.atk === 15, 'gear adds atk: 12 + g1(3) = 15');
ok(E.computeStats(1, 'mage', {}).matk === 14, 'mage lvl1 matk = 14');

// ---------- damage formula ----------
ok(E.physicalDamage(40, 20, 1.0) === 30, 'phys 40*1 - 20*0.5 = 30');
ok(E.physicalDamage(10, 100, 1.0) === 1, 'high def floored to 1 chip');
ok(E.magicDamage(30, 10, 1.7) === Math.round(30 * 1.7 - 5), 'magic mult 1.7');
ok(E.physicalDamage(50, 0, 2.5) === 125, 'no def = full dmg');
ok(E.physicalDamage(5, 5, 1.0) === Math.max(1, Math.round(5 - 2.5)), 'small values floor-safe');

// ---------- generateEnemy ----------
const e1 = E.generateEnemy(1);
ok(e1.hp === 40 && e1.atk === 8, 'enemy floor1 base');
const e20 = E.generateEnemy(20);
ok(e20.hp > e1.hp * 3 && e20.atk > e1.atk * 3, 'enemy scales hard by floor 20');
ok(e20.rotation.length === 1 && ['physical', 'magic'].includes(e20.rotation[0].type), 'enemy has rotation');

// ---------- resolveFight ----------
let p15 = E.computeStats(15, 'warrior', {});
let r = E.resolveFight({ ...p15 }, CLASSES.warrior.rotation, E.generateEnemy(1));
ok(r.winner === 'player', 'strong player beats weak enemy');
ok(r.enemyHpLeft === 0, 'enemy hp depleted');
let r2 = E.resolveFight(E.computeStats(1, 'mage', {}), CLASSES.mage.rotation, E.generateEnemy(60));
ok(r2.winner === 'enemy', 'weak mage loses to floor60 enemy');
ok(typeof E.resolveFight(E.computeStats(20, 'warrior', {}), CLASSES.warrior.rotation, E.generateEnemy(5)).rounds === 'number', 'resolve returns rounds');

// ---------- rollDrop ----------
let d = E.rollDrop(5);
ok(['common', 'uncommon', 'rare', 'epic', 'legendary', 'divine'].includes(d.rarity), 'valid rarity');
ok(d.value > 0 && d.id, 'drop has value + id');
let divineLow = 0;
for (let i = 0; i < 5000; i++) if (E.rollDrop(10).rarity === 'divine') divineLow++;
ok(divineLow === 0, 'no divine below floor 20');
function rarePlus(floor, n) { let c = 0; for (let i = 0; i < n; i++) { const rr = E.rollDrop(floor).rarity; if (['rare', 'epic', 'legendary', 'divine'].includes(rr)) c++; } return c; }
ok(rarePlus(40, 3000) > rarePlus(5, 3000), 'deeper floor -> more rare+ drops');

// ---------- merchantPrice ----------
ok(E.merchantPrice({ value: 3 }) === 3, 'flat = item value');
ok(E.merchantPrice({ value: 400 }) > E.merchantPrice({ value: 3 }) * 50, 'divine >> common');

// ==================== BALANCE SIM (THE GATE) ====================
function avgKry(level, cls, n) {
  let krySum = 0, dfSum = 0;
  for (let i = 0; i < n; i++) {
    const rr = E.simulateDelve(level, cls, {}, { maxFloors: 100 });
    krySum += rr.kryptonitePotential;
    dfSum += rr.deathFloor;
  }
  return { kry: krySum / n, df: dfSum / n };
}

const weak = avgKry(1, 'warrior', 2000);
const strong = avgKry(20, 'warrior', 2000);
ok(strong.df > weak.df * 2, 'lvl20 reaches ~2x+ depth of lvl1 (' + weak.df.toFixed(1) + ' -> ' + strong.df.toFixed(1) + ')');
ok(strong.kry > weak.kry, 'lvl20 earns more Kryptonite');
ok(strong.kry < 4000, 'lvl20 avg Kryptonite/run bounded (< 4000), got ' + strong.kry.toFixed(1));

let divineCount = 0, totalDrops = 0;
for (let i = 0; i < 2000; i++) {
  const rr = E.simulateDelve(20, 'mage', {}, { maxFloors: 100 });
  divineCount += rr.dropsByRarity.divine || 0;
  for (const k of Object.keys(rr.dropsByRarity)) totalDrops += rr.dropsByRarity[k];
}
ok(totalDrops > 0, 'drops actually happen');
const divineRate = divineCount / totalDrops;
ok(divineRate < 0.005, 'divine drop rate < 0.5%, got ' + divineRate.toFixed(4));

let maxReached = 0;
for (let i = 0; i < 500; i++) maxReached = Math.max(maxReached, E.simulateDelve(15, 'warrior', {}).deathFloor);
ok(maxReached <= 100, 'no run exceeds maxFloors (terminates)');

// ---- summary ----
console.log('\n' + (fail === 0 ? '✅ SEMUA TEST LULUS' : '❌ ADA TEST GAGAL'));
console.log('Pass: ' + pass + ' | Fail: ' + fail);
process.exit(fail === 0 ? 0 : 1);
