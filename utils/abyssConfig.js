'use strict';

// ============================================================
// ABYSS TOWER config — pure data (no Discord, no IO).
// SINGLE SOURCE OF TRUTH for boss numbers: test/abyss_tune_sim.js FLOORS[].
// Values were transcribed 1:1 from the sim (sim-gated balance), then live-
// feedback retuned (v3.2 kits) and v3.3 anti-heal rule (ALL bosses F5+ carry
// an anti-heal source — owner mandate: lifesteal must never win solo). v3.3
// additions are NOT in the sim; they are gate-verified via test/abyss_verify.js
// (which drives this config through the REAL engine).
// NOTE (F2): spec §6 table says HP x2.6 — the sim tuned it to x2.5. Sim wins.
//
// Combat rules the ENGINE task implements (documented here, not exported):
//  - Boss stats = computeStats(bossTunedLevel(floor), 'warrior'/'mage') x mults
//    (warrior for HP/ATK/DEF, mage for MATK/MDEF) — see bossTunedLevel below.
//  - Boss ult gating: skills with cd >= 4 START AT HALF-CD (PvP parity —
//    no turn-1 Oblivion nuke/stun; sim tuned with this in place).
//  - PvP semantics: damage scalar x0.7, +/-15% per-hit roll, player HP x1.15.
//  - Mirror floor (F9): stats/skills copied from the player; hpMult x1.5;
//    player passives copied at passiveCopy (1/2 — raised from 1/3 after the
//    mirror rolled over at Lv280, owner live feedback); copied self-buff
//    skills (parry/warcry/shadowdance) WORK for the boss.
// ============================================================

// REC_BIAS (spec §3): F3+ bosses are tuned at rec x1.1 while the UI shows the
// raw recLevel — recommendation is ASPIRATIONAL (comfortable clear ~ rec+10%).
// F1-F2 stay 1.0 (onboarding stays epic-friendly); F9 mirror is exempt
// (scales with the player by construction).
const REC_BIAS_MID = 1.2; // F3-F7: owner wants real bite at rec (live feedback round 3 — "jangan kegampangan")
const REC_BIAS = 1.1;     // F8+: walls already live here (nest venom / mirror / 3-phase)

function bossTunedLevel(floor) {
  if (floor.id <= 2 || floor.mirror) return floor.recLevel; // onboarding honest, mirror self-scales
  return Math.floor(floor.recLevel * (floor.id <= 7 ? REC_BIAS_MID : REC_BIAS));
}

const TURN_LIMIT = 30;
const STAR_THRESHOLDS = {
  three: { turns: 18, hpPct: 50 }, // 3 stars: clear <= 18 turns AND HP >= 50%
  two: { turns: 25 },              // 2 stars: clear <= 25 turns
};

