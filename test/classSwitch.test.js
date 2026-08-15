'use strict';
// Class switch system tests. Run: node test/classSwitch.test.js
const BM = require('../utils/battleManager');
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : (fail++, console.log('  ❌ ' + m)); };
const mkData = (uid) => ({ [uid]: { username: 'T', balance: 100000, level: 1, xp: 0, xpNeeded: 400, totalWins: 0, totalLosses: 0, totalEarned: 0, totalLost: 0, lastDaily: null, registeredAt: '2026-01-01T00:00:00Z' } });

// ---- constructor: default record persis pemain baru (D3/G10) ----
const rec = BM.createCharacterRecord();
ok(rec.charLevel === 1 && rec.charExp === 0 && rec.charExpNeeded === 100, 'record: lv1 exp0 need100');
ok(rec.charName === null && rec.bestDepth === 0 && rec.scoreAchievedAt === null, 'record: no name, depth 0, no score date');
ok(rec.equipment && rec.equipment.weapon === null && Object.keys(rec.equipment).length === 5, 'record: 5 empty slots');

// ---- migrasi flat -> characters ----
const data = mkData('U1');
const b1 = BM.ensureBattleData(data.U1);
b1.charClass = 'mage'; b1.charLevel = 200; b1.charExp = 500; b1.charExpNeeded = 10050;
b1.charName = 'DarkMage'; b1.bestDepth = 150; b1.equipment.weapon = 'g1';
const b1m = BM.ensureBattleData(data.U1); // second call triggers/keeps migration
ok(b1m.characters && b1m.characters.mage.charLevel === 200, 'migrasi: mage char ada, level utuh');
ok(b1m.characters.mage.bestDepth === 150 && b1m.characters.mage.charName === 'DarkMage', 'migrasi: depth & name utuh');
ok(b1m.characters.mage.equipment.weapon === 'g1', 'migrasi: equipment utuh');
ok(b1m.activeClass === 'mage', 'migrasi: activeClass = class lama');
ok(b1m.charLevel === undefined && b1m.charClass === undefined && b1m.equipment === undefined, 'migrasi: field flat dihapus');
ok(BM.getActiveChar(b1m).charName === 'DarkMage', 'getActiveChar mengembalikan karakter aktif');

// ---- idempoten + pemain tanpa class tak tersentuh ----
BM.ensureBattleData(data.U1);
ok(BM.getActiveChar(b1m).charLevel === 200, 'migrasi idempoten');
const data2 = mkData('U2');
const b2 = BM.ensureBattleData(data2.U2);
ok(!b2.characters, 'pemain tanpa class: struktur characters belum dibuat');
ok(BM.getCharClass(b2) === null, 'getCharClass null sebelum pilih class');

// ---- applyCreateCharacter pakai constructor ----
const data3 = mkData('U3');
BM.ensureBattleData(data3.U3);
ok(BM.applyCreateCharacter(data3, 'U3', 'warrior').ok, 'create char warrior ok');
const b3 = BM.ensureBattleData(data3.U3);
ok(b3.characters.warrior.charLevel === 1 && b3.characters.warrior.bestDepth === 0, 'char baru: lv1 depth0 (bukan warisan)');
ok(b3.activeClass === 'warrior', 'create: aktif');
const r3 = BM.applyCreateCharacter(data3, 'U3', 'mage');
ok(!r3.ok && /ky switch/.test(r3.reason), 'multi-char via register ditolak, diarahkan ke ky switch (guard Task 4)');
// deep-equality jalur register vs constructor:
ok(JSON.stringify(b3.characters.warrior) === JSON.stringify(BM.createCharacterRecord()), 'record register === constructor (G10)');

