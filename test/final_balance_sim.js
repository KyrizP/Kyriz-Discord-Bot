'use strict';
// Final comprehensive sim: PvE wall test + PvP with Divine gear + passives
// Tests specifically: "can a Lv200 Mage who was at floor 80 still push after nerf?"
// Also tests all PvP matchups with Divine gear.
// Run: node test/final_balance_sim.js

const E = require('../utils/battleEngine');
const P = require('../utils/pvpManager');
const { CLASSES, PASSIVE_CAPS } = require('../utils/battleConfig');

const ORIG_W = { ...CLASSES.warrior.growth };
const ORIG_M = { ...CLASSES.mage.growth };

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

// PvE: start from specific floor (simulating sweep to bestDepth-5)
function simPvEFromFloor(cls, level, passiveConfig, startFloor, runs) {
  const { uniqueItems, equipment } = buildGear(cls, passiveConfig);
  const stats = E.computeStats(level, cls, equipment, uniqueItems);
  const passives = E.getPassives(equipment, uniqueItems);
  const skills = CLASSES[cls].skills;
  let totalExtra = 0, maxExtra = 0, minExtra = Infinity;
  for (let r = 0; r < runs; r++) {
    let hp = stats.hp, cleared = 0;
    for (let floor = startFloor; floor <= 500; floor++) {
      if (hp <= 0) break;
      const result = E.resolveFight({ stats, hp, skills, passives }, E.generateEnemy(floor));
      if (result.winner === 'player') { hp = result.playerHpLeft; cleared++; } else break;
    }
    totalExtra += cleared;
    maxExtra = Math.max(maxExtra, cleared);
    minExtra = Math.min(minExtra, cleared);
  }
  return { avg: Math.round(totalExtra / runs), min: minExtra, max: maxExtra };
}

// PvE full depth (from floor 1)
function simPvEFull(cls, level, passiveConfig, runs) {
  const { uniqueItems, equipment } = buildGear(cls, passiveConfig);
  const stats = E.computeStats(level, cls, equipment, uniqueItems);
  const passives = E.getPassives(equipment, uniqueItems);
  const skills = CLASSES[cls].skills;
  let total = 0;
  for (let r = 0; r < runs; r++) {
    let hp = stats.hp, depth = 0;
    for (let floor = 1; floor <= 500; floor++) {
      if (hp <= 0) break;
      const result = E.resolveFight({ stats, hp, skills, passives }, E.generateEnemy(floor));
      if (result.winner === 'player') { hp = result.playerHpLeft; depth = floor; } else break;
    }
    total += depth;
  }
  return Math.round(total / runs);
}

function mkPlayer(id, cls, level, passiveConfig) {
  const { uniqueItems, equipment } = buildGear(cls, passiveConfig);
  const stats = E.computeStats(level, cls, equipment, uniqueItems);
  return { id, username: id, charName: id, charLevel: level, charClass: cls, stats, skills: CLASSES[cls].skills, equipment, uniqueItems, cosmetics: {} };
}

function simPvP(cls1, pass1, cls2, pass2, level, fights) {
  let p1wins = 0, p2wins = 0, draws = 0, totalTurns = 0;
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
      if (!P.resolvePvpTurn(fightId, actor.id, sid).ok) P.resolvePvpTurn(fightId, actor.id, actor.skills[0].id);
      if (ak === 'p1') p1t++; else p2t++;
    }
    totalTurns += fight.turnCount;
    if (fight.timeout) draws++;
    else if (fight.winner === 'p1') p1wins++;
    else p2wins++;
    P.endFight(fightId);
  }
  P.activePvpFights.clear();
  return {
    p1wr: Math.round(p1wins / fights * 100),
    p2wr: Math.round(p2wins / fights * 100),
    drawPct: Math.round(draws / fights * 100),
    avgTurns: (totalTurns / fights).toFixed(1),
  };
}

