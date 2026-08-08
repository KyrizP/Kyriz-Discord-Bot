'use strict';

// ============================================================
// Battle Mode stateful manager.
// Pure apply-* functions (testable — take/return the data object) +
// thin IO wrappers (read -> apply -> write, atomic) + in-memory run Map.
// Reuses economyManager helpers. No edits to existing game logic.
//
// Run state lives in-memory only (activeRuns Map). Restart-mid-run loses
// the run (entry fee already persisted) — same risk profile as crash/mines.
// ============================================================

const { CLASSES, GEAR, DROPS } = require('./battleConfig');
const { computeStats, generateEnemy, resolveFight, rollDrop } = require('./battleEngine');
const economy = require('./economyManager');
const { isSuperAdmin } = economy;

const ENTRY_FEE = 15000;
const SWEEP_BUFFER = 5;          // sweep resolves floors 1..(bestDepth - SWEEP_BUFFER) instantly
const GEAR_SELLBACK = 0.4;       // sell-back gear at 40% of price
const CHAR_EXP_BASE = 100;
const charExpFor = (f) => 8 + Math.floor(f * 1.5);   // char exp per floor cleared (tunable)
const profileXpFor = (floors) => Math.max(0, floors) * 15;

// ---------- ensure battle data (nested under user.battle — max isolation) ----------
function ensureBattleData(user) {
  if (!user.battle) {
    user.battle = {
      kryptonite: 0,
      charLevel: 1, charExp: 0, charExpNeeded: CHAR_EXP_BASE,
      charClass: null,
      equipment: { weapon: null, head: null, armor: null, boots: null, accessory: null },
      bag: {},
      bestDepth: 0,
    };
  }
  return user.battle;
}

// ---------- pure apply-functions (mutate the passed data object; no IO) ----------
function applyCreateCharacter(data, userId, classId) {
  const b = ensureBattleData(data[userId]);
  if (!CLASSES[classId]) return { ok: false, reason: 'Invalid class. Pick warrior or mage.' };
  if (b.charClass) return { ok: false, reason: 'You already have a character.' };
  b.charClass = classId;
  return { ok: true };
}

function applyGainCharExp(data, userId, exp) {
  const b = ensureBattleData(data[userId]);
  if (!b.charClass) return { leveledUp: false, newLevel: b.charLevel };
  b.charExp += Math.max(0, Math.floor(exp));
  let leveledUp = false;
  while (b.charExp >= b.charExpNeeded) {
    b.charExp -= b.charExpNeeded;
    b.charLevel += 1;
    b.charExpNeeded = Math.floor(CHAR_EXP_BASE * Math.pow(1.15, b.charLevel - 1));
    leveledUp = true;
  }
  return { leveledUp, newLevel: b.charLevel };
}

function applyDelveStart(data, userId) {
  const u = data[userId];
  if (!u) return { ok: false, reason: 'You are not registered. Use `ky register` first.' };
  const b = ensureBattleData(u);
  if (!b.charClass) return { ok: false, reason: 'no_character' };
  if (!isSuperAdmin(userId)) {
    if ((u.balance || 0) < ENTRY_FEE) return { ok: false, reason: 'Insufficient 💎 Kryztal for entry (need 15,000).' };
    u.balance -= ENTRY_FEE;
  }
  return { ok: true, paid: !isSuperAdmin(userId) };
}

// Extract: bank the run bag (drops) + accumulated char exp; update bestDepth.
function applyExtract(data, userId, runState) {
  const b = ensureBattleData(data[userId]);
  let banked = 0;
  for (const id of Object.keys(runState.bag || {})) {
    b.bag[id] = (b.bag[id] || 0) + runState.bag[id];
    banked += runState.bag[id];
  }
  const reached = Math.max(0, (runState.floor || 1) - 1);
  if (reached > b.bestDepth) b.bestDepth = reached;
  let expRes = { leveledUp: false, newLevel: b.charLevel };
  if (runState.expAccum) expRes = applyGainCharExp(data, userId, runState.expAccum);
  return { banked, exp: runState.expAccum || 0, leveledUp: expRes.leveledUp, newLevel: expRes.newLevel };
}

