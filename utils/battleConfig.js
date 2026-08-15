'use strict';

// ============================================================
// Battle Mode config — data-driven catalogs (isolated, no Discord).
// All tunable numbers live here as named constants; the balance
// sim (test/battleEngine.test.js) is the gate before going live.
// ============================================================

// CLASSES — base stats at lvl 1 + per-level growth + skills (PvE auto-picks; PvP player-picks).
// skill: { id, name, mult, type:'physical'|'magic', cd, effect? }  effect: {kind:'parry'|'buff'|'burn',...}
const CLASSES = {
  warrior: {
    name: 'Warrior',
    emoji: '⚔️',
    base:   { hp: 100, atk: 12, matk: 4,  def: 10, mdef: 5,  spd: 6 },
    growth: { hp: 20,  atk: 2.2, matk: 0.8, def: 2.0, mdef: 2.0, spd: 0.5 }, // v1.2: ATK 2.0→2.2 (slight buff for PvE parity)
    skills: [
      { id: 'slash',  name: 'Slash',        mult: 1.0, type: 'physical', cd: 0 },
      { id: 'parry',  name: 'Parry Strike', mult: 1.6, type: 'physical', cd: 2, effect: { kind: 'parry' } },
      { id: 'warcry', name: 'War Cry',      mult: 2.5, type: 'physical', cd: 4, effect: { kind: 'buff', stat: 'atk', pct: 25, turns: 2, dmgReduce: 35, pierce: 0.5, pierceEvasion: true } },
    ],
  },
  mage: {
    name: 'Mage',
    emoji: '🔮',
    base:   { hp: 70,  atk: 4,  matk: 14, def: 5,  mdef: 9,  spd: 7 },
    growth: { hp: 15,  atk: 1.0, matk: 3.0, def: 2.0, mdef: 3.2, spd: 3.0 }, // v1.2: DEF 2.1→2.0 (equal to Warrior DEF — PvP balance via pvpManager instead)
    skills: [
      { id: 'bolt',     name: 'Bolt',     mult: 1.0, type: 'magic', cd: 0 },
      { id: 'fireball', name: 'Fireball', mult: 1.7, type: 'magic', cd: 2, effect: { kind: 'burn', pct: 10, turns: 3 } },
      { id: 'meteor',   name: 'Meteor',   mult: 2.5, type: 'magic', cd: 4, effect: { kind: 'burn', pct: 20, turns: 3, pierce: 0.5, pierceEvasion: true } },
    ],
  },
  rogue: {
    name: 'Rogue',
    emoji: '🗡️',
    base:   { hp: 80,  atk: 13, matk: 4,  def: 6,  mdef: 6,  spd: 12 },
    growth: { hp: 17,  atk: 2.8, matk: 1.0, def: 1.3, mdef: 2.5, spd: 3.5 }, // def 1.8→1.3 / mdef 1.8→2.5: shifts rogue's power from "vs physical(W)" to "vs magic(M)" — completes the W>R>M>W cycle (sim-gated, PvE parity unchanged 66/76/86)
    baseEvasion: 8, // class passive: % chance to dodge — ADDS with gear evasion, total capped 48% (engine: min(base+gear, 48))
    skills: [
      { id: 'backstab',    name: 'Backstab',     mult: 1.0, type: 'physical', cd: 0 },
      { id: 'venomfang',   name: 'Venom Fang',   mult: 1.5, type: 'physical', cd: 2, effect: { kind: 'poison', pct: 15, turns: 3 } }, // poison = ATK-based DoT, bypasses all defenses
      { id: 'shadowdance', name: 'Shadow Dance', mult: 2.0, type: 'physical', cd: 4, effect: { kind: 'dodge', charges: 2 } }, // 2 guaranteed dodges — pierced by ults (pierceEvasion), consumed by ALL attacks
    ],
  },
};

// ENEMY GROWTH — exponential per floor. stat = base * scale^(floor-1)
const ENEMY_BASE = {
  scale: 1.07,        // +7%/floor (gentler — high floors reachable via grind; sim-tuned)
  hp: 40, atk: 8, matk: 6, def: 5, mdef: 4, spd: 4,
};

