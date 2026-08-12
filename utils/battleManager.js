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
const { computeStats, generateEnemy, resolveFight, rollDrop, getPassives } = require('./battleEngine');
const economy = require('./economyManager');
const { isSuperAdmin } = economy;
const unique = require('./uniqueItems');

const ENTRY_FEE = 5000;
const SWEEP_BUFFER = 5;          // sweep resolves floors 1..(bestDepth - SWEEP_BUFFER) instantly
const GEAR_SELLBACK = 0.35;      // sell-back gear at 35% (all tiers, v1.1)
const CHAR_EXP_BASE = 100;
const charExpFor = (f) => 8 + Math.floor(f * 1.5);   // char exp per floor cleared (tunable)
const PROFILE_XP_EXTRACT = 50; // fixed profile XP on successful extract
const PROFILE_XP_DIE = 20; // fixed profile XP on death (consolation)

// ---------- ensure battle data (nested under user.battle — max isolation) ----------
function ensureBattleData(user) {
  if (!user.battle) {
    user.battle = {
      kryptonite: 0,
      charLevel: 1, charExp: 0, charExpNeeded: CHAR_EXP_BASE,
      charClass: null,
      charName: null,
      scoreAchievedAt: null,
      equipment: { weapon: null, head: null, armor: null, boots: null, accessory: null },
      bag: {}, uniqueItems: {},
      bestDepth: 0, pvpWins: 0, pvpLosses: 0,
    };
  }
  // backfill v1.1 fields for existing users (lazy migration)
  const b = user.battle;
  if (!b.uniqueItems) b.uniqueItems = {};
  if (!b.equipment || !b.equipment.accessory) b.equipment = Object.assign({ weapon: null, head: null, armor: null, boots: null, accessory: null }, b.equipment || {});
  if (b.bestDepth == null) b.bestDepth = 0;
  if (b.pvpWins == null) b.pvpWins = 0;
  if (b.pvpLosses == null) b.pvpLosses = 0;
  return b;
}

