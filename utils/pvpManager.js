'use strict';

// ============================================================
// PvP duel engine — turn-based. Pure resolve + in-memory state.
// No Discord, no IO (caller persists W/L + renders). AFK timer
// callbacks into the Discord layer via onForfeit. Mutual-exclusion
// helper isInFight is paired with battleManager.hasActiveRun (caller
// checks both — avoids any circular require).
// ============================================================

const { getPassives, getCritChance, physicalDamage, magicDamage } = require('./battleEngine');
const { CRIT } = require('./battleConfig');

const activePvpFights = new Map(); // fightId -> fight
const AFK_MS = 60_000;
const TURN_CAP = 26; // v1.3 balance: 20→26 — enough room for kills, W vs W uses HP% tiebreak at cap
const PVP_HP_RATIO = 1.15; // v1.4 balance: 1.0→1.15 — slight HP boost for sustain (fights ~6-7t/player instead of ~3t)
// PvP level dampen (sqrt): higher level gives a SMALL edge (grinding still useful) but a few levels
// don't auto-win (strategy decides nearby levels), and stats don't explode at extreme levels.
// PvE uses the REAL level (untouched) — this is PvP-only, in startFight.
const PVP_LEVEL_K = 4;
function pvpEffLevel(level) { return 1 + PVP_LEVEL_K * Math.sqrt(Math.max(0, (level || 1) - 1)); }
// === PvP BALANCE KNOBS === (sim can't pin exact 50/50 — skill picks are interactive; tune live)
// Multiplicative defense: stacking DEF/MRED gives %-reduction (additive formula let burst ignore DEF).
// Damage scalar: lengthens fights (spec wants 4-10 rounds, not 1-2 turn one-shots). Ults gated turn 1.
// After live playtest: if one class dominates, adjust PVP_DAMAGE_MULT (lower = tankier/slower).
const PVP_DAMAGE_MULT = 0.7; // v1.4 balance: 1.0→0.7 — slower fights, more sustain/strategy. Burn bypasses this (Mage class identity)
const PVP_DAMAGE_ROLL = 0.15; // v1.5: ±15% per-hit roll. Deterministic races made winrates cliff (100/0 flips); the roll smooths them into comebacks. Sim-gated.
const PVP_WARCRY_DR_CAP = 15; // v1.5: 25→15 — parry uptime + DR stacked to lock mages out (sim: WvM epic 100% warrior pre-nerf)
// v1.5: burn scales with PvP effLevel. The class growth gap (mage matk 3.0 vs warrior atk 2.2/level) shifts WvM
// by level — a flat mult can't track it. Formula keeps epic WvM at 38-64% across Lv80-500 (sim). PvE burn untouched.
const PVP_BURN_BASE = 0.95, PVP_BURN_SLOPE = 0.0100;
function pvpBurnMult(level) { return PVP_BURN_BASE + PVP_BURN_SLOPE * pvpEffLevel(level || 1); }
const PVP_GATE_ULTS = true;
const PVP_DEF_MODE = 'add'; // additive defense (dampen bounds stats so burst can't explode; more damage through = faster fights)
const PVP_DEF_K = 80;

function isInFight(userId) {
  for (const f of activePvpFights.values()) {
    if (f.over) continue;
    if (f.p1.id === userId || f.p2.id === userId) return true;
  }
  return false;
}
function getFight(fightId) { return activePvpFights.get(fightId) || null; }

function _combatant(p, hpMax, passives) {
  return {
    id: p.id, username: p.username, charName: p.charName, cosmetics: p.cosmetics || {},
    charLevel: p.charLevel, charClass: p.charClass, equipment: p.equipment || {}, uniqueItems: p.uniqueItems || {},
    stats: p.stats, hpMax, hp: hpMax,
    skills: p.skills, passives,
    cdLeft: {}, buff: { atkPct: 0, turns: 0, dmgReduce: 0 }, burn: { dmg: 0, turns: 0 }, parryBlocks: 0,
  };
}