// ---- applyGainCharExp menulis ke karakter aktif ----
const data4 = mkData('U4');
BM.ensureBattleData(data4.U4); BM.applyCreateCharacter(data4, 'U4', 'mage');
BM.applyGainCharExp(data4, 'U4', 150);
const b4 = BM.ensureBattleData(data4.U4);
ok(b4.characters.mage.charLevel === 2 && b4.characters.mage.charExp === 50, 'exp naik ke char aktif (150 = 100+50)');

// ---- delve: start butuh karakter aktif; sweep dari bestDepth karakter itu ----
const data5 = mkData('U5');
BM.ensureBattleData(data5.U5); BM.applyCreateCharacter(data5, 'U5', 'warrior');
BM.getActiveChar(BM.ensureBattleData(data5.U5)).bestDepth = 30; // simulasi progress warrior
ok(BM.applyDelveStart(data5, 'U5').ok, 'delve start ok dengan char aktif');
const data5b = mkData('U9'); BM.ensureBattleData(data5b.U9);
ok(BM.applyDelveStart(data5b, 'U9').reason === 'no_character', 'delve start tanpa char -> no_character');

// ---- extract menulis ke karakter PEMAIN RUN (G7), bukan aktif sekarang ----
const data6 = mkData('U6');
BM.ensureBattleData(data6.U6); BM.applyCreateCharacter(data6, 'U6', 'mage');
const runState = { classId: 'mage', floor: 51, bag: { d1: 2 }, expAccum: 300 };
BM.ensureBattleData(data6.U6).activeClass = 'mage';
BM.applyExtract(data6, 'U6', runState);
const b6 = BM.ensureBattleData(data6.U6);
ok(b6.characters.mage.bestDepth === 50, 'extract: depth masuk ke char run (50)');
ok(b6.bag.d1 === 2, 'extract: bag shared terisi');
// paksa switch aktif ke warrior SEBELUM extract (defense-in-depth test):
BM.ensureBattleData(data6.U6).kryptonite = 6000;
BM.applyChangeClass(data6, 'U6', 'warrior'); // kini aktif = warrior (jalur bayar Task 4)
BM.applyExtract(data6, 'U6', { classId: 'mage', floor: 71, bag: {}, expAccum: 0 });
ok(BM.ensureBattleData(data6.U6).characters.mage.bestDepth === 70, 'G7: extract tetap ke characters[run.classId] walau aktif warrior');
ok(BM.ensureBattleData(data6.U6).characters.warrior.bestDepth === 0, 'char lain tidak terkontaminasi');

// ---- charName per karakter ----
const data7 = mkData('U7');
BM.ensureBattleData(data7.U7); BM.applyCreateCharacter(data7, 'U7', 'warrior');
ok(BM.applySetCharName(data7, 'U7', 'IronKnight').ok, 'set name ok');
BM.ensureBattleData(data7.U7).kryptonite = 6000;
BM.applyChangeClass(data7, 'U7', 'mage'); // char kedua via jalur bayar
ok(BM.ensureBattleData(data7.U7).characters.mage.charName === null, 'char kedua belum bernama');
ok(BM.applySetCharName(data7, 'U7', 'DarkMage').ok, 'set name char kedua ok');
ok(BM.ensureBattleData(data7.U7).characters.warrior.charName === 'IronKnight', 'nama char pertama tidak berubah');

// ---- G5: equip item yang terpasang di char lain -> tolak ----
const data8 = mkData('U8');
BM.ensureBattleData(data8.U8); BM.applyCreateCharacter(data8, 'U8', 'warrior');
const bb = BM.ensureBattleData(data8.U8);
bb.uniqueItems.kyw1 = { id: 'kyw1', rarity: 'divine', slot: 'weapon', stats: { atk: 48 }, passives: [] };
bb.uniqueItems.kyw2 = { id: 'kyw2', rarity: 'divine', slot: 'head', stats: { def: 10 }, passives: [] }; // spare divine (setup fix: bulk butuh 1 item sellable agar ok:true — brief asli hanya punya kyw1 yg equipped)
bb.characters.warrior.equipment.weapon = 'kyw1'; // terpasang di warrior (aktif)
BM.ensureBattleData(data8.U8).kryptonite = 6000;
BM.applyChangeClass(data8, 'U8', 'mage');         // aktif = mage (jalur bayar)
ok(BM.applyEquip(data8, 'U8', 'kyw1').ok === false, 'G5: equip item milik-equipment-warrior ditolak di mage');
ok(BM.isEquippedOnAnyChar(bb, 'kyw1') === true, 'isEquippedOnAnyChar deteksi lintas char');