// DROP RARITIES — value:[lo,hi] Kryponite sell RANGE (a guide for item values);
// weight: fn(floor) drives the rarity roll. Divine only floor 20+, ultra-rare.
const DROP_RARITIES = [
  { id: 'common',    value: [2, 5],     weight: () => 70 },
  { id: 'uncommon',  value: [6, 15],    weight: () => 20 },
  { id: 'rare',      value: [20, 40],   weight: (f) => Math.min(8,   2 + f * 0.12) },
  { id: 'epic',      value: [50, 90],   weight: (f) => Math.min(5,   0.5 + f * 0.05) },
  { id: 'legendary', value: [120, 200], weight: (f) => Math.min(1.5, 0.1 + f * 0.015) },
  { id: 'divine',    value: [300, 500], weight: (f) => (f < 20 ? 0 : Math.min(0.05, (f - 20) * 0.001)) },
];

// DROP ZONES — hard floor breakpoints (v1.1) replacing the continuous weight fns above.
// weights are % per rarity (mythic is NOT a drop rarity — only a gear tier).
// Each row's weights sum to ~100; rollDrop normalizes defensively.
const DROP_ZONES = [
  { min: 1,  max: 30,        weights: { common: 65, uncommon: 20, rare: 12,  epic: 2.5, legendary: 0.5, divine: 0 } },
  { min: 31, max: 60,        weights: { common: 45, uncommon: 0,  rare: 35,  epic: 15,  legendary: 4,   divine: 1 } },
  { min: 61, max: 90,        weights: { common: 30, uncommon: 0,  rare: 40,  epic: 20,  legendary: 7,   divine: 3 } },
  { min: 91, max: Infinity,  weights: { common: 0,  uncommon: 15, rare: 40,  epic: 25,  legendary: 12,  divine: 8 } },
];

// DROPS — concrete loot items, code `d<n>`. value = 🧪 Kryptonite sell price.
// Every rarity tier MUST have at least one item (rollDrop picks a random item of the rolled tier).
const DROPS = {
  d1: { id: 'd1', name: 'Slime Gel',       rarity: 'common',    value: 3 },
  d2: { id: 'd2', name: 'Goblin Fang',     rarity: 'common',    value: 4 },
  d3: { id: 'd3', name: 'Wolf Pelt',       rarity: 'uncommon',  value: 10 },
  d4: { id: 'd4', name: 'Crystal Shard',   rarity: 'rare',      value: 30 },
  d5: { id: 'd5', name: 'Phoenix Feather', rarity: 'epic',      value: 70 },
  d6: { id: 'd6', name: 'Dragon Scale',    rarity: 'legendary', value: 160 },
  d7: { id: 'd7', name: 'Celestial Core',  rarity: 'divine',    value: 400 },
};

