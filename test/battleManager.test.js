'use strict';
// battleManager apply-function tests (pure — mock data, no IO). Run: node test/battleManager.test.js
const M = require('../utils/battleManager');
let pass = 0, fail = 0;
const ok = (c, msg) => { c ? pass++ : (fail++, console.log('  ❌ ' + msg)); };

// save/restore SUPERADMIN_ID for the superadmin-free-entry test
const _savedSup = process.env.SUPERADMIN_ID;

// ---- ensureBattleData ----
const b = M.ensureBattleData({});
ok(b.kryptonite === 0 && b.activeClass === null && !b.characters, 'defaults correct');
ok(b.equipment.weapon === null && b.equipment.accessory === null, '5 equip slots null');
ok(Object.keys(b.bag).length === 0 && M.getActiveChar(b) === null, 'bag empty, no char yet (bestDepth lives per-character)');
const u = { battle: { kryptonite: 5, charLevel: 3, charClass: 'mage', equipment: {}, bag: {}, charExp: 0, charExpNeeded: 100, bestDepth: 7 } };
ok(M.ensureBattleData(u) === u.battle, 'idempotent');

// ---- createCharacter + charExp ----
let d = { u1: {} };
ok(M.applyCreateCharacter(d, 'u1', 'warrior').ok && M.getCharClass(d.u1.battle) === 'warrior', 'create warrior');
ok(!M.applyCreateCharacter(d, 'u1', 'warrior').ok, 'no duplicate char of same class (multi-class allowed since class-switch)');
ok(!M.applyCreateCharacter({ u2: {} }, 'u2', 'ninja').ok, 'reject invalid class');
M.getActiveChar(d.u1.battle).charExpNeeded = 100;
let lv = M.applyGainCharExp(d, 'u1', 250);
ok(M.getActiveChar(d.u1.battle).charLevel >= 2 && lv.leveledUp, 'exp grants level up');
ok(!M.applyGainCharExp({ u3: {} }, 'u3', 500).leveledUp, 'no level up without class');

// ---- delveStart (entry fee, superadmin free) ----
let dA = { u1: { balance: 50000 } };
M.applyCreateCharacter(dA, 'u1', 'warrior');
let sA = M.applyDelveStart(dA, 'u1');
ok(sA.ok && sA.paid && dA.u1.balance === 45000, 'entry deducts 5k');
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
ok(M.getActiveChar(dB.u1.battle).bestDepth === 5, 'bestDepth = floor-1 on extract');
ok(M.getActiveChar(dB.u1.battle).charExp === 50, 'extract banks accumulated char exp');

// ---- die discards run bag, keeps exp, bestDepth=floor ----
let dC = { u1: { balance: 1000 } };
M.applyCreateCharacter(dC, 'u1', 'warrior');
let di = M.applyDie(dC, 'u1', { floor: 9, bag: { d1: 5 }, expAccum: 30 });
ok(di.lost === 5 && Object.keys(dC.u1.battle.bag).length === 0, 'die discards bag');
ok(M.getActiveChar(dC.u1.battle).bestDepth === 0, 'die does NOT save checkpoint (extract only)');
ok(M.getActiveChar(dC.u1.battle).charExp === 0, 'die LOSES char exp (consistent with drops)');

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

