'use strict';

// ============================================================
// Unique item gacha — PURE. No Discord, no IO.
// Legend/Mythic/Divine gear instances: kyXXXX id, random stats
// within tier ranges, random passives. Epic-and-below stay templates.
// ============================================================

const { TIER_INFO, LEGEND_GEAR_RANGES, PASSIVES } = require('./battleConfig');

const TIER_PRICE = { legendary: 5000, mythic: 10000, divine: 20000 };
const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

// Name pools per slot (+variant for weapon). Picked at random; cosmetic only.
const NAMES = {
  weapon_atk: ['Dragon Slayer', 'Warsplitter', 'Doombringer', 'Godrend', 'Tyrfing'],
  weapon_matk: ['Archmage Staff', 'Voidcaller', 'Spellspear', 'Mindreaver', 'Aetherwood'],
  head: ['Aegis Crown', 'Vanguard Helm', 'Sage Cowl', 'Ironvisage', 'Halo Circlet'],
  armor: ['Aegisplate', 'Bulwark Mail', 'Eternity Cuirass', 'Fortress Plate', 'Warden Robe'],
  boots: ['Swiftstep', 'Windrunners', 'Haste Greaves', 'Zephyr Boots', 'Stormstriders'],
  accessory: ['Berserker Sigil', 'Precision Charm', 'Greed Ring', 'Wisdom Eye', 'Fate Pendant'],
};

function _randInt(lo, hi) { return lo + Math.floor(Math.random() * (hi - lo + 1)); }
function _pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function generateUniqueId(existingSet) {
  let id;
  do {
    let s = 'ky';
    for (let i = 0; i < 4; i++) s += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
    id = s;
  } while (existingSet && existingSet.has(id));
  return id;
}

function _pickWeighted(pool) {
  const total = pool.reduce((s, p) => s + p.w, 0);
  let roll = Math.random() * total;
  for (const p of pool) { roll -= p.w; if (roll <= 0) return p; }
  return pool[pool.length - 1];
}

// Accessory: 2 DIFFERENT stats from weighted pool; spd uses smaller range + lower weight.
function _pickTwoWeighted(pool) {
  const first = _pickWeighted(pool);
  const rest = pool.filter((p) => p.k !== first.k);
  const second = _pickWeighted(rest);
  return [first, second];
}

function rollStats(tier, slot, variant) {
  const r = LEGEND_GEAR_RANGES[tier][slot];
  if (!r) throw new Error('No ranges for ' + tier + '/' + slot);
  const stats = {};
  let name;
  if (slot === 'weapon') {
    // pure gacha: ATK or MATK random (can't pick). Bad roll? Sell + rebuy to reroll.
    const isMatk = Math.random() < 0.5;
    const key = isMatk ? 'matk' : 'atk';
    stats[key] = _randInt(r.atk[0], r.atk[1]); // atk/matk ranges are identical
    name = isMatk ? _pick(NAMES.weapon_matk) : _pick(NAMES.weapon_atk);
  } else if (slot === 'head' || slot === 'armor') {
    // gambling: 1 random defensive stat (DEF or MDEF)
    const key = Math.random() < 0.5 ? 'def' : 'mdef';
    stats[key] = _randInt(r.stat[0], r.stat[1]);
    name = _pick(NAMES[slot]);
  } else if (slot === 'boots') {
    stats.spd = _randInt(r.spd[0], r.spd[1]);
    name = _pick(NAMES.boots);
  } else if (slot === 'accessory') {
    const pool = [{ k: 'atk', w: 3 }, { k: 'matk', w: 3 }, { k: 'def', w: 3 }, { k: 'mdef', w: 3 }, { k: 'spd', w: 1 }];
    const picked = _pickTwoWeighted(pool);
    for (const { k } of picked) {
      if (k === 'spd') stats.spd = _randInt(r.spd[0], r.spd[1]);
      else stats[k] = _randInt(r.main[0], r.main[1]);
    }
    name = _pick(NAMES.accessory);
  }
  return { stats, name };
}

function rollPassives(tier) {
  const count = TIER_INFO[tier].passives;
  const ids = Object.keys(PASSIVES);
  const picked = [];
  const used = new Set();
  while (picked.length < count) {
    const avail = ids.filter((id) => !used.has(id));
    const pool = avail.map((id) => ({ id, w: PASSIVES[id].weight }));
    const id = _pickWeighted(pool).id;
    used.add(id);
    const [lo, hi] = PASSIVES[id].ranges[tier];
    picked.push({ id, emoji: PASSIVES[id].emoji, value: _randInt(lo, hi), unit: PASSIVES[id].unit });
  }
  return picked;
}

function createUnique(tier, slot, variant, existingSet) {
  if (!TIER_PRICE[tier]) throw new Error('Unique items are Legend+ only (got ' + tier + ')');
  if (!LEGEND_GEAR_RANGES[tier] || !LEGEND_GEAR_RANGES[tier][slot]) throw new Error('Bad slot: ' + slot);
  const { stats, name } = rollStats(tier, slot, variant);
  const passives = rollPassives(tier);
  const id = generateUniqueId(existingSet);
  return {
    id,
    base: slot === 'weapon' ? 'weapon_' + (stats.matk ? 'matk' : 'atk') : slot,
    name, rarity: tier, slot, stats, passives,
    boughtAt: new Date().toISOString(),
  };
}

function sellValue(unique) {
  const price = TIER_PRICE[unique.rarity] || 0;
  return Math.round(price * 0.35);
}

module.exports = { generateUniqueId, rollStats, rollPassives, createUnique, sellValue, TIER_PRICE };
