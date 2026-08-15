'use strict';
// Evasion MODE comparison sim: max(base,gear) [current] vs additive capped 48 [proposed Option B].
// The evasion behavior comes from the SOURCE (battleEngine/pvpManager) — this script only
// labels the run (argv[2]). Run baseline first, edit source, run again, diff the tables.
// Rogue-only: Warrior/Mage have baseEvasion 0 => zero change for them (static reference rows).
// Run: node test/evasion_mode_sim.js <label>

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
    for (const f of ['greed', 'wisdom', 'swift']) { if (!usedIds.has(f)) { passives.push({ id: f, emoji: '', value: DIVINE_MAX[f], unit: f === 'swift' ? '' : '%' }); break; } } // non-combat filler (matches final_balance_sim)
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
  let p1wins = 0, p2wins = 0, draws = 0, totalTurns = 0;
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
    else p2wins++;
    P.endFight(fightId);
  }
  P.activePvpFights.clear();
  return { p1wr: Math.round(p1wins / fights * 100), p2wr: Math.round(p2wins / fights * 100), drawPct: Math.round(draws / fights * 100), avgTurns: (totalTurns / fights).toFixed(1) };
}

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
      const result = E.resolveFight({ stats, hp, skills, passives, charClass: cls }, E.generateEnemy(floor));
      if (result.winner === 'player') { hp = result.playerHpLeft; depth = floor; } else break;
    }
    total += depth;
  }
  return Math.round(total / runs);
}

// ==============================
const FIGHTS = 2000, RUNS = 40;
console.log(`\n████ EVE MODE: ${LABEL.toUpperCase()} ████`);

// Rogue builds. Gear eva column assumes the mode: max => max(8,gear), add => 8+gear capped 48.
const rogueBuilds = [
  ['DPS (no eva)',       { berserker: 2, lifesteal: 2, fortify: 1 }],
  ['EVA1 (13 eva)',      { evasion: 1, lifesteal: 2, berserker: 1 }],
  ['EVA3 (39 eva)',      { evasion: 3, lifesteal: 1 }],
  ['EVA5 (40 cap eva)',  { evasion: 5 }],
];
const OPP = { fortify: 3, lifesteal: 2 };

console.log(`\n⚔️ PvP Rogue vs Warrior (opponent: Fort+LS divine) — ${FIGHTS} fights`);
console.log('  Build               | Lv 50 | Lv100 | Lv200 | Lv300 | AvgT');
console.log('  ────────────────────┼───────┼───────┼───────┼───────┼─────');
for (const [label, pass] of rogueBuilds) {
  const cells = [];
  let tSum = 0;
  for (const lv of [50, 100, 200, 300]) {
    const r = simPvP('rogue', pass, 'warrior', OPP, lv, FIGHTS);
    cells.push(String(r.p1wr + '%').padStart(5));
    tSum += parseFloat(r.avgTurns);
  }
  console.log(`  ${label.padEnd(20)} | ${cells.join(' | ')} | ${(tSum / 4).toFixed(1)}`);
}

console.log(`\n⚔️ PvP Rogue vs Mage (opponent: Fort+LS divine) — ${FIGHTS} fights`);
console.log('  Build               | Lv 50 | Lv100 | Lv200 | Lv300 | AvgT');
console.log('  ────────────────────┼───────┼───────┼───────┼───────┼─────');
for (const [label, pass] of rogueBuilds) {
  const cells = [];
  let tSum = 0;
  for (const lv of [50, 100, 200, 300]) {
    const r = simPvP('rogue', pass, 'mage', OPP, lv, FIGHTS);
    cells.push(String(r.p1wr + '%').padStart(5));
    tSum += parseFloat(r.avgTurns);
  }
  console.log(`  ${label.padEnd(20)} | ${cells.join(' | ')} | ${(tSum / 4).toFixed(1)}`);
}

// Static references (unaffected by mode): W vs M + W vs W + M vs M
console.log(`\n📋 Reference (mode-immune): W vs M / W vs W / M vs M at Lv100`);
for (const [l1, c1, l2, c2] of [['W', 'warrior', 'M', 'mage'], ['W', 'warrior', 'W', 'warrior'], ['M', 'mage', 'M', 'mage']]) {
  const r = simPvP(c1, OPP, c2, OPP, 100, FIGHTS);
  console.log(`  ${l1} vs ${l2}: ${r.p1wr}% / ${r.p2wr}% (draw ${r.drawPct}%) t=${r.avgTurns}`);
}

// RvR mirror: both get the mode bonus => should stay ~50, sanity for turn-length inflation
console.log(`\n🪞 RvR mirror EVA3 vs EVA3`);
for (const lv of [100, 300]) {
  const r = simPvP('rogue', { evasion: 3, lifesteal: 1 }, 'rogue', { evasion: 3, lifesteal: 1 }, lv, FIGHTS);
  console.log(`  Lv${lv}: ${r.p1wr}% / ${r.p2wr}% (draw ${r.drawPct}%) t=${r.avgTurns}`);
}

// PvE death floors
console.log(`\n⛏️ PvE full-depth death floor (avg of ${RUNS} runs)`);
console.log('  Class  | Build               | Lv80 | Lv200');
console.log('  ───────┼─────────────────────┼──────┼───────');
for (const [label, pass] of rogueBuilds) {
  const d80 = simPvEFull('rogue', 80, pass, RUNS);
  const d200 = simPvEFull('rogue', 200, pass, RUNS);
  console.log(`  🗡️ rog | ${label.padEnd(20)}| ${String(d80).padStart(4)} | ${String(d200).padStart(5)}`);
}
// Static PvE reference (mode-immune)
for (const [cls, emo] of [['warrior', '⚔️ war'], ['mage', '🔮 mag']]) {
  const d80 = simPvEFull(cls, 80, OPP, RUNS);
  const d200 = simPvEFull(cls, 200, OPP, RUNS);
  console.log(`  ${emo} | ${'Fort+LS'.padEnd(20)}| ${String(d80).padStart(4)} | ${String(d200).padStart(5)}`);
}
console.log(`\nDone (${LABEL}).`);
