'use strict';
// Class rebalance sim: test proposed growth rate changes.
// Patches CLASSES in-memory (does NOT modify battleConfig.js).
// Run: node test/class_rebalance_sim.js

const E = require('../utils/battleEngine');
const P = require('../utils/pvpManager');
const { CLASSES, PASSIVE_CAPS } = require('../utils/battleConfig');

// ============================================================
// Patch growth rates IN-MEMORY for testing
// ============================================================
const ORIGINAL = {
  warrior: { ...CLASSES.warrior.growth },
  mage: { ...CLASSES.mage.growth },
  warriorBase: { ...CLASSES.warrior.base },
  mageBase: { ...CLASSES.mage.base },
};

function applyGrowth(label, wGrowth, mGrowth) {
  Object.assign(CLASSES.warrior.growth, ORIGINAL.warrior, wGrowth || {});
  Object.assign(CLASSES.mage.growth, ORIGINAL.mage, mGrowth || {});
  Object.assign(CLASSES.warrior.base, ORIGINAL.warriorBase);
  Object.assign(CLASSES.mage.base, ORIGINAL.mageBase);
  console.log(`\n  [${label}]`);
  console.log(`  Warrior: HP=${CLASSES.warrior.growth.hp} ATK=${CLASSES.warrior.growth.atk} DEF=${CLASSES.warrior.growth.def} MDEF=${CLASSES.warrior.growth.mdef} SPD=${CLASSES.warrior.growth.spd}`);
  console.log(`  Mage:    HP=${CLASSES.mage.growth.hp} MATK=${CLASSES.mage.growth.matk} DEF=${CLASSES.mage.growth.def} MDEF=${CLASSES.mage.growth.mdef} SPD=${CLASSES.mage.growth.spd}`);
}

function restoreGrowth() {
  Object.assign(CLASSES.warrior.growth, ORIGINAL.warrior);
  Object.assign(CLASSES.mage.growth, ORIGINAL.mage);
}

// ============================================================
// Gear + sim helpers (same as balance_verify)
// ============================================================
const EQUIP_SLOTS = ['weapon', 'head', 'armor', 'boots', 'accessory'];
const DIVINE_MAX = { berserker: 32, precision: 25, lifesteal: 25, swift: 20, fortify: 22, evasion: 13, greed: 30, wisdom: 30 };
const DIVINE_STATS = {
  weapon_atk: { atk: 55 }, weapon_matk: { matk: 55 }, head: { def: 26 },
  armor: { def: 52 }, boots: { spd: 34 },
  accessory_atk: { atk: 35, spd: 12 }, accessory_matk: { matk: 35, spd: 12 },
};

function buildGear(cls, passiveConfig) {
  const uniqueItems = {}, equipment = {};
  const fillers = ['greed', 'wisdom', 'swift'];
  const isM = cls === 'mage';
  const slotStats = [isM ? DIVINE_STATS.weapon_matk : DIVINE_STATS.weapon_atk, DIVINE_STATS.head, DIVINE_STATS.armor, DIVINE_STATS.boots, isM ? DIVINE_STATS.accessory_matk : DIVINE_STATS.accessory_atk];
  const assignments = [];
  for (const [pid, count] of Object.entries(passiveConfig)) for (let i = 0; i < count; i++) assignments.push(pid);
  for (let i = 0; i < 5; i++) {
    const id = `ky_sim_${i}`, passives = [];
    if (i < assignments.length) passives.push({ id: assignments[i], emoji: '', value: DIVINE_MAX[assignments[i]], unit: assignments[i] === 'swift' ? '' : '%' });
    const usedIds = new Set(passives.map(p => p.id));
    for (const f of fillers) { if (!usedIds.has(f)) { passives.push({ id: f, emoji: '', value: DIVINE_MAX[f], unit: f === 'swift' ? '' : '%' }); break; } }
    if (passives.length < 2) passives.push({ id: 'wisdom', emoji: '', value: 30, unit: '%' });
    uniqueItems[id] = { id, name: `SimGear${i}`, rarity: 'divine', slot: EQUIP_SLOTS[i], stats: slotStats[i], passives };
    equipment[EQUIP_SLOTS[i]] = id;
  }
  return { uniqueItems, equipment };
}

function mkPlayer(id, cls, level, passiveConfig) {
  const { uniqueItems, equipment } = buildGear(cls, passiveConfig);
  const stats = E.computeStats(level, cls, equipment, uniqueItems);
  return { id, username: id, charName: id, charLevel: level, charClass: cls, stats, skills: CLASSES[cls].skills, equipment, uniqueItems, cosmetics: {} };
}

