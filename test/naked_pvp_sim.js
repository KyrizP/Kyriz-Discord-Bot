'use strict';
// Naked PvP sim: NO gear, NO passives. Pure class stats.
// Tests W vs W, M vs M, W vs M at multiple levels.
// Tracks win rate + average turns.
// Run: node test/naked_pvp_sim.js

const E = require('../utils/battleEngine');
const P = require('../utils/pvpManager');
const { CLASSES } = require('../utils/battleConfig');

const ORIG_W = { ...CLASSES.warrior.growth };
const ORIG_M = { ...CLASSES.mage.growth };

function mkNakedPlayer(id, cls, level) {
  const stats = E.computeStats(level, cls, {});
  return { id, username: id, charName: id, charLevel: level, charClass: cls,
    stats, skills: CLASSES[cls].skills, equipment: {}, uniqueItems: {}, cosmetics: {} };
}

function simPvPDetailed(cls1, cls2, level, fights) {
  let p1wins = 0, totalTurns = 0, timeouts = 0;
  const pattern = [0, 1, 0, 1, 2];
  for (let f = 0; f < fights; f++) {
    P.activePvpFights.clear();
    const fightId = `sim_${f}`;
    const fight = P.startFight(fightId, mkNakedPlayer('P1', cls1, level), mkNakedPlayer('P2', cls2, level));
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
    totalTurns += turns;
    if (fight.winner === 'p1') p1wins++;
    if (fight.timeout) timeouts++;
    P.endFight(fightId);
  }
  P.activePvpFights.clear();
  return {
    p1wr: Math.round(p1wins / fights * 100),
    avgTurns: (totalTurns / fights).toFixed(1),
    timeouts,
  };
}

// ============================================================
const FIGHTS = 300;

const configs = [
  {
    label: 'CURRENT (no changes)',
    w: {}, m: {},
  },
  {
    label: 'A: W-ATK 2.2, M-DEF 1.5, M-HP 15 (keep)',
    w: { atk: 2.2 }, m: { def: 1.5 },
  },
  {
    label: 'B: W-ATK 2.2, M-DEF 1.5, M-HP 13',
    w: { atk: 2.2 }, m: { def: 1.5, hp: 13 },
  },
  {
    label: 'C: W-ATK 2.3, M-DEF 1.5, M-HP 15 (keep)',
    w: { atk: 2.3 }, m: { def: 1.5 },
  },
  {
    label: 'D: W-ATK 2.3, M-DEF 1.4, M-HP 15 (keep)',
    w: { atk: 2.3 }, m: { def: 1.4 },
  },
  {
    label: 'E: W-ATK 2.5, M-DEF 1.5, M-HP 15 (keep)',
    w: { atk: 2.5 }, m: { def: 1.5 },
  },
  {
    label: 'F: W-ATK 2.0, M-DEF 1.5, M-HP 15 (W unchanged)',
    w: {}, m: { def: 1.5 },
  },
  {
    label: 'G: W-ATK 2.0, M-DEF 1.4, M-HP 15 (W unchanged)',
    w: {}, m: { def: 1.4 },
  },
];

const levels = [10, 20, 50, 100, 200];
const matchups = [
  ['W vs M', 'warrior', 'mage'],
  ['W vs W', 'warrior', 'warrior'],
  ['M vs M', 'mage', 'mage'],
];

for (const cfg of configs) {
  Object.assign(CLASSES.warrior.growth, ORIG_W, cfg.w);
  Object.assign(CLASSES.mage.growth, ORIG_M, cfg.m);

  const wS100 = E.computeStats(100, 'warrior', {});
  const mS100 = E.computeStats(100, 'mage', {});

  console.log('\n' + '═'.repeat(80));
  console.log(`  ${cfg.label}`);
  console.log(`  Warrior Lv100: HP=${wS100.hp} ATK=${wS100.atk} DEF=${wS100.def} MDEF=${wS100.mdef} SPD=${wS100.spd}`);
  console.log(`  Mage    Lv100: HP=${mS100.hp} MATK=${mS100.matk} DEF=${mS100.def} MDEF=${mS100.mdef} SPD=${mS100.spd}`);
  console.log('═'.repeat(80));

  for (const [mLabel, c1, c2] of matchups) {
    console.log(`\n  ${mLabel} (naked, no gear, ${FIGHTS} fights):`);
    const isMirror = c1 === c2;
    console.log(`  ${'Level'.padEnd(6)} | ${'P1 WR'.padStart(6)} | ${'Turns'.padStart(6)} | ${'TO'.padStart(3)} | Verdict`);
    console.log(`  ${'─'.repeat(6)}┼${'─'.repeat(8)}┼${'─'.repeat(8)}┼${'─'.repeat(5)}┼${'─'.repeat(20)}`);
    for (const lv of levels) {
      const r = simPvPDetailed(c1, c2, lv, FIGHTS);
      let verdict;
      if (isMirror) {
        verdict = (r.p1wr >= 45 && r.p1wr <= 55) ? '≈ FAIR (mirror)' : 'SKEWED? ⚠️';
      } else {
        verdict = r.p1wr >= 35 && r.p1wr <= 65 ? '✅ BALANCED' :
                  r.p1wr > 65 ? `⚠️ ${c1} DOM` : `⚠️ ${c2} DOM`;
      }
      console.log(`  Lv${String(lv).padStart(3)} | ${String(r.p1wr + '%').padStart(6)} | ${String(r.avgTurns).padStart(6)} | ${String(r.timeouts).padStart(3)} | ${verdict}`);
    }
  }
}

// Restore
Object.assign(CLASSES.warrior.growth, ORIG_W);
Object.assign(CLASSES.mage.growth, ORIG_M);
console.log('\n' + '═'.repeat(80));
console.log('  Done. Growth rates restored.');
console.log('═'.repeat(80));
