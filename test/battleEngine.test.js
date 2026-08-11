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
ok(s10.hp === 280, 'warrior lvl10 hp = 280 (100 + growth 20*9)');
ok(s10.atk === 30, 'warrior lvl10 atk = 30 (12 + growth 2.0*9)');
ok(s10.hp > E.computeStats(10, 'mage', {}).hp, 'warrior tankier than mage same lvl');
let withGear = E.computeStats(1, 'warrior', { weapon: 'g1' });
ok(withGear.atk === 15, 'gear adds atk: 12 + g1(3) = 15');
ok(E.computeStats(1, 'mage', {}).matk === 14, 'mage lvl1 matk = 14');

// ---------- computeStats with uniques + passives ----------
const uniq = {
  ky1111: { id: 'ky1111', rarity: 'legendary', slot: 'weapon', stats: { atk: 25 },
            passives: [{ id: 'berserker', emoji: '🗡️', value: 11, unit: '%' }] },
  ky2222: { id: 'ky2222', rarity: 'divine', slot: 'boots', stats: { spd: 30 },
            passives: [{ id: 'swift', emoji: '💨', value: 10, unit: '' }, { id: 'precision', emoji: '🎯', value: 14, unit: '%' }] },
};
let su = E.computeStats(10, 'warrior', { weapon: 'ky1111', boots: 'ky2222' }, uniq);
ok(su.atk === 55, 'unique weapon atk applied: 30 + 25 = 55');
let base10sp = E.computeStats(10, 'warrior', {});
ok(su.spd === base10sp.spd + 30 + 10, 'swift passive adds flat spd on top of boots');

let psum = E.getPassives({ weapon: 'ky1111', boots: 'ky2222' }, uniq);
ok(psum.berserker === 11 && psum.swift === 10 && psum.precision === 14, 'getPassives aggregates across uniques');

ok(E.getCritChance({ precision: 14 }) === 0.14, 'crit chance = precision/100');
ok(E.getCritChance({ precision: 60 }) === 0.5, 'crit capped at 0.5');
ok(E.getCritChance({}) === 0, 'no precision = no crit');

// backward compat: no uniqueItems arg still works (existing v1 gear)
let sOld = E.computeStats(1, 'warrior', { weapon: 'g1' });
ok(sOld.atk === 15, 'v1 g-code gear still works without uniqueItems (12 + g1(3) = 15)');

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
ok(e20.rotation.length === 2 && e20.rotation[0].type === 'physical' && e20.rotation[1].type === 'magic', 'enemy has mixed rotation (physical + magic)');
ok(E.generateEnemy(1).critChance === 0, 'no enemy crit below floor 45');
ok(E.generateEnemy(44).critChance === 0, 'floor 44 still safe (no crit)');
ok(E.generateEnemy(45).critChance === 0.2, 'enemy crit 20% from floor 45');
ok(E.generateEnemy(80).critChance === 0.2, 'enemy crit flat 20% at floor 80');

// ---------- resolveFight (skills + passives + crit) ----------
let p15 = E.computeStats(15, 'warrior', {});
let r = E.resolveFight({ stats: p15, hp: p15.hp, skills: CLASSES.warrior.skills, passives: {} }, E.generateEnemy(1));
ok(r.winner === 'player', 'strong player beats weak enemy');
ok(r.enemyHpLeft === 0, 'enemy hp depleted');
let mageLvl1 = E.computeStats(1, 'mage', {});
let r2 = E.resolveFight({ stats: mageLvl1, hp: mageLvl1.hp, skills: CLASSES.mage.skills, passives: {} }, E.generateEnemy(60));
ok(r2.winner === 'enemy', 'weak mage loses to floor60 enemy');
let p20 = E.computeStats(20, 'warrior', {});
ok(typeof E.resolveFight({ stats: p20, hp: p20.hp, skills: CLASSES.warrior.skills, passives: {} }, E.generateEnemy(5)).rounds === 'number', 'resolve returns rounds');