// Superadmin bypasses the T&C registration gate, so they have no economy entry by default.
// Auto-create a minimal entry so they can play battle like a normal player.
function ensureUser(data, userId) {
  if (!data[userId] && isSuperAdmin(userId)) {
    data[userId] = { username: 'Superadmin', balance: 0, level: 1, xp: 0, xpNeeded: 400,
      totalWins: 0, totalLosses: 0, totalEarned: 0, totalLost: 0, lastDaily: null, registeredAt: new Date().toISOString() };
  }
  return data[userId] || null;
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
    b.charExpNeeded = CHAR_EXP_BASE + 50 * (b.charLevel - 1); // LINEAR — leveling feasible at any level (no stall -> farm window keeps shifting up)
    b.scoreAchievedAt = new Date().toISOString(); // track when current stats were achieved (lb tiebreaker)
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
    if ((u.balance || 0) < ENTRY_FEE) return { ok: false, reason: `Insufficient 💎 Kryztal for entry (need ${ENTRY_FEE.toLocaleString()}).` };
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

// Die: lose EVERYTHING this run (drops + Char EXP). NO bestDepth update —
// checkpoint (sweep target) is only saved on a successful Extract.
function applyDie(data, userId, runState) {
  ensureBattleData(data[userId]);
  let lost = 0;
  for (const id of Object.keys(runState.bag || {})) lost += runState.bag[id];
  return { lost };
}

function applySell(data, userId, itemId, qty) {
  const b = ensureBattleData(data[userId]);
  const greedMult = 1 + (getPassives(b.equipment, b.uniqueItems).greed || 0) / 100; // Greed passive boosts sell value
  if (itemId === 'all') {
    let kry = 0, sold = 0;
    for (const id of Object.keys(b.bag)) {
      if (DROPS[id]) { kry += Math.round(DROPS[id].value * b.bag[id] * greedMult); sold += b.bag[id]; delete b.bag[id]; }
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
  const kry = Math.round(item.value * n * greedMult);
  b.kryptonite += kry;
  return { sold: n, kryptonite: kry, name: item.name };
}

function applySellGear(data, userId, itemId, qty) {
  const b = ensureBattleData(data[userId]);
  if (itemId && itemId.startsWith('ky')) {
    const uq = b.uniqueItems[itemId];
    if (!uq) return { ok: false, reason: 'Not in your collection.' };
    for (const sl of Object.keys(b.equipment)) if (b.equipment[sl] === itemId) return { ok: false, reason: 'Unequip it first.' };
    const kry = unique.sellValue(uq);
    delete b.uniqueItems[itemId];
    b.kryptonite += kry;
    return { ok: true, kryptonite: kry, name: uq.name, sold: 1 };
  }
  // Rarity sell: `ky sellgear <rarity>` or `ky sellgear <abbr>` — sell ALL unequipped gear of that tier.
  // Each at its OWN sellback price (unique = 35% of tier price; template = 35% of item price).
  const RARITY_ABBR = { l: 'legendary', m: 'mythic', d: 'divine', e: 'epic', r: 'rare', u: 'uncommon', c: 'common' };
  const tier = RARITY_ABBR[itemId] || (['legendary', 'mythic', 'divine', 'epic', 'rare', 'uncommon', 'common'].includes(itemId) ? itemId : null);
  if (tier) {
    if (qty !== 'all') return { ok: false, reason: 'Sell ALL ' + tier + ' gear? Use `ky sellgear ' + itemId + ' all` (requires confirmation).' };
    let kry = 0, sold = 0;
    // unique items
    for (const id of Object.keys(b.uniqueItems)) {
      let equipped = false;
      for (const sl of Object.keys(b.equipment)) if (b.equipment[sl] === id) { equipped = true; break; }
      if (equipped) continue;
      if (b.uniqueItems[id].rarity === tier) { kry += unique.sellValue(b.uniqueItems[id]); delete b.uniqueItems[id]; sold++; }
    }
    // template g-items
    for (const id of Object.keys(b.bag)) {
      if (GEAR[id] && GEAR[id].rarity === tier && b.bag[id] > 0) {
        kry += Math.round(GEAR[id].price * GEAR_SELLBACK * b.bag[id]);
        sold += b.bag[id];
        delete b.bag[id];
      }
    }
    if (sold === 0) return { ok: false, reason: 'No unequipped ' + tier + ' gear to sell.' };
    b.kryptonite += kry;
    return { ok: true, kryptonite: kry, sold, name: sold + '× ' + tier };
  }
  const item = GEAR[itemId];
  if (!item) return { ok: false, reason: 'Not equipment.' };
  // Equipped gear lives in b.equipment (separate from b.bag spares). Selling from bag
  // (spares) never touches the equipped copy -> no unequip needed to sell spares.
  const have = b.bag[itemId] || 0;
  if (have <= 0) return { ok: false, reason: 'Not in your bag. (To sell the equipped copy, `ky unequip` it first.)' };
  const n = qty === 'all' ? have : Math.min(have, Math.max(1, Math.floor(qty || 1))); // default 1, each at sellback
  b.bag[itemId] -= n;
  if (b.bag[itemId] <= 0) delete b.bag[itemId];
  const kry = Math.round((item.price || 0) * GEAR_SELLBACK * n);
  b.kryptonite += kry;
  return { ok: true, kryptonite: kry, name: item.name, sold: n };
}

function applyEquip(data, userId, itemId) {
  const b = ensureBattleData(data[userId]);
  if (!itemId) return { ok: false, reason: 'Equip what? Usage: `ky equip <g-code|ky-id>`' };
  if (itemId.startsWith('ky')) {
    const uq = b.uniqueItems[itemId];
    if (!uq) return { ok: false, reason: 'Not in your collection.' };
    for (const sl of Object.keys(b.equipment)) if (b.equipment[sl] === itemId) return { ok: false, reason: 'Already equipped.' };
    const slot = uq.slot;
    const prev = b.equipment[slot];
    b.equipment[slot] = itemId;
    if (prev && prev.startsWith('g')) b.bag[prev] = (b.bag[prev] || 0) + 1; // ky prev stays spare in uniqueItems
    b.scoreAchievedAt = new Date().toISOString();
    return { ok: true, slot, swapped: prev };
  }
  const item = GEAR[itemId];
  if (!item) return { ok: false, reason: 'Not equipment.' };
  if (!b.bag[itemId]) return { ok: false, reason: 'Not in your bag.' };
  const slot = item.slot;
  const prev = b.equipment[slot];
  b.equipment[slot] = itemId;
  delete b.bag[itemId];
  if (prev) { if (prev.startsWith('g')) b.bag[prev] = (b.bag[prev] || 0) + 1; }
  b.scoreAchievedAt = new Date().toISOString(); // stats changed → lb tiebreaker
  return { ok: true, slot, swapped: prev };
}

function applyUnequip(data, userId, slot) {
  const b = ensureBattleData(data[userId]);
  if (!(slot in (b.equipment || {}))) return { ok: false, reason: 'Invalid slot.' };
  const itemId = b.equipment[slot];
  if (!itemId) return { ok: false, reason: 'Nothing equipped there.' };
  b.equipment[slot] = null;
  if (itemId.startsWith('g')) b.bag[itemId] = (b.bag[itemId] || 0) + 1; // ky stays in uniqueItems as spare
  b.scoreAchievedAt = new Date().toISOString(); // stats changed → lb tiebreaker
  return { ok: true, slot, itemId };
}

// Set character display name (shown in ky char/battle/gear/bag). Validated.
function applySetCharName(data, userId, name) {
  const u = ensureUser(data, userId);
  if (!u) return { ok: false, reason: 'Not registered.' };
  const b = ensureBattleData(u);
  if (!b.charClass) return { ok: false, reason: 'Create a character first (`ky battle`).' };
  name = (name || '').trim();
  if (!name) return { ok: false, reason: 'Name cannot be empty. Usage: `ky name <name>`' };
  if (name.length > 20) return { ok: false, reason: 'Name too long (max 20 chars).' };
  if (!/^[\w\s\-']{1,20}$/.test(name)) return { ok: false, reason: 'Invalid characters. Use letters, numbers, spaces, -, _.' };
  b.charName = name;
  return { ok: true, name };
}
function setCharName(userId, name) {
  const data = economy.readEconomy();
  ensureUser(data, userId);
  const r = applySetCharName(data, userId, name);
  if (r.ok) economy.writeEconomy(data);
  return r;
}
function getCharName(userId) {
  const data = economy.readEconomy();
  const u = data[userId];
  return (u && u.battle && u.battle.charName) ? u.battle.charName : null;
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

// Buy a Legend+ unique (gacha). Atomic: no unique created if insufficient kry.
function applyBuyUnique(data, userId, tier, slot, variant) {
  const u = data[userId];
  if (!u) return { ok: false, reason: 'You are not registered.' };
  const b = ensureBattleData(u);
  if (!unique.TIER_PRICE[tier]) return { ok: false, reason: 'Tier must be legendary, mythic, or divine.' };
  const price = unique.TIER_PRICE[tier];
  if ((b.kryptonite || 0) < price) return { ok: false, reason: `Insufficient 🧪 Kryptonite (need ${price.toLocaleString()}).` };
  const existing = new Set(Object.keys(b.uniqueItems));
  const uniq = unique.createUnique(tier, slot, variant, existing);
  b.kryptonite -= price;
  b.uniqueItems[uniq.id] = uniq;
  return { ok: true, unique: uniq, price, kryptonite: b.kryptonite };
}

// ---------- in-memory run state ----------
const activeRuns = new Map(); // userId -> { floor, hp, bag, expAccum, classId, stats }

// ---------- IO wrappers (read -> apply -> write) ----------
function createCharacter(userId, classId) {
  const data = economy.readEconomy();
  ensureUser(data, userId);
  const r = applyCreateCharacter(data, userId, classId);
  if (r.ok) economy.writeEconomy(data);
  return r;
}

function startDelve(userId) {
  if (activeRuns.has(userId)) return { ok: false, reason: 'You already have an active battle. Use `ky end` to finish it.' };
  const data = economy.readEconomy();
  ensureUser(data, userId);
  const start = applyDelveStart(data, userId);
  if (!start.ok) return { ok: false, reason: start.reason, needClass: start.reason === 'no_character' };
  const b = ensureBattleData(data[userId]);
  const stats = computeStats(b.charLevel, b.charClass, b.equipment, b.uniqueItems || {});
  const run = { userId, floor: 1, hp: stats.hp, bag: {}, expAccum: 0, cleared: 0, classId: b.charClass, stats, equipment: { ...b.equipment }, uniqueItems: { ...(b.uniqueItems || {}) } };
  // sweep: fast-forward through proven-easy floors (below bestDepth). HP-FREE — no fights
  // (you've cleared these before, they're trivial). Full HP at the sweep target. Only Push costs HP.
  const sweepTo = Math.max(1, b.bestDepth - SWEEP_BUFFER);
  run.floor = sweepTo;
  economy.writeEconomy(data); // persist entry-fee deduction
  activeRuns.set(userId, run);
  return { ok: true, paid: start.paid, run, stats, startFloor: run.floor };
}

function hasActiveRun(userId) { return activeRuns.has(userId); }
function getRun(userId) { return activeRuns.get(userId) || null; }

// Resolve the run's current floor (Push). Run state in-memory; writes only on death.
function nextFloor(userId) {
  const run = activeRuns.get(userId);
  if (!run) return { ok: false, reason: 'No active battle. Use `ky battle`.' };
  const enemy = generateEnemy(run.floor);
  const passives = getPassives(run.equipment, run.uniqueItems || {});
  const fight = resolveFight({ stats: run.stats, hp: run.hp, skills: CLASSES[run.classId].skills, passives }, enemy);
  if (fight.winner === 'player') {
    run.hp = fight.playerHpLeft;
    const drop = rollDrop(run.floor);
    run.bag[drop.id] = (run.bag[drop.id] || 0) + 1;
    let exp = charExpFor(run.floor);
    if ((passives.wisdom || 0) > 0) exp = Math.round(exp * (1 + passives.wisdom / 100));
    run.expAccum += exp;
    run.cleared = (run.cleared || 0) + 1;
    const cleared = run.floor;
    run.floor += 1;
    return { ok: true, won: true, cleared, hp: run.hp, drop, nextFloor: run.floor, enemyMaxHp: enemy.hp, log: fight.log };
  }
  const diedAt = run.floor;
  const data = economy.readEconomy();
  const res = applyDie(data, userId, run);
  economy.writeEconomy(data);
  try { economy.addXP(userId, PROFILE_XP_DIE); } catch (_) { /* consolation profile XP */ }
  activeRuns.delete(userId);
  return { ok: true, won: false, diedAt, lost: res.lost, enemyMaxHp: enemy.hp, log: fight.log };
}

function extractRun(userId) {
  const run = activeRuns.get(userId);
  if (!run) return { ok: false, reason: 'No active battle.' };
  const depth = run.floor - 1;
  const data = economy.readEconomy();
  const res = applyExtract(data, userId, run);
  economy.writeEconomy(data);
  try { economy.addXP(userId, PROFILE_XP_EXTRACT); } catch (_) { /* profile XP best-effort */ }
  activeRuns.delete(userId);
  return { ok: true, banked: res.banked, exp: res.exp, depth, leveledUp: res.leveledUp, newLevel: res.newLevel };
}

// Fast Sweep: auto-resolve up to N floors (bulk push). Same risk as Push (can die mid-sweep).
function fastSweep(userId, maxFloors) {
  if (!activeRuns.has(userId)) return { ok: false, reason: 'No active battle. Use `ky battle`.' };
  const cap = Math.max(1, Math.min(maxFloors || 5, 10));
  let cleared = 0; const drops = {}; let result = null;
  for (let i = 0; i < cap; i++) {
    const r = nextFloor(userId);
    if (!r.ok) break;
    if (!r.won) { result = { ok: true, cleared, drops, died: true, diedAt: r.diedAt, lost: r.lost }; break; }
    cleared++;
    if (r.drop) drops[r.drop.id] = (drops[r.drop.id] || 0) + 1;
  }
  if (!result) {
    const run = activeRuns.get(userId);
    result = { ok: true, cleared, drops, died: false, hp: run ? run.hp : 0, floor: run ? run.floor : 1 };
  }
  return result;
}

function sell(userId, itemId, qty) {
  const data = economy.readEconomy();
  ensureUser(data, userId);
  const r = applySell(data, userId, itemId, qty);
  economy.writeEconomy(data);
  return r;
}
function sellGear(userId, itemId, qty) {
  if (activeRuns.has(userId)) return { ok: false, reason: 'Finish or end your battle first (`ky end`) — gear is locked during a run.' };
  const data = economy.readEconomy();
  ensureUser(data, userId);
  const r = applySellGear(data, userId, itemId, qty);
  economy.writeEconomy(data);
  return r;
}
function equip(userId, itemId) {
  if (activeRuns.has(userId)) return { ok: false, reason: 'Finish or end your battle first (`ky end`) — gear is locked during a run.' };
  const data = economy.readEconomy();
  ensureUser(data, userId);
  const r = applyEquip(data, userId, itemId);
  economy.writeEconomy(data);
  return r;
}
function unequip(userId, slot) {
  if (activeRuns.has(userId)) return { ok: false, reason: 'Finish or end your battle first (`ky end`) — gear is locked during a run.' };
  const data = economy.readEconomy();
  ensureUser(data, userId);
  const r = applyUnequip(data, userId, slot);
  economy.writeEconomy(data);
  return r;
}
function buyGear(userId, itemId) {
  if (activeRuns.has(userId)) return { ok: false, reason: 'Finish or end your battle first (`ky end`) — gear is locked during a run.' };
  const data = economy.readEconomy();
  ensureUser(data, userId);
  const r = applyBuyGear(data, userId, itemId);
  if (r.ok) economy.writeEconomy(data);
  return r;
}
function buyUnique(userId, tier, slot, variant) {
  if (activeRuns.has(userId)) return { ok: false, reason: 'Finish or end your battle first (`ky end`) — gear is locked during a run.' };
  const data = economy.readEconomy();
  ensureUser(data, userId);
  const r = applyBuyUnique(data, userId, tier, slot, variant);
  if (r.ok) economy.writeEconomy(data);
  return r;
}

// Battle leaderboard: rank by FLOOR DEPTH (bestDepth) first, then Combat Score, then scoreAchievedAt.
// Admin & superadmin INCLUDED (unlike the regular balance leaderboard).
// Depth = gameplay achievement (decoupled from raw stats); CS is the tiebreak.
function getBattleLeaderboard(limit = 10, memberIds = null) {
  const data = economy.readEconomy();
  const players = [];
  for (const [uid, user] of Object.entries(data)) {
    if (memberIds && !memberIds.has(uid)) continue; // server scope filter
    if (user.battle && user.battle.charClass) {
      const stats = computeStats(user.battle.charLevel, user.battle.charClass, user.battle.equipment, user.battle.uniqueItems || {});
      const score = stats.hp + stats.atk + stats.matk + stats.def + stats.mdef + stats.spd;
      players.push({
        userId: uid,
        username: user.username || 'Unknown',
        charName: user.battle.charName || null,
        score,
        charLevel: user.battle.charLevel,
        charClass: user.battle.charClass,
        bestDepth: user.battle.bestDepth || 0,
        registeredAt: user.registeredAt || '9999',
        scoreAchievedAt: user.battle.scoreAchievedAt || user.registeredAt || '9999',
        cosmetics: user.cosmetics || null,
      });
    }
  }
  players.sort((a, b) => {
  if (b.bestDepth !== a.bestDepth) return b.bestDepth - a.bestDepth;    // FLOOR DEPTH first (gameplay achievement)
    if (b.score !== a.score) return b.score - a.score;                  // CS tiebreak
    return (a.scoreAchievedAt || '9999').localeCompare(b.scoreAchievedAt || '9999'); // reached it first
  });
  return players.slice(0, limit);
}

// Record a PvP outcome atomically: W/L for both combatants (no ELO — dropped).
function applyPvpResult(data, winnerId, loserId) {
  if (!data[winnerId] || !data[loserId]) return { ok: false }; // defensive: combatant entry missing
  const bw = ensureBattleData(data[winnerId]);
  const bl = ensureBattleData(data[loserId]);
  bw.pvpWins = (bw.pvpWins || 0) + 1;
  bl.pvpLosses = (bl.pvpLosses || 0) + 1;
  return { ok: true }; // NOTE: no scoreAchievedAt bump — W/L isn't part of Combat Score, so it shouldn't move the LB tiebreak
}
function recordPvp(winnerId, loserId) {
  const data = economy.readEconomy();
  applyPvpResult(data, winnerId, loserId);
  economy.writeEconomy(data);
  return { ok: true };
}

module.exports = {
  ensureBattleData, ensureUser, applyCreateCharacter, applyGainCharExp, applyDelveStart, applyExtract, applyDie,
  applySell, applySellGear, applyEquip, applyUnequip, applyBuyGear, applyBuyUnique, applySetCharName, applyPvpResult,
  createCharacter, startDelve, nextFloor, extractRun, fastSweep, hasActiveRun, getRun,
  sell, sellGear, equip, unequip, buyGear, buyUnique, setCharName, getCharName, getBattleLeaderboard, recordPvp,
  ENTRY_FEE, GEAR_SELLBACK,
};