// Die: drops lost, BUT char exp is kept (sticky progression); update bestDepth.
function applyDie(data, userId, runState) {
  const b = ensureBattleData(data[userId]);
  let lost = 0;
  for (const id of Object.keys(runState.bag || {})) lost += runState.bag[id];
  if ((runState.floor || 0) > b.bestDepth) b.bestDepth = runState.floor;
  let expRes = { leveledUp: false, newLevel: b.charLevel };
  if (runState.expAccum) expRes = applyGainCharExp(data, userId, runState.expAccum);
  return { lost, exp: runState.expAccum || 0, leveledUp: expRes.leveledUp, newLevel: expRes.newLevel };
}

function applySell(data, userId, itemId, qty) {
  const b = ensureBattleData(data[userId]);
  if (itemId === 'all') {
    let kry = 0, sold = 0;
    for (const id of Object.keys(b.bag)) {
      if (DROPS[id]) { kry += DROPS[id].value * b.bag[id]; sold += b.bag[id]; delete b.bag[id]; }
    }
    b.kryptonite += kry;
    return { sold, kryptonite: kry };
  }
  const item = DROPS[itemId];
  if (!item) return { sold: 0, kryptonite: 0, reason: 'Not a sellable drop. (Equipment: `ky sellgear <code>`.)' };
  const have = b.bag[itemId] || 0;
  const n = qty === 'all' ? have : Math.min(have, Math.max(1, Math.floor(qty || 1)));
  if (n <= 0) return { sold: 0, kryptonite: 0, reason: 'You have none of that.' };
  b.bag[itemId] -= n;
  if (b.bag[itemId] <= 0) delete b.bag[itemId];
  const kry = item.value * n;
  b.kryptonite += kry;
  return { sold: n, kryptonite: kry, name: item.name };
}

function applySellGear(data, userId, itemId) {
  const b = ensureBattleData(data[userId]);
  const item = GEAR[itemId];
  if (!item) return { ok: false, reason: 'Not equipment.' };
  if (Object.values(b.equipment).includes(itemId)) return { ok: false, reason: 'Unequip it first (`ky unequip <slot>`).' };
  if (!b.bag[itemId]) return { ok: false, reason: 'Not in your bag.' };
  delete b.bag[itemId];
  const kry = Math.round((item.price || 0) * GEAR_SELLBACK);
  b.kryptonite += kry;
  return { ok: true, kryptonite: kry, name: item.name };
}

function applyEquip(data, userId, itemId) {
  const b = ensureBattleData(data[userId]);
  const item = GEAR[itemId];
  if (!item) return { ok: false, reason: 'Not equipment.' };
  if (!b.bag[itemId]) return { ok: false, reason: 'Not in your bag.' };
  const slot = item.slot;
  const prev = b.equipment[slot];
  b.equipment[slot] = itemId;
  delete b.bag[itemId];
  if (prev) b.bag[prev] = (b.bag[prev] || 0) + 1;
  return { ok: true, slot, swapped: prev };
}

function applyUnequip(data, userId, slot) {
  const b = ensureBattleData(data[userId]);
  if (!(slot in b.equipment)) return { ok: false, reason: 'Invalid slot.' };
  const itemId = b.equipment[slot];
  if (!itemId) return { ok: false, reason: 'Nothing equipped there.' };
  b.equipment[slot] = null;
  b.bag[itemId] = (b.bag[itemId] || 0) + 1;
  return { ok: true, slot, itemId };
}

// Buy gear with Kryptonite. Guard: registered + sufficient kryptonite. No char required.
function applyBuyGear(data, userId, itemId) {
  const u = data[userId];
  if (!u) return { ok: false, reason: 'You are not registered.' };
  const b = ensureBattleData(u);
  const item = GEAR[itemId];
  if (!item) return { ok: false, reason: 'No such equipment. See `ky shop equipment`.' };
  if ((b.kryptonite || 0) < item.price) return { ok: false, reason: `Insufficient 🧪 Kryptonite (need ${item.price.toLocaleString()}).` };
  b.kryptonite -= item.price;
  b.bag[itemId] = (b.bag[itemId] || 0) + 1;
  return { ok: true, name: item.name, price: item.price, kryptonite: b.kryptonite };
}

// ---------- in-memory run state ----------
const activeRuns = new Map(); // userId -> { floor, hp, bag, expAccum, classId, stats }

// ---------- IO wrappers (read -> apply -> write) ----------
function createCharacter(userId, classId) {
  const data = economy.readEconomy();
  const r = applyCreateCharacter(data, userId, classId);
  if (r.ok) economy.writeEconomy(data);
  return r;
}

