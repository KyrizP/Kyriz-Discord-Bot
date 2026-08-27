'use strict';

// ============================================================
// ABYSS TOWER state manager — data layer.
// Same convention as battleManager: pure apply-* functions
// (mutate the passed data object, no IO) + thin IO wrappers
// (read -> apply -> write, atomic via economyManager writer).
//
// DEP DIRECTION (no circular requires): battleManager requires
// THIS module (ensureAbyssData backfill). Therefore abyssManager
// must NEVER require battleManager — the active-character check
// is duplicated inline below (see hasActiveChar).
// ============================================================

const { STAR_THRESHOLDS, ABYSS_REWARDS, ABYSS_MILESTONES, ABYSS_FLOORS, TURN_LIMIT,
        bossTunedLevel, ABYSSAL_EDGE, ABYSSAL_TIER, ABYSS_PASSIVES } = require('./abyssConfig');
const { PASSIVES, CLASSES, CRIT, EVASION_TOTAL_CAP } = require('./battleConfig'); // pure data — no cycle
const { MILESTONE_TITLE_LABELS } = require('./shopItems'); // pure data — no cycle (title label -> catalog id)
const { computeStats, getPassives, physicalDamage, magicDamage } = require('./battleEngine'); // no cycle (battleEngine requires battleConfig only)
const unique = require('./uniqueItems');
const economy = require('./economyManager');

const N_FLOORS = ABYSS_FLOORS.length; // 10

// Local duplicate of battleManager.getActiveChar's existence check.
function hasActiveChar(b) { return !!(b.characters && b.activeClass && b.characters[b.activeClass]); }

// ---------- ensure abyss data (backfill + defensive shape repair) ----------
function ensureAbyssData(b) {
  if (!b.abyss || typeof b.abyss !== 'object' || Array.isArray(b.abyss)) b.abyss = {};
  const a = b.abyss;
  if (!Array.isArray(a.stars)) a.stars = Array(N_FLOORS).fill(0);
  if (a.stars.length !== N_FLOORS) { // resize, preserving valid entries (clamp 0..3)
    const old = a.stars;
    a.stars = Array(N_FLOORS).fill(0);
    for (let i = 0; i < Math.min(old.length, N_FLOORS); i++) {
      const v = old[i];
      if (typeof v === 'number' && Number.isFinite(v)) a.stars[i] = Math.min(3, Math.max(0, Math.floor(v)));
    }
  }
  for (let i = 0; i < N_FLOORS; i++) { // clamp 0..3 even on same-length arrays (manual-edit repair)
    const v = a.stars[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) a.stars[i] = 0;
    else a.stars[i] = Math.min(3, Math.max(0, Math.floor(v)));
  }
  if (!Array.isArray(a.rewarded)) a.rewarded = Array(N_FLOORS).fill(false);
  if (a.rewarded.length !== N_FLOORS) { // resize, preserving booleans
    const old = a.rewarded;
    a.rewarded = Array(N_FLOORS).fill(false);
    for (let i = 0; i < Math.min(old.length, N_FLOORS); i++) a.rewarded[i] = old[i] === true;
  }
  if (!a.milestones || typeof a.milestones !== 'object' || Array.isArray(a.milestones)) a.milestones = {};
  return a;
}

// ---------- pure apply-functions ----------
// Floor gate: valid index + sequential unlock + registered + has a character.
function applyCanEnterFloor(data, userId, floorIdx) {
  const u = data[userId];
  if (!u) return { ok: false, reason: 'You are not registered. Use `ky register` first.' };
  if (!u.battle || !hasActiveChar(u.battle)) return { ok: false, reason: 'no_character' };
  if (!Number.isInteger(floorIdx) || floorIdx < 0 || floorIdx >= N_FLOORS) return { ok: false, reason: 'Invalid floor.' };
  const a = ensureAbyssData(u.battle);
  if (floorIdx > 0 && a.stars[floorIdx - 1] <= 0) {
    return { ok: false, reason: 'Clear Floor ' + floorIdx + ' first.' }; // floorIdx is 0-based -> previous floor is floorIdx
  }
  return { ok: true, floorIdx };
}

// Stars from clear performance (STAR_THRESHOLDS is the single source).
function starsFor(turnsUsed, hpPct) {
  const turns = Math.max(0, Math.floor(Number(turnsUsed) || 0));
  const hp = Math.min(100, Math.max(0, Number(hpPct) || 0));
  if (turns <= STAR_THRESHOLDS.three.turns && hp >= STAR_THRESHOLDS.three.hpPct) return 3;
  if (turns <= STAR_THRESHOLDS.two.turns) return 2;
  return 1;
}

function totalStars(a) { return a.stars.reduce((s, x) => s + x, 0); }

