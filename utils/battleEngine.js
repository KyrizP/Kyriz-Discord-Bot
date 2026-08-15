'use strict';

// ============================================================
// Battle Mode engine — PURE combat/economy math. No Discord, no IO.
// Fully unit-tested (test/battleEngine.test.js, incl. balance sim).
// ============================================================

const { CLASSES, GEAR, ENEMY_BASE, DROP_RARITIES, DROP_ZONES, DROPS, CRIT, PASSIVE_CAPS } = require('./battleConfig');

const STAT_KEYS = ['hp', 'atk', 'matk', 'def', 'mdef', 'spd'];
const EQUIP_SLOTS = ['weapon', 'head', 'armor', 'boots', 'accessory'];
const MAX_ROUNDS = 30; // stalemate (round cap) => enemy wins (forces offense)

// Resolve an equipment id to a stat source: g* -> GEAR template, ky* -> uniqueItems instance.
function _resolveItem(id, uniqueItems) {
  if (!id) return null;
  if (id.startsWith('ky')) return (uniqueItems && uniqueItems[id]) || null;
  return GEAR[id] || null;
}

// ---- stats: base (charLevel + class) + gear bonuses (g* or ky*) + Swift passive (flat SPD) ----
function computeStats(charLevel, charClass, equipment = {}, uniqueItems = {}) {
  const c = CLASSES[charClass];
  if (!c) throw new Error('Unknown class: ' + charClass);
  const lvl = Math.max(1, Math.floor(charLevel));
  const stats = {};
  for (const k of STAT_KEYS) stats[k] = Math.round(c.base[k] + c.growth[k] * (lvl - 1));
  for (const slot of EQUIP_SLOTS) {
    const item = _resolveItem(equipment[slot], uniqueItems);
    if (item && item.stats) {
      for (const k of Object.keys(item.stats)) {
        if (STAT_KEYS.includes(k)) stats[k] += item.stats[k];
      }
    }
  }
  // Swift passive (flat SPD) folds into spd so Combat Score + turn order reflect it.
  const passives = getPassives(equipment, uniqueItems);
  if (passives.swift) stats.spd += passives.swift;
  return stats;
}

// Sum each passive type across equipped uniques. Legend+ only (g* has none).
function getPassivesRaw(equipment = {}, uniqueItems = {}) {
  const sums = {};
  for (const slot of EQUIP_SLOTS) {
    const id = equipment[slot];
    if (id && id.startsWith('ky') && uniqueItems[id]) {
      for (const p of (uniqueItems[id].passives || [])) {
        sums[p.id] = (sums[p.id] || 0) + (p.value || 0);
      }
    }
  }
  return sums;
}
function getPassives(equipment = {}, uniqueItems = {}) {
  const sums = getPassivesRaw(equipment, uniqueItems);
  // apply stacking caps (prevent degenerate builds: 5× Lifesteal=100%, 5× Fortify=110%, etc.)
  for (const id of Object.keys(PASSIVE_CAPS)) {
    if (sums[id] != null && sums[id] > PASSIVE_CAPS[id]) sums[id] = PASSIVE_CAPS[id];
  }
  return sums;
}

function getCritChance(passives = {}) {
  return Math.min(CRIT.cap, (passives.precision || 0) / 100);
}

// ---- damage: symmetric (same formula for player & enemy => fair) ----
function physicalDamage(atk, def, mult) {
  return Math.max(1, Math.round(atk * mult - def * 0.5));
}
function magicDamage(matk, mdef, mult) {
  return Math.max(1, Math.round(matk * mult - mdef * 0.5));
}

// ---- enemy generation: exponential per floor ----
function generateEnemy(floor) {
  const f = Math.max(1, Math.floor(floor));
  const k = Math.pow(ENEMY_BASE.scale, f - 1);
  const atk = Math.round(ENEMY_BASE.atk * k);
  const matk = Math.round(ENEMY_BASE.matk * k);
  const type = atk >= matk ? 'physical' : 'magic';
  return {
    floor: f,
    hp: Math.round(ENEMY_BASE.hp * k),
    atk, matk,
    def: Math.round(ENEMY_BASE.def * k),
    mdef: Math.round(ENEMY_BASE.mdef * k),
    spd: Math.round(ENEMY_BASE.spd * k),
    critChance: f >= CRIT.enemyFloor ? CRIT.enemyChance : 0,
    rotation: [{ mult: 1.0, type: 'physical' }, { mult: 1.0, type: 'magic' }],
  };
}