// ============================================================
const RUNS = 50;
const FIGHTS = 300;

const cfgs = [
  { label: 'CURRENT', w: {}, m: {} },
  { label: 'CONFIG A: W-ATK 2.2, M-DEF 1.5', w: { atk: 2.2 }, m: { def: 1.5 } },
];

const passiveBuilds = [
  ['No passives', {}],
  ['3× Fort+2× LS', { fortify: 3, lifesteal: 2 }],
  ['2× Brs+2× LS+Fort', { berserker: 2, lifesteal: 2, fortify: 1 }],
  ['5× Fortify', { fortify: 5 }],
  ['5× Lifesteal', { lifesteal: 5 }],
  ['5× Berserker', { berserker: 5 }],
];

for (const cfg of cfgs) {
  Object.assign(CLASSES.warrior.growth, ORIG_W, cfg.w);
  Object.assign(CLASSES.mage.growth, ORIG_M, cfg.m);

  console.log('\n' + '═'.repeat(90));
  console.log(`  ${cfg.label}`);
  console.log('═'.repeat(90));

  // =============================================
  // PART 1: PvE Wall Test (the critical question)
  // =============================================
  console.log('\n  📍 PvE WALL TEST: Can Lv200 Mage still push from floor 75? (sweep to 75, push from 76)');
  console.log('  Scenario: bestDepth=80, sweep to 75, fight from floor 76 with full HP\n');
  console.log('  Build                | Class   | Extra floors | Can push? | Full depth');
  console.log('  ─────────────────────┼─────────┼──────────────┼───────────┼───────────');
  for (const [label, pass] of passiveBuilds) {
    for (const cls of ['warrior', 'mage']) {
      const wallTest = simPvEFromFloor(cls, 200, pass, 76, RUNS);
      const fullD = simPvEFull(cls, 200, pass, RUNS);
      const canPush = wallTest.avg >= 6 ? '✅ YES' : wallTest.avg >= 1 ? '🟡 barely' : '❌ STUCK';
      const clsEmoji = cls === 'warrior' ? '⚔️' : '🔮';
      console.log(`  ${label.padEnd(21)} | ${clsEmoji} ${cls.padEnd(6)} | avg=${String(wallTest.avg).padStart(2)} (${wallTest.min}-${wallTest.max})  | ${canPush.padEnd(9)} | ${fullD}`);
    }
  }

  // Also test Lv100 at floor 55
  console.log('\n  📍 PvE WALL TEST: Can Lv100 Mage still push from floor 55? (bestDepth=60)\n');
  console.log('  Build                | Class   | Extra floors | Can push?');
  console.log('  ─────────────────────┼─────────┼──────────────┼──────────');
  for (const [label, pass] of [['No passives', {}], ['3× Fort+2× LS', { fortify: 3, lifesteal: 2 }]]) {
    for (const cls of ['warrior', 'mage']) {
      const wallTest = simPvEFromFloor(cls, 100, pass, 56, RUNS);
      const canPush = wallTest.avg >= 6 ? '✅ YES' : wallTest.avg >= 1 ? '🟡 barely' : '❌ STUCK';
      console.log(`  ${label.padEnd(21)} | ${cls === 'warrior' ? '⚔️' : '🔮'} ${cls.padEnd(6)} | avg=${String(wallTest.avg).padStart(2)} (${wallTest.min}-${wallTest.max})  | ${canPush}`);
    }
  }

  // =============================================
  // PART 2: PvP with Divine gear + passives
  // =============================================
  console.log('\n  ⚔️ PvP WITH DIVINE GEAR + PASSIVES (Lv100, 300 fights):');
  console.log('  P1                     vs P2                     | P1 WR | P2 WR | Draw | Turns | Result');
  console.log('  ───────────────────────────────────────────────────┼───────┼───────┼──────┼───────┼────────');

  const pvpTests = [
    // W vs M (same builds)
    ['⚔️ W no pass',      'warrior', {},                       '🔮 M no pass',      'mage', {}],
    ['⚔️ W Fort+LS',      'warrior', { fortify: 3, lifesteal: 2 }, '🔮 M Fort+LS',  'mage', { fortify: 3, lifesteal: 2 }],
    ['⚔️ W Brs+LS+F',     'warrior', { berserker: 2, lifesteal: 2, fortify: 1 }, '🔮 M Brs+LS+F', 'mage', { berserker: 2, lifesteal: 2, fortify: 1 }],
    ['⚔️ W full Fort',    'warrior', { fortify: 5 },           '🔮 M full Fort',    'mage', { fortify: 5 }],
    ['⚔️ W full Brs',     'warrior', { berserker: 5 },         '🔮 M full Brs',     'mage', { berserker: 5 }],
    // W vs W (mirror)
    ['⚔️ W Fort',         'warrior', { fortify: 5 },           '⚔️ W Brs',          'warrior', { berserker: 5 }],
    ['⚔️ W Fort+LS',      'warrior', { fortify: 3, lifesteal: 2 }, '⚔️ W Fort',     'warrior', { fortify: 5 }],
    ['⚔️ W Brs+LS+F',     'warrior', { berserker: 2, lifesteal: 2, fortify: 1 }, '⚔️ W Fort+LS', 'warrior', { fortify: 3, lifesteal: 2 }],
    // M vs M (mirror)
    ['🔮 M Fort',         'mage', { fortify: 5 },              '🔮 M Brs',          'mage', { berserker: 5 }],
    ['🔮 M Fort+LS',      'mage', { fortify: 3, lifesteal: 2 }, '🔮 M Fort',        'mage', { fortify: 5 }],
    ['🔮 M Brs+LS+F',     'mage', { berserker: 2, lifesteal: 2, fortify: 1 }, '🔮 M Fort+LS', 'mage', { fortify: 3, lifesteal: 2 }],
  ];

  for (const [l1, c1, p1, l2, c2, p2] of pvpTests) {
    const r = simPvP(c1, p1, c2, p2, 100, FIGHTS);
    const mark = r.drawPct > 30 ? 'STALL' : r.p1wr >= 35 && r.p1wr <= 65 ? '✅ BAL' : r.p1wr > 65 ? '⚠️ P1' : '⚠️ P2';
    console.log(`  ${l1.padEnd(24)} vs ${l2.padEnd(24)} | ${String(r.p1wr+'%').padStart(5)} | ${String(r.p2wr+'%').padStart(5)} | ${String(r.drawPct+'%').padStart(4)} | ${r.avgTurns.padStart(5)} | ${mark}`);
  }

  // PvP at multiple levels W vs M with Fort+LS
  console.log('\n  ⚔️ PvP W vs M (Fort+LS) at different levels:');
  console.log('  Level | W WR  | M WR  | Draw | Turns | Result');
  console.log('  ──────┼───────┼───────┼──────┼───────┼────────');
  for (const lv of [20, 50, 100, 150, 200]) {
    const pass = { fortify: 3, lifesteal: 2 };
    const r = simPvP('warrior', pass, 'mage', pass, lv, FIGHTS);
    const mark = r.drawPct > 30 ? 'STALL' : r.p1wr >= 35 && r.p1wr <= 65 ? '✅ BAL' : r.p1wr > 65 ? '⚠️ W' : '⚠️ M';
    console.log(`  Lv${String(lv).padStart(3)} | ${String(r.p1wr+'%').padStart(5)} | ${String(r.p2wr+'%').padStart(5)} | ${String(r.drawPct+'%').padStart(4)} | ${r.avgTurns.padStart(5)} | ${mark}`);
  }
}

Object.assign(CLASSES.warrior.growth, ORIG_W);
Object.assign(CLASSES.mage.growth, ORIG_M);
console.log('\n  Growth rates restored. No files modified.');