// 30-star milestone: grant the Abyssal Edge (once, permanently).
// Fixed stats + rupture + 2 distinct combat passives at divine MAX (config pool).
function applyCheckAllStarsMilestone(data, userId) {
  const u = data[userId];
  if (!u || !u.battle) return null;
  const b = u.battle;
  const a = ensureAbyssData(b);
  if (totalStars(a) !== ABYSS_MILESTONES.allStars.stars || a.milestones.allStars) return null;
  if (!b.uniqueItems) b.uniqueItems = {};
  const edge = {
    id: unique.generateUniqueId(new Set(Object.keys(b.uniqueItems))),
    base: 'weapon_atk',
    name: ABYSSAL_EDGE.name,
    rarity: ABYSSAL_EDGE.tier,          // 'abyssal' — unsellable tier (battleManager guard)
    slot: ABYSSAL_EDGE.slot,
    stats: { ...ABYSSAL_EDGE.stats },   // fixed {atk:100, matk:100} — NO re-roll
    passives: ABYSSAL_EDGE.fixedPassives.map((fp) => {
      const src = fp.id === 'rupture' ? ABYSS_PASSIVES.rupture : PASSIVES[fp.id];
      return { id: fp.id, emoji: src.emoji, value: fp.value, unit: src.unit };
    }),
    boughtAt: new Date().toISOString(), // field name kept: battleCommands sorts the collection by it
  };
  b.uniqueItems[edge.id] = edge;
  a.milestones.allStars = true;
  return edge;
}

// Record a boss clear. Stars are BEST-KEPT (never downgrade). Rewards are granted
// AUTOMATICALLY on FIRST clear only (rewarded[i] === false) — no claim step, no
// pending/unclaimed state that could be double-granted. Replays can only improve stars.
function applyRecordClear(data, userId, floorIdx, turnsUsed, hpPct) {
  const gate = applyCanEnterFloor(data, userId, floorIdx);
  if (!gate.ok) return { ok: false, reason: gate.reason };
  const u = data[userId];
  const b = u.battle;
  const a = ensureAbyssData(b);
  const rw = ABYSS_REWARDS.floors[floorIdx];

  const stars = starsFor(turnsUsed, hpPct);
  const isNewBest = stars > a.stars[floorIdx];
  if (isNewBest) a.stars[floorIdx] = stars;

  const firstClear = a.rewarded[floorIdx] !== true;
  let rewards = null;
  if (firstClear) {
    rewards = { kryptonite: 0, kryztal: 0, drop: null, titles: [] };
    // Kryptonite: base + 25% of base per star (ABYSS_REWARDS.starBonusPct)
    rewards.kryptonite = rw.base + Math.round(rw.base * ABYSS_REWARDS.starBonusPct * stars);
    b.kryptonite = (b.kryptonite || 0) + rewards.kryptonite;
    // Floor milestone (1x): 💎 kryztal credited to the SAME user object's balance
    // (economy currency — same field economyManager writes), title returned for UI.
    const ms = ABYSS_MILESTONES.floors[rw.floor];
    if (ms && !a.milestones[rw.floor]) {
      a.milestones[rw.floor] = true;
      if (ms.kryztal) { rewards.kryztal = ms.kryztal; u.balance = (u.balance || 0) + ms.kryztal; }
      if (ms.title) {
        rewards.titles.push(ms.title);
        // Add to cosmetics.owned as the CATALOG ID (display strings can't equip — getItem
        // resolves ids only). Label->id map lives in shopItems (single source).
        const tid = MILESTONE_TITLE_LABELS[ms.title] || ms.title;
        if (!u.cosmetics) u.cosmetics = { title: null, badge: null, color: null, owned: [] };
        if (!Array.isArray(u.cosmetics.owned)) u.cosmetics.owned = [];
        if (!u.cosmetics.owned.includes(tid)) u.cosmetics.owned.push(tid);
      }
    }
    // Gear drop: unique of the floor's tier, random slot (normal gacha machinery)
    if (rw.dropTier) {
      if (!b.uniqueItems) b.uniqueItems = {};
      const slots = ['weapon', 'head', 'armor', 'boots', 'accessory'];
      const slot = slots[Math.floor(Math.random() * slots.length)];
      rewards.drop = unique.createUnique(rw.dropTier, slot, undefined, new Set(Object.keys(b.uniqueItems)));
      b.uniqueItems[rewards.drop.id] = rewards.drop;
    }
    a.rewarded[floorIdx] = true;
  }

  // 30-star trophy check (guarded internally — no-op unless total === 30 && not granted)
  const edge = applyCheckAllStarsMilestone(data, userId);
  if (edge) rewards = rewards || { kryptonite: 0, kryztal: 0, drop: null, titles: [] };
  if (edge) {
    rewards.titles.push(ABYSS_MILESTONES.allStars.title);
    // Abyssal Master title → cosmetics.owned as the CATALOG ID (same equip flow as above)
    const eu = data[userId];
    const mid = MILESTONE_TITLE_LABELS[ABYSS_MILESTONES.allStars.title] || ABYSS_MILESTONES.allStars.title;
    if (!eu.cosmetics) eu.cosmetics = { title: null, badge: null, color: null, owned: [] };
    if (!Array.isArray(eu.cosmetics.owned)) eu.cosmetics.owned = [];
    if (!eu.cosmetics.owned.includes(mid)) eu.cosmetics.owned.push(mid);
  }

  return { ok: true, stars, isNewBest, firstClear, rewards, edge };
}

// ---------- IO wrappers (read -> apply -> write, atomic via economyManager) ----------
function canEnterFloor(userId, floorIdx) {
  return applyCanEnterFloor({ [userId]: economy.readPlayer(userId) }, userId, floorIdx);
}

function recordClear(userId, floorIdx, turnsUsed, hpPct) {
  const data = { [userId]: economy.readPlayer(userId) };
  const r = applyRecordClear(data, userId, floorIdx, turnsUsed, hpPct);
  if (r.ok && data[userId]) economy.writePlayer(userId, data[userId]);
  return r;
}

