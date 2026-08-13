'use strict';
// Realistic PvP sim: Turn cap 30, Epic gear, tests all configs.
// Patches TURN_CAP in-memory. Tests with class-appropriate Epic gear sets.
// Run: node test/realistic_pvp_sim.js

const E = require('../utils/battleEngine');
const P = require('../utils/pvpManager');
const { CLASSES, GEAR } = require('../utils/battleConfig');

const ORIG_W = { ...CLASSES.warrior.growth };
const ORIG_M = { ...CLASSES.mage.growth };

// Epic gear sets — class-appropriate
// Warrior: ATK weapon, DEF head, DEF armor, SPD boots, ATK+SPD accessory
const EPIC_WARRIOR = {
  weapon: 'g10',    // Dragon Slayer: atk 16
  head: 'g21',      // Vanguard Greathelm: def 12
  armor: 'g12',     // Mithril Armor: def 18
  boots: 'g13',     // Boots of Haste: spd 8
  accessory: 'g14', // Warlord Gauntlets: atk 10, spd 3
};
// Mage: MATK weapon, MDEF head, MDEF armor, SPD boots, MATK+MDEF accessory
const EPIC_MAGE = {
  weapon: 'g11',    // Archmage Staff: matk 16
  head: 'g22',      // Archmage Cowl: mdef 11
  armor: 'g23',     // Mystic Vestments: mdef 14
  boots: 'g13',     // Boots of Haste: spd 8
  accessory: 'g15', // Arcane Orb: matk 10, mdef 5
};

function mkPlayer(id, cls, level, epicGear) {
  const equipment = epicGear || {};
  const stats = E.computeStats(level, cls, equipment, {});
  return { id, username: id, charName: id, charLevel: level, charClass: cls,
    stats, skills: CLASSES[cls].skills, equipment, uniqueItems: {}, cosmetics: {} };
}

function simPvP(cls1, gear1, cls2, gear2, level, fights, turnCap) {
  // Patch TURN_CAP
  const origCap = P.TURN_CAP;
  // TURN_CAP is a const, need to access via module internals
  // Instead, we'll run the sim with a manual turn limit
  let p1wins = 0, p2wins = 0, draws = 0, totalTurns = 0, p1hpPcts = [], p2hpPcts = [];
  const pattern = [0, 1, 0, 1, 2];
  for (let f = 0; f < fights; f++) {
    P.activePvpFights.clear();
    const fightId = `sim_${f}`;
    const fight = P.startFight(fightId, mkPlayer('P1', cls1, level, gear1), mkPlayer('P2', cls2, level, gear2));
    P.clearAfkTimer(fightId);
    let p1t = 0, p2t = 0, turns = 0;
    // Use our own turn cap check since we can't modify the const
    while (!fight.over && turns < turnCap) {
      turns++;
      const ak = fight.active, actor = fight[ak];
      const ti = ak === 'p1' ? p1t : p2t;
      const want = actor.skills[pattern[ti % pattern.length]];
      const sid = (actor.cdLeft[want.id] || 0) <= 0 ? want.id : actor.skills[0].id;
      if (!P.resolvePvpTurn(fightId, actor.id, sid).ok) P.resolvePvpTurn(fightId, actor.id, actor.skills[0].id);
      if (ak === 'p1') p1t++; else p2t++;
    }
    totalTurns += turns;
    const p1hp = fight.p1.hp / fight.p1.hpMax;
    const p2hp = fight.p2.hp / fight.p2.hpMax;
    if (fight.over && !fight.timeout) {
      if (fight.winner === 'p1') p1wins++; else p2wins++;
    } else {
      // Timeout — compare HP%
      if (fight.p1.hp <= 0 && fight.p2.hp <= 0) draws++;
      else if (p1hp > p2hp) p1wins++;
      else if (p2hp > p1hp) p2wins++;
      else draws++;
    }
    p1hpPcts.push(Math.round(p1hp * 100));
    p2hpPcts.push(Math.round(p2hp * 100));
    P.endFight(fightId);
  }
  P.activePvpFights.clear();
  const avgP1hp = Math.round(p1hpPcts.reduce((a, b) => a + b, 0) / p1hpPcts.length);
  const avgP2hp = Math.round(p2hpPcts.reduce((a, b) => a + b, 0) / p2hpPcts.length);
  const actualKills = p1wins + p2wins - draws;
  return {
    p1wr: Math.round(p1wins / fights * 100),
    p2wr: Math.round(p2wins / fights * 100),
    drawPct: Math.round(draws / fights * 100),
    avgTurns: (totalTurns / fights).toFixed(1),
    avgP1hp, avgP2hp,
    killRate: Math.round((fights - draws) / fights * 100 - (fight => 0)), // what % ended in actual kill vs timeout
  };
}

