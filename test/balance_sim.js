'use strict';
// Full-skill balance simulation for Divine passive combos.
// Uses actual resolveFight (PvE) + actual resolvePvpTurn (PvP) — no shortcuts.
// Run: node test/balance_sim.js

const E = require('../utils/battleEngine');
const P = require('../utils/pvpManager');
const { CLASSES, PASSIVE_CAPS, CRIT } = require('../utils/battleConfig');

// ============================================================
// Helpers
// ============================================================
const EQUIP_SLOTS = ['weapon', 'head', 'armor', 'boots', 'accessory'];

// Divine max stats per slot
const DIVINE_STATS = {
  weapon_atk:  { atk: 55 },
  weapon_matk: { matk: 55 },
  head:        { def: 26 },
  armor:       { def: 52 },
  boots:       { spd: 34 },
  accessory_atk:  { atk: 35, spd: 12 },
  accessory_matk: { matk: 35, spd: 12 },
};

const DIVINE_MAX = {
  berserker: 32, precision: 25, lifesteal: 25, swift: 20,
  fortify: 22, evasion: 13, greed: 30, wisdom: 30,
};

function buildGear(cls, passiveConfig) {
  // passiveConfig = { berserker: 3, lifesteal: 2 } => pieces 0-2 get berserker, 3-4 get lifesteal
  // Each piece has 2 passives (Divine). Second = filler (greed/wisdom/swift)
  const uniqueItems = {};
  const equipment = {};
  const fillers = ['greed', 'wisdom', 'swift'];
  const isM = cls === 'mage';

  const slotStats = [
    isM ? DIVINE_STATS.weapon_matk : DIVINE_STATS.weapon_atk,
    DIVINE_STATS.head,
    DIVINE_STATS.armor,
    DIVINE_STATS.boots,
    isM ? DIVINE_STATS.accessory_matk : DIVINE_STATS.accessory_atk,
  ];

  // Expand passive config into per-slot assignments
  const assignments = [];
  for (const [pid, count] of Object.entries(passiveConfig)) {
    for (let i = 0; i < count; i++) assignments.push(pid);
  }

  for (let i = 0; i < 5; i++) {
    const id = `ky_sim_${i}`;
    const passives = [];
    // Primary passive
    if (i < assignments.length) {
      passives.push({ id: assignments[i], emoji: '', value: DIVINE_MAX[assignments[i]], unit: assignments[i] === 'swift' ? '' : '%' });
    }
    // Second passive (filler — non-combat)
    const usedIds = new Set(passives.map(p => p.id));
    for (const f of fillers) {
      if (!usedIds.has(f)) {
        passives.push({ id: f, emoji: '', value: DIVINE_MAX[f], unit: f === 'swift' ? '' : '%' });
        break;
      }
    }
    // Ensure 2 passives
    if (passives.length < 2) {
      passives.push({ id: 'wisdom', emoji: '', value: DIVINE_MAX.wisdom, unit: '%' });
    }

    uniqueItems[id] = { id, name: `SimGear${i}`, rarity: 'divine', slot: EQUIP_SLOTS[i], stats: slotStats[i], passives };
    equipment[EQUIP_SLOTS[i]] = id;
  }
  return { uniqueItems, equipment };
}

function mkPvpPlayer(id, cls, level, passiveConfig) {
  const { uniqueItems, equipment } = buildGear(cls, passiveConfig);
  const stats = E.computeStats(level, cls, equipment, uniqueItems);
  return {
    id, username: id, charName: id, charLevel: level, charClass: cls,
    stats, skills: CLASSES[cls].skills, equipment, uniqueItems, cosmetics: {},
  };
}

// ============================================================
// PvE sim: uses REAL resolveFight (full skill rotation, passives, burn, parry, etc.)
// ============================================================
function simPvE(cls, level, passiveConfig, runs) {
  const { uniqueItems, equipment } = buildGear(cls, passiveConfig);
  const stats = E.computeStats(level, cls, equipment, uniqueItems);
  const passives = E.getPassives(equipment, uniqueItems);
  const skills = CLASSES[cls].skills;
  let totalDepth = 0, maxD = 0, minD = Infinity;

  for (let r = 0; r < runs; r++) {
    let hp = stats.hp;
    let depth = 0;
    for (let floor = 1; floor <= 500; floor++) {
      if (hp <= 0) break;
      const enemy = E.generateEnemy(floor);
      const result = E.resolveFight({ stats, hp, skills, passives }, enemy);
      if (result.winner === 'player') {
        hp = result.playerHpLeft;
        depth = floor;
      } else {
        break;
      }
    }
    totalDepth += depth;
    maxD = Math.max(maxD, depth);
    minD = Math.min(minD, depth);
  }

  return {
    avg: Math.round(totalDepth / runs), min: minD, max: maxD,
    passives, stats,
  };
}

