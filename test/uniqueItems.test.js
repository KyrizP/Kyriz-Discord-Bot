'use strict';
// uniqueItems gacha tests. Run: node test/uniqueItems.test.js
const U = require('../utils/uniqueItems');
const { PASSIVES } = require('../utils/battleConfig');
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : (fail++, console.log('  ❌ ' + m)); };

// ---- id format + collision ----
ok(/^ky[a-z0-9]{4}$/.test(U.generateUniqueId(new Set())), 'id format kyXXXX (4 lowercase alnum)');
let s = new Set();
for (let i = 0; i < 5000; i++) s.add(U.generateUniqueId(s));
ok(s.size === 5000, '5000 ids, zero collision');

// ---- stat ranges (weapon: ATK or MATK random — pure gacha) ----
let weaponGotAtk = 0, weaponGotMatk = 0;
for (let i = 0; i < 500; i++) {
  const u = U.createUnique('legendary', 'weapon', null, new Set()); // variant ignored — random atk/matk
  const val = u.stats.atk || u.stats.matk;
  if (u.stats.atk) weaponGotAtk++; if (u.stats.matk) weaponGotMatk++;
  ok(val >= 20 && val <= 28, 'legend weapon atk/matk in [20,28]');
  ok((u.stats.atk ? 1 : 0) + (u.stats.matk ? 1 : 0) === 1, 'weapon has exactly 1 of atk/matk');
  ok(u.rarity === 'legendary' && u.slot === 'weapon' && u.id.startsWith('ky'), 'unique shape');
  ok(u.passives.length === 1, 'legend gets exactly 1 passive');
}
ok(weaponGotAtk > 0 && weaponGotMatk > 0, 'weapon gacha rolls both atk and matk over time');
// divine boots spd range
for (let i = 0; i < 200; i++) {
  const u = U.createUnique('divine', 'boots', null, new Set());
  ok(u.stats.spd >= 24 && u.stats.spd <= 34, 'divine boots spd in [24,34]');
  ok(u.passives.length === 2, 'divine gets exactly 2 passives');
}

// ---- accessory: 2 DIFFERENT stats, spd uses smaller range ----
for (let i = 0; i < 500; i++) {
  const u = U.createUnique('mythic', 'accessory', null, new Set());
  const keys = Object.keys(u.stats);
  ok(keys.length === 2, 'accessory has exactly 2 stats');
  ok(keys[0] !== keys[1], 'accessory stats are different (no dup)');
  if (u.stats.spd != null) ok(u.stats.spd >= 4 && u.stats.spd <= 8, 'mythic accessory spd in [4,8]');
}

// ---- divine 2 passives: different types ----
for (let i = 0; i < 500; i++) {
  const u = U.createUnique('divine', 'head', null, new Set());
  if (u.passives.length === 2) ok(u.passives[0].id !== u.passives[1].id, 'divine 2 passives are different types');
}

// ---- passive values within tier range ----
for (let i = 0; i < 500; i++) {
  const u = U.createUnique('divine', 'weapon', 'atk', new Set());
  for (const p of u.passives) {
    const [lo, hi] = PASSIVES[p.id].ranges.divine;
    ok(p.value >= lo && p.value <= hi, 'divine passive ' + p.id + ' value in range');
  }
}

// ---- sellValue = 35% of tier price ----
const d = U.createUnique('divine', 'weapon', 'atk', new Set());
ok(U.sellValue(d) === 7000, 'divine sellValue = 7000 (35% of 20000)');
const l = U.createUnique('legendary', 'head', null, new Set());
ok(U.sellValue(l) === 1750, 'legendary sellValue = 1750 (35% of 5000)');

// ---- exploit: invalid tier rejected (no crash, no junk) ----
let threw = false;
try { U.createUnique('epic', 'weapon', 'atk', new Set()); } catch (e) { threw = true; }
ok(threw, 'epic (non-Legend+) rejected by unique system');

// ---- no negative/undefined stats ever ----
for (const tier of ['legendary', 'mythic', 'divine']) {
  for (const slot of ['weapon', 'head', 'armor', 'boots', 'accessory']) {
    const u = U.createUnique(tier, slot, slot === 'weapon' ? 'atk' : null, new Set());
    ok(Object.values(u.stats).every((v) => Number.isFinite(v) && v > 0), tier + '/' + slot + ' stats finite & > 0');
  }
}

// ---- head/armor: exactly 1 stat (DEF or MDEF) — gambling ----
for (let i = 0; i < 300; i++) {
  const u = U.createUnique('mythic', 'armor', null, new Set());
  const keys = Object.keys(u.stats);
  ok(keys.length === 1 && (keys[0] === 'def' || keys[0] === 'mdef'), 'armor = exactly 1 of def/mdef (gambling)');
}
let headDefs = 0, headMdefs = 0;
for (let i = 0; i < 300; i++) {
  const u = U.createUnique('divine', 'head', null, new Set());
  const k = Object.keys(u.stats)[0];
  if (k === 'def') headDefs++; if (k === 'mdef') headMdefs++;
}
ok(headDefs > 0 && headMdefs > 0, 'head gambling rolls both def and mdef over time');

console.log('\n' + (fail === 0 ? '✅ SEMUA TEST LULUS' : '❌ ADA TEST GAGAL'));
console.log('Pass: ' + pass + ' | Fail: ' + fail);
process.exit(fail === 0 ? 0 : 1);