// ============================================================
const FIGHTS = 300;
const levels = [10, 20, 50, 100, 200];

const configs = [
  { label: 'CURRENT',                                    w: {}, m: {} },
  { label: 'A: W-ATK 2.2, M-DEF 1.5',                   w: { atk: 2.2 }, m: { def: 1.5 } },
  { label: 'B: W-ATK 2.3, M-DEF 1.5',                   w: { atk: 2.3 }, m: { def: 1.5 } },
  { label: 'C: W-ATK 2.3, M-DEF 1.4',                   w: { atk: 2.3 }, m: { def: 1.4 } },
];

const turnCaps = [20, 30];

for (const cfg of configs) {
  Object.assign(CLASSES.warrior.growth, ORIG_W, cfg.w);
  Object.assign(CLASSES.mage.growth, ORIG_M, cfg.m);

  const wS = E.computeStats(100, 'warrior', EPIC_WARRIOR, {});
  const mS = E.computeStats(100, 'mage', EPIC_MAGE, {});
  console.log('\n' + '═'.repeat(85));
  console.log(`  ${cfg.label}`);
  console.log(`  Warrior Lv100+Epic: HP=${wS.hp} ATK=${wS.atk} DEF=${wS.def} MDEF=${wS.mdef} SPD=${wS.spd}`);
  console.log(`  Mage    Lv100+Epic: HP=${mS.hp} MATK=${mS.matk} DEF=${mS.def} MDEF=${mS.mdef} SPD=${mS.spd}`);
  console.log('═'.repeat(85));

  for (const cap of turnCaps) {
    console.log(`\n  ⚔️ EPIC GEAR, Turn Cap = ${cap}:`);
    console.log('  Match     | Level | W WR  | M WR  | Draw | Turns | W HP% | M HP% | Result');
    console.log('  ──────────┼───────┼───────┼───────┼──────┼───────┼───────┼───────┼────────');
    for (const lv of levels) {
      const r = simPvP('warrior', EPIC_WARRIOR, 'mage', EPIC_MAGE, lv, FIGHTS, cap);
      const mark = r.drawPct > 30 ? 'STALL' : r.p1wr >= 35 && r.p1wr <= 65 ? '✅ BAL' : r.p1wr > 65 ? '⚠️ W' : '⚠️ M';
      console.log(`  W vs M    | Lv${String(lv).padStart(3)} | ${String(r.p1wr+'%').padStart(5)} | ${String(r.p2wr+'%').padStart(5)} | ${String(r.drawPct+'%').padStart(4)} | ${r.avgTurns.padStart(5)} | ${String(r.avgP1hp+'%').padStart(5)} | ${String(r.avgP2hp+'%').padStart(5)} | ${mark}`);
    }

    // Mirror at Lv100
    const ww = simPvP('warrior', EPIC_WARRIOR, 'warrior', EPIC_WARRIOR, 100, FIGHTS, cap);
    const mm = simPvP('mage', EPIC_MAGE, 'mage', EPIC_MAGE, 100, FIGHTS, cap);
    console.log(`  W vs W    | Lv100 | ${String(ww.p1wr+'%').padStart(5)} | ${String(ww.p2wr+'%').padStart(5)} | ${String(ww.drawPct+'%').padStart(4)} | ${ww.avgTurns.padStart(5)} | ${String(ww.avgP1hp+'%').padStart(5)} | ${String(ww.avgP2hp+'%').padStart(5)} | ${ww.drawPct > 30 ? 'STALL' : '✅'}`);
    console.log(`  M vs M    | Lv100 | ${String(mm.p1wr+'%').padStart(5)} | ${String(mm.p2wr+'%').padStart(5)} | ${String(mm.drawPct+'%').padStart(4)} | ${mm.avgTurns.padStart(5)} | ${String(mm.avgP1hp+'%').padStart(5)} | ${String(mm.avgP2hp+'%').padStart(5)} | ${mm.drawPct > 30 ? 'STALL' : '✅'}`);
  }
}

Object.assign(CLASSES.warrior.growth, ORIG_W);
Object.assign(CLASSES.mage.growth, ORIG_M);
console.log('\n  Growth rates restored.\n');