function startDelve(userId) {
  const data = economy.readEconomy();
  const start = applyDelveStart(data, userId);
  if (!start.ok) return { ok: false, reason: start.reason, needClass: start.reason === 'no_character' };
  const b = ensureBattleData(data[userId]);
  const stats = computeStats(b.charLevel, b.charClass, b.equipment);
  const run = { userId, floor: 1, hp: stats.hp, bag: {}, expAccum: 0, classId: b.charClass, stats };
  // sweep: auto-resolve safe floors instantly (economy-safe — gated by entry fee)
  const sweepTo = Math.max(1, b.bestDepth - SWEEP_BUFFER);
  const swept = {};
  for (; run.floor < sweepTo; run.floor++) {
    const enemy = generateEnemy(run.floor);
    const r = resolveFight({ ...run.stats, hp: run.hp }, CLASSES[run.classId].rotation, enemy);
    if (r.winner !== 'player') break; // would die during sweep — play live from here
    run.hp = r.playerHpLeft;
    const drop = rollDrop(run.floor);
    run.bag[drop.id] = (run.bag[drop.id] || 0) + 1;
    swept[drop.id] = (swept[drop.id] || 0) + 1;
    run.expAccum += charExpFor(run.floor);
  }
  economy.writeEconomy(data); // persist entry-fee deduction
  activeRuns.set(userId, run);
  return { ok: true, paid: start.paid, run, stats, startFloor: run.floor, swept };
}

function hasActiveRun(userId) { return activeRuns.has(userId); }
function getRun(userId) { return activeRuns.get(userId) || null; }

// Resolve the run's current floor (Push). Run state in-memory; writes only on death.
function nextFloor(userId) {
  const run = activeRuns.get(userId);
  if (!run) return { ok: false, reason: 'No active battle. Use `ky battle`.' };
  const enemy = generateEnemy(run.floor);
  const fight = resolveFight({ ...run.stats, hp: run.hp }, CLASSES[run.classId].rotation, enemy);
  if (fight.winner === 'player') {
    run.hp = fight.playerHpLeft;
    const drop = rollDrop(run.floor);
    run.bag[drop.id] = (run.bag[drop.id] || 0) + 1;
    run.expAccum += charExpFor(run.floor);
    const cleared = run.floor;
    run.floor += 1;
    return { ok: true, won: true, cleared, hp: run.hp, drop, nextFloor: run.floor };
  }
  const diedAt = run.floor;
  const data = economy.readEconomy();
  const res = applyDie(data, userId, run);
  economy.writeEconomy(data);
  activeRuns.delete(userId);
  return { ok: true, won: false, diedAt, lost: res.lost, exp: res.exp, leveledUp: res.leveledUp, newLevel: res.newLevel };
}

function extractRun(userId) {
  const run = activeRuns.get(userId);
  if (!run) return { ok: false, reason: 'No active battle.' };
  const depth = run.floor - 1;
  const data = economy.readEconomy();
  const res = applyExtract(data, userId, run);
  economy.writeEconomy(data);
  try { economy.addXP(userId, profileXpFor(depth)); } catch (_) { /* profile XP best-effort */ }
  activeRuns.delete(userId);
  return { ok: true, banked: res.banked, exp: res.exp, depth, leveledUp: res.leveledUp, newLevel: res.newLevel };
}

function sell(userId, itemId, qty) {
  const data = economy.readEconomy();
  const r = applySell(data, userId, itemId, qty);
  economy.writeEconomy(data);
  return r;
}
function sellGear(userId, itemId) {
  const data = economy.readEconomy();
  const r = applySellGear(data, userId, itemId);
  economy.writeEconomy(data);
  return r;
}
function equip(userId, itemId) {
  const data = economy.readEconomy();
  const r = applyEquip(data, userId, itemId);
  economy.writeEconomy(data);
  return r;
}
function unequip(userId, slot) {
  const data = economy.readEconomy();
  const r = applyUnequip(data, userId, slot);
  economy.writeEconomy(data);
  return r;
}
function buyGear(userId, itemId) {
  const data = economy.readEconomy();
  const r = applyBuyGear(data, userId, itemId);
  if (r.ok) economy.writeEconomy(data);
  return r;
}

module.exports = {
  ensureBattleData, applyCreateCharacter, applyGainCharExp, applyDelveStart, applyExtract, applyDie,
  applySell, applySellGear, applyEquip, applyUnequip, applyBuyGear,
  createCharacter, startDelve, nextFloor, extractRun, hasActiveRun, getRun, sell, sellGear, equip, unequip, buyGear,
  ENTRY_FEE, GEAR_SELLBACK,
};
