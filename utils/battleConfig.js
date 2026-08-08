'use strict';

// ============================================================
// Battle Mode config — data-driven catalogs (isolated, no Discord).
// All tunable numbers live here as named constants; the balance
// sim (test/battleEngine.test.js) is the gate before going live.
// ============================================================

// CLASSES — base stats at lvl 1 + per-level growth + PvE auto rotation.
// rotation: { id, mult (skillMult), type: 'physical'|'magic' }
const CLASSES = {
  warrior: {
    name: 'Warrior',
    emoji: '⚔️',
    base:   { hp: 100, atk: 12, matk: 4,  def: 10, mdef: 5,  spd: 6 },
    growth: { hp: 20,  atk: 2.5, matk: 0.8, def: 2.0, mdef: 1.0, spd: 0.5 },
    rotation: [
      { id: 'slash', mult: 1.0, type: 'physical' },
      { id: 'heavy', mult: 1.6, type: 'physical' },
    ],
  },
  mage: {
    name: 'Mage',
    emoji: '🔮',
    base:   { hp: 70,  atk: 4,  matk: 14, def: 5,  mdef: 9,  spd: 7 },
    growth: { hp: 12,  atk: 0.8, matk: 2.8, def: 1.0, mdef: 1.8, spd: 0.6 },
    rotation: [
      { id: 'bolt',     mult: 1.0, type: 'magic' },
      { id: 'fireball', mult: 1.7, type: 'magic' },
    ],
  },
};

// ENEMY GROWTH — exponential per floor. stat = base * scale^(floor-1)
const ENEMY_BASE = {
  scale: 1.12,        // +12%/floor (sim-proven; tune here if balance gate fails)
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
  g3: { id: 'g3', name: 'Leather Armor', slot: 'armor',     rarity: 'common',   price: 120, stats: { def: 3, hp: 15 } },
  g4: { id: 'g4', name: 'Iron Armor',    slot: 'armor',     rarity: 'uncommon', price: 300, stats: { def: 6, hp: 30 } },
  g5: { id: 'g5', name: 'Swift Boots',   slot: 'boots',     rarity: 'uncommon', price: 200, stats: { spd: 3 } },
  g6: { id: 'g6', name: 'Leather Cap',   slot: 'head',      rarity: 'common',   price: 90,  stats: { def: 2, hp: 10 } },
  g7: { id: 'g7', name: 'Power Ring',    slot: 'accessory', rarity: 'rare',     price: 500, stats: { atk: 5, spd: 1 } },
  g8: { id: 'g8', name: 'Oak Staff',     slot: 'weapon',    rarity: 'common',   price: 100, stats: { matk: 4 } },
  g9: { id: 'g9', name: 'Arcane Amulet', slot: 'accessory', rarity: 'rare',     price: 550, stats: { matk: 6, mdef: 3 } },
};

// v1 merchant uses flat per-item sell prices (the item's `value`). v2 adds daily variance.
const MERCHANT_FLAT = true;

module.exports = { CLASSES, ENEMY_BASE, DROP_RARITIES, DROPS, GEAR, MERCHANT_FLAT };
