'use strict';
// Evasion mode LEVEL SWEEP: PvP Lv80..500 (10 points) + PvE depth at 5 levels + opponent-build sensitivity.
// Mode comes from SOURCE. Run: node test/evasion_level_sweep.js <label>
const E = require('../utils/battleEngine');
const P = require('../utils/pvpManager');
const { CLASSES } = require('../utils/battleConfig');

const LABEL = process.argv[2] || 'run';
const EQUIP_SLOTS = ['weapon', 'head', 'armor', 'boots', 'accessory'];
const DIVINE_MAX = { berserker: 32, precision: 25, lifesteal: 25, swift: 20, fortify: 22, evasion: 13, greed: 30, wisdom: 30 };
const DIVINE_STATS = {
  weapon_atk: { atk: 55 }, weapon_matk: { matk: 55 }, head: { def: 26 },
  armor: { def: 52 }, boots: { spd: 34 },
  accessory_atk: { atk: 35, spd: 12 }, accessory_matk: { matk: 35, spd: 12 },
};

function buildGear(cls, passiveConfig) {
  const uniqueItems = {}, equipment = {};
  const isM = cls === 'mage';
  const slotStats = [isM ? DIVINE_STATS.weapon_matk : DIVINE_STATS.weapon_atk, DIVINE_STATS.head, DIVINE_STATS.armor, DIVINE_STATS.boots, isM ? DIVINE_STATS.accessory_matk : DIVINE_STATS.accessory_atk];
  const assignments = [];
  for (const [pid, count] of Object.entries(passiveConfig)) for (let i = 0; i < count; i++) assignments.push(pid);
  for (let i = 0; i < 5; i++) {
    const id = `ky_sim_${i}`, passives = [];
    if (i < assignments.length) passives.push({ id: assignments[i], emoji: '', value: DIVINE_MAX[assignments[i]], unit: assignments[i] === 'swift' ? '' : '%' });
    const usedIds = new Set(passives.map(p => p.id));
    for (const f of ['greed', 'wisdom', 'swift']) { if (!usedIds.has(f)) { passives.push({ id: f, emoji: '', value: DIVINE_MAX[f], unit: f === 'swift' ? '' : '%' }); break; } }
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

function simPvP(cls1, pass1, cls2, pass2, level, fights) {
  let p1wins = 0, draws = 0, totalTurns = 0;
  const pattern = [0, 1, 0, 1, 2];
  for (let f = 0; f < fights; f++) {
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
    P.endFight(fightId);
  }
  P.activePvpFights.clear();
  return { wr: Math.round(p1wins / fights * 100), drawPct: Math.round(draws / fights * 100), avgTurns: (totalTurns / fights).toFixed(1) };
}

function simPvEFull(cls, level, passiveConfig, runs) {
  const { uniqueItems, equipment } = buildGear(cls, passiveConfig);
  const stats = E.computeStats(level, cls, equipment, uniqueItems);
  const passives = E.getPassives(equipment, uniqueItems);
  const skills = CLASSES[cls].skills;
  let total = 0;
  for (let r = 0; r < runs; r++) {
    let hp = stats.hp, depth = 0;
    for (let floor = 1; floor <= 700; floor++) {
      if (hp <= 0) break;
      const result = E.resolveFight({ stats, hp, skills, passives, charClass: cls }, E.generateEnemy(floor));
      if (result.winner === 'player') { hp = result.playerHpLeft; depth = floor; } else break;
    }
    total += depth;
  }
  return Math.round(total / runs);
}

const FIGHTS = 1500, RUNS = 30;
const LEVELS = [80, 100, 150, 200, 250, 300, 350, 400, 450, 500];
const rogueBuilds = [
  ['DPS',      { berserker: 2, lifesteal: 2, fortify: 1 }],
  ['EVA3',     { evasion: 3, lifesteal: 1 }],
  ['EVA5',     { evasion: 5 }],
];
const OPP = { fortify: 3, lifesteal: 2 };

console.log(`\n████ LEVEL SWEEP — MODE: ${LABEL.toUpperCase()} ████`);

for (const oppCls of ['warrior', 'mage']) {
  console.log(`\n⚔️ Rogue vs ${oppCls === 'warrior' ? 'Warrior' : 'Mage'} (Fort+LS) — ${FIGHTS} fights — Rogue WR per level`);
  console.log('  Build | ' + LEVELS.map(l => `Lv${l}`).join(' | '));
  console.log('  ──────┼' + LEVELS.map(() => '──────').join('┼'));
  for (const [label, pass] of rogueBuilds) {
    const cells = LEVELS.map((lv) => { const r = simPvP('rogue', pass, oppCls, OPP, lv, FIGHTS); return String(r.wr + '%').padStart(6); });
    console.log(`  ${label.padEnd(5)} | ` + cells.join(' | '));
  }
}

// Opponent-build sensitivity at Lv200: does a damage-stacked opponent flip any matchup?
console.log(`\n🧪 Opponent-build sensitivity (Lv200, Rogue WR)`);
const sensTests = [
  ['rog EVA5 vs War Brs5 (full dmg)', 'rogue', { evasion: 5 }, 'warrior', { berserker: 5 }],
  ['rog EVA5 vs War Fort5 (full tank)', 'rogue', { evasion: 5 }, 'warrior', { fortify: 5 }],
  ['rog EVA3 vs Mage Brs5 (full dmg)', 'rogue', { evasion: 3, lifesteal: 1 }, 'mage', { berserker: 5 }],
  ['rog DPS  vs Mage Brs5', 'rogue', { berserker: 2, lifesteal: 2, fortify: 1 }, 'mage', { berserker: 5 }],
];
for (const [label, c1, p1, c2, p2] of sensTests) {
  const r = simPvP(c1, p1, c2, p2, 200, FIGHTS);
  console.log(`  ${label.padEnd(34)}: ${String(r.wr + '%').padStart(5)} (draw ${r.drawPct}%, t=${r.avgTurns})`);
}

console.log(`\n🪞 RvR mirror EVA5 vs EVA5 (worst stall case)`);
for (const lv of [250, 500]) {
  const r = simPvP('rogue', { evasion: 5 }, 'rogue', { evasion: 5 }, lv, FIGHTS);
  console.log(`  Lv${lv}: ${r.wr}%/${100 - r.wr - r.drawPct}% (draw ${r.drawPct}%) t=${r.avgTurns}`);
}

console.log(`\n⛏️ PvE full-depth death floor (avg ${RUNS} runs)`);
const pveLevels = [80, 150, 250, 400, 500];
console.log('  Class/Build      | ' + pveLevels.map(l => `Lv${l}`).join(' | '));
console.log('  ──────────────────┼' + pveLevels.map(() => '──────').join('┼'));
const pveRows = [
  ['🗡️ rog DPS',  'rogue', { berserker: 2, lifesteal: 2, fortify: 1 }],
  ['🗡️ rog EVA3', 'rogue', { evasion: 3, lifesteal: 1 }],
  ['🗡️ rog EVA5', 'rogue', { evasion: 5 }],
  ['⚔️ war FortLS', 'warrior', OPP],
  ['🔮 mag FortLS', 'mage', OPP],
];
for (const [label, cls, pass] of pveRows) {
  console.log(`  ${label.padEnd(18)}| ` + pveLevels.map((lv) => String(simPvEFull(cls, lv, pass, RUNS)).padStart(6)).join(' | '));
}
console.log(`\nDone (${LABEL}).`);
