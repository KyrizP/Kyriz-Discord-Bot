'use strict';
// battleManager apply-function tests (pure — mock data, no IO). Run: node test/battleManager.test.js
const M = require('../utils/battleManager');
let pass = 0, fail = 0;
const ok = (c, msg) => { c ? pass++ : (fail++, console.log('  ❌ ' + msg)); };

// save/restore SUPERADMIN_ID for the superadmin-free-entry test
const _savedSup = process.env.SUPERADMIN_ID;

// ---- ensureBattleData ----
const b = M.ensureBattleData({});
ok(b.kryptonite === 0 && b.charLevel === 1 && b.charClass === null, 'defaults correct');
ok(b.equipment.weapon === null && b.equipment.accessory === null, '5 equip slots null');
ok(Object.keys(b.bag).length === 0 && b.bestDepth === 0, 'bag empty, bestDepth 0');
const u = { battle: { kryptonite: 5, charLevel: 3, charClass: 'mage', equipment: {}, bag: {}, charExp: 0, charExpNeeded: 100, bestDepth: 7 } };
ok(M.ensureBattleData(u) === u.battle, 'idempotent');

// ---- createCharacter + charExp ----
let d = { u1: {} };
ok(M.applyCreateCharacter(d, 'u1', 'warrior').ok && d.u1.battle.charClass === 'warrior', 'create warrior');
ok(!M.applyCreateCharacter(d, 'u1', 'mage').ok, 'no double-create');
ok(!M.applyCreateCharacter({ u2: {} }, 'u2', 'ninja').ok, 'reject invalid class');
d.u1.battle.charExpNeeded = 100;
let lv = M.applyGainCharExp(d, 'u1', 250);
ok(d.u1.battle.charLevel >= 2 && lv.leveledUp, 'exp grants level up');
ok(!M.applyGainCharExp({ u3: {} }, 'u3', 500).leveledUp, 'no level up without class');

// ---- delveStart (entry fee, superadmin free) ----
let dA = { u1: { balance: 50000 } };
M.applyCreateCharacter(dA, 'u1', 'warrior');
let sA = M.applyDelveStart(dA, 'u1');
ok(sA.ok && sA.paid && dA.u1.balance === 35000, 'entry deducts 15k');
ok(!M.applyDelveStart({ u1: { balance: 100 } }, 'u1').ok, 'reject insufficient (note: no class here anyway)');
ok(M.applyDelveStart({ u2: { balance: 999999 } }, 'u2').reason === 'no_character', 'no character -> reason');
process.env.SUPERADMIN_ID = 'SUP_1';
let dSup = { SUP_1: { balance: 999 } };
M.applyCreateCharacter(dSup, 'SUP_1', 'mage');
let sSup = M.applyDelveStart(dSup, 'SUP_1');
ok(sSup.ok && sSup.paid === false && dSup.SUP_1.balance === 999, 'superadmin entry free, balance untouched');
process.env.SUPERADMIN_ID = _savedSup;

// ---- extract banks run bag + exp, bestDepth=floor-1 ----
let dB = { u1: { balance: 1000 } };
M.applyCreateCharacter(dB, 'u1', 'warrior');
let ex = M.applyExtract(dB, 'u1', { floor: 6, bag: { d1: 3, d2: 1 }, expAccum: 50 });
ok(ex.banked === 4 && dB.u1.battle.bag.d1 === 3 && dB.u1.battle.bag.d2 === 1, 'extract banks bag');
ok(dB.u1.battle.bestDepth === 5, 'bestDepth = floor-1 on extract');
ok(dB.u1.battle.charExp === 50, 'extract banks accumulated char exp');

// ---- die discards run bag, keeps exp, bestDepth=floor ----
let dC = { u1: { balance: 1000 } };
M.applyCreateCharacter(dC, 'u1', 'warrior');
let di = M.applyDie(dC, 'u1', { floor: 9, bag: { d1: 5 }, expAccum: 30 });
ok(di.lost === 5 && Object.keys(dC.u1.battle.bag).length === 0, 'die discards bag');
ok(dC.u1.battle.bestDepth === 0, 'die does NOT save checkpoint (extract only)');
ok(dC.u1.battle.charExp === 0, 'die LOSES char exp (consistent with drops)');

// ---- sell drops: id / qty / all ----
let dD = { u1: { balance: 0 } };
M.applyCreateCharacter(dD, 'u1', 'warrior');
dD.u1.battle.bag = { d1: 5, d2: 2 };
let sl = M.applySell(dD, 'u1', 'd1', 2);
ok(sl.sold === 2 && dD.u1.battle.bag.d1 === 3 && dD.u1.battle.kryptonite === 6, 'sell 2x d1 (value 3) = 6 kry');
let slAll = M.applySell(dD, 'u1', 'all');
ok(slAll.sold === 5 && Object.keys(dD.u1.battle.bag).length === 0, 'sell all empties drops (d1:3+d2:2=5)');
ok(!M.applySell(dD, 'u1', 'd9').ok === false || M.applySell(dD, 'u1', 'd9').reason, 'non-drop id rejected gracefully');
// gear not sellable via ky sell (must use sellgear)
dD.u1.battle.bag = { g1: 1 };
let bad = M.applySell(dD, 'u1', 'g1');
ok(bad.sold === 0 && bad.reason, 'gear rejected by sell (use sellgear)');