// GEAR — equippable items, code `g<n>`. price = 🧪 buy price; sellback = price * 0.4 (battleManager).
const GEAR = {
  g1: { id: 'g1', name: 'Rusty Sword',   slot: 'weapon',    rarity: 'common',   price: 100, stats: { atk: 3 } },
  g2: { id: 'g2', name: 'Iron Blade',    slot: 'weapon',    rarity: 'uncommon', price: 250, stats: { atk: 7 } },
  g3: { id: 'g3', name: 'Leather Armor', slot: 'armor',     rarity: 'common',   price: 120, stats: { def: 5 } },
  g4: { id: 'g4', name: 'Iron Armor',    slot: 'armor',     rarity: 'uncommon', price: 300, stats: { def: 10 } },
  g5: { id: 'g5', name: 'Swift Boots',   slot: 'boots',     rarity: 'uncommon', price: 200, stats: { spd: 3 } },
  g6: { id: 'g6', name: 'Leather Cap',   slot: 'head',      rarity: 'common',   price: 90,  stats: { def: 4 } },
  g7: { id: 'g7', name: 'Power Ring',    slot: 'accessory', rarity: 'rare',     price: 500, stats: { atk: 5, spd: 1 } },
  g8: { id: 'g8', name: 'Oak Staff',     slot: 'weapon',    rarity: 'common',   price: 100, stats: { matk: 4 } },
  g9: { id: 'g9', name: 'Arcane Amulet', slot: 'accessory', rarity: 'rare',     price: 550, stats: { matk: 6, mdef: 3 } },
  // --- Rare ---
  g16: { id: 'g16', name: 'Knight Helm',     slot: 'head',      rarity: 'rare',   price: 400, stats: { def: 6 } },
  g17: { id: 'g17', name: 'Mage Hat',        slot: 'head',      rarity: 'rare',   price: 400, stats: { matk: 5 } },
  g18: { id: 'g18', name: 'Crystal Wand',    slot: 'weapon',    rarity: 'rare',   price: 400, stats: { matk: 7 } },
  g19: { id: 'g19', name: 'Steel Longsword', slot: 'weapon',    rarity: 'rare',   price: 350, stats: { atk: 6 } },
  g20: { id: 'g20', name: 'Battle Boots',    slot: 'boots',     rarity: 'rare',   price: 350, stats: { def: 3, spd: 2 } },
  // --- Epic (v1 highest; Legendary/Divine = v2) ---
  g10: { id: 'g10', name: 'Dragon Slayer',    slot: 'weapon',    rarity: 'epic',   price: 1100, stats: { atk: 16 } },
  g11: { id: 'g11', name: 'Archmage Staff',   slot: 'weapon',    rarity: 'epic',   price: 1100, stats: { matk: 16 } },
  g12: { id: 'g12', name: 'Mithril Armor',    slot: 'armor',     rarity: 'epic',   price: 900, stats: { def: 18 } },
  g13: { id: 'g13', name: 'Boots of Haste',   slot: 'boots',     rarity: 'epic',   price: 850, stats: { spd: 8 } },
  g14: { id: 'g14', name: 'Warlord Gauntlets',slot: 'accessory', rarity: 'epic',   price: 1000, stats: { atk: 10, spd: 3 } },
  g15: { id: 'g15', name: 'Arcane Orb',       slot: 'accessory', rarity: 'epic',   price: 1000, stats: { matk: 10, mdef: 5 } },
  // --- Epic head/armor variants (DEF or MDEF versions) ---
  g21: { id: 'g21', name: 'Vanguard Greathelm', slot: 'head',  rarity: 'epic', price: 950, stats: { def: 12 } },
  g22: { id: 'g22', name: 'Archmage Cowl',      slot: 'head',  rarity: 'epic', price: 950, stats: { mdef: 11 } },
  g23: { id: 'g23', name: 'Mystic Vestments',    slot: 'armor', rarity: 'epic', price: 950, stats: { mdef: 14 } },
};

// v1 merchant uses flat per-item sell prices (the item's `value`). v2 adds daily variance.
const MERCHANT_FLAT = true;

// TIER_INFO — letter/color/price/passive-count per tier. price = mystery-box buy price
// AND the sell-value basis (sellback 35%). common-epic price here is a fallback only
// (g* items use their own .price); legendary/mythic/divine use this price.
const TIER_INFO = {
  common:    { letter: 'C', color: '⚪', price: 100,   passives: 0 },
  uncommon:  { letter: 'U', color: '🟢', price: 250,   passives: 0 },
  rare:      { letter: 'R', color: '🔵', price: 450,   passives: 0 },
  epic:      { letter: 'E', color: '🟣', price: 1000,  passives: 0 },
  legendary: { letter: 'L', color: '🟠', price: 5000,  passives: 1 },
  mythic:    { letter: 'M', color: '🟡', price: 10000, passives: 1 },
  divine:    { letter: 'D', color: '🔶', price: 20000, passives: 2 },
  immortal:  { letter: 'I', color: '🔴', price: 0,     passives: 0 },
};

// LEGEND_GEAR_RANGES — random stat ranges per tier per slot. Inclusive bounds.
// weapon uses variant 'atk'|'matk'. accessory rolls 2 DIFFERENT stats (main vs spd range).
const LEGEND_GEAR_RANGES = {
  legendary: {
    weapon:    { atk: [20, 28], matk: [20, 28] },
    head:      { stat: [6, 10] },           // 1 random stat: DEF or MDEF (gambling)
    armor:     { stat: [18, 26] },          // 1 random stat: DEF or MDEF (gambling)
    boots:     { spd: [8, 14] },
    accessory: { main: [12, 18], spd: [2, 5] },
  },
  mythic: {
    weapon:    { atk: [30, 40], matk: [30, 40] },
    head:      { stat: [11, 16] },
    armor:     { stat: [28, 38] },
    boots:     { spd: [15, 22] },
    accessory: { main: [18, 26], spd: [4, 8] },
  },
  divine: {
    weapon:    { atk: [42, 55], matk: [42, 55] },
    head:      { stat: [18, 26] },
    armor:     { stat: [40, 52] },
    boots:     { spd: [24, 34] },
    accessory: { main: [25, 35], spd: [6, 12] },
  },
};

