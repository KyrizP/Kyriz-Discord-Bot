'use strict';
// Realistic PvP balance sim with RANDOM skill selection + multiple tuning knobs.
// Tests: PVP_DAMAGE_MULT × Warrior ATK bonus × all matchups/gear/levels.
// Random skills break the determinism that caused 100-0 results.
// Run: node test/pvp_balance_final.js

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
const EPIC_W = { weapon: 'g10', head: 'g21', armor: 'g12', boots: 'g13', accessory: 'g14' };
const EPIC_M = { weapon: 'g11', head: 'g22', armor: 'g23', boots: 'g13', accessory: 'g15' };

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

function mkPlayer(id, cls, level, gearType, passives, wBonus) {
  let equipment = {}, uniqueItems = {};
  if (gearType === 'divine') {
    const g = buildDivine(cls, passives || {});
    equipment = g.equipment; uniqueItems = g.uniqueItems;
  } else if (gearType === 'epic') {
    equipment = cls === 'warrior' ? EPIC_W : EPIC_M;
  }
  const stats = { ...E.computeStats(level, cls, equipment, uniqueItems) };
  // Apply PvP warrior ATK bonus
  if (cls === 'warrior' && wBonus > 1) stats.atk = Math.round(stats.atk * wBonus);
  return { id, username: id, charName: id, charLevel: level, charClass: cls, stats, skills: CLASSES[cls].skills, equipment, uniqueItems, cosmetics: {} };
}

// Pick a random AVAILABLE skill (smart random: prefer stronger skills, use ult when ready)
function pickRandomSkill(actor) {
  const available = actor.skills.filter(s => (actor.cdLeft[s.id] || 0) <= 0);
  if (available.length === 0) return actor.skills[0].id; // fallback to basic
  // 50% chance to use strongest available, 50% random
  if (Math.random() < 0.5) {
    // Use highest mult available
    available.sort((a, b) => b.mult - a.mult);
    return available[0].id;
  }
  return available[Math.floor(Math.random() * available.length)].id;
}

function simPvP(cls1, cls2, lv1, lv2, gear, pass1, pass2, wBonus, fights) {
  let p1wins = 0, p2wins = 0, draws = 0, totalTurns = 0, kills = 0;
  for (let f = 0; f < fights; f++) {
    P.activePvpFights.clear();
    const fightId = `sim_${f}`;
    const fight = P.startFight(fightId,
      mkPlayer('P1', cls1, lv1, gear, pass1, wBonus),
      mkPlayer('P2', cls2, lv2, gear, pass2, wBonus));
    P.clearAfkTimer(fightId);
    let turns = 0;
    while (!fight.over && turns < 50) {
      turns++;
      const ak = fight.active, actor = fight[ak];
      const sid = pickRandomSkill(actor);
      const res = P.resolvePvpTurn(fightId, actor.id, sid);
      if (!res.ok) P.resolvePvpTurn(fightId, actor.id, actor.skills[0].id);
    }
    totalTurns += fight.turnCount;
    if (fight.timeout) draws++;
    else { kills++; if (fight.winner === 'p1') p1wins++; else p2wins++; }
    P.endFight(fightId);
  }
  P.activePvpFights.clear();
  return {
    p1wr: Math.round(p1wins / fights * 100),
    p2wr: Math.round(p2wins / fights * 100),
    drawPct: Math.round(draws / fights * 100),
    killRate: Math.round(kills / fights * 100),
    avgTurns: (totalTurns / fights).toFixed(1),
  };
}

// ============================================================
const FIGHTS = 500;
const wBonusRange = [1.0, 1.05, 1.10, 1.12, 1.15, 1.20];

console.log('═'.repeat(90));
console.log('  PVP BALANCE SIM — Random skill picks (realistic)');
console.log('  Testing Warrior PvP ATK bonus sweep');
console.log('═'.repeat(90));

// ── W vs M at same level, different gear tiers ──
const tests = [
  { label: 'Epic no pass Lv100',     gear: 'epic',   p: {},                                    lv: 100 },
  { label: 'Epic no pass Lv50',      gear: 'epic',   p: {},                                    lv: 50  },
  { label: 'Divine no pass Lv100',   gear: 'divine', p: {},                                    lv: 100 },
  { label: 'Divine Fort+LS Lv100',   gear: 'divine', p: { fortify: 3, lifesteal: 2 },          lv: 100 },
  { label: 'Divine Brs+LS+F Lv100',  gear: 'divine', p: { berserker: 2, lifesteal: 2, fortify: 1 }, lv: 100 },
  { label: 'Divine Fort+LS Lv50',    gear: 'divine', p: { fortify: 3, lifesteal: 2 },          lv: 50  },
  { label: 'Divine Fort+LS Lv200',   gear: 'divine', p: { fortify: 3, lifesteal: 2 },          lv: 200 },
];

console.log('\n── W vs M (same level, same build) ──\n');
const header = 'Scenario'.padEnd(28) + ' | ' + wBonusRange.map(b => `${b.toFixed(2)}x`).join(' | ');
console.log('  ' + header);
console.log('  ' + '─'.repeat(28) + '─┼─' + wBonusRange.map(() => '──────').join('─┼─'));