// PvE auto-resolve. player = { stats, hp, skills, passives }. Pure. SPD = turn order (ties=>player).
function resolveFight(player, enemy) {
  const stats = player.stats;
  const skills = (player.skills && player.skills.length) ? player.skills : null;
  const p = player.passives || {};
  let php = player.hp;
  let ehp = enemy.hp;
  const pMax = stats.hp;
  const playerFirst = stats.spd >= enemy.spd;

  const cdLeft = {};               // skill id -> turns of CD remaining
  const buff = { atkPct: 0, turns: 0, dmgReduce: 0 }; // War Cry self-buff (atk + damage-taken reduce)
  let parryBlocks = 0;              // Parry Strike -> blocks next N enemy hits
  const enemyBurn = { dmg: 0, turns: 0 }; // player's burn on the enemy
  const pattern = skills ? [0, 1, 0, 1, 2] : null; // basic, s2, basic, s2, ult
  let pi = 0, ei = 0, rounds = 0;
  const log = [];
  const crit = getCritChance(p);

  const _playerHit = () => {
    if (skills) for (const k of Object.keys(cdLeft)) if (cdLeft[k] > 0) cdLeft[k] -= 1; // tick CDs
    let skill;
    if (skills) {
      const want = skills[pattern[pi % pattern.length]]; pi++;
      skill = (cdLeft[want.id] || 0) <= 0 ? want : skills[0]; // CD-skip -> basic
    } else {
      skill = { mult: 1.0, type: stats.atk >= stats.matk ? 'physical' : 'magic' };
    }
    const atkMult = buff.turns > 0 ? (1 + buff.atkPct / 100) : 1;
    if (buff.turns > 0) buff.turns -= 1; // buff applies to this hit, then expends a turn
    const pierce = (skill.effect && skill.effect.pierce) ? skill.effect.pierce : 0;
    let dmg = skill.type === 'magic'
      ? magicDamage(stats.matk * atkMult, enemy.mdef * (1 - pierce), skill.mult)
      : physicalDamage(stats.atk * atkMult, enemy.def * (1 - pierce), skill.mult);
    if ((p.berserker || 0) > 0) dmg = Math.round(dmg * (1 + p.berserker / 100));
    if (crit > 0 && Math.random() < crit) dmg = Math.floor(dmg * CRIT.mult);
    ehp -= dmg;
    if ((p.lifesteal || 0) > 0) php = Math.min(pMax, php + Math.floor(dmg * p.lifesteal / 100));
    if (skill.effect) {
      if (skill.effect.kind === 'buff') { buff.atkPct = skill.effect.pct; buff.turns = skill.effect.turns; buff.dmgReduce = skill.effect.dmgReduce || 0; }
      else if (skill.effect.kind === 'parry') { parryBlocks = 1; }
      else if (skill.effect.kind === 'burn') { enemyBurn.dmg = Math.round(stats.matk * skill.effect.pct / 100); enemyBurn.turns = skill.effect.turns; }
    }
    if (skill.cd) cdLeft[skill.id] = skill.cd;
  };

  const _enemyHit = () => {
    if (enemyBurn.turns > 0) { ehp -= enemyBurn.dmg; enemyBurn.turns -= 1; if (ehp <= 0) return; } // burn ticks first
    let dmg;
    if (parryBlocks > 0) { dmg = 0; parryBlocks -= 1; }            // parry blocks the hit
    else if ((p.evasion || 0) > 0 && Math.random() < p.evasion / 100) { dmg = 0; } // dodge
    else {
      const sk = enemy.rotation[ei % enemy.rotation.length]; ei++;
      dmg = sk.type === 'magic' ? magicDamage(enemy.matk, stats.mdef, sk.mult) : physicalDamage(enemy.atk, stats.def, sk.mult);
      if ((enemy.critChance || 0) > 0 && Math.random() < enemy.critChance) dmg = Math.floor(dmg * CRIT.mult);
      if (buff.turns > 0 && (buff.dmgReduce || 0) > 0) dmg = Math.round(dmg * (1 - buff.dmgReduce / 100)); // War Cry self-DR
      if ((p.fortify || 0) > 0) dmg = Math.round(dmg * (1 - p.fortify / 100));
      if (dmg < 1) dmg = 1;                                          // min 1 chip unless parried/evaded
    }
    if (dmg > 0) php -= dmg;
  };

  while (php > 0 && ehp > 0 && rounds < MAX_ROUNDS) {
    log.push({ php: Math.max(0, php), ehp: Math.max(0, ehp) });
    rounds++;
    if (playerFirst) { _playerHit(); if (ehp <= 0) break; _enemyHit(); if (php <= 0) break; }
    else { _enemyHit(); if (php <= 0) break; _playerHit(); if (ehp <= 0) break; }
  }
  log.push({ php: Math.max(0, php), ehp: Math.max(0, ehp) });
  const playerDead = php <= 0, enemyDead = ehp <= 0;
  let winner;
  if (playerDead && enemyDead) winner = playerFirst ? 'player' : 'enemy';
  else if (enemyDead) winner = 'player';
  else if (playerDead) winner = 'enemy';
  else winner = 'enemy'; // stalemate => enemy
  return { winner, rounds, playerHpLeft: Math.max(0, php), enemyHpLeft: Math.max(0, ehp), log };
}