function simPvE(cls, level, passiveConfig, runs) {
  const { uniqueItems, equipment } = buildGear(cls, passiveConfig);
  const stats = E.computeStats(level, cls, equipment, uniqueItems);
  const passives = E.getPassives(equipment, uniqueItems);
  const skills = CLASSES[cls].skills;
  let totalDepth = 0, maxD = 0, minD = Infinity;
  for (let r = 0; r < runs; r++) {
    let hp = stats.hp, depth = 0;
    for (let floor = 1; floor <= 500; floor++) {
      if (hp <= 0) break;
      const result = E.resolveFight({ stats, hp, skills, passives }, E.generateEnemy(floor));
      if (result.winner === 'player') { hp = result.playerHpLeft; depth = floor; } else break;
    }
    totalDepth += depth; maxD = Math.max(maxD, depth); minD = Math.min(minD, depth);
  }
  return { avg: Math.round(totalDepth / runs), min: minD, max: maxD };
}

function simPvP(cls1, pass1, cls2, pass2, level, fights) {
  let p1wins = 0;
  const pattern = [0, 1, 0, 1, 2];
  for (let f = 0; f < fights; f++) {
    P.activePvpFights.clear();
    const fightId = `sim_${f}`;
    const fight = P.startFight(fightId, mkPlayer('P1', cls1, level, pass1), mkPlayer('P2', cls2, level, pass2));
    P.clearAfkTimer(fightId);
    let p1t = 0, p2t = 0, turns = 0;
    while (!fight.over && turns < 50) {
      turns++;
      const ak = fight.active, actor = fight[ak];
      const ti = ak === 'p1' ? p1t : p2t;
      const want = actor.skills[pattern[ti % pattern.length]];
      const sid = (actor.cdLeft[want.id] || 0) <= 0 ? want.id : actor.skills[0].id;
      const result = P.resolvePvpTurn(fightId, actor.id, sid);
      if (!result.ok) P.resolvePvpTurn(fightId, actor.id, actor.skills[0].id);
      if (ak === 'p1') p1t++; else p2t++;
    }
    if (fight.winner === 'p1') p1wins++;
    P.endFight(fightId);
  }
  P.activePvpFights.clear();
  return { p1wr: Math.round(p1wins / fights * 100) };
}

// ============================================================
// Test scenarios
// ============================================================
const RUNS = 50;
const FIGHTS = 300;

const passiveBuilds = [
  ['No passives',           {}],
  ['3× Fort + 2× LS',      { fortify: 3, lifesteal: 2 }],
  ['2× Brs + 2× LS + Fort',{ berserker: 2, lifesteal: 2, fortify: 1 }],
  ['5× Fortify',            { fortify: 5 }],
  ['5× Lifesteal',          { lifesteal: 5 }],
  ['5× Berserker',          { berserker: 5 }],
  ['5× Evasion',            { evasion: 5 }],
  ['2× Prec + 2× Brs + LS',{ precision: 2, berserker: 2, lifesteal: 1 }],
];

const growthScenarios = [
  {
    label: 'CURRENT (no changes)',
    warrior: {},
    mage: {},
  },
  {
    label: 'PROPOSED: W-ATK 2.5, W-HP 22, M-DEF 1.0, M-HP 12',
    warrior: { hp: 22, atk: 2.5 },
    mage: { hp: 12, def: 1.0 },
  },
];