function getAbyssProgress(userId) {
  const u = economy.readPlayer(userId);
  const empty = { stars: Array(N_FLOORS).fill(0), rewarded: Array(N_FLOORS).fill(false), milestones: {}, totalStars: 0, highestFloor: 0 };
  if (!u || !u.battle) return empty;
  const a = ensureAbyssData(u.battle); // in-memory repair only — persists on the next battle write
  let highestFloor = 0;
  a.stars.forEach((s, i) => { if (s > 0) highestFloor = i + 1; });
  return { stars: a.stars.slice(), rewarded: a.rewarded.slice(), milestones: { ...a.milestones }, totalStars: totalStars(a), highestFloor };
}

// ============================================================
// COMBAT ENGINE — turn-based boss fight.
// Faithful port of test/abyss_tune_sim.js `simulate()` (the balance-tuning
// instrument): same turn structure, defense chains, DoT rules, CC, mechanic
// tick order and boss AI. State per fight in `activeAbyssFights`; the UI layer
// drives player-turn -> boss-turn. No Discord, no IO during resolution.
// Deviations from the sim are deliberate and listed in
// .superpowers/sdd/task-3-report.md (tie rule, darkAdapt live, per-source
// anti-heal, DoT-kill stops the boss's action).
// ============================================================

const ABYSS_SCALAR = 0.7;        // PvP damage scalar (spec §3 locked)
const ABYSS_ROLL = 0.15;         // ±15% per-hit roll, both directions
const ABYSS_HP_RATIO = 1.15;     // player HP ratio (boss HP set by mults)
const ABYSS_WARCRY_DR_CAP = 15;  // PvP War Cry DR cap
const ABYSS_RUPTURE = 0.15;      // Abyssal Edge: fixed 15% DEF/MDEF pierce (single source, never rolls)

const activeAbyssFights = new Map(); // userId -> fight

function isInAbyssFight(userId) { return activeAbyssFights.has(userId); }
function getAbyssFight(userId) { return activeAbyssFights.get(userId) || null; }
function endAbyssFight(userId) { // THE single cleanup path — every exit route calls this (caller triggers the UI)
  const f = activeAbyssFights.get(userId);
  if (f && f.afkTimer) { clearTimeout(f.afkTimer); f.afkTimer = null; } // UI may park its AFK timer on the fight
  activeAbyssFights.delete(userId);
}

// Class skill (effect-kind shape) -> flat attack spec, same shape as abyssConfig
// boss skills: {id,name,mult,type,cd, burn?, poison?, parry?, dodge?, buff?, pierceEva}.
function classSkillToSpec(sk) {
  const e = sk.effect || {};
  return {
    id: sk.id, name: sk.name, mult: sk.mult, type: sk.type, cd: sk.cd || 0,
    burn: e.kind === 'burn' ? { pct: e.pct, turns: e.turns } : undefined,
    poison: e.kind === 'poison' ? { pct: e.pct, turns: e.turns } : undefined,
    parry: e.kind === 'parry' ? 1 : undefined,
    dodge: e.kind === 'dodge' ? 1 : undefined,
    buff: e.kind === 'buff' ? 1 : undefined,
    pierceEva: !!e.pierceEvasion,
  };
}

// Boss stats — EXACT sim formula. Mirror (F9): player stats x1.0 (swift already
// folded into the copied spd), HP = player RAW stats.hp (NOT x1.15) x hpMult.
function computeBossStats(floor, playerStats) {
  if (floor.mirror) {
    const am = floor.atkMult || 1; // mirror offense mult (owner: "atknya ditambahin") — applies to BOTH atk & matk (class-agnostic)
    return { hp: Math.floor(playerStats.hp * floor.hpMult), atk: Math.floor(playerStats.atk * am), matk: Math.floor(playerStats.matk * am),
             def: playerStats.def, mdef: playerStats.mdef, spd: playerStats.spd };
  }
  const tuned = bossTunedLevel(floor);
  const w = computeStats(tuned, 'warrior', {}, {});
  const m = computeStats(tuned, 'mage', {}, {});
  return { hp: Math.floor(w.hp * floor.hpMult), atk: Math.floor(w.atk * floor.atkMult),
           matk: Math.floor(m.matk * floor.matkMult), def: Math.floor(w.def * floor.defMult),
           mdef: Math.floor(m.mdef * floor.mdefMult), spd: floor.spd };
}

// Mirror passive copy: floor(v × passiveCopy) of each player passive. rupture and swift are
// NEVER copied (single-source trophy passive; swift already lives in the copied SPD).
function mirrorPassives(passives, copy) {
  const c = copy || 1 / 3; // default 1/3 (sim original) — F9 config sets 1/2
  const out = {};
  for (const [k, v] of Object.entries(passives || {})) {
    if (k === 'rupture' || k === 'swift') continue;
    const f = Math.floor((v || 0) * c);
    if (f > 0) out[k] = f;
  }
  return out;
}