// MYSTERY BOXES — shop codes for Legend/Mythic/Divine boxes. Buy via `ky buygear <code> [atk|matk]`.
// Weapon boxes take an atk|matk variant; others roll automatically. On buy -> becomes a kyXXXX unique.
const _cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const MYSTERY_BOXES = {};
['legendary', 'mythic', 'divine'].forEach((tier, ti) => {
  ['weapon', 'head', 'armor', 'boots', 'accessory'].forEach((slot, si) => {
    const code = 'g' + (100 + ti * 5 + si);
    MYSTERY_BOXES[code] = { code, tier, slot, name: _cap(tier) + ' ' + _cap(slot) + ' Box' };
  });
});

// PASSIVES — catalog. Buffed values so Divine gear feels impactful (Lifesteal ~20% target).
// weight drives the gacha roll (greed/wisdom slightly higher).
const PASSIVES = {
  berserker: { emoji: '🗡️', name: 'Berserker', weight: 10, unit: '%', ranges: { legendary: [12, 18], mythic: [17, 23], divine: [22, 32] } },
  precision: { emoji: '🎯', name: 'Precision', weight: 10, unit: '%', ranges: { legendary: [8, 14],  mythic: [12, 18], divine: [16, 25] } },
  lifesteal: { emoji: '🩸', name: 'Lifesteal', weight: 10, unit: '%', ranges: { legendary: [5, 10],  mythic: [10, 17], divine: [15, 25] } },
  swift:     { emoji: '💨', name: 'Swift',     weight: 10, unit: '',  ranges: { legendary: [4, 8],   mythic: [8, 14],  divine: [12, 20] } },
  fortify:   { emoji: '🛡️', name: 'Fortify',   weight: 10, unit: '%', ranges: { legendary: [5, 10],  mythic: [10, 15], divine: [14, 22] } },
  evasion:   { emoji: '🌀', name: 'Evasion',   weight: 10, unit: '%', ranges: { legendary: [3, 5],   mythic: [5, 8],   divine: [8, 13] } },
  greed:     { emoji: '🧪', name: 'Greed',     weight: 11, unit: '%', ranges: { legendary: [12, 18], mythic: [17, 23], divine: [22, 30] } },
  wisdom:    { emoji: '📚', name: 'Wisdom',    weight: 11, unit: '%', ranges: { legendary: [12, 18], mythic: [17, 23], divine: [22, 30] } },
};

// EVASION_TOTAL_CAP — additive total of class baseEvasion + gear evasion (Rogue's edge:
// 8 base + 40 gear = 48; every other class has base 0 so their total stays ≤ PASSIVE_CAPS.evasion).
// Single source of truth — battleEngine, pvpManager and the `ky char` display all read THIS.
const EVASION_TOTAL_CAP = 48;

// CRIT — player crit source is Precision passive only; enemy crit floor 45+.
const CRIT = { mult: 1.75, cap: 0.50, enemyFloor: 45, enemyChance: 0.20 };

// PASSIVE_CAPS — stacking across multiple gear is capped to prevent degenerate builds
// (5× Lifesteal = 100% invulnerability, 5× Fortify = 110% → negative dmg, etc.).
// Swift/Greed/Wisdom uncapped (flat/utility, diminishing returns naturally).
// v1.2 nerfs: Fortify 80→45 (was 100-0 PvP), Lifesteal 80→65. Evasion stays 40 (ult pierce is enough counter).
const PASSIVE_CAPS = { berserker: 100, precision: Math.round(CRIT.cap * 100), lifesteal: 65, fortify: 45, evasion: 40 }; // precision capped here TOO so the panel can show (MAX) — combat already capped it via getCritChance (keep in sync with CRIT.cap)

module.exports = { CLASSES, ENEMY_BASE, DROP_RARITIES, DROP_ZONES, DROPS, GEAR, MERCHANT_FLAT,
  TIER_INFO, LEGEND_GEAR_RANGES, MYSTERY_BOXES, PASSIVES, PASSIVE_CAPS, CRIT, EVASION_TOTAL_CAP };