// ============================================================
// PvP sim: uses REAL resolvePvpTurn (full skill picks, burn, parry, CD, etc.)
// ============================================================
// Skill pick strategy: rotation pattern same as PvE (basic, skill2, basic, skill2, ult)
function simPvP(cls1, pass1, cls2, pass2, level, fights) {
  let p1wins = 0;
  const pattern = [0, 1, 0, 1, 2]; // basic, s2, basic, s2, ult

  for (let f = 0; f < fights; f++) {
    P.activePvpFights.clear();
    const fightId = `sim_${f}`;
    const p1 = mkPvpPlayer('P1', cls1, level, pass1);
    const p2 = mkPvpPlayer('P2', cls2, level, pass2);
    const fight = P.startFight(fightId, p1, p2);
    P.clearAfkTimer(fightId); // no timers in sim

    let p1turn = 0, p2turn = 0;
    let turns = 0;
    while (!fight.over && turns < 50) {
      turns++;
      const actorKey = fight.active;
      const actor = fight[actorKey];
      const skills = actor.skills;
      const turnIdx = actorKey === 'p1' ? p1turn : p2turn;
      const wantIdx = pattern[turnIdx % pattern.length];
      const want = skills[wantIdx];
      // Pick wanted skill; if on CD, fall back to basic
      const skillId = (actor.cdLeft[want.id] || 0) <= 0 ? want.id : skills[0].id;

      const result = P.resolvePvpTurn(fightId, actor.id, skillId);
      if (!result.ok) {
        // Shouldn't happen, but fallback to basic
        P.resolvePvpTurn(fightId, actor.id, skills[0].id);
      }
      if (actorKey === 'p1') p1turn++; else p2turn++;
    }

    if (fight.winner === 'p1') p1wins++;
    P.endFight(fightId);
  }

  P.activePvpFights.clear();
  return { p1wins, p2wins: fights - p1wins, p1wr: Math.round(p1wins / fights * 100) };
}

// ============================================================
// Run
// ============================================================
const RUNS_PVE = 50;
const FIGHTS_PVP = 200;
const LEVEL = 100;

console.log('═══════════════════════════════════════════════════════════════');
console.log('  KYRIZ BALANCE SIM — Full Skill Engine (Divine Lv' + LEVEL + ')');
console.log('  PvE: ' + RUNS_PVE + ' runs × build | PvP: ' + FIGHTS_PVP + ' fights × matchup');
console.log('═══════════════════════════════════════════════════════════════\n');

// --- PvE ---
console.log('── PvE: Warrior Lv' + LEVEL + ' ──\n');
const pveBuildsDef = [
  ['Baseline (no combat passives)',      'warrior', {}],
  ['5× Fortify',                         'warrior', { fortify: 5 }],
  ['5× Lifesteal',                       'warrior', { lifesteal: 5 }],
  ['5× Berserker',                       'warrior', { berserker: 5 }],
  ['5× Precision',                       'warrior', { precision: 5 }],
  ['5× Evasion',                         'warrior', { evasion: 5 }],
  ['3× Fortify + 2× Lifesteal',         'warrior', { fortify: 3, lifesteal: 2 }],
  ['2× Berserker + 2× Lifesteal + 1× Fort', 'warrior', { berserker: 2, lifesteal: 2, fortify: 1 }],
  ['2× Fortify + 2× Evasion + 1× LS',  'warrior', { fortify: 2, evasion: 2, lifesteal: 1 }],
  ['2× Precision + 2× Berserker + 1× LS', 'warrior', { precision: 2, berserker: 2, lifesteal: 1 }],
];

const pveResults = [];
for (const [label, cls, cfg] of pveBuildsDef) {
  const r = simPvE(cls, LEVEL, cfg, RUNS_PVE);
  const pStr = Object.entries(r.passives).filter(([k]) => !['greed','wisdom','swift'].includes(k)).map(([k,v]) => `${k}:${v}${k==='swift'?'':' %'}`).join(', ') || 'none';
  pveResults.push({ label, ...r, pStr });
}
pveResults.sort((a, b) => b.avg - a.avg);
console.log('Rank | Build                                         | Avg  | Min  | Max  | Effective Passives');
console.log('─────┼───────────────────────────────────────────────┼──────┼──────┼──────┼────────────────────');
pveResults.forEach((r, i) => {
  console.log(`  ${String(i+1).padStart(2)} | ${r.label.padEnd(45)} | ${String(r.avg).padStart(4)} | ${String(r.min).padStart(4)} | ${String(r.max).padStart(4)} | ${r.pStr}`);
});

console.log('\n── PvE: Mage Lv' + LEVEL + ' (key builds) ──\n');
const mageBuilds = [
  ['Mage Baseline',                       'mage', {}],
  ['Mage 3× Fort + 2× LS',              'mage', { fortify: 3, lifesteal: 2 }],
  ['Mage 2× Brs + 2× LS + 1× Fort',    'mage', { berserker: 2, lifesteal: 2, fortify: 1 }],
  ['Mage 5× Fortify',                    'mage', { fortify: 5 }],
];
for (const [label, cls, cfg] of mageBuilds) {
  const r = simPvE(cls, LEVEL, cfg, RUNS_PVE);
  const pStr = Object.entries(r.passives).filter(([k]) => !['greed','wisdom','swift'].includes(k)).map(([k,v]) => `${k}:${v}${k==='swift'?'':' %'}`).join(', ') || 'none';
  console.log(`${label.padEnd(45)} | Avg: ${String(r.avg).padStart(4)} | Min: ${String(r.min).padStart(4)} | Max: ${String(r.max).padStart(4)} | ${pStr}`);
}

