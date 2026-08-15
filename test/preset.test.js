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
console.log('\n' + (fail === 0 ? '✅ OK' : '❌ FAIL') + ' — Pass: ' + pass + ' | Fail: ' + fail);
process.exit(fail ? 1 : 0);