// ---- equip + swap + unequip ----
let dE = { u1: { balance: 0 } };
M.applyCreateCharacter(dE, 'u1', 'warrior');
dE.u1.battle.bag = { g1: 1 };
let eq = M.applyEquip(dE, 'u1', 'g1');
ok(eq.ok && eq.slot === 'weapon' && dE.u1.battle.equipment.weapon === 'g1' && !dE.u1.battle.bag.g1, 'equip moves bag->slot');
dE.u1.battle.bag.g2 = 1;
let eq2 = M.applyEquip(dE, 'u1', 'g2');
ok(dE.u1.battle.equipment.weapon === 'g2' && dE.u1.battle.bag.g1 === 1, 'equip swaps old to bag');
let ueq = M.applyUnequip(dE, 'u1', 'weapon');
ok(ueq.ok && dE.u1.battle.equipment.weapon === null && dE.u1.battle.bag.g2 === 1, 'unequip moves slot->bag');

// ---- sellgear 40% (unequipped only) ----
let dF = { u1: { balance: 0 } };
M.applyCreateCharacter(dF, 'u1', 'warrior');
dF.u1.battle.bag = { g1: 1 };
let sg = M.applySellGear(dF, 'u1', 'g1');
ok(sg.ok && sg.kryptonite === 40 && !dF.u1.battle.bag.g1, 'sellgear g1 (price 100) = 40 kry');
dF.u1.battle.equipment.armor = 'g3';
dF.u1.battle.bag = { g3: 2 }; // 2 spares + 1 equipped
let sgEq = M.applySellGear(dF, 'u1', 'g3', 1); // sell 1 SPARE — should work (no unequip needed)
ok(sgEq.ok && sgEq.sold === 1 && sgEq.kryptonite === 48 && dF.u1.battle.bag.g3 === 1, 'sell spare g3 while one is equipped (no unequip needed)');
ok(dF.u1.battle.equipment.armor === 'g3', 'equipped g3 copy untouched when selling spares');

// ---- buygear ----
let dG = { u1: { balance: 0 } };
M.ensureBattleData(dG.u1);
dG.u1.battle.kryptonite = 150;
let bg = M.applyBuyGear(dG, 'u1', 'g1');
ok(bg.ok && bg.kryptonite === 50 && dG.u1.battle.bag.g1 === 1, 'buy g1 (price 100) -> kry 50, bag.g1=1');
let bg2 = M.applyBuyGear(dG, 'u1', 'g2'); // g2 price 250, only 50 left
ok(!bg2.ok && dG.u1.battle.kryptonite === 50, 'insufficient kryptonite rejected, balance unchanged (no partial)');
ok(!M.applyBuyGear(dG, 'u1', 'zzz').ok, 'invalid gear code rejected');
ok(!M.applyBuyGear({}, 'nobody', 'g1').ok, 'unregistered rejected (no throw)');

// ---- sellgear multi-copy (bug: was selling all for one price) ----
let dH = { u1: { balance: 0 } };
M.applyCreateCharacter(dH, 'u1', 'warrior');
dH.u1.battle.bag = { g1: 2 };
let sg1 = M.applySellGear(dH, 'u1', 'g1'); // default qty 1
ok(sg1.ok && sg1.sold === 1 && sg1.kryptonite === 40 && dH.u1.battle.bag.g1 === 1, 'sellgear g1 default = sell 1 (40), keep 1');
let sg2 = M.applySellGear(dH, 'u1', 'g1', 2); // only 1 left -> sells 1
ok(sg2.ok && sg2.sold === 1 && sg2.kryptonite === 40, 'sellgear qty 2 but only 1 left = sell 1 (no over-sell)');
dH.u1.battle.bag = { g1: 3 };
let sgAll = M.applySellGear(dH, 'u1', 'g1', 'all');
ok(sgAll.ok && sgAll.sold === 3 && sgAll.kryptonite === 120 && !dH.u1.battle.bag.g1, 'sellgear g1 all (x3) = 120 (3x sellback, NO underpayment)');

// ---- summary ----
console.log('\n' + (fail === 0 ? '✅ SEMUA TEST LULUS' : '❌ ADA TEST GAGAL'));
console.log('Pass: ' + pass + ' | Fail: ' + fail);
process.exit(fail === 0 ? 0 : 1);
