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
ok(!BM.applyCreateCharacter(data3, 'U3', 'mage').reason.includes('already have a character'), 'multi-char tidak lagi ditolak "already have" (diganti guard changeclass)');
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
BM.applyCreateCharacter(data6, 'U6', 'warrior'); // kini aktif = warrior
BM.applyExtract(data6, 'U6', { classId: 'mage', floor: 71, bag: {}, expAccum: 0 });
ok(BM.ensureBattleData(data6.U6).characters.mage.bestDepth === 70, 'G7: extract tetap ke characters[run.classId] walau aktif warrior');
ok(BM.ensureBattleData(data6.U6).characters.warrior.bestDepth === 0, 'char lain tidak terkontaminasi');

// ---- charName per karakter ----
const data7 = mkData('U7');
BM.ensureBattleData(data7.U7); BM.applyCreateCharacter(data7, 'U7', 'warrior');
ok(BM.applySetCharName(data7, 'U7', 'IronKnight').ok, 'set name ok');
BM.applyCreateCharacter(data7, 'U7', 'mage');
ok(BM.ensureBattleData(data7.U7).characters.mage.charName === null, 'char kedua belum bernama');
ok(BM.applySetCharName(data7, 'U7', 'DarkMage').ok, 'set name char kedua ok');
ok(BM.ensureBattleData(data7.U7).characters.warrior.charName === 'IronKnight', 'nama char pertama tidak berubah');

console.log('\n' + (fail === 0 ? '✅ SEMUA TEST LULUS' : '❌ ADA TEST GAGAL'));
console.log('Pass: ' + pass + ' | Fail: ' + fail);
process.exit(fail === 0 ? 0 : 1);