// Build the full fight state (pure — takes the economy data object). Gates via
// applyCanEnterFloor (registered + sequential unlock + active character).
function buildAbyssFight(data, userId, floorIdx, busyReason) {
  if (busyReason) return { ok: false, reason: busyReason }; // cross-locks (mid-delve/mid-duel) are pre-checked by the UI layer and passed through
  const gate = applyCanEnterFloor(data, userId, floorIdx);
  if (!gate.ok) return { ok: false, reason: gate.reason };
  const floor = ABYSS_FLOORS[floorIdx];
  const b = data[userId].battle;
  const clsId = b.activeClass;
  const cls = CLASSES[clsId];
  const char = b.characters[clsId];
  const stats = computeStats(char.charLevel, clsId, char.equipment, b.uniqueItems || {});
  const passives = getPassives(char.equipment, b.uniqueItems || {});
  const hpMax = Math.max(1, Math.floor(stats.hp * ABYSS_HP_RATIO));
  const playerSpecs = cls.skills.map(classSkillToSpec);
  const player = {
    stats, passives,
    hp: hpMax, hpMax,
    skills: playerSpecs,
    cdLeft: Object.fromEntries(playerSpecs.filter((s) => (s.cd || 0) >= 4).map((s) => [s.id, Math.ceil(s.cd / 2)])), // player ults gated at half-CD (PvP parity — symmetric with boss)
    buff: { atkPct: 0, turns: 0, dr: 0 },
    burn: { dmg: 0, turns: 0 }, poison: { dmg: 0, turns: 0 },
    parry: 0, dodge: 0,
    evasion: Math.min((cls.baseEvasion || 0) + (passives.evasion || 0), EVASION_TOTAL_CAP), // base + gear additive, cap 48
    cc: 0, antiHeal: { turns: 0, reduction: 0 },
  };
  // F9 shadow drain (owner: "anti lifesteal dari ronde start") — active from the moment
  // the gate slams shut, not from the first darkAdapt tick. atkMultStack still ramps at every 4.
  if (floor.mirror && floor.mechanic && floor.mechanic.darkAdapt && floor.mechanic.darkAdapt.antiHeal)
    player.antiHeal = { turns: 999, reduction: floor.mechanic.darkAdapt.antiHeal };
  const bStats = computeBossStats(floor, stats);
  const skills = floor.mirror ? cls.skills.map(classSkillToSpec) : floor.skills;
  const boss = {
    stats: bStats, hp: bStats.hp, hpMax: bStats.hp, skills,
    cdLeft: {}, buff: { atkPct: 0, turns: 0, dr: 0 },
    burn: { dmg: 0, turns: 0 }, poison: { dmg: 0, turns: 0 },
    parry: 0, dodge: 0,
    atkMultStack: 1, shield: 0, phase: 1, drones: [],
    mPassives: floor.mirror ? mirrorPassives(passives, floor.passiveCopy) : null,
  };
  for (const sk of skills) if ((sk.cd || 0) >= 4) boss.cdLeft[sk.id] = Math.ceil(sk.cd / 2); // ult gating: cd>=4 starts at half-CD (PvP parity)
  const fight = {
    userId, floorIdx, floor,
    player, boss,
    playerFirst: stats.spd > bStats.spd, // STRICT — ties go to the boss (spec §6 F9)
    awaiting: null,                      // 'player' | 'boss' | null(over) — set below
    turnCount: 0, roundStarted: false, acted: { player: false, boss: false },
    over: false, winner: null, timeout: false, processing: false,
    events: [], resultData: null, afkTimer: null,
  };
  fight.awaiting = fight.playerFirst ? 'player' : 'boss';
  return { ok: true, fight };
}

// IO wrapper: registers the fight in the Map.
// CROSS-LOCKS: this module cannot require battleManager/pvpManager (circular —
// battleManager requires THIS module). The caller (UI layer) pre-checks
// battleManager.hasActiveRun(userId) / pvp.isInFight(userId) and passes
// opts.busy = a ready-to-render English reason string when the player is busy.
// opts.data: test injection (pre-read economy object) — defaults to the real read.
function startAbyssFight(userId, floorIdx, opts = {}) {
  if (isInAbyssFight(userId)) return { ok: false, reason: 'You are already in an Abyss fight.' };
  const data = opts.data || { [userId]: economy.readPlayer(userId) };
  const r = buildAbyssFight(data, userId, floorIdx, opts.busy);
  if (!r.ok) return r;
  activeAbyssFights.set(userId, r.fight);
  return r;
}

// ---------- internals ----------
const _roll = () => 1 - ABYSS_ROLL + Math.random() * 2 * ABYSS_ROLL;

function _healBoss(fight, pct) {
  const b = fight.boss;
  const before = b.hp;
  b.hp = Math.min(b.hpMax, b.hp + Math.floor(b.hpMax * pct));
  if (b.hp > before) fight._events.push({ type: 'heal', target: 'boss', heal: b.hp - before });
}

