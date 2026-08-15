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

console.log('\n' + (fail === 0 ? '✅ SEMUA TEST LULUS' : '❌ ADA TEST GAGAL'));
console.log('Pass: ' + pass + ' | Fail: ' + fail);
process.exit(fail === 0 ? 0 : 1);
