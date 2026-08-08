'use strict';

// ============================================================
// Battle Mode engine — PURE combat/economy math. No Discord, no IO.
// Fully unit-tested (test/battleEngine.test.js, incl. balance sim).
// ============================================================

const { CLASSES, GEAR, ENEMY_BASE, DROP_RARITIES, DROPS } = require('./battleConfig');

const STAT_KEYS = ['hp', 'atk', 'matk', 'def', 'mdef', 'spd'];
const EQUIP_SLOTS = ['weapon', 'head', 'armor', 'boots', 'accessory'];
const MAX_ROUNDS = 30; // stalemate (round cap) => enemy wins (forces offense)

// ---- stats: base (charLevel + class) + gear bonuses ----
function computeStats(charLevel, charClass, equipment = {}) {
  const c = CLASSES[charClass];
  if (!c) throw new Error('Unknown class: ' + charClass);
  const lvl = Math.max(1, Math.floor(charLevel));
  const stats = {};
  for (const k of STAT_KEYS) stats[k] = Math.round(c.base[k] + c.growth[k] * (lvl - 1));
  for (const slot of EQUIP_SLOTS) {
    const item = equipment[slot] ? GEAR[equipment[slot]] : null;
    if (item && item.stats) {
      for (const k of Object.keys(item.stats)) {
        if (STAT_KEYS.includes(k)) stats[k] += item.stats[k];
      }
    }
  }
  return stats;
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
    rotation: [{ mult: 1.0, type }],
  };
}

function _dmg(attacker, defender, skill) {
  return skill.type === 'magic'
    ? magicDamage(attacker.matk, defender.mdef, skill.mult)
    : physicalDamage(attacker.atk, defender.def, skill.mult);
}

// ---- auto-resolve one fight. SPD = turn order only (ties => player). HP carried by caller. ----
function resolveFight(playerStats, playerRotation, enemy) {
  const rot = (playerRotation && playerRotation.length)
    ? playerRotation
    : [{ mult: 1.0, type: playerStats.atk >= playerStats.matk ? 'physical' : 'magic' }];
  let php = playerStats.hp;
  let ehp = enemy.hp;
  const playerFirst = playerStats.spd >= enemy.spd;
  let rounds = 0, pi = 0, ei = 0;
  const log = []; // round-by-round HP states for battle animation
  while (php > 0 && ehp > 0 && rounds < MAX_ROUNDS) {
    log.push({ php: Math.max(0, php), ehp: Math.max(0, ehp) }); // state at start of round
    rounds++;
    if (playerFirst) {
      ehp -= _dmg(playerStats, enemy, rot[pi % rot.length]); pi++;
      if (ehp <= 0) break;
      php -= _dmg(enemy, playerStats, enemy.rotation[ei % enemy.rotation.length]); ei++;
    } else {
      php -= _dmg(enemy, playerStats, enemy.rotation[ei % enemy.rotation.length]); ei++;
      if (php <= 0) break;
      ehp -= _dmg(playerStats, enemy, rot[pi % rot.length]); pi++;
    }
  }
  log.push({ php: Math.max(0, php), ehp: Math.max(0, ehp) }); // final state (incl. death)
  const playerDead = php <= 0;
  const enemyDead = ehp <= 0;
  let winner;
  if (playerDead && enemyDead) winner = playerFirst ? 'player' : 'enemy';   // last striker wins
  else if (enemyDead) winner = 'player';
  else if (playerDead) winner = 'enemy';
  else winner = 'enemy';                                                     // stalemate => enemy
  return { winner, rounds, playerHpLeft: Math.max(0, php), enemyHpLeft: Math.max(0, ehp), log };
}

// ---- drops: pick a rarity tier by weight(floor), then a random item of that tier ----
const _byRarity = {};
for (const id of Object.keys(DROPS)) {
  const r = DROPS[id].rarity;
  (_byRarity[r] = _byRarity[r] || []).push(DROPS[id]);
}

function rollDrop(floor) {
  const weights = DROP_RARITIES.map((r) => Math.max(0, r.weight(floor)));
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = Math.random() * total;
  let tier = DROP_RARITIES[0];
  for (let i = 0; i < DROP_RARITIES.length; i++) {
    roll -= weights[i];
    if (roll <= 0) { tier = DROP_RARITIES[i]; break; }
  }
  const pool = _byRarity[tier.id] || _byRarity['common'];
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
function simulateDelve(charLevel, charClass, equipment = {}, opts = {}) {
  const maxFloors = opts.maxFloors || 100;
  const stats = computeStats(charLevel, charClass, equipment);
  const cls = CLASSES[charClass];
  let php = stats.hp;
  let deathFloor = 0;
  let floorsCleared = 0;
  let kryptonitePotential = 0;
  const dropsByRarity = {};

  for (let floor = 1; floor <= maxFloors; floor++) {
    if (php <= 0) { deathFloor = floor - 1; break; }
    const enemy = generateEnemy(floor);
    const result = resolveFight({ ...stats, hp: php }, cls.rotation, enemy);
    if (result.winner === 'player') {
      floorsCleared = floor;
      php = result.playerHpLeft; // HP persists across floors (no heal in v1)
      const drop = rollDrop(floor);
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
  computeStats, physicalDamage, magicDamage, generateEnemy, resolveFight,
  rollDrop, merchantPrice, simulateDelve, STAT_KEYS, EQUIP_SLOTS, MAX_ROUNDS,
};