// Round mechanics — tick ONCE per turn (1 turn = 1 player action + 1 boss action),
// at the start of the FIRST actor's resolution. The sim ticks at round start
// before whoever acts — this is what makes F2's shield absorb the SAME-round
// player hit. Sim tick order: shield > enrage > regen > darkAdapt > swarm >
// p1(p1 shield/enrage, phase 1 only) > p3 regen, THEN phase transitions.
function _roundStart(fight) {
  if (fight.roundStarted) return;
  fight.roundStarted = true;
  fight.turnCount += 1;
  fight.acted = { player: false, boss: false };
  const round = fight.turnCount;
  const mech = fight.floor.mechanic;
  const b = fight.boss;
  if (!mech) return;
  if (mech.shield && round % mech.shield.every === 0) b.shield = Math.floor(b.hpMax * mech.shield.pct);
  if (mech.enrage && round % mech.enrage.every === 0) b.atkMultStack += mech.enrage.pct;
  if (mech.regen && round % mech.regen.every === 0) _healBoss(fight, mech.regen.pct);
  if (mech.darkAdapt && round % mech.darkAdapt.every === 0) {
    b.atkMultStack += mech.darkAdapt.pct; // ATK/MATK +pct permanent, stacking (shadow drain itself is live from round 1 — see buildAbyssFight)
  }
  if (mech.swarm && round % mech.swarm.every === 0 && b.drones.length < mech.swarm.max) {
    b.drones.push({ ttl: mech.swarm.droneTtl, atk: Math.floor(b.stats.atk * mech.swarm.droneAtkPct) });
    fight._events.push({ type: 'mechanic', kind: 'swarm', drones: b.drones.length });
  }
  if (mech.p1 && b.phase === 1) {
    if (mech.p1.shield && round % mech.p1.shield.every === 0) b.shield = Math.floor(b.hpMax * mech.p1.shield.pct);
    if (mech.p1.enrage && round % mech.p1.enrage.every === 0) b.atkMultStack += mech.p1.enrage.pct;
  }
  if (mech.p3 && mech.p3.regen && b.phase === 3 && round % mech.p3.regen.every === 0) _healBoss(fight, mech.p3.regen.pct);
  // phase transitions (after ticks — a p1 enrage still lands on the crossing round, sim order)
  if (mech.phaseShift && b.phase === 1 && b.hp <= b.hpMax * mech.phaseShift.at) {
    b.phase = 2;
    const d = b.stats.def; b.stats.def = b.stats.mdef; b.stats.mdef = d; // DEF <-> MDEF swap
    if (mech.phaseShift.stun) fight.player.cc = 1;
    fight._events.push({ type: 'mechanic', kind: 'phaseShift', phase: 2 });
  }
  if (mech.p1 && mech.p2) {
    if (b.phase === 1 && b.hp <= b.hpMax * 0.6) { b.phase = 2; fight._events.push({ type: 'mechanic', kind: 'phase', phase: 2 }); }
    else if (b.phase === 2 && b.hp <= b.hpMax * 0.3) {
      b.phase = 3;
      if (mech.p3 && mech.p3.antiHeal) { // permanent (fight-capped) — event so the seal is visible in the log
        fight.player.antiHeal = { turns: 999, reduction: mech.p3.antiHeal };
        fight._events.push({ type: 'antiHeal', target: 'player', reduction: mech.p3.antiHeal, turns: 999 });
      }
      fight._events.push({ type: 'mechanic', kind: 'phase', phase: 3 });
    }
  }
}

// Player attack pipeline (sim playerHitBoss, 1:1). Order: raw damage (frost aura
// pre-scalar) > berserker (dampened x0.7 of value) > precision crit > MIRROR
// defense chain > x0.7 scalar + roll > shield absorb > hp > DoTs/self-effects >
// lifesteal. Counter is fired by the caller AFTER this returns.
function _playerHit(fight, skill) {
  const p = fight.player, b = fight.boss, fl = fight.floor, events = fight._events;
  const atkMult = p.buff.turns > 0 ? 1 + p.buff.atkPct / 100 : 1;
  if (p.buff.turns > 0) p.buff.turns -= 1;
  const rupt = (p.passives.rupture || 0) > 0 ? ABYSS_RUPTURE : 0;
  let dmg;
  if (skill.type === 'magic') dmg = magicDamage(p.stats.matk * atkMult, b.stats.mdef * (1 - rupt), skill.mult);
  else if (skill.type === 'mixed') dmg = Math.round((physicalDamage(p.stats.atk * atkMult, b.stats.def * (1 - rupt), skill.mult) + magicDamage(p.stats.matk * atkMult, b.stats.mdef * (1 - rupt), skill.mult)) / 2);
  else {
    dmg = physicalDamage(p.stats.atk * atkMult, b.stats.def * (1 - rupt), skill.mult);
    if (fl.mechanic && fl.mechanic.frostAura) dmg = Math.round(dmg * (1 - fl.mechanic.frostAura.physReduction)); // F7: physical -30% BEFORE scalar
  }
  if ((p.passives.berserker || 0) > 0) dmg = Math.round(dmg * (1 + p.passives.berserker / 100 * 0.7));
  const crit = (p.passives.precision || 0) > 0 && Math.random() * 100 < p.passives.precision;
  if (crit) dmg = Math.floor(dmg * CRIT.mult);
  // MIRROR boss defense: copied parry (-75%) > dodge charges > copied evasion > copied fortify/buff DR
  let parried = false, dodged = false, evaded = false;
  if (!b.mPassives && fl.bossEvasion && !skill.pierceEva && dmg > 0 && Math.random() * 100 < fl.bossEvasion) {
    dmg = 0; evaded = true; // non-mirror floor evasion (config: fl.bossEvasion, e.g. Frost Lich phasing)
  }
  else if (b.mPassives) {
    const pierceEva = !!skill.pierceEva;
    if (b.parry > 0) { dmg = Math.max(1, Math.round(dmg * 0.25)); b.parry -= 1; parried = true; }
    else {
      if (b.dodge > 0) { b.dodge -= 1; dodged = true; if (!pierceEva) dmg = 0; } // charge burned by ANY attack; pierce still damages
      // mirror evasion = max(copied player evasion, floor.bossEvasion) — intrinsic slipperiness (owner round 5)
      else if (!pierceEva && Math.random() * 100 < Math.max((b.mPassives.evasion || 0), (fl.bossEvasion || 0))) { dmg = 0; evaded = true; }
      if (dmg > 0) {
        if (b.buff.turns > 0 && b.buff.dr > 0) dmg = Math.round(dmg * (1 - b.buff.dr / 100));
        if ((b.mPassives.fortify || 0) > 0) dmg = Math.round(dmg * (1 - b.mPassives.fortify / 100));
        if (dmg < 1) dmg = 1;
      }
    }
  }
  dmg = Math.round(dmg * ABYSS_SCALAR * _roll());
  let absorbed = 0;
  if (b.shield > 0) { absorbed = Math.min(b.shield, dmg); b.shield -= absorbed; dmg -= absorbed; } // F2/F10 shield
  b.hp -= dmg;
  events.push({ type: 'hit', actor: 'player', skill: skill.name, dmg, crit, parried, dodged, evaded, absorbed });
  // player DoTs / self-effects land even on a dodged/evaded hit (sim semantics)
  if (skill.burn) { b.burn.dmg = Math.round(p.stats.matk * skill.burn.pct / 100); b.burn.turns = skill.burn.turns; events.push({ type: 'burn', target: 'boss', dmg: b.burn.dmg, turns: b.burn.turns }); }
  if (skill.poison) { b.poison.dmg = Math.round(p.stats.atk * skill.poison.pct / 100); b.poison.turns = skill.poison.turns; events.push({ type: 'poison', target: 'boss', dmg: b.poison.dmg, turns: b.poison.turns }); }
  if (skill.parry) p.parry = 1;
  if (skill.dodge) p.dodge = 2;
  if (skill.buff) p.buff = { atkPct: 25, turns: 2, dr: ABYSS_WARCRY_DR_CAP };
  // lifesteal on ACTUAL damage dealt (post-shield), anti-heal aware
  if (dmg > 0 && (p.passives.lifesteal || 0) > 0) {
    const red = p.antiHeal.turns > 0 ? p.antiHeal.reduction : 0;
    const heal = Math.floor(dmg * p.passives.lifesteal * (1 - red / 100) / 100);
    if (heal > 0) { p.hp = Math.min(p.hpMax, p.hp + heal); events.push({ type: 'lifesteal', target: 'player', heal }); }
  }
  return dmg;
}

