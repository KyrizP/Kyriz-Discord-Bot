'use strict';
// PvP class bonus sweep: find optimal Warrior damage multiplier for balanced cross-class PvP.
// Tests warrior bonus from 1.0 to 1.5 in 0.05 steps.
// Run: node test/pvp_bonus_sweep.js

const E = require('../utils/battleEngine');
const P = require('../utils/pvpManager');
const { CLASSES } = require('../utils/battleConfig');

const EQUIP_SLOTS = ['weapon', 'head', 'armor', 'boots', 'accessory'];
const DIVINE_MAX = { berserker: 32, precision: 25, lifesteal: 25, swift: 20, fortify: 22, evasion: 13, greed: 30, wisdom: 30 };
const DIVINE_STATS = {
  weapon_atk: { atk: 55 }, weapon_matk: { matk: 55 }, head: { def: 26 },
  armor: { def: 52 }, boots: { spd: 34 },
  accessory_atk: { atk: 35, spd: 12 }, accessory_matk: { matk: 35, spd: 12 },
};

// Epic gear
const EPIC_WARRIOR = { weapon: 'g10', head: 'g21', armor: 'g12', boots: 'g13', accessory: 'g14' };
const EPIC_MAGE = { weapon: 'g11', head: 'g22', armor: 'g23', boots: 'g13', accessory: 'g15' };

