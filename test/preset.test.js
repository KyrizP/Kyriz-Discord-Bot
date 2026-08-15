'use strict';
const BM = require('../utils/battleManager');
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : (fail++, console.log('  ❌ ' + m)); };
const mkData = (uid) => ({ [uid]: { username: 'T', balance: 100000, level: 1, xp: 0, xpNeeded: 400, totalWins: 0, totalLosses: 0, totalEarned: 0, totalLost: 0, lastDaily: null, registeredAt: '2026-01-01T00:00:00Z' } });

const d1 = mkData('U1'); BM.ensureBattleData(d1.U1); BM.applyCreateCharacter(d1, 'U1', 'warrior');
const b1 = BM.ensureBattleData(d1.U1);
b1.uniqueItems.kyw1 = { id: 'kyw1', rarity: 'divine', slot: 'weapon', stats: { atk: 48 }, passives: [] };
BM.getActiveChar(b1).equipment.weapon = 'kyw1';
BM.getActiveChar(b1).equipment.head = 'g21';
ok(BM.applyPresetSave(d1, 'U1', 1).ok, 'save slot 1 ok');
ok(b1.presets[0].slots.weapon === 'kyw1' && b1.presets[0].slots.head === 'g21', 'snapshot 5 slot');
ok(b1.presets[0].slots.armor === null, 'P6: slot kosong ikut');
ok(BM.applyPresetSave(d1, 'U1', 2).ok, 'save slot 2 ok (2 gratis)');
ok(!BM.applyPresetSave(d1, 'U1', 3).ok, 'P3: slot 3 ditolak — cuma punya 2');
ok(!BM.applyPresetSave(d1, 'U1', 0).ok && !BM.applyPresetSave(d1, 'U1', -1).ok, 'nomor invalid ditolak');
// P4: timpa
BM.getActiveChar(b1).equipment.weapon = null;
ok(BM.applyPresetSave(d1, 'U1', 1).ok, 'timpa slot 1 ok');
ok(b1.presets[0].slots.weapon === null, 'P4: isi baru menggantikan lama');
// delete + kapasitas tidak berubah (slot tetap milik user, isinya saja kosong)
ok(BM.applyPresetDelete(d1, 'U1', 2).ok && b1.presets[1] === null, 'delete slot 2 -> null');
ok(!BM.applyPresetDelete(d1, 'U1', 5).ok, 'delete slot di luar kapasitas ditolak');

// ---------- T2: load — atomic validate-all-then-swap ----------
const d2 = mkData('U2'); BM.ensureBattleData(d2.U2); BM.applyCreateCharacter(d2, 'U2', 'warrior');
const b2 = BM.ensureBattleData(d2.U2);
b2.uniqueItems.kyw1 = { id: 'kyw1', rarity: 'divine', slot: 'weapon', stats: { atk: 48 }, passives: [] };
b2.bag.g21 = 1; b2.bag.g13 = 1;
BM.getActiveChar(b2).equipment.weapon = 'kyw1';
BM.applyPresetSave(d2, 'U2', 1);
BM.getActiveChar(b2).equipment.weapon = null;
BM.getActiveChar(b2).equipment.head = 'g21'; b2.bag.g21 -= 1;
ok(BM.applyPresetLoad(d2, 'U2', 1).ok, 'load slot 1 ok');
const c2 = BM.getActiveChar(b2);
ok(c2.equipment.weapon === 'kyw1', 'weapon terpasang');
ok(c2.equipment.head === null, 'P6: head kosong di snapshot = kosong setelah load');
ok(b2.bag.g21 === 1, 'gear lama kembali ke bag');
BM.getActiveChar(b2).equipment.boots = 'g13'; b2.bag.g13 -= 1;
BM.applyPresetSave(d2, 'U2', 2);
BM.getActiveChar(b2).equipment.boots = null; b2.bag.g13 += 1; // unequip returns g-item to bag (T2 fix: brief omitted this, leaving g13 unowned -> its own ownership rule would reject)
ok(BM.applyPresetLoad(d2, 'U2', 2).ok && BM.getActiveChar(b2).equipment.boots === 'g13', 'load g-item dari bag');
ok(!b2.bag.g13, 'g-item habis dari bag saat dipasang');
// P5: slot kosong -> info, tak tersentuh
BM.applyPresetDelete(d2, 'U2', 1);
const before = JSON.stringify(BM.getActiveChar(b2).equipment);
const e1 = BM.applyPresetLoad(d2, 'U2', 1);
ok(!e1.ok && /Slot 1 is empty/.test(e1.reason), 'P5: slot kosong -> info');
ok(JSON.stringify(BM.getActiveChar(b2).equipment) === before, 'P5: equipment tak tersentuh');
const e2 = BM.applyPresetLoad(d2, 'U2', 7);
ok(!e2.ok && /only have 2/.test(e2.reason), 'P3: slot 7 -> info jumlah slot');

// T2 regression: same g-item still equipped when its preset loads — swap must return it
// THEN take it back (no free bag copy). Brief's code skipped the decrement -> dupe.
const d3 = mkData('U3'); BM.ensureBattleData(d3.U3); BM.applyCreateCharacter(d3, 'U3', 'warrior');
const b3 = BM.ensureBattleData(d3.U3);
b3.bag.g13 = 1;
const c3 = BM.getActiveChar(b3);
c3.equipment.boots = 'g13'; b3.bag.g13 -= 1;
BM.applyPresetSave(d3, 'U3', 1);
ok(BM.applyPresetLoad(d3, 'U3', 1).ok, 'G4: load ok saat item preset masih terpasang');
ok(c3.equipment.boots === 'g13' && !b3.bag.g13, 'G4: re-equip item sama tidak duplikat ke bag');