// ---- G6: jual unique terpasang di char manapun -> tolak/single, bulk -> skip ----
ok(BM.applySellGear(data8, 'U8', 'kyw1', 1).ok === false, 'G6: jual item terpasang di char non-aktif ditolak');
const bulk = BM.applySellGear(data8, 'U8', 'divine', 'all');
ok(bulk.ok === true && bb.uniqueItems.kyw1, 'G6 bulk: item terpasang di-skip, tidak terjual');
ok(!bb.uniqueItems.kyw2, 'G6 bulk: spare divine justru terjual (hanya equipped yang di-skip)');
ok(bulk.ok && bulk.sold === 1, 'G6 bulk: sold=1 (kyw2), equipped kyw1 tidak dihitung');

// ---- pindah gear jalur sah: unequip (warrior) -> switch -> equip (mage) ----
ok(BM.applySwitchClass(data8, 'U8', 'warrior').ok, 'switch ke warrior ok (jalur sah Task 4)');
ok(BM.applyUnequip(data8, 'U8', 'weapon').ok, 'unequip dari warrior ok');
ok(BM.applySwitchClass(data8, 'U8', 'mage').ok, 'switch ke mage ok');
ok(BM.applyEquip(data8, 'U8', 'kyw1').ok, 'equip ke mage setelah dilepas — jalur sah berhasil');

// ---- unequip all: mixed g+ky, stacking count, empty, tanpa duplikasi ----
const dU = mkData('U10');
BM.ensureBattleData(dU.U10); BM.applyCreateCharacter(dU, 'U10', 'warrior');
const bU = BM.ensureBattleData(dU.U10);
bU.uniqueItems.kyw1 = { id: 'kyw1', rarity: 'divine', slot: 'weapon', stats: { atk: 48 }, passives: [] };
bU.bag.g10 = 1; // satu spare g10 di bag (dua sword sama total)
const cU = BM.getActiveChar(bU);
cU.equipment.weapon = 'kyw1'; cU.equipment.head = 'g21';
cU.equipment.armor = 'g3'; // setup fix: g10 slot-nya weapon (bentrok dgn kyw1) — item ke-3 di slot lain agar count=3 sesuai asersi brief
BM.applyEquip(dU, 'U10', 'g10'); // ambil spare -> equipped (bag.g10 habis)
const rU = BM.applyUnequipAll(dU, 'U10');
ok(rU.ok && rU.count === 3, 'unequip all: 3 item lepas');
ok(bU.bag.g10 === 1 && bU.bag.g21 === 1, 'g-item kembali ke bag dengan count benar (tidak jadi 1 semua)');
ok(bU.uniqueItems.kyw1, 'ky-item tetap di koleksi');
ok(Object.values(cU.equipment).every(v => v === null), 'semua slot kosong');
ok(!BM.applyUnequipAll(dU, 'U10').ok, 'second call: nothing equipped -> info');
// duplikasi check: total kepemilikan tidak berubah
ok(bU.bag.g10 === 1, 'tidak ada duplikasi (bag.g10 tetap 1)');