function buildDivine(cls, passiveConfig) {
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

function mkPlayer(id, cls, level, gearType, passives) {
  let equipment = {}, uniqueItems = {};
  if (gearType === 'divine') {
    const g = buildDivine(cls, passives || {});
    equipment = g.equipment; uniqueItems = g.uniqueItems;
  } else if (gearType === 'epic') {
    equipment = cls === 'warrior' ? EPIC_WARRIOR : EPIC_MAGE;
  }
  const stats = E.computeStats(level, cls, equipment, uniqueItems);
  return { id, username: id, charName: id, charLevel: level, charClass: cls, stats, skills: CLASSES[cls].skills, equipment, uniqueItems, cosmetics: {} };
}

// Modified sim that applies warrior damage bonus manually
// Since we can't change PVP constants at runtime, we'll monkey-patch
function simPvPWithBonus(cls1, cls2, level, fights, wBonus, gearType, pass1, pass2) {
  // Strategy: intercept damage by patching the fight objects
  // Actually simpler: since warrior bonus = multiply warrior's ATK/MATK before fight
  // We'll modify stats directly
  let p1wins = 0, p2wins = 0, draws = 0, totalTurns = 0;
  const pattern = [0, 1, 0, 1, 2];
  
  for (let f = 0; f < fights; f++) {
    P.activePvpFights.clear();
    const fightId = `sim_${f}`;
    const p1 = mkPlayer('P1', cls1, level, gearType, pass1);
    const p2 = mkPlayer('P2', cls2, level, gearType, pass2);
    
    // Apply class bonus to ATK/MATK (before fight starts, PvP only)
    if (cls1 === 'warrior') {
      p1.stats = { ...p1.stats, atk: Math.round(p1.stats.atk * wBonus) };
    }
    if (cls2 === 'warrior') {
      p2.stats = { ...p2.stats, atk: Math.round(p2.stats.atk * wBonus) };
    }
    
    const fight = P.startFight(fightId, p1, p2);
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
    drawPct: Math.round(draws / fights * 100),
    avgTurns: (totalTurns / fights).toFixed(1),
  };
}

// ============================================================
const FIGHTS = 300;

console.log('═'.repeat(85));
console.log('  PVP CLASS BONUS SWEEP — Finding optimal Warrior damage multiplier');
console.log('  Testing Warrior ATK boost 1.0x to 1.50x in PvP (Mage unchanged)');
console.log('═'.repeat(85));

const bonusRange = [1.0, 1.05, 1.10, 1.15, 1.20, 1.25, 1.30, 1.35, 1.40, 1.45, 1.50];

const scenarios = [
  { label: 'Epic, no pass, Lv100',    gear: 'epic',   pass: {},                                    level: 100 },
  { label: 'Divine, no pass, Lv100',   gear: 'divine', pass: {},                                    level: 100 },
  { label: 'Divine, Fort+LS, Lv100',   gear: 'divine', pass: { fortify: 3, lifesteal: 2 },          level: 100 },
  { label: 'Divine, Brs+LS+F, Lv100',  gear: 'divine', pass: { berserker: 2, lifesteal: 2, fortify: 1 }, level: 100 },
  { label: 'Divine, Fort+LS, Lv50',    gear: 'divine', pass: { fortify: 3, lifesteal: 2 },          level: 50  },
  { label: 'Divine, Fort+LS, Lv200',   gear: 'divine', pass: { fortify: 3, lifesteal: 2 },          level: 200 },
  { label: 'Epic, no pass, Lv50',      gear: 'epic',   pass: {},                                    level: 50  },
];

// Header
console.log('\n  Scenario' + ' '.repeat(28) + bonusRange.map(b => `${b.toFixed(2)}x`).join(' | '));
console.log('  ' + '─'.repeat(38) + '┼' + bonusRange.map(() => '───────').join('┼'));

const allResults = [];

for (const sc of scenarios) {
  const row = [`  ${sc.label.padEnd(36)} |`];
  const rowResults = [];
  for (const bonus of bonusRange) {
    const r = simPvPWithBonus('warrior', 'mage', sc.level, FIGHTS, bonus, sc.gear, sc.pass, sc.pass);
    const wr = r.p1wr;
    rowResults.push(wr);
    const flag = wr >= 40 && wr <= 60 ? ' ✅' : wr >= 35 && wr <= 65 ? ' 🟡' : ' ⚠️';
    row.push(`${String(wr + '%').padStart(4)}${flag}`);
  }
  allResults.push({ label: sc.label, results: rowResults });
  console.log(row.join(' | '));
}

// Find best bonus (lowest average deviation from 50%)
console.log('\n── AGGREGATE ANALYSIS ──\n');
console.log('  Bonus | Avg WR | Max Dev | Verdict');
console.log('  ──────┼────────┼─────────┼────────');
for (let i = 0; i < bonusRange.length; i++) {
  const b = bonusRange[i];
  const wrs = allResults.map(r => r.results[i]);
  const avgWr = Math.round(wrs.reduce((a, b) => a + b, 0) / wrs.length);
  const maxDev = Math.max(...wrs.map(w => Math.abs(w - 50)));
  const flag = avgWr >= 45 && avgWr <= 55 && maxDev <= 20 ? '✅ SWEET SPOT' : 
               avgWr >= 40 && avgWr <= 60 ? '🟡 OK' : '⚠️';
  console.log(`  ${b.toFixed(2)}x | ${String(avgWr + '%').padStart(6)} | ${String(maxDev).padStart(7)} | ${flag}`);
}

// Detailed view with best bonus — also check W vs W impact
const bestIdx = allResults.reduce((best, _, i) => {
  const wrs = allResults.map(r => r.results[i]);
  const avgDev = wrs.reduce((a, w) => a + Math.abs(w - 50), 0) / wrs.length;
  const bestWrs = allResults.map(r => r.results[best]);
  const bestDev = bestWrs.reduce((a, w) => a + Math.abs(w - 50), 0) / bestWrs.length;
  return avgDev < bestDev ? i : best;
}, 0);

const bestBonus = bonusRange[bestIdx];
console.log(`\n  🏆 Best bonus: ${bestBonus.toFixed(2)}x\n`);

// Check mirror matchups with best bonus (should be unchanged since both get it)
console.log('── Mirror matchups with bonus (should stay ~50%) ──\n');
for (const [label, gear, pass, lv] of [
  ['W vs W Epic Lv100', 'epic', {}, 100],
  ['W vs W Divine Fort+LS Lv100', 'divine', { fortify: 3, lifesteal: 2 }, 100],
  ['M vs M Divine Fort+LS Lv100', 'divine', { fortify: 3, lifesteal: 2 }, 100],
]) {
  const cls = label.startsWith('M') ? 'mage' : 'warrior';
  const r = simPvPWithBonus(cls, cls, lv, FIGHTS, cls === 'warrior' ? bestBonus : 1.0, gear, pass, pass);
  const flag = r.drawPct > 30 ? 'STALL' : r.p1wr >= 40 && r.p1wr <= 60 ? '✅' : '⚠️';
  console.log(`  ${label.padEnd(35)} | ${String(r.p1wr+'%').padStart(5)} P1 | ${r.avgTurns} turns | ${flag}`);
}

console.log('\n  Done.');