for (const sc of growthScenarios) {
  console.log('\n' + '═'.repeat(75));
  applyGrowth(sc.label, sc.warrior, sc.mage);
  console.log('═'.repeat(75));

  // Show Lv100 raw stats
  const wS = E.computeStats(100, 'warrior', {});
  const mS = E.computeStats(100, 'mage', {});
  console.log(`\n  Lv100 naked stats:`);
  console.log(`  Warrior: HP=${wS.hp} ATK=${wS.atk} DEF=${wS.def} MDEF=${wS.mdef} SPD=${wS.spd}`);
  console.log(`  Mage:    HP=${mS.hp} MATK=${mS.matk} DEF=${mS.def} MDEF=${mS.mdef} SPD=${mS.spd}`);

  // PvE
  console.log('\n── PvE: Depth by class + build (Lv100, Divine gear) ──\n');
  console.log('Build                          | W Avg | W Max | M Avg | M Max | Gap');
  console.log('───────────────────────────────┼───────┼───────┼───────┼───────┼─────');
  for (const [label, cfg] of passiveBuilds) {
    const w = simPvE('warrior', 100, cfg, RUNS);
    const m = simPvE('mage', 100, cfg, RUNS);
    const gap = m.avg - w.avg;
    const gapStr = gap > 0 ? `M+${gap}` : gap < 0 ? `W+${-gap}` : 'even';
    console.log(`${label.padEnd(30)} | ${String(w.avg).padStart(5)} | ${String(w.max).padStart(5)} | ${String(m.avg).padStart(5)} | ${String(m.max).padStart(5)} | ${gapStr}`);
  }

  // PvP — ALL matchups
  console.log('\n── PvP: All class matchups (Lv100, ' + FIGHTS + ' fights) ──\n');

  const pvpSets = [
    // Warrior vs Mage (cross-class)
    { cat: '⚔️ vs 🔮 CROSS-CLASS', matchups: [
      ['W no pass',    'warrior', {},    'M no pass',    'mage', {}],
      ['W Fort+LS',    'warrior', { fortify: 3, lifesteal: 2 }, 'M Fort+LS', 'mage', { fortify: 3, lifesteal: 2 }],
      ['W Brs+LS+Fort','warrior', { berserker: 2, lifesteal: 2, fortify: 1 }, 'M Brs+LS+Fort', 'mage', { berserker: 2, lifesteal: 2, fortify: 1 }],
      ['W full Fort',  'warrior', { fortify: 5 }, 'M full Fort', 'mage', { fortify: 5 }],
      ['W full Brs',   'warrior', { berserker: 5 }, 'M full Brs', 'mage', { berserker: 5 }],
      ['W Prec+Brs',   'warrior', { precision: 2, berserker: 2, lifesteal: 1 }, 'M Prec+Brs', 'mage', { precision: 2, berserker: 2, lifesteal: 1 }],
    ]},
    // Warrior vs Warrior (mirror)
    { cat: '⚔️ vs ⚔️ WARRIOR MIRROR', matchups: [
      ['W Fort',     'warrior', { fortify: 5 },       'W Brs',    'warrior', { berserker: 5 }],
      ['W Fort+LS',  'warrior', { fortify: 3, lifesteal: 2 }, 'W full Fort', 'warrior', { fortify: 5 }],
      ['W Brs+LS+F', 'warrior', { berserker: 2, lifesteal: 2, fortify: 1 }, 'W Fort+LS', 'warrior', { fortify: 3, lifesteal: 2 }],
      ['W Evasion',  'warrior', { evasion: 5 }, 'W Brs', 'warrior', { berserker: 5 }],
      ['W Precision','warrior', { precision: 5 }, 'W Fort', 'warrior', { fortify: 5 }],
    ]},
    // Mage vs Mage (mirror)
    { cat: '🔮 vs 🔮 MAGE MIRROR', matchups: [
      ['M Fort',     'mage', { fortify: 5 },       'M Brs',    'mage', { berserker: 5 }],
      ['M Fort+LS',  'mage', { fortify: 3, lifesteal: 2 }, 'M full Fort', 'mage', { fortify: 5 }],
      ['M Brs+LS+F', 'mage', { berserker: 2, lifesteal: 2, fortify: 1 }, 'M Fort+LS', 'mage', { fortify: 3, lifesteal: 2 }],
      ['M Evasion',  'mage', { evasion: 5 }, 'M Brs', 'mage', { berserker: 5 }],
    ]},
  ];

  for (const { cat, matchups } of pvpSets) {
    console.log(`  ${cat}`);
    for (const [l1, c1, p1, l2, c2, p2] of matchups) {
      const r = simPvP(c1, p1, c2, p2, 100, FIGHTS);
      const v = r.p1wr > 60 ? '← P1' : r.p1wr < 40 ? 'P2 →' : '≈ BAL';
      const flag = (r.p1wr > 70 || r.p1wr < 30) ? ' ⚠️' : ' ✅';
      console.log(`    ${l1.padEnd(16)} vs ${l2.padEnd(16)} | ${String(r.p1wr + '%').padStart(5)} | ${v}${flag}`);
    }
    console.log('');
  }

  // Multi-level check (Lv20, Lv50, Lv100, Lv200)
  console.log('── PvE wall check: no gear, no passives ──\n');
  console.log('Level | W depth | M depth | Gap');
  console.log('──────┼─────────┼─────────┼─────');
  for (const lv of [1, 10, 20, 50, 100, 150, 200]) {
    const w = simPvE('warrior', lv, {}, 30);
    const m = simPvE('mage', lv, {}, 30);
    const gap = m.avg - w.avg;
    const gapStr = gap > 0 ? `M+${gap}` : gap < 0 ? `W+${-gap}` : 'even';
    console.log(`  ${String(lv).padStart(3)} | ${String(w.avg).padStart(7)} | ${String(m.avg).padStart(7)} | ${gapStr}`);
  }

  // PvP cross-class at different levels
  console.log('\n── PvP: Warrior vs Mage at different levels (no passives) ──\n');
  console.log('Level |  W WR | Verdict');
  console.log('──────┼───────┼────────');
  for (const lv of [10, 20, 50, 100, 150, 200]) {
    const r = simPvP('warrior', {}, 'mage', {}, lv, FIGHTS);
    const v = r.p1wr > 60 ? 'W ↑' : r.p1wr < 40 ? 'M ↑' : '≈ BAL';
    const flag = (r.p1wr > 70 || r.p1wr < 30) ? ' ⚠️' : ' ✅';
    console.log(`  ${String(lv).padStart(3)} | ${String(r.p1wr + '%').padStart(5)} | ${v}${flag}`);
  }
}

restoreGrowth();
console.log('\n' + '═'.repeat(75));
console.log('  Done. Original growth rates restored (in-memory only, no file changed).');
console.log('═'.repeat(75));