function startFight(fightId, p1, p2) {
  const hpMax1 = Math.max(1, Math.floor(p1.stats.hp * PVP_HP_RATIO));
  const hpMax2 = Math.max(1, Math.floor(p2.stats.hp * PVP_HP_RATIO));
  const passives1 = getPassives(p1.equipment, p1.uniqueItems);
  const passives2 = getPassives(p2.equipment, p2.uniqueItems);
  const first = p1.stats.spd >= p2.stats.spd ? 'p1' : 'p2';
  const fight = {
    id: fightId,
    p1: _combatant(p1, hpMax1, passives1),
    p2: _combatant(p2, hpMax2, passives2),
    active: first,
    turnCount: 0,
    afkTimer: null,
    messageId: null, channelId: null,
    over: false, winner: null,
  };
  activePvpFights.set(fightId, fight);
  if (PVP_GATE_ULTS) {
    // Only ULTS (cd>=4) start at half-CD (→2). Skill 2 (cd 2) starts at 0 (available turn 1, same as before).
    // After first use, normal cd. Makes ults usable by turn 3 (was turn 5 with full gate).
    for (const k of ['p1', 'p2']) {
      for (const sk of fight[k].skills) {
        if (sk.cd >= 4) fight[k].cdLeft[sk.id] = Math.ceil(sk.cd / 2);
      }
    }
  }
  return fight;
}

function resolvePvpTurn(fightId, actorId, skillId) {
  const fight = activePvpFights.get(fightId);
  if (!fight || fight.over) return { ok: false, reason: 'No active duel.' };
  const actorKey = fight.active;
  const actor = fight[actorKey];
  if (actor.id !== actorId) return { ok: false, reason: 'Not your turn.' };
  const defKey = actorKey === 'p1' ? 'p2' : 'p1';
  const def = fight[defKey];
  const skill = actor.skills.find((s) => s.id === skillId);
  if (!skill) return { ok: false, reason: 'Unknown skill.' };
  if ((actor.cdLeft[skillId] || 0) > 0) return { ok: false, reason: 'Skill on cooldown.' };

  const events = [];

  // start of the actor's valid turn: tick their cooldowns down one
  for (const k of Object.keys(actor.cdLeft)) if (actor.cdLeft[k] > 0) actor.cdLeft[k] -= 1;

  // 1. burn ticks at start of the actor's (victim's) turn
  if (actor.burn.turns > 0) {
    const bdmg = Math.max(1, actor.burn.dmg); // v1.4: burn bypasses PVP_DAMAGE_MULT — Mage burn stays full strength while skill damage is dampened
    actor.hp -= bdmg; actor.burn.turns -= 1;
    events.push({ type: 'burn', target: actorKey, dmg: bdmg });
    if (actor.hp <= 0) { actor.hp = 0; return _endTurn(fight, defKey, actorKey, events, true); } // burn killed the ACTOR → defender (burn caster) wins
  }

  // 2. compute outgoing damage (+ berserker + crit)
  const atkMult = actor.buff.turns > 0 ? (1 + actor.buff.atkPct / 100) : 1;
  if (actor.buff.turns > 0) actor.buff.turns -= 1;
  const pierce = (skill.effect && skill.effect.pierce) ? skill.effect.pierce : 0;
  const rawAtk = skill.type === 'magic' ? actor.stats.matk * atkMult : actor.stats.atk * atkMult;
  const rawDef = (skill.type === 'magic' ? def.stats.mdef : def.stats.def) * (1 - pierce);
  let dmg = PVP_DEF_MODE === 'mult'
    ? Math.max(1, Math.round(rawAtk * skill.mult * (1 - rawDef / (rawDef + PVP_DEF_K))))
    : (skill.type === 'magic' ? magicDamage(rawAtk, rawDef, skill.mult) : physicalDamage(rawAtk, rawDef, skill.mult));
  if ((actor.passives.berserker || 0) > 0) dmg = Math.round(dmg * (1 + actor.passives.berserker / 100 * 0.7));
  let critted = false;
  const crit = getCritChance(actor.passives);
  if (crit > 0 && Math.random() < crit) { dmg = Math.floor(dmg * CRIT.mult); critted = true; }

  // 3. defender defenses: parry > evasion > fortify
  let parried = false, evaded = false;
  if ((def.parryBlocks || 0) > 0) { dmg = Math.max(1, Math.round(dmg * 0.25)); def.parryBlocks -= 1; parried = true; } // parry: -75% (not full block) — prevents WvW mutual-parry stall; still a strong counter
  else if (!(skill.effect && skill.effect.pierceEvasion) && (def.passives.evasion || 0) > 0 && Math.random() < def.passives.evasion / 100) { dmg = 0; evaded = true; } // ults pierce evasion
  else {
    if ((def.buff.turns > 0) && (def.buff.dmgReduce || 0) > 0) dmg = Math.round(dmg * (1 - def.buff.dmgReduce / 100)); // War Cry self-DR
    if ((def.passives.fortify || 0) > 0) dmg = Math.round(dmg * (1 - def.passives.fortify / 100));
    if (dmg < 1) dmg = 1;
  }
  dmg = Math.round(dmg * PVP_DAMAGE_MULT * (1 - PVP_DAMAGE_ROLL + Math.random() * 2 * PVP_DAMAGE_ROLL)); // PvP tuning: lengthen fights + ±roll (comebacks)
  if (dmg === 0 && !evaded) dmg = 1; // guard: a min-chip parried/fortified hit must not become 0 (free evade) if scalar is ever lowered
  if (dmg > 0) def.hp -= dmg;
  events.push({ type: 'hit', actor: actorKey, skill: skill.name, dmg, crit: critted, parried, evaded });

  // 4. lifesteal (on actual damage dealt)
  if (dmg > 0 && (actor.passives.lifesteal || 0) > 0) {
    const heal = Math.floor(dmg * actor.passives.lifesteal / 100);
    if (heal > 0) { actor.hp = Math.min(actor.hpMax, actor.hp + heal); events.push({ type: 'lifesteal', target: actorKey, heal }); }
  }

  // 5. skill effects
  if (skill.effect) {
    if (skill.effect.kind === 'buff') { actor.buff.atkPct = skill.effect.pct; actor.buff.turns = skill.effect.turns; actor.buff.dmgReduce = Math.min(skill.effect.dmgReduce || 0, PVP_WARCRY_DR_CAP); }
    else if (skill.effect.kind === 'parry') { actor.parryBlocks = 1; } // blocks next incoming hit (cd 2 — not spammable)
    else if (skill.effect.kind === 'burn') { def.burn.dmg = Math.round(actor.stats.matk * skill.effect.pct / 100 * pvpBurnMult(actor.charLevel)); def.burn.turns = skill.effect.turns; } // v1.5: burn × effLevel formula (see constants)
  }
  if (skill.cd) actor.cdLeft[skill.id] = skill.cd;

  // 6. death check
  if (def.hp <= 0) { def.hp = 0; return _endTurn(fight, actorKey, defKey, events, true); }
  return _endTurn(fight, actorKey, defKey, events, false);
}

