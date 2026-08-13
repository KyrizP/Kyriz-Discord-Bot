'use strict';
// Evasion viability check: 40% cap + ult pierce evasion (current config).
// Tests evasion builds vs all other builds in PvP.
// Run: node test/evasion_check.js

const E = require('../utils/battleEngine');
const P = require('../utils/pvpManager');
const { CLASSES, PASSIVE_CAPS } = require('../utils/battleConfig');

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

function simPvP(cls1, pass1, cls2, pass2, level, fights) {
  let p1wins = 0, p2wins = 0, draws = 0, totalTurns = 0, dodges = 0, totalAtks = 0;
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
      const res = P.resolvePvpTurn(fightId, actor.id, sid);
      if (!res.ok) P.resolvePvpTurn(fightId, actor.id, actor.skills[0].id);
      else {
        totalAtks++;
        if (res.events && res.events.some(e => e.includes && e.includes('dodged'))) dodges++;
      }
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
const FIGHTS = 500;
console.log('═'.repeat(80));
console.log(`  EVASION VIABILITY CHECK — Cap ${PASSIVE_CAPS.evasion}% + Ult Pierce`);
console.log(`  Fortify cap: ${PASSIVE_CAPS.fortify}% | Lifesteal cap: ${PASSIVE_CAPS.lifesteal}%`);
console.log('═'.repeat(80));

const builds = [
  ['5× Evasion',     { evasion: 5 }],
  ['5× Fortify',     { fortify: 5 }],
  ['5× Berserker',   { berserker: 5 }],
  ['5× Lifesteal',   { lifesteal: 5 }],
  ['5× Precision',   { precision: 5 }],
  ['Fort+LS (3+2)',  { fortify: 3, lifesteal: 2 }],
  ['Brs+LS+F',      { berserker: 2, lifesteal: 2, fortify: 1 }],
  ['Eva+Fort (3+2)', { evasion: 3, fortify: 2 }],
  ['Eva+LS (3+2)',   { evasion: 3, lifesteal: 2 }],
];

// Round-robin: every build vs every other build
for (const cls of ['warrior', 'mage']) {
  const emoji = cls === 'warrior' ? '⚔️' : '🔮';
  console.log(`\n  ${emoji} ${cls.toUpperCase()} MIRROR PvP (Lv100, ${FIGHTS} fights):\n`);

  // Header
  const nameW = 12;
  const header = '  ' + 'P1 Build'.padEnd(nameW) + ' vs ' + 'P2 Build'.padEnd(nameW) + ' | P1 WR | P2 WR | Draw | Turns | Verdict';
  console.log(header);
  console.log('  ' + '─'.repeat(header.length - 2));

  // Evasion vs each other build
  const evasionBuild = builds[0];
  for (let j = 1; j < builds.length; j++) {
    const r = simPvP(cls, evasionBuild[1], cls, builds[j][1], 100, FIGHTS);
    const v = r.drawPct > 30 ? 'STALL' : r.p1wr >= 35 && r.p1wr <= 65 ? '✅ BAL' : r.p1wr > 65 ? '⬆️ EVA' : '⬇️ EVA';
    console.log(`  ${evasionBuild[0].padEnd(nameW)} vs ${builds[j][0].padEnd(nameW)} | ${String(r.p1wr+'%').padStart(5)} | ${String(r.p2wr+'%').padStart(5)} | ${String(r.drawPct+'%').padStart(4)} | ${r.avgTurns.padStart(5)} | ${v}`);
  }

  // Also test hybrid evasion builds
  console.log('');
  for (let i = builds.length - 2; i < builds.length; i++) {
    for (let j = 1; j < 7; j++) {
      if (i === j) continue;
      const r = simPvP(cls, builds[i][1], cls, builds[j][1], 100, FIGHTS);
      const v = r.drawPct > 30 ? 'STALL' : r.p1wr >= 35 && r.p1wr <= 65 ? '✅ BAL' : r.p1wr > 65 ? '⬆️ P1' : '⬇️ P1';
      console.log(`  ${builds[i][0].padEnd(nameW)} vs ${builds[j][0].padEnd(nameW)} | ${String(r.p1wr+'%').padStart(5)} | ${String(r.p2wr+'%').padStart(5)} | ${String(r.drawPct+'%').padStart(4)} | ${r.avgTurns.padStart(5)} | ${v}`);
    }
  }
}

// Cross-class evasion
console.log(`\n  ⚔️ vs 🔮 CROSS-CLASS (Lv100, ${FIGHTS} fights):\n`);
const crossTests = [
  ['5× Evasion', { evasion: 5 }, '5× Evasion', { evasion: 5 }],
  ['5× Evasion', { evasion: 5 }, '5× Fortify', { fortify: 5 }],
  ['5× Evasion', { evasion: 5 }, 'Fort+LS', { fortify: 3, lifesteal: 2 }],
  ['Eva+Fort',   { evasion: 3, fortify: 2 }, 'Fort+LS', { fortify: 3, lifesteal: 2 }],
  ['Eva+LS',     { evasion: 3, lifesteal: 2 }, 'Brs+LS+F', { berserker: 2, lifesteal: 2, fortify: 1 }],
];
for (const [l1, p1, l2, p2] of crossTests) {
  const r = simPvP('warrior', p1, 'mage', p2, 100, FIGHTS);
  const v = r.drawPct > 30 ? 'STALL' : r.p1wr >= 35 && r.p1wr <= 65 ? '✅ BAL' : r.p1wr > 65 ? '⬆️ W' : '⬇️ W';
  console.log(`  W ${l1.padEnd(12)} vs M ${l2.padEnd(12)} | ${String(r.p1wr+'%').padStart(5)} | ${String(r.p2wr+'%').padStart(5)} | ${String(r.drawPct+'%').padStart(4)} | ${r.avgTurns.padStart(5)} | ${v}`);
}

console.log('\n' + '═'.repeat(80));
console.log('  Done.');