// Boss attack pipeline (sim bossAttack, 1:1). Order: buff mult consumed > atk
// stack (enrage/darkAdapt/buff x berserk) > self-buffs > raw damage > boss crit >
// mirror copied offense > PLAYER defense chain > scalar+roll > hp (+F10-P1
// vampiric) > cc/DoTs/anti-heal/self-heal.
function _bossAttack(fight, skill) {
  const p = fight.player, b = fight.boss, fl = fight.floor, events = fight._events;
  const buffMult = b.buff.turns > 0 ? 1 + b.buff.atkPct / 100 : 1;
  if (b.buff.turns > 0) b.buff.turns -= 1;
  const berserk = fl.mechanic && fl.mechanic.p3 && b.phase === 3 ? fl.mechanic.p3.berserk.atk : 1; // F10-P3 berserk x1.5 (ATK and MATK)
  const stack = b.atkMultStack * buffMult * berserk;
  if (skill.parry) b.parry = 1;               // mirror self-buffs actually WORK (copied class skills)
  if (skill.dodge) b.dodge = 2;
  if (skill.buff) b.buff = { atkPct: 25, turns: 2, dr: ABYSS_WARCRY_DR_CAP };
  let dmg;
  if (skill.type === 'magic') dmg = magicDamage(b.stats.matk * stack, p.stats.mdef, skill.mult);
  else if (skill.type === 'mixed') dmg = Math.round((physicalDamage(b.stats.atk * stack, p.stats.def, skill.mult) + magicDamage(b.stats.matk * stack, p.stats.mdef, skill.mult)) / 2);
  else dmg = physicalDamage(b.stats.atk * stack, p.stats.def, skill.mult);
  let critDone = false;
  if (fl.crit > 0 && Math.random() < fl.crit) { dmg = Math.floor(dmg * (fl.critMult || 1.5)); critDone = true; }
  // MIRROR offense: copied berserker (dampened like the player's) + copied precision as extra crit
  if (b.mPassives) {
    if ((b.mPassives.berserker || 0) > 0) dmg = Math.round(dmg * (1 + b.mPassives.berserker / 100 * 0.7));
    if (!critDone && (b.mPassives.precision || 0) > 0 && Math.random() * 100 < b.mPassives.precision) { dmg = Math.floor(dmg * CRIT.mult); critDone = true; }
  }
  // player defense chain: parry (-75%, 1 charge) > dodge charges > evasion > War Cry DR + fortify
  let parried = false, dodged = false, evaded = false;
  const pierceEva = !!skill.pierceEva;
  if (p.parry > 0) { dmg = Math.max(1, Math.round(dmg * 0.25)); p.parry -= 1; parried = true; }
  else {
    if (p.dodge > 0) { p.dodge -= 1; dodged = true; if (!pierceEva) dmg = 0; } // charge burned by ANY attack; pierce still damages
    else if (!pierceEva && p.evasion > 0 && Math.random() * 100 < p.evasion) { dmg = 0; evaded = true; }
    if (dmg > 0) { // reduction layer: every LANDED hit incl. pierce
      if (p.buff.turns > 0 && p.buff.dr > 0) dmg = Math.round(dmg * (1 - p.buff.dr / 100));
      if ((p.passives.fortify || 0) > 0) dmg = Math.round(dmg * (1 - p.passives.fortify / 100));
      if (dmg < 1) dmg = 1;
    }
  }
  dmg = Math.round(dmg * ABYSS_SCALAR * _roll());
  if (dmg > 0) {
    p.hp -= dmg;
    // boss lifesteal: floor config (generic) or F10-P1 vampiric — take the larger, never stack both
    const phaseLifesteal = (fl.mechanic && fl.mechanic.p1 && fl.mechanic.p1.lifesteal && b.phase === 1 ? fl.mechanic.p1.lifesteal : 0)
      || (fl.mechanic && fl.mechanic.p2 && fl.mechanic.p2.lifesteal && b.phase === 2 ? fl.mechanic.p2.lifesteal : 0);
    const lsRate = Math.max((fl.bossLifesteal || 0), phaseLifesteal);
    if (lsRate > 0) {
      const heal = Math.floor(dmg * lsRate);
      if (heal > 0) { const before = b.hp; b.hp = Math.min(b.hpMax, b.hp + heal); if (b.hp > before) events.push({ type: 'lifesteal', target: 'boss', heal: b.hp - before }); }
    }
  }
  events.push({ type: 'hit', actor: 'boss', skill: skill.name, dmg, crit: critDone, parried, dodged, evaded });
  if (skill.cc && Math.random() * 100 < skill.cc.chance) { p.cc = 1; p.ccKind = (skill.cc && skill.cc.kind) || 'stunned'; events.push({ type: 'cc', target: 'player', skill: skill.name, kind: p.ccKind }); } // skip next player action (boss still acts)
  if (skill.burn) { p.burn.dmg = Math.round(b.stats.matk * skill.burn.pct / 100); p.burn.turns = skill.burn.turns; events.push({ type: 'burn', target: 'player', dmg: p.burn.dmg, turns: p.burn.turns }); }
  if (skill.poison) { p.poison.dmg = Math.round(b.stats.atk * skill.poison.pct / 100); p.poison.turns = skill.poison.turns; events.push({ type: 'poison', target: 'player', dmg: p.poison.dmg, turns: p.poison.turns }); }
  if (skill.antiHeal) { p.antiHeal = { turns: skill.antiHeal.turns, reduction: skill.antiHeal.reduction }; events.push({ type: 'antiHeal', target: 'player', reduction: skill.antiHeal.reduction, turns: skill.antiHeal.turns }); }
  if (skill.heal) _healBoss(fight, skill.heal); // F4 Nature's Embrace
  return dmg;
}