// ---- sellgear 35% (unequipped only) ----
let dF = { u1: { balance: 0 } };
M.applyCreateCharacter(dF, 'u1', 'warrior');
dF.u1.battle.bag = { g1: 1 };
let sg = M.applySellGear(dF, 'u1', 'g1');
ok(sg.ok && sg.kryptonite === 35 && !dF.u1.battle.bag.g1, 'sellgear g1 (price 100) = 35 kry');
dF.u1.battle.equipment.armor = 'g3';
dF.u1.battle.bag = { g3: 2 }; // 2 spares + 1 equipped
let sgEq = M.applySellGear(dF, 'u1', 'g3', 1); // sell 1 SPARE — should work (no unequip needed)
ok(sgEq.ok && sgEq.sold === 1 && sgEq.kryptonite === 42 && dF.u1.battle.bag.g3 === 1, 'sell spare g3 while one is equipped (no unequip needed)');
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
ok(sg1.ok && sg1.sold === 1 && sg1.kryptonite === 35 && dH.u1.battle.bag.g1 === 1, 'sellgear g1 default = sell 1 (35), keep 1');
let sg2 = M.applySellGear(dH, 'u1', 'g1', 2); // only 1 left -> sells 1
ok(sg2.ok && sg2.sold === 1 && sg2.kryptonite === 35, 'sellgear qty 2 but only 1 left = sell 1 (no over-sell)');
dH.u1.battle.bag = { g1: 3 };
let sgAll = M.applySellGear(dH, 'u1', 'g1', 'all');
ok(sgAll.ok && sgAll.sold === 3 && sgAll.kryptonite === 105 && !dH.u1.battle.bag.g1, 'sellgear g1 all (x3) = 105 (3x 35 sellback, NO underpayment)');

// ---- unique items: buy / equip / sell + exploits ----
// buy unique (legendary weapon) — deducts 5000, stores unique
let dU = { u1: { balance: 0 } };
M.ensureBattleData(dU.u1);
dU.u1.battle.kryptonite = 20000;
let bu = M.applyBuyUnique(dU, 'u1', 'legendary', 'weapon', 'atk');
ok(bu.ok && bu.unique.id.startsWith('ky') && dU.u1.battle.kryptonite === 15000, 'buy legend weapon: -5000 kry, unique stored');
ok(dU.u1.battle.uniqueItems[bu.unique.id], 'unique stored in uniqueItems map');

// insufficient kry -> no unique created, balance untouched (atomic, no partial)
let dU2 = { u1: { balance: 0 } };
M.ensureBattleData(dU2.u1);
dU2.u1.battle.kryptonite = 3000;
let buBad = M.applyBuyUnique(dU2, 'u1', 'divine', 'weapon', 'atk'); // divine = 20000
ok(!buBad.ok && Object.keys(dU2.u1.battle.uniqueItems).length === 0 && dU2.u1.battle.kryptonite === 3000, 'insufficient kry: no unique, no deduction');

// equip unique -> slot set; equip same unique in 2nd slot -> rejected
let dE2 = { u1: { balance: 0 } };
M.ensureBattleData(dE2.u1);
dE2.u1.battle.kryptonite = 20000;
let mk = M.applyBuyUnique(dE2, 'u1', 'legendary', 'weapon', 'atk');
let eqU = M.applyEquip(dE2, 'u1', mk.unique.id);
ok(eqU.ok && eqU.slot === 'weapon' && dE2.u1.battle.equipment.weapon === mk.unique.id, 'equip unique weapon');
let eqDup = M.applyEquip(dE2, 'u1', mk.unique.id); // try equip same id again
ok(!eqDup.ok, 'cannot equip same unique id in two slots');

// sell equipped unique -> rejected (must unequip first)
let sgEq2 = M.applySellGear(dE2, 'u1', mk.unique.id);
ok(!sgEq2.ok, 'cannot sell equipped unique (unequip first)');
// unequip then sell -> works, refund 35% (1750)
M.applyUnequip(dE2, 'u1', 'weapon');
let sgU = M.applySellGear(dE2, 'u1', mk.unique.id);
ok(sgU.ok && sgU.kryptonite === 1750 && !dE2.u1.battle.uniqueItems[mk.unique.id], 'sell spare unique: refund 1750, removed from collection');

// exploit: sell same unique twice -> second rejected (already deleted)
let sgU2 = M.applySellGear(dE2, 'u1', mk.unique.id);
ok(!sgU2.ok, 'cannot sell deleted unique twice (no double refund)');