// ---- changeclass: biaya, atomic, auto-aktif (D2, G9) ----
const data9 = mkData('A1');
BM.ensureBattleData(data9.A1); BM.applyCreateCharacter(data9, 'A1', 'warrior');
BM.ensureBattleData(data9.A1).kryptonite = 6000;
ok(BM.applyChangeClass(data9, 'A1', 'mage').ok, 'changeclass mage ok (6000 kry >= 5000)');
ok(BM.ensureBattleData(data9.A1).kryptonite === 1000, 'biaya 5000 terpotong sekali');
ok(BM.ensureBattleData(data9.A1).activeClass === 'mage', 'D2: langsung aktif');
ok(BM.ensureBattleData(data9.A1).characters.mage.charLevel === 1, 'D3: char baru lv1');
ok(BM.applyChangeClass(data9, 'A1', 'mage').ok === false, 'G9: class sudah ada -> tolak');
ok(BM.ensureBattleData(data9.A1).kryptonite === 1000, 'G9: tolak tidak memotong lagi');
BM.ensureBattleData(data9.A1).kryptonite = 100;
ok(BM.applyChangeClass(data9, 'A1', 'rogue').ok === false, 'class invalid tolak');
// (butuh class ketiga di CLASSES untuk tes invalid-lebih-lengkap — cukup string ngawur)
ok(BM.applyChangeClass(data9, 'A1', 'warrior').ok === false, 'class sudah dimiliki -> tolak (bukan create lagi)');

// ---- switchclass ----
ok(BM.applySwitchClass(data9, 'A1', 'warrior').ok, 'switch ke warrior ok');
ok(BM.ensureBattleData(data9.A1).activeClass === 'warrior', 'aktif = warrior');
ok(BM.ensureBattleData(data9.A1).characters.warrior.charLevel === 1, 'data warrior utuh');
const rSw = BM.applySwitchClass(data9, 'A1', 'mage'); // aktif=warrior, mage dimiliki tapi tidak aktif
ok(rSw.ok === true, 'switch ke class dimiliki (tidak aktif): boleh');
ok(BM.ensureBattleData(data9.A1).activeClass === 'mage', 'aktif kembali = mage');
ok(BM.applySwitchClass(data9, 'A1', 'rogue').ok === false, 'G12: class tak dimiliki -> tolak');

// ---- B1: switchclass pemain tanpa karakter (characters belum ada) tidak crash ----
const dC = mkData('CB');
BM.ensureBattleData(dC.CB);
let threw = false; let rC = null;
try { rC = BM.applySwitchClass(dC, 'CB', 'warrior'); } catch { threw = true; }
ok(!threw && rC !== null && rC.ok === false, 'switchclass classless: no throw, not ok');

// ---- B1 twin: changeclass pemain tanpa karakter (characters belum ada) tidak crash ----
const dCc = mkData('CD');
BM.ensureBattleData(dCc.CD);
let threwC = false; let rCc = null;
try { rCc = BM.applyChangeClass(dCc, 'CD', 'mage'); } catch { threwC = true; }
ok(!threwC && rCc !== null && rCc.ok === false, 'changeclass classless: no throw, not ok');
ok(rCc && /Create a character first/.test(rCc.reason), "changeclass classless: reason 'Create a character first'");

// ---- B3: inherited key ('constructor') ditolak sebagai class invalid ----
const dI = mkData('UX');
BM.ensureBattleData(dI.UX); BM.applyCreateCharacter(dI, 'UX', 'warrior');
BM.ensureBattleData(dI.UX).kryptonite = 6000;
const rI = BM.applyChangeClass(dI, 'UX', 'constructor');
ok(rI.ok === false && /Invalid class/.test(rI.reason), "inherited key 'constructor': Invalid class");
const bI = BM.ensureBattleData(dI.UX);
ok(Object.keys(bI.characters).length === 1 && bI.kryptonite === 6000, 'inherited key: no state change (kry utuh, char tidak terbuat)');