// ------------------------------------------------------------
// FLOORS — transcribed EXACTLY from test/abyss_tune_sim.js FLOORS[].
// Outer naming per plan Task 1 (recLevel/hpMult/...); mechanic + skill effect
// shapes kept IDENTICAL to the sim so the combat task ports sim logic 1:1
// (mech: shield/enrage/regen/counter/phaseShift/frostAura/swarm/darkAdapt,
// F10 phases p1/p2/p3; skill effects: burn/poison {pct,turns}, cc {chance},
// heal, antiHeal {reduction,turns}, pierceEva).
// F9 (mirror) has no mults/spd/skills — everything is copied from the player.
// ------------------------------------------------------------
const ABYSS_FLOORS = [
  { id: 1, name: 'Feral Guardian', emoji: '🐺',
    recLevel: 50, recClass: null,
    hpMult: 3.5, atkMult: 0.9, matkMult: 0.9, defMult: 0.6, mdefMult: 0.5, spd: 4,
    crit: 0, critMult: 1.0,
    skills: [
      { id: 'bite', name: 'Bite', mult: 1.0, type: 'physical', cd: 0 },
      { id: 'claw', name: 'Claw', mult: 1.4, type: 'physical', cd: 2 },
    ],
    mechanic: null },

  { id: 2, name: 'Stone Sentinel', emoji: '🛡️',
    recLevel: 80, recClass: 'mage', // sim proof: warrior 8% / mage 100% — anti-physical rock is a mage floor
    hpMult: 2.5, atkMult: 0.5, matkMult: 0.5, defMult: 0.6, mdefMult: 0.4, spd: 3,
    crit: 0, critMult: 1.0,
    skills: [
      { id: 'slam', name: 'Slam', mult: 1.0, type: 'physical', cd: 0 },
      { id: 'heavy_blow', name: 'Heavy Blow', mult: 1.6, type: 'physical', cd: 3 },
    ],
    mechanic: { shield: { every: 4, pct: 0.15 } } },

  { id: 3, name: 'Infernal Drake', emoji: '🔥',
    recLevel: 110, recClass: 'rogue',
    hpMult: 4.0, atkMult: 0.7, matkMult: 1.20, defMult: 0.5, mdefMult: 0.7, spd: 10,
    crit: 0.10, critMult: 1.5, bossEvasion: 10, // FIREPROOF SCALES — agile drake
    skills: [
      { id: 'flame_breath', name: 'Flame Breath', mult: 1.2, type: 'magic', cd: 0 },
      { id: 'scorch', name: 'Scorch', mult: 1.0, type: 'magic', cd: 2, burn: { pct: 12, turns: 3 } },
      { id: 'inferno', name: 'Inferno', mult: 2.0, type: 'magic', cd: 4, burn: { pct: 20, turns: 3 } },
    ],
    mechanic: { enrage: { every: 3, pct: 0.10 } } },

  { id: 4, name: 'Ancient Treant', emoji: '🌿',
    recLevel: 150, recClass: 'mage',
    hpMult: 3.0, atkMult: 0.7, matkMult: 0.70, defMult: 0.7, mdefMult: 0.6, spd: 4,
    crit: 0.15, critMult: 1.5,
    skills: [
      { id: 'root_slam', name: 'Root Slam', mult: 1.0, type: 'magic', cd: 0, cc: { chance: 25 } },
      { id: 'natures_wrath', name: "Nature's Wrath", mult: 1.5, type: 'magic', cd: 3 },
      { id: 'natures_embrace', name: "Nature's Embrace", mult: 1.5, type: 'magic', cd: 6, heal: 0.08, cc: { chance: 100, kind: 'rooted' }, antiHeal: { reduction: 50, turns: 3 } }, // roots drain vitality
    ],
    mechanic: { regen: { every: 4, pct: 0.03 } } },

  { id: 5, name: 'Thunder Wyrm', emoji: '⚡',
    recLevel: 200, recClass: 'warrior',
    hpMult: 3.0, atkMult: 0.7, matkMult: 0.95, defMult: 0.6, mdefMult: 0.8, spd: 7,
    crit: 0.15, critMult: 1.5, bossEvasion: 12, // STORMFORM — lightning-fast, hard to pin
    skills: [
      { id: 'thunder_bolt', name: 'Thunder Bolt', mult: 1.2, type: 'magic', cd: 0 },
      { id: 'storm_surge', name: 'Storm Surge', mult: 1.8, type: 'magic', cd: 3, antiHeal: { reduction: 35, turns: 3 } }, // lightning disrupts recovery
      { id: 'lightning_storm', name: 'Lightning Storm', mult: 2.5, type: 'magic', cd: 5, pierceEva: true },
    ],
    mechanic: { counter: { chance: 50, mult: 1.2 } } },

  { id: 6, name: 'Shadow Warden', emoji: '🌑',
    recLevel: 250, recClass: 'rogue',
    hpMult: 3.8, atkMult: 0.85, matkMult: 0.85, defMult: 0.8, mdefMult: 0.5, spd: 7,
    crit: 0.15, critMult: 1.5, bossEvasion: 15, // LIVING SHADOW — slips through attacks
    skills: [
      { id: 'shadow_strike', name: 'Shadow Strike', mult: 1.1, type: 'physical', cd: 0 },
      { id: 'dark_pulse', name: 'Dark Pulse', mult: 1.5, type: 'magic', cd: 2, antiHeal: { reduction: 30, turns: 3 } }, // shadow corrupts vitality
      { id: 'umbral_rend', name: 'Umbral Rend', mult: 1.8, type: 'physical', cd: 3 },
    ],
    mechanic: { phaseShift: { at: 0.5, stun: true } } },

  { id: 7, name: 'Frost Lich', emoji: '🧊',
    recLevel: 300, recClass: 'mage',
    hpMult: 3.5, atkMult: 0.7, matkMult: 0.90, defMult: 0.9, mdefMult: 0.8, spd: 6,
    crit: 0.20, critMult: 1.75, bossEvasion: 18,
    skills: [
      { id: 'frost_bolt', name: 'Frost Bolt', mult: 1.3, type: 'magic', cd: 0, cc: { chance: 20, kind: 'frozen' } },
      { id: 'ice_storm', name: 'Ice Storm', mult: 2.0, type: 'magic', cd: 3 },
      { id: 'frost_nova', name: 'Frost Nova', mult: 1.0, type: 'magic', cd: 5, cc: { chance: 75, kind: 'frozen' }, antiHeal: { reduction: 50, turns: 3 } }, // frostbite prevents recovery
    ],
    mechanic: { frostAura: { physReduction: 0.30 } } },

  { id: 8, name: 'Hive Queen', emoji: '👥',
    recLevel: 370, recClass: 'rogue',
    hpMult: 3.5, atkMult: 0.90, matkMult: 0.7, defMult: 0.6, mdefMult: 0.6, spd: 9, bossEvasion: 10,
    crit: 0.20, critMult: 1.75,
    skills: [
      { id: 'sting', name: 'Sting', mult: 1.0, type: 'physical', cd: 0 },
      { id: 'toxic_spray', name: 'Toxic Spray', mult: 1.4, type: 'physical', cd: 2, poison: { pct: 10, turns: 3 }, cc: { chance: 25 }, antiHeal: { reduction: 25, turns: 3 } }, // nest venom: mild constant suppression
      { id: 'venomous_onslaught', name: 'Venomous Onslaught', mult: 2.0, type: 'physical', cd: 4, poison: { pct: 15, turns: 3 }, antiHeal: { reduction: 100, turns: 3 } }, // full shutdown window (ult identity)
    ],
    mechanic: { swarm: { every: 3, max: 2, droneAtkPct: 0.40, droneTtl: 3 } } },

  // MIRROR — stats + class skills copied from the player at runtime.
  // Player gear passives copied at 1/3 value ("it learned from you — you keep the edge").
  { id: 9, name: 'Doppelganger', emoji: '🪞',
    recLevel: 430, recClass: 'warrior',
    mirror: true, hpMult: 2.0, passiveCopy: 1 / 2, bossEvasion: 12, // owner round 6: 3★ must be RARE — clear ~30-60%, 3★ 0-18% by class (warrior wall, mage chance)
    crit: 0.20, critMult: 1.75,
    skills: null, // resolved from the challenger's class skills at fight start
    mechanic: { darkAdapt: { every: 3, pct: 0.08, antiHeal: 25 } } }, // faster ramp (t5 deaths made 4/6% dead weight); drain live from round 1 (buildAbyssFight)

  { id: 10, name: 'Abyssal Overlord', emoji: '💀',
    recLevel: 500, recClass: null,
    hpMult: 4.5, atkMult: 1.05, matkMult: 1.05, defMult: 1.0, mdefMult: 1.0, spd: 7, bossEvasion: 10,
    crit: 0.25, critMult: 1.75,
    skills: [
      { id: 'void_slash', name: 'Void Slash', mult: 1.2, type: 'physical', cd: 0, cc: { chance: 20 } },
      { id: 'abyssal_blast', name: 'Abyssal Blast', mult: 1.6, type: 'magic', cd: 2 },
      { id: 'oblivion', name: 'Oblivion', mult: 2.5, type: 'mixed', cd: 4, pierceEva: true, cc: { chance: 100 } },
    ],
    // three phases: 100-60% VAMPIRIC / 60-30% PUNISH / 30-0% BERSERK (no shield/regen — v3 simplification)
    mechanic: {
      p1: { enrage: { every: 4, pct: 0.12 }, lifesteal: 0.30 },
      p2: { counter: { chance: 35, mult: 1.2, antiHeal: { reduction: 40, turns: 3 } } }, // counter wounds resist healing; vampiric lingers (weaker)
      p3: { berserk: { atk: 1.7 }, antiHeal: 60 }, // seal your wounds
    } },
];