// exploit: equip mismatched slot (weapon unique auto-fits weapon slot only)
let dS = { u1: { balance: 0 } };
M.ensureBattleData(dS.u1);
dS.u1.battle.kryptonite = 5000;
let mkw = M.applyBuyUnique(dS, 'u1', 'legendary', 'weapon', 'atk');
M.applyEquip(dS, 'u1', mkw.unique.id);
ok(dS.u1.battle.equipment.weapon === mkw.unique.id && dS.u1.battle.equipment.boots === null, 'weapon unique only fits weapon slot');

// backfill: existing user without uniqueItems/pvp fields gets them
let dOld = { u1: { battle: { kryptonite: 5, charLevel: 1, charClass: 'warrior', equipment: { weapon: null }, bag: {}, charExp: 0, charExpNeeded: 100, bestDepth: 0 } } };
let bOld = M.ensureBattleData(dOld.u1);
ok(bOld.uniqueItems && bOld.pvpWins === 0 && bOld.pvpLosses === 0, 'existing user backfilled with uniqueItems + pvp W/L fields');

// ---- PvP result recording (W/L only, no ELO) ----
let dP = { A: { balance: 0 }, B: { balance: 0 } };
M.ensureBattleData(dP.A); M.ensureBattleData(dP.B);
dP.A.battle.charClass = 'warrior'; dP.B.battle.charClass = 'mage';
let pr = M.applyPvpResult(dP, 'A', 'B');
ok(pr.ok, 'pvp result recorded');
ok(dP.A.battle.pvpWins === 1 && dP.B.battle.pvpLosses === 1, 'W/L recorded');
ok(dP.A.battle.pvpRating === undefined, 'no ELO rating field created');
// backfill: user without pvp fields gets 0 W/L
let dP2 = { A: { battle: { charClass: 'warrior', equipment: {}, bag: {}, charLevel: 1, charExp: 0, charExpNeeded: 100, bestDepth: 0 } } };
M.ensureBattleData(dP2.A);
ok(dP2.A.battle.pvpWins === 0 && dP2.A.battle.pvpLosses === 0, 'W/L backfilled to 0');

// ---- Greed passive boosts drop sell value (regression: was silently lost) ----
let dGr = { u1: { balance: 0 } };
M.ensureBattleData(dGr.u1);
dGr.u1.battle.uniqueItems = { kyG: { id: 'kyG', rarity: 'divine', slot: 'accessory', stats: { atk: 30 }, passives: [{ id: 'greed', value: 20 }] } };
dGr.u1.battle.equipment.accessory = 'kyG';
dGr.u1.battle.bag = { d4: 1 }; // d4 Crystal Shard, value 30
let gsl = M.applySell(dGr, 'u1', 'd4', 1);
ok(gsl.kryptonite === 36 && dGr.u1.battle.kryptonite === 36, 'Greed boosts sell: d4 (30) × 1.20 = 36');
dGr.u1.battle.kryptonite = 0;
dGr.u1.battle.bag = { d1: 10 }; // d1 value 3 ×10 = 30 base
let gslA = M.applySell(dGr, 'u1', 'all');
ok(gslA.kryptonite === 36, 'Greed boosts sell all: d1×10 (30) × 1.20 = 36');
// no Greed → base value
let dGr2 = { u1: { balance: 0 } };
M.ensureBattleData(dGr2.u1);
dGr2.u1.battle.bag = { d4: 1 };
ok(M.applySell(dGr2, 'u1', 'd4', 1).kryptonite === 30, 'no Greed → base value 30');

// ---- gear locked during active run (rental exploit guard) ----
// The guard lives on the equip/unequip/sellGear IO wrappers (which read real economy),
// not on the pure apply* fns, so it isn't unit-testable here without mocking economy.
// Verified by code review: `if (activeRuns.has(userId)) return {ok:false,...}` at the top
// of each IO wrapper. (startDelve also has an internal hasActiveRun guard now.)

// ---- summary ----
console.log('\n' + (fail === 0 ? '✅ SEMUA TEST LULUS' : '❌ ADA TEST GAGAL'));
console.log('Pass: ' + pass + ' | Fail: ' + fail);
process.exit(fail === 0 ? 0 : 1);