// --- PvP ---
console.log('\n═══════════════════════════════════════════════════════════════');
console.log('── PvP: Full Skill Matchups (' + FIGHTS_PVP + ' fights, Lv' + LEVEL + ') ──\n');

const pvpMatchups = [
  // Pure builds
  ['5× Fortify (Tank)',     'warrior', { fortify: 5 },       '5× Berserker (DPS)',   'warrior', { berserker: 5 }],
  ['5× Fortify (Tank)',     'warrior', { fortify: 5 },       '5× Lifesteal (Sustain)', 'warrior', { lifesteal: 5 }],
  ['5× Berserker (DPS)',    'warrior', { berserker: 5 },     '5× Lifesteal (Sustain)', 'warrior', { lifesteal: 5 }],
  ['5× Evasion (Dodge)',    'warrior', { evasion: 5 },       '5× Berserker (DPS)',   'warrior', { berserker: 5 }],
  ['5× Precision (Crit)',   'warrior', { precision: 5 },     '5× Fortify (Tank)',    'warrior', { fortify: 5 }],

  // Balanced vs Pure
  ['3× Fort + 2× LS',      'warrior', { fortify: 3, lifesteal: 2 },  '5× Fortify (Tank)',    'warrior', { fortify: 5 }],
  ['2× Brs + 2× LS + Fort','warrior', { berserker: 2, lifesteal: 2, fortify: 1 }, '5× Fortify (Tank)', 'warrior', { fortify: 5 }],
  ['2× Brs + 2× LS + Fort','warrior', { berserker: 2, lifesteal: 2, fortify: 1 }, '3× Fort + 2× LS', 'warrior', { fortify: 3, lifesteal: 2 }],

  // Cross-class (same build)
  ['Warrior (Brs+LS+Fort)', 'warrior', { berserker: 2, lifesteal: 2, fortify: 1 }, 'Mage (Brs+LS+Fort)', 'mage', { berserker: 2, lifesteal: 2, fortify: 1 }],
  ['Warrior (Fort+LS)',     'warrior', { fortify: 3, lifesteal: 2 },  'Mage (Fort+LS)',       'mage', { fortify: 3, lifesteal: 2 }],
  ['Warrior (Full Fort)',   'warrior', { fortify: 5 },                'Mage (Full Fort)',     'mage', { fortify: 5 }],
  ['Warrior Baseline',      'warrior', {},                            'Mage Baseline',        'mage', {}],
];

console.log('P1                            vs  P2                            | P1 WR | P2 WR | Verdict');
console.log('──────────────────────────────────────────────────────────────────┼───────┼───────┼─────────');
for (const [l1, c1, p1, l2, c2, p2] of pvpMatchups) {
  const r = simPvP(c1, p1, c2, p2, LEVEL, FIGHTS_PVP);
  const v = r.p1wr > 60 ? `← ${l1} DOMINATES` : r.p1wr < 40 ? `${l2} DOMINATES →` : '≈ BALANCED';
  const flag = (r.p1wr > 70 || r.p1wr < 30) ? ' ⚠️' : '';
  console.log(`${l1.padEnd(29)} vs  ${l2.padEnd(29)} | ${String(r.p1wr+'%').padStart(5)} | ${String((100-r.p1wr)+'%').padStart(5)} | ${v}${flag}`);
}

// --- Cap analysis ---
console.log('\n═══════════════════════════════════════════════════════════════');
console.log('── Passive Cap Saturation (5× Divine max per slot) ──\n');
console.log('Passive    | Per-piece max | 5× Raw | Current Cap | Effective | Status');
console.log('───────────┼──────────────┼────────┼─────────────┼───────────┼───────');
for (const [name, id, max, cap] of [
  ['Berserker','berserker',32,100],['Precision','precision',25,50],['Lifesteal','lifesteal',25,80],
  ['Swift','swift',20,Infinity],['Fortify','fortify',22,80],['Evasion','evasion',13,40],
  ['Greed','greed',30,Infinity],['Wisdom','wisdom',30,Infinity],
]) {
  const raw = max * 5;
  const eff = cap === Infinity ? raw : Math.min(raw, cap);
  const capStr = cap === Infinity ? '  ∞' : `${cap}%`.padStart(4);
  const status = cap !== Infinity && raw >= cap ? 'CAP HIT' : 'under cap';
  console.log(`${name.padEnd(10)} | ${String(max+'%').padStart(12)} | ${String(raw+'%').padStart(6)} | ${capStr.padStart(11)} | ${String(eff+'%').padStart(9)} | ${status}`);
}

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('  Done. Inspect results above for balance concerns.');
console.log('═══════════════════════════════════════════════════════════════');