// G-free-2nd-char: pemain dgn karakter tak bisa buat class lain gratis via register path
const dG = mkData('GA');
BM.ensureBattleData(dG.GA); BM.applyCreateCharacter(dG, 'GA', 'warrior');
const rg = BM.applyCreateCharacter(dG, 'GA', 'mage');
ok(!rg.ok && /ky switch/.test(rg.reason), 'register path: second char rejected, points to ky switch');
// changeclass masih bisa (bayar):
BM.ensureBattleData(dG.GA).kryptonite = 6000;
ok(BM.applyChangeClass(dG, 'GA', 'mage').ok, 'changeclass path tetap jalan (bayar 5000)');

// ---- LB: entri terbaik per pemain + filter class ----
const dataL = {
  P1: { username: 'p1', registeredAt: '2026-01-01T00:00:00Z', battle: null, cosmetics: {} },
  P2: { username: 'p2', registeredAt: '2026-01-02T00:00:00Z', battle: null, cosmetics: {} },
};
for (const [uid, u] of Object.entries(dataL)) {
  const b = BM.ensureBattleData(u);
  // brief assumes characters map pre-exists; ensureBattleData keeps it lazy (see test line ~32) — init it here
  b.characters = { warrior: BM.createCharacterRecord(), mage: BM.createCharacterRecord() };
}
dataL.P1.battle.activeClass = 'warrior';
dataL.P1.battle.characters.warrior.bestDepth = 80; dataL.P1.battle.characters.mage.bestDepth = 40;
dataL.P2.battle.activeClass = 'mage';
dataL.P2.battle.characters.mage.bestDepth = 90; dataL.P2.battle.characters.warrior.bestDepth = 10;
// (inject data via applyExtract terlalu berat — set langsung field record utk LB test)
const lbAll = BM.getBattleLeaderboardFor(dataL, 10, null);
ok(lbAll[0].userId === 'P2' && lbAll[0].bestDepth === 90 && lbAll[0].charClass === 'mage', 'LB utama: char terbaik P2 (mage 90)');
ok(lbAll[1].userId === 'P1' && lbAll[1].charClass === 'warrior', 'LB utama: char terbaik P1 (warrior 80)');
const lbW = BM.getBattleLeaderboardFor(dataL, 10, 'warrior');
ok(lbW.length === 2 && lbW[0].userId === 'P1' && lbW[0].bestDepth === 80, 'LB warrior: P1 top');
const lbM = BM.getBattleLeaderboardFor(dataL, 10, 'mage');
ok(lbM[0].userId === 'P2' && lbM[0].bestDepth === 90, 'LB mage: P2 top');


// ---- charName safety: reserved words, username collision, per-char rename ----
const dN = mkData('UN'); dN.UN.username = 'rizdevs';
BM.ensureBattleData(dN.UN); BM.applyCreateCharacter(dN, 'UN', 'warrior');
dN.UN.battle.kryptonite = 6000;
ok(!BM.applySetCharName(dN, 'UN', 'super admin').ok, 'nama reserved: super admin ditolak');
ok(!BM.applySetCharName(dN, 'UN', 'ADMIN').ok, 'nama reserved: case-insensitive ditolak');
ok(!BM.applySetCharName(dN, 'UN', 'RizDevs').ok, 'nama collision: username pemain lain ditolak');
ok(!BM.applySetCharName(dN, 'UN', 'dot.name').ok && !BM.applySetCharName(dN, 'UN', 'tilde~').ok, 'simbol berbahaya ditolak');
ok(BM.applySetCharName(dN, 'UN', 'Valid Name-1').ok, 'nama wajar lolos');
BM.applyChangeClass(dN, 'UN', 'mage');
ok(dN.UN.battle.characters.warrior.charName === 'Valid Name-1' && dN.UN.battle.characters.mage.charName === null, 'nama per-karakter terisolasi');

console.log('\n' + (fail === 0 ? '✅ SEMUA TEST LULUS' : '❌ ADA TEST GAGAL'));
console.log('Pass: ' + pass + ' | Fail: ' + fail);
process.exit(fail === 0 ? 0 : 1);