// ---- drops: pick a rarity tier by weight(floor), then a random item of that tier ----
const _byRarity = {};
for (const id of Object.keys(DROPS)) {
  const r = DROPS[id].rarity;
  (_byRarity[r] = _byRarity[r] || []).push(DROPS[id]);
}

function _zoneFor(floor) {
  for (const z of DROP_ZONES) if (floor >= z.min && floor <= z.max) return z;
  return DROP_ZONES[DROP_ZONES.length - 1];
}

function rollDrop(floor) {
  const f = Math.max(1, Math.floor(floor));
  const zone = _zoneFor(f);
  const ids = Object.keys(zone.weights);
  const total = ids.reduce((s, id) => s + Math.max(0, zone.weights[id] || 0), 0);
  let roll = Math.random() * total;
  let rarity = 'common';
  for (const id of ids) {
    roll -= Math.max(0, zone.weights[id] || 0);
    if (roll <= 0) { rarity = id; break; }
  }
  const pool = _byRarity[rarity] || _byRarity['common'];
  const item = pool[Math.floor(Math.random() * pool.length)];
  return { id: item.id, name: item.name, rarity: item.rarity, value: item.value };
}

// ---- merchant: v1 flat = the item's value ----
function merchantPrice(drop) {
  if (drop && drop.value != null) return drop.value;
  const tier = DROP_RARITIES.find((r) => r.id === (drop && drop.rarity)) || DROP_RARITIES[0];
  return Math.round((tier.value[0] + tier.value[1]) / 2);
}

// ---- balance sim: a full auto delve (push until death). THE BALANCE GATE. ----
function simulateDelve(charLevel, charClass, equipment = {}, uniqueItems = {}, opts = {}) {
  const maxFloors = opts.maxFloors || 100;
  const stats = computeStats(charLevel, charClass, equipment, uniqueItems);
  const cls = CLASSES[charClass];
  const passives = getPassives(equipment, uniqueItems);
  let php = stats.hp;
  let deathFloor = 0;
  let floorsCleared = 0;
  let kryptonitePotential = 0;
  const dropsByRarity = {};

  for (let floor = 1; floor <= maxFloors; floor++) {
    if (php <= 0) { deathFloor = floor - 1; break; }
    const enemy = generateEnemy(floor);
    const result = resolveFight({ stats, hp: php, skills: cls.skills, passives }, enemy);
    if (result.winner === 'player') {
      floorsCleared = floor;
      php = result.playerHpLeft; // HP persists across floors (no heal in v1)
      let drop = rollDrop(floor);
      if ((passives.greed || 0) > 0) drop.value = Math.round(drop.value * (1 + passives.greed / 100));
      kryptonitePotential += merchantPrice(drop);
      dropsByRarity[drop.rarity] = (dropsByRarity[drop.rarity] || 0) + 1;
    } else {
      deathFloor = floor; // died on this floor — its drop is unbanked (lost)
      php = 0;
      break;
    }
  }
  if (deathFloor === 0) deathFloor = maxFloors; // survived to cap
  return { deathFloor, floorsCleared, kryptonitePotential, dropsByRarity };
}

module.exports = {
  computeStats, getPassivesRaw, getPassives, getCritChance, physicalDamage, magicDamage, generateEnemy, resolveFight,
  rollDrop, merchantPrice, simulateDelve, STAT_KEYS, EQUIP_SLOTS, MAX_ROUNDS,
};