// Boss AI (sim bossPickSkill, 1:1): sort by cd desc (ult > skill2 > basic), first OFF-CD wins.
function _bossPickSkill(fight) {
  const b = fight.boss;
  const byCd = [...b.skills].sort((x, z) => (z.cd || 0) - (x.cd || 0));
  for (const s of byCd) {
    if ((s.cd || 0) === 0 || !(b.cdLeft[s.id] > 0)) {
      if (s.cd) b.cdLeft[s.id] = s.cd;
      return s;
    }
  }
  return b.skills[0];
}

function _setResult(fight) {
  const p = fight.player;
  fight.resultData = { turns: fight.turnCount, hpPct: Math.max(0, Math.round(p.hp / p.hpMax * 100)) };
}
function _endFight(fight, winner) {
  fight.over = true;
  fight.winner = winner;
  fight.awaiting = null;
  _setResult(fight);
}

// Turn-limit check at ROUND completion (both actors acted). Boss alive at turn 30
// => player loses. Checked at round end so a boss-first round 30 still gives the
// player their final action (exact sim loop semantics).
function _endRound(fight) {
  if (fight.over) return;
  if (fight.acted.player && fight.acted.boss) {
    fight.roundStarted = false;
    if (fight.turnCount >= TURN_LIMIT) { fight.timeout = true; _endFight(fight, 'boss'); }
  }
}