function _endTurn(fight, actorKey, defKey, events, kill) {
  fight.turnCount += 1;
  if (kill) { fight.over = true; fight.winner = actorKey; return { ok: true, events, over: true, winner: actorKey, fight }; }
  if (fight.turnCount >= TURN_CAP) {
    fight.over = true;
    const hp1 = fight.p1.hp / fight.p1.hpMax, hp2 = fight.p2.hp / fight.p2.hpMax;
    fight.winner = hp1 >= hp2 ? 'p1' : 'p2';
    return { ok: true, events, over: true, winner: fight.winner, fight, timeout: true };
  }
  fight.active = defKey;
  return { ok: true, events, over: false, fight };
}

function forfeitByAfk(fightId) {
  const f = activePvpFights.get(fightId);
  if (!f || f.over) return { ok: false }; // stale guard — no double-end
  f.over = true; f.winner = f.active === 'p1' ? 'p2' : 'p1'; f.afkForfeit = f.active;
  return { ok: true, fight: f };
}
function forfeitManual(fightId, userId) {
  const f = activePvpFights.get(fightId);
  if (!f || f.over) return { ok: false };
  const loserKey = f.p1.id === userId ? 'p1' : (f.p2.id === userId ? 'p2' : null);
  if (!loserKey) return { ok: false };
  f.over = true; f.winner = loserKey === 'p1' ? 'p2' : 'p1'; f.manualForfeit = loserKey;
  return { ok: true, fight: f };
}

function startAfkTimer(fightId, onForfeit) {
  const f = activePvpFights.get(fightId);
  if (!f) return;
  clearAfkTimer(fightId);
  f.afkTimer = setTimeout(() => {
    const res = forfeitByAfk(fightId);
    if (res.ok && typeof onForfeit === 'function') onForfeit(fightId, res.fight);
  }, AFK_MS);
}
function clearAfkTimer(fightId) {
  const f = activePvpFights.get(fightId);
  if (f && f.afkTimer) { clearTimeout(f.afkTimer); f.afkTimer = null; }
}
// THE single cleanup path. Every exit route (death, turn cap, AFK, ky end) calls this.
function endFight(fightId) {
  clearAfkTimer(fightId);
  activePvpFights.delete(fightId);
}

module.exports = {
  activePvpFights, isInFight, getFight, startFight, resolvePvpTurn,
  forfeitByAfk, forfeitManual, startAfkTimer, clearAfkTimer, endFight,
  pvpEffLevel, pvpBurnMult, AFK_MS, TURN_CAP,
};