// ------------------------------------------------------------
// BOSS DIALOGUES (spec §6.1 — FINAL, transcribed verbatim)
// ------------------------------------------------------------
const BOSS_DIALOGUES = {
  1:  { intro: 'Another pup wanders into the dark. Let\'s see if you can bite.',
        victory: 'The guardian falls. The tower takes notice.',
        defeat: 'Was that a bite? Come back when you have teeth.' },
  2:  { intro: 'Stone does not bleed. Stone does not break. Stone waits.',
        victory: 'Even mountains crumble. Climb.',
        defeat: 'Stone does not celebrate. It simply remains.' },
  3:  { intro: 'You smell of fear and kryptonite. Both burn beautifully.',
        victory: 'The drake\'s fire gutters out. You are still standing.',
        defeat: 'You burned for a while. Not long enough.' },
  4:  { intro: 'The forest has claimed greater heroes than you. It is... patient.',
        victory: 'The ancient roots wither. The path opens.',
        defeat: 'The forest keeps what it takes. Including you.' },
  5:  { intro: 'You reach for power. Power reaches back.',
        victory: 'The storm is silenced. Something above stirs.',
        defeat: 'You reached for power. It reached back. Told you.' },
  6:  { intro: 'I am every mistake you have ever made. Shall we begin?',
        victory: 'The shadow dissolves — but it saw everything.',
        defeat: 'I told you — I know your every move. Even the fatal one.' },
  7:  { intro: 'Warm-blooded. Brief. Come, freeze forever.',
        victory: 'The Lich shatters. Cold no longer lives here.',
        defeat: 'Frozen. Forever. As promised.' },
  8:  { intro: 'You are one. We are legion. Do the arithmetic.',
        victory: 'The hive falls silent. The queen was the arithmetic.',
        defeat: 'One divided by legion. The arithmetic was never in your favor.' },
  9:  { intro: 'I know your every move. I AM your every move.',
        victory: 'You defeated the only opponent who truly knew you.',
        defeat: 'You lost to yourself. Sit with that.' },
  10: { intro: 'Mortals climb my tower seeking meaning. I am the meaning at the top.',
        victory: 'The Overlord falls. The Abyss... is yours.',
        defeat: 'The meaning at the top was never yours to take. Climb again, mortal.' },
};

