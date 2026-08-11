'use strict';
// Self-check for battleConfig catalogs. Run: node test/battleConfig.test.js
const C = require('../utils/battleConfig');
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : (fail++, console.log('  ❌ ' + m)); };

ok(C.CLASSES.warrior && C.CLASSES.mage, 'both classes exist');
ok(C.CLASSES.warrior.base.hp > C.CLASSES.mage.base.hp, 'warrior tankier than mage');
for (const id of ['hp', 'atk', 'matk', 'def', 'mdef', 'spd']) {
  ok(typeof C.CLASSES.warrior.base[id] === 'number', 'warrior base.' + id);
  ok(typeof C.CLASSES.warrior.growth[id] === 'number', 'warrior growth.' + id);
  ok(typeof C.CLASSES.mage.base[id] === 'number', 'mage base.' + id);
}
ok(C.CLASSES.warrior.skills.length >= 1 && C.CLASSES.mage.skills.length >= 1, 'both have skills');
for (const sk of [...C.CLASSES.warrior.skills, ...C.CLASSES.mage.skills]) {
  ok(typeof sk.id === 'string' && typeof sk.mult === 'number' && (sk.type === 'physical' || sk.type === 'magic'), 'skill well-formed: ' + (sk.id || '?'));
}
ok(C.DROP_RARITIES.length === 6, '6 rarity tiers');
ok(C.DROPS.d7 && C.DROPS.d7.rarity === 'divine', 'divine drop exists');
// every rarity tier must have >=1 item (rollDrop picks a random item of the rolled tier)
for (const r of C.DROP_RARITIES) {
  ok(Object.values(C.DROPS).some((d) => d.rarity === r.id), 'tier has an item: ' + r.id);
}
ok(Object.keys(C.GEAR).length >= 5, 'at least 5 gear items');
ok(typeof C.ENEMY_BASE.scale === 'number' && C.ENEMY_BASE.scale > 1, 'enemy scale > 1');
// every gear item has slot + stats + price
for (const g of Object.values(C.GEAR)) {
  ok(typeof g.slot === 'string' && g.stats && typeof g.price === 'number', 'gear well-formed: ' + g.id);
}

console.log('\n' + (fail === 0 ? '✅ battleConfig OK' : '❌ FAIL'));
console.log('Pass: ' + pass + ' | Fail: ' + fail);
process.exit(fail === 0 ? 0 : 1);