const allWrs = {};
for (const t of tests) {
  const row = [`${t.label.padEnd(28)} |`];
  for (const wb of wBonusRange) {
    const r = simPvP('warrior', 'mage', t.lv, t.lv, t.gear, t.p, t.p, wb, FIGHTS);
    const k = r.killRate > 0 ? `${r.p1wr}%` : `${r.p1wr}%☠`;
    const flag = r.p1wr >= 40 && r.p1wr <= 60 ? '✅' : r.p1wr >= 35 && r.p1wr <= 65 ? '🟡' : '⚠️';
    row.push(`${k.padStart(4)} ${flag}`);
    if (!allWrs[wb]) allWrs[wb] = [];
    allWrs[wb].push(r.p1wr);
  }
  console.log('  ' + row.join(' | '));
}

// Aggregate
console.log('\n── AGGREGATE ──\n');
console.log('  Bonus | Avg WR | Min  | Max  | Spread | Verdict');
console.log('  ──────┼────────┼──────┼──────┼────────┼────────');
let bestBonus = 1.0, bestScore = 999;
for (const wb of wBonusRange) {
  const wrs = allWrs[wb];
  const avg = Math.round(wrs.reduce((a, b) => a + b, 0) / wrs.length);
  const mn = Math.min(...wrs), mx = Math.max(...wrs);
  const spread = mx - mn;
  const score = Math.abs(avg - 50) + spread * 0.3;
  const flag = avg >= 40 && avg <= 60 && spread <= 30 ? '✅ GOOD' :
               avg >= 35 && avg <= 65 ? '🟡 OK' : '⚠️';
  if (score < bestScore) { bestScore = score; bestBonus = wb; }
  console.log(`  ${wb.toFixed(2)}x | ${String(avg + '%').padStart(6)} | ${String(mn + '%').padStart(4)} | ${String(mx + '%').padStart(4)} | ${String(spread).padStart(6)} | ${flag}`);
}

console.log(`\n  🏆 Best bonus: ${bestBonus.toFixed(2)}x`);

// ── Mirror matchups with best bonus ──
console.log(`\n── Mirror matchups with ${bestBonus.toFixed(2)}x bonus ──\n`);
const mirrors = [
  ['W vs W Epic Lv100',       'warrior', 'warrior', 'epic',   {}, 100, 100],
  ['W vs W Divine F+LS Lv100','warrior', 'warrior', 'divine', { fortify: 3, lifesteal: 2 }, 100, 100],
  ['M vs M Epic Lv100',       'mage',    'mage',    'epic',   {}, 100, 100],
  ['M vs M Divine F+LS Lv100','mage',    'mage',    'divine', { fortify: 3, lifesteal: 2 }, 100, 100],
];
console.log('  Match                      | P1 WR | P2 WR | Draw | Kill% | Turns');
console.log('  ───────────────────────────┼───────┼───────┼──────┼───────┼──────');
for (const [label, c1, c2, gear, pass, lv1, lv2] of mirrors) {
  const r = simPvP(c1, c2, lv1, lv2, gear, pass, pass, bestBonus, FIGHTS);
  console.log(`  ${label.padEnd(27)} | ${String(r.p1wr+'%').padStart(5)} | ${String(r.p2wr+'%').padStart(5)} | ${String(r.drawPct+'%').padStart(4)} | ${String(r.killRate+'%').padStart(5)} | ${r.avgTurns.padStart(5)}`);
}

// ── Level diff test (Lv95 vs Lv100) ──
console.log(`\n── Level difference test with ${bestBonus.toFixed(2)}x bonus ──\n`);
console.log('  Match                          | P1 WR | P2 WR | Draw | Verdict');
console.log('  ───────────────────────────────┼───────┼───────┼──────┼────────');
const lvTests = [
  ['W Lv95 vs M Lv100 (Epic)',    'warrior', 'mage',    95,  100, 'epic',   {}],
  ['W Lv100 vs M Lv95 (Epic)',    'warrior', 'mage',    100, 95,  'epic',   {}],
  ['W Lv95 vs W Lv100 (Epic)',    'warrior', 'warrior', 95,  100, 'epic',   {}],
  ['M Lv95 vs M Lv100 (Epic)',    'mage',    'mage',    95,  100, 'epic',   {}],
  ['W Lv95 vs M Lv100 (Div F+LS)','warrior','mage',    95,  100, 'divine', { fortify: 3, lifesteal: 2 }],
  ['W Lv100 vs M Lv95 (Div F+LS)','warrior','mage',    100, 95,  'divine', { fortify: 3, lifesteal: 2 }],
];
for (const [label, c1, c2, lv1, lv2, gear, pass] of lvTests) {
  const r = simPvP(c1, c2, lv1, lv2, gear, pass, pass, bestBonus, FIGHTS);
  const v = r.p1wr >= 35 && r.p1wr <= 65 ? '✅ Reachable' : '⚠️ Dominant';
  console.log(`  ${label.padEnd(31)} | ${String(r.p1wr+'%').padStart(5)} | ${String(r.p2wr+'%').padStart(5)} | ${String(r.drawPct+'%').padStart(4)} | ${v}`);
}

console.log('\n  Done.\n');