function resolveAbyssPlayerTurn(userId, skillId) {
  const fight = activeAbyssFights.get(userId);
  if (!fight) return { ok: false, reason: 'No active Abyss fight.' };
  if (fight.over) return { ok: false, reason: 'The fight is already over.' };
  if (fight.processing) return { ok: false, reason: 'Resolving — hold on.' };
  if (fight.awaiting === 'boss') return { ok: false, reason: 'The boss is acting.' };
  const skill = fight.player.skills.find((s) => s.id === skillId);
  if (!skill) return { ok: false, reason: 'Unknown skill.' };
  // Player CDs tick at the START of the valid turn, BEFORE availability is decided —
  // sim/delve semantics, SYMMETRIC with the boss side (its tick also precedes skill pick).
  // A cd-2 skill is usable every OTHER turn. (PvP uses check-then-tick = effective cd+1;
  // Abyss follows the tuned instrument here — gate-verified.)
  for (const k of Object.keys(fight.player.cdLeft)) if (fight.player.cdLeft[k] > 0) fight.player.cdLeft[k] -= 1;
  if ((fight.player.cdLeft[skill.id] || 0) > 0) return { ok: false, reason: 'Skill on cooldown.' };

  fight.processing = true; // re-entry guard (single-threaded sync resolution)
  const startLen = fight.events.length;
  try {
    fight._events = fight.events; // the per-turn slice is events[startLen..]
    _roundStart(fight);
    fight.acted.player = true;
    const p = fight.player;
    // player DoTs tick at own turn start — bypass ALL defenses + the 0.7 scalar; can kill
    if (p.burn.turns > 0) { const d = p.burn.dmg; p.hp -= d; p.burn.turns -= 1; fight._events.push({ type: 'burn', target: 'player', dmg: d }); }
    if (p.poison.turns > 0) { const d = p.poison.dmg; p.hp -= d; p.poison.turns -= 1; fight._events.push({ type: 'poison', target: 'player', dmg: d }); }
    if (p.antiHeal.turns > 0) p.antiHeal.turns -= 1;
    if (p.hp > 0 && p.cc > 0) {
      const ccK = p.ccKind || 'stunned'; p.cc = 0; p.ccKind = null;
      fight._events.push({ type: 'ccSkip', target: 'player', kind: ccK });
    } else if (p.hp > 0) {
      if (skill.cd) p.cdLeft[skill.id] = skill.cd;
      _playerHit(fight, skill);
      // F5 / F10-P2 counter: fires when the player used a CD skill (runs even if the
      // hit just killed the boss — sim parity; a boss death still wins below).
      const mech = fight.floor.mechanic;
      const ctr = mech && mech.counter && skill.cd > 0 ? mech.counter
        : (mech && mech.p2 && mech.p2.counter && fight.boss.phase === 2 && skill.cd > 0 ? mech.p2.counter : null);
      if (ctr && Math.random() * 100 < ctr.chance) {
        fight._events.push({ type: 'counter' });
        _bossAttack(fight, { id: 'counter', name: 'Counter', mult: ctr.mult, type: 'physical', cd: 0, antiHeal: ctr.antiHeal }); // full pipeline incl. player defense chain (F10-P2 wounds resist healing)
      }
    }
    if (fight.boss.hp <= 0) _endFight(fight, 'player'); // boss dead wins even if the counter killed the player (sim rule)
    else if (p.hp <= 0) _endFight(fight, 'boss');
    else { fight.awaiting = 'boss'; _endRound(fight); }
    const events = fight.events.slice(startLen);
    return { ok: true, events, over: fight.over, winner: fight.winner, timeout: fight.timeout || undefined, fight };
  } finally {
    fight.processing = false;
    fight._events = null;
  }
}

function resolveAbyssBossTurn(userId) {
  const fight = activeAbyssFights.get(userId);
  if (!fight) return { ok: false, reason: 'No active Abyss fight.' };
  if (fight.over) return { ok: false, reason: 'The fight is already over.' };
  if (fight.processing) return { ok: false, reason: 'Resolving — hold on.' };
  if (fight.awaiting === 'player') return { ok: false, reason: 'It is your turn.' };

  fight.processing = true;
  const startLen = fight.events.length;
  try {
    fight._events = fight.events;
    _roundStart(fight);
    fight.acted.boss = true;
    const b = fight.boss;
    // boss DoTs (from the player) tick at boss turn start — can kill the boss
    if (b.burn.turns > 0) { const d = b.burn.dmg; b.hp -= d; b.burn.turns -= 1; fight._events.push({ type: 'burn', target: 'boss', dmg: d }); }
    if (b.poison.turns > 0) { const d = b.poison.dmg; b.hp -= d; b.poison.turns -= 1; fight._events.push({ type: 'poison', target: 'boss', dmg: d }); }
    if (b.hp > 0) { // DoT killed the boss -> it does not act (player wins, checked below)
      for (const k of Object.keys(b.cdLeft)) if (b.cdLeft[k] > 0) b.cdLeft[k] -= 1;
      _bossAttack(fight, _bossPickSkill(fight));
      // drones (F8 swarm): untargetable timed pressure — each strikes once, ages, expires
      for (const d of b.drones) {
        const dd = Math.max(1, Math.round(d.atk - fight.player.stats.def * 0.5));
        const ddmg = Math.round(dd * ABYSS_SCALAR * _roll());
        fight.player.hp -= ddmg;
        fight._events.push({ type: 'drone', dmg: ddmg });
        d.ttl -= 1;
      }
      b.drones = b.drones.filter((d) => d.ttl > 0);
    }
    if (b.hp <= 0) _endFight(fight, 'player');
    else if (fight.player.hp <= 0) _endFight(fight, 'boss');
    else { fight.awaiting = 'player'; _endRound(fight); }
    const events = fight.events.slice(startLen);
    return { ok: true, events, over: fight.over, winner: fight.winner, timeout: fight.timeout || undefined, fight };
  } finally {
    fight.processing = false;
    fight._events = null;
  }
}

module.exports = {
  ensureAbyssData, applyCanEnterFloor, applyRecordClear, applyCheckAllStarsMilestone,
  starsFor, canEnterFloor, recordClear, getAbyssProgress,
  // combat engine
  activeAbyssFights, isInAbyssFight, getAbyssFight, endAbyssFight,
  computeBossStats, mirrorPassives, buildAbyssFight, startAbyssFight,
  resolveAbyssPlayerTurn, resolveAbyssBossTurn, TURN_LIMIT,
};