// T2: Q5 — preset item equipped on ANOTHER character -> reject, name the class, touch nothing
const d4 = mkData('U4'); BM.ensureBattleData(d4.U4); BM.applyCreateCharacter(d4, 'U4', 'warrior');
const b4 = BM.ensureBattleData(d4.U4);
b4.uniqueItems.kyw2 = { id: 'kyw2', rarity: 'legend', slot: 'weapon', stats: { atk: 20 }, passives: [] };
BM.getActiveChar(b4).equipment.weapon = 'kyw2';
BM.applyPresetSave(d4, 'U4', 1);
BM.getActiveChar(b4).equipment.weapon = null; // move it to the mage by hand
b4.characters.mage = { charLevel: 1, charExp: 0, charExpNeeded: 100, charName: null, bestDepth: 0,
  equipment: { weapon: 'kyw2', head: null, armor: null, boots: null, accessory: null }, scoreAchievedAt: null };
const before4 = JSON.stringify(BM.getActiveChar(b4).equipment);
const e4 = BM.applyPresetLoad(d4, 'U4', 1);
ok(!e4.ok && /Mage/.test(e4.reason), 'Q5: item di char lain -> reject sebut kelas');
ok(JSON.stringify(BM.getActiveChar(b4).equipment) === before4, 'Q5: equipment tak tersentuh');

// ---------- T3: purge-on-sell (Q6 anti-exploit) + buy slot w/ escalating prices ----------
// Wrapped in a block: brief reuses d3/b3/d4/b4 names already taken at module top-level.
{
const d3 = mkData('U3'); BM.ensureBattleData(d3.U3); BM.applyCreateCharacter(d3, 'U3', 'warrior');
const b3 = BM.ensureBattleData(d3.U3);
b3.uniqueItems.kyw2 = { id: 'kyw2', rarity: 'divine', slot: 'weapon', stats: { matk: 48 }, passives: [] };
BM.getActiveChar(b3).equipment.weapon = 'kyw2';
b3.kryptonite = 0;
BM.applyPresetSave(d3, 'U3', 1);
BM.getActiveChar(b3).equipment.weapon = null;
const kryBefore = b3.kryptonite;
ok(BM.applySellGear(d3, 'U3', 'kyw2', 1).ok, 'jual kyw2 ok');
ok(b3.kryptonite > kryBefore, 'dapat 🧪 sekali');
ok(b3.presets[0].slots.weapon === null, 'Q6 lapis1: preset dinull-kan saat jual');
ok(!b3.uniqueItems.kyw2, 'item hilang dari koleksi');
ok(BM.applyPresetLoad(d3, 'U3', 1).ok, 'load preset (slot weapon kini null) tidak error');
ok(BM.getActiveChar(b3).equipment.weapon === null, 'Q6 lapis2: tidak ada phantom item');
ok(!BM.applySellGear(d3, 'U3', 'kyw2', 1).ok, 'jual ulang -> tolak');
// bulk juga purge:
b3.uniqueItems.kyw3 = { id: 'kyw3', rarity: 'divine', slot: 'head', stats: { def: 20 }, passives: [] };
b3.presets[0].slots.head = 'kyw3';
ok(BM.applySellGear(d3, 'U3', 'divine', 'all').ok, 'bulk divine jual');
ok(b3.presets[0].slots.head === null, 'bulk juga purge preset');
// g-item spare terjual juga purge:
b3.bag.g10 = 1; b3.presets[0].slots.weapon = 'g10';
ok(BM.applySellGear(d3, 'U3', 'g10', 1).ok, 'jual g10 spare');
ok(b3.presets[0].slots.weapon === null, 'g-item juga purge');

// buy slot — harga menanjak: 2→3 = 2000, 3→4 = 5000, 4→5 = 10000
const d4 = mkData('U4'); BM.ensureBattleData(d4.U4); BM.applyCreateCharacter(d4, 'U4', 'mage');
const b4 = BM.ensureBattleData(d4.U4);
b4.kryptonite = 5000;
ok(BM.applyBuyPresetSlot(d4, 'U4').ok && b4.presetSlots === 3 && b4.kryptonite === 3000, '2→3: +1 slot, 2000 terpotong');
ok(BM.applyPresetSave(d4, 'U4', 3).ok, 'slot baru bisa dipakai');
b4.kryptonite = 4000;
ok(!BM.applyBuyPresetSlot(d4, 'U4').ok && b4.kryptonite === 4000, '3→4 butuh 5000: kurang -> tolak tanpa potong');
b4.kryptonite = 6000;
ok(BM.applyBuyPresetSlot(d4, 'U4').ok && b4.presetSlots === 4 && b4.kryptonite === 1000, '3→4: 5000 terpotong');
b4.kryptonite = 10000;
ok(BM.applyBuyPresetSlot(d4, 'U4').ok && b4.presetSlots === 5 && b4.kryptonite === 0, '4→5: 10000 terpotong');
b4.kryptonite = 999999;
ok(!BM.applyBuyPresetSlot(d4, 'U4').ok, 'cap 5 ditolak');
b4.presetSlots = 4; b4.kryptonite = 100;
ok(!BM.applyBuyPresetSlot(d4, 'U4').ok && b4.kryptonite === 100, 'saldo kurang: tolak tanpa potong');
}

console.log('\n' + (fail === 0 ? '✅ OK' : '❌ FAIL') + ' — Pass: ' + pass + ' | Fail: ' + fail);
process.exit(fail ? 1 : 0);