// ---------- rollDrop (zone-based) ----------
let d = E.rollDrop(5);
ok(['common', 'uncommon', 'rare', 'epic', 'legendary', 'divine'].includes(d.rarity), 'valid rarity');
ok(d.value > 0 && d.id, 'drop has value + id');
// Zone 1 (floors 1-30): no divine possible (weight 0)
let divineLow = 0;
for (let i = 0; i < 5000; i++) if (E.rollDrop(10).rarity === 'divine') divineLow++;
ok(divineLow === 0, 'no divine in zone 1 (floors 1-30)');
// Zone 4 (floor 95): no common (weight 0), uncommon appears
let commonHigh = 0, uncommonHigh = 0;
for (let i = 0; i < 3000; i++) {
  const r = E.rollDrop(95).rarity;
  if (r === 'common') commonHigh++;
  if (r === 'uncommon') uncommonHigh++;
}
ok(commonHigh === 0, 'no common in zone 4 (floor 95)');
ok(uncommonHigh > 0, 'uncommon present in zone 4');
// Deeper floor -> more rare+ on average
function rarePlus(floor, n) { let c = 0; for (let i = 0; i < n; i++) { const rr = E.rollDrop(floor).rarity; if (['rare', 'epic', 'legendary', 'divine'].includes(rr)) c++; } return c; }
ok(rarePlus(70, 3000) > rarePlus(10, 3000), 'deeper floor -> more rare+ drops');
// Zone boundaries resolve
ok(E.rollDrop(30).rarity !== undefined && E.rollDrop(31).rarity !== undefined, 'zone boundaries resolve');

// ---------- merchantPrice ----------
ok(E.merchantPrice({ value: 3 }) === 3, 'flat = item value');
ok(E.merchantPrice({ value: 400 }) > E.merchantPrice({ value: 3 }) * 50, 'divine >> common');

// ==================== BALANCE SIM (THE GATE) ====================
function avgKry(level, cls, n) {
  let krySum = 0, dfSum = 0;
  for (let i = 0; i < n; i++) {
    const rr = E.simulateDelve(level, cls, {}, {}, { maxFloors: 100 });
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
  const rr = E.simulateDelve(20, 'mage', {}, {}, { maxFloors: 100 });
  divineCount += rr.dropsByRarity.divine || 0;
  for (const k of Object.keys(rr.dropsByRarity)) totalDrops += rr.dropsByRarity[k];
}
ok(totalDrops > 0, 'drops actually happen');
const divineRate = divineCount / totalDrops;
ok(divineRate < 0.005, 'divine drop rate < 0.5%, got ' + divineRate.toFixed(4));

let maxReached = 0;
for (let i = 0; i < 500; i++) maxReached = Math.max(maxReached, E.simulateDelve(15, 'warrior', {}).deathFloor);
ok(maxReached <= 100, 'no run exceeds maxFloors (terminates)');

// ---- War Cry pierces 50% DEF (regression: physical pierce was a no-op) ----
// Warrior atk 150 vs enemy def 800: without pierce, War Cry = max(1, 375-400)=1 chip (can't kill).
// With pierce, War Cry = physicalDamage(150, 400, 2.5)=175 → kills in a few cycles. Player must WIN.
{
  const wcPlayer = { stats: { hp: 99999, atk: 150, matk: 0, def: 99999, mdef: 99999, spd: 30 }, hp: 99999, skills: CLASSES.warrior.skills, passives: {} };
  const tankEnemy = { hp: 500, atk: 1, matk: 1, def: 800, mdef: 99999, spd: 1, rotation: [{ mult: 1, type: 'physical' }], critChance: 0 };
  const r = E.resolveFight(wcPlayer, tankEnemy);
  ok(r.winner === 'player' && r.enemyHpLeft === 0, 'War Cry pierces high DEF (kills def-800 enemy; impossible if pierce broken)');
}

// ---- summary ----
console.log('\n' + (fail === 0 ? '✅ SEMUA TEST LULUS' : '❌ ADA TEST GAGAL'));
console.log('Pass: ' + pass + ' | Fail: ' + fail);
process.exit(fail === 0 ? 0 : 1);