// ------------------------------------------------------------
// REWARDS (spec §9 — FINAL). 1x per floor, permanent. Star bonus = 25% of base per star.
// dropTier: unique-gear tier rolled for the floor's gear drop ('legendary'|'mythic'|'divine'|null).
// ------------------------------------------------------------
const ABYSS_REWARDS = {
  starBonusPct: 0.25,
  floors: [
    { floor: 1,  base: 2000,   dropTier: null },
    { floor: 2,  base: 4000,   dropTier: null },
    { floor: 3,  base: 8000,   dropTier: null },
    { floor: 4,  base: 12000,  dropTier: null },
    { floor: 5,  base: 20000,  dropTier: 'legendary' },
    { floor: 6,  base: 35000,  dropTier: null },
    { floor: 7,  base: 55000,  dropTier: 'mythic' },
    { floor: 8,  base: 85000,  dropTier: null },
    { floor: 9,  base: 150000, dropTier: 'divine' },
    { floor: 10, base: 300000, dropTier: 'divine' },
  ],
};

// MILESTONES — permanent, 1x, auto-granted on first clear (or first 30 stars).
// Title values INCLUDE their emoji (renders everywhere titles render, no engine change).
const ABYSS_MILESTONES = {
  floors: {
    1:  { title: '🗝️ Gatebreaker' },
    2:  { kryztal: 100000 },
    3:  { title: '🐉 Drake Slayer' },
    4:  { kryztal: 250000 },
    5:  { title: '⚡ Stormcaller' },
    6:  { kryztal: 500000 },
    7:  { title: '❄️ Frozen Heart' },
    8:  { kryztal: 750000 },
    9:  { title: '🪞 Self-Slayer' },
    10: { kryztal: 1000000, title: '💀 Abyssal Overlord' },
  },
  allStars: { stars: 30, title: '🌌 Abyssal Master', abyssalEdge: true },
};

// ------------------------------------------------------------
// ABYSSAL EDGE — 30-star trophy weapon (spec §9.1, owner decision).
// Fixed stats (NO re-roll), unsellable, 1 per account. Passives go through the
// normal getPassives() pipeline — nothing pierces PASSIVE_CAPS.
// ------------------------------------------------------------
const ABYSSAL_TIER = { letter: 'A', color: '🌌', name: 'Abyssal', price: 0 }; // above Divine, below Immortal

// PASSIVES-style entry, LOCAL to abyss (battleConfig gets its wiring in a later task).
// No ranges/weight => rupture can NEVER roll from mystery boxes.
const ABYSS_PASSIVES = {
  rupture: { emoji: '🕳️', name: 'Rupture', unit: '%', value: 15,
    desc: 'Rupture 15% — attacks ignore 15% of the target\'s DEF/MDEF' },
};

const ABYSSAL_EDGE = {
  id: 'abyssal_edge',
  name: 'Abyssal Edge',
  emoji: '🌌',
  slot: 'weapon',
  tier: 'abyssal',
  stats: { atk: 100, matk: 100 }, // fixed (divine max is 55 — off-stat is dead per class, not OP cross-class)
  fixedPassives: [
    { id: 'rupture', value: 15 },
    { id: 'berserker', value: 40 },
    { id: 'precision', value: 30 },
    { id: 'lifesteal', value: 30 },
  ],
  sellable: false,
  onePerAccount: true,
};

// All passives are FIXED — no rolling. See ABYSSAL_EDGE.fixedPassives.

module.exports = {
  ABYSS_FLOORS, TURN_LIMIT, STAR_THRESHOLDS,
  BOSS_DIALOGUES, ABYSS_REWARDS, ABYSS_MILESTONES,
  REC_BIAS, bossTunedLevel,
  ABYSSAL_TIER, ABYSS_PASSIVES, ABYSSAL_EDGE,
};
