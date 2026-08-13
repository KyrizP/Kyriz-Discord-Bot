'use strict';
// Verification sim after nerfs: Fortify 45%, Lifesteal 65%, Evasion 30%, ult pierce evasion.
// Run: node test/balance_verify.js

const E = require('../utils/battleEngine');
const P = require('../utils/pvpManager');
const { CLASSES, PASSIVE_CAPS } = require('../utils/battleConfig');

const EQUIP_SLOTS = ['weapon', 'head', 'armor', 'boots', 'accessory'];
const DIVINE_MAX = {
  berserker: 32, precision: 25, lifesteal: 25, swift: 20,
  fortify: 22, evasion: 13, greed: 30, wisdom: 30,
};
const DIVINE_STATS = {
  weapon_atk: { atk: 55 }, weapon_matk: { matk: 55 },
  head: { def: 26 }, armor: { def: 52 }, boots: { spd: 34 },
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

function mkPvpPlayer(id, cls, level, passiveConfig) {
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
  return { avg: Math.round(totalDepth / runs), min: minD, max: maxD, passives };
}

function simPvP(cls1, pass1, cls2, pass2, level, fights) {
  let p1wins = 0;
  const pattern = [0, 1, 0, 1, 2];
  for (let f = 0; f < fights; f++) {
    P.activePvpFights.clear();
    const fightId = `sim_${f}`;
    const fight = P.startFight(fightId, mkPvpPlayer('P1', cls1, level, pass1), mkPvpPlayer('P2', cls2, level, pass2));
    P.clearAfkTimer(fightId);
    let p1turn = 0, p2turn = 0, turns = 0;
    while (!fight.over && turns < 50) {
      turns++;
      const actorKey = fight.active, actor = fight[actorKey];
      const turnIdx = actorKey === 'p1' ? p1turn : p2turn;
      const want = actor.skills[pattern[turnIdx % pattern.length]];
      const skillId = (actor.cdLeft[want.id] || 0) <= 0 ? want.id : actor.skills[0].id;
      const result = P.resolvePvpTurn(fightId, actor.id, skillId);
      if (!result.ok) P.resolvePvpTurn(fightId, actor.id, actor.skills[0].id);
      if (actorKey === 'p1') p1turn++; else p2turn++;
    }
    if (fight.winner === 'p1') p1wins++;
    P.endFight(fightId);
  }
  P.activePvpFights.clear();
  return { p1wins, p2wins: fights - p1wins, p1wr: Math.round(p1wins / fights * 100) };
}

// ============================================================
const LVL = 100;
const RUNS = 50;
const FIGHTS = 300;

console.log('═══════════════════════════════════════════════════════════════');
console.log('  POST-NERF VERIFICATION — Fortify=' + PASSIVE_CAPS.fortify + '% | LS=' + PASSIVE_CAPS.lifesteal + '% | Eva=' + PASSIVE_CAPS.evasion + '% | Ult pierce evasion');
console.log('═══════════════════════════════════════════════════════════════\n');

// PvE
console.log('── PvE: Warrior Lv' + LVL + ' (baseline must NOT be stuck) ──\n');
const pveData = [
  ['Baseline (no passives)', 'warrior', {}],
  ['5× Fortify',             'warrior', { fortify: 5 }],
  ['5× Lifesteal',           'warrior', { lifesteal: 5 }],
  ['5× Berserker',           'warrior', { berserker: 5 }],
  ['3× Fort + 2× LS',       'warrior', { fortify: 3, lifesteal: 2 }],
  ['2× Brs + 2× LS + Fort', 'warrior', { berserker: 2, lifesteal: 2, fortify: 1 }],
  ['5× Evasion',             'warrior', { evasion: 5 }],
];
let pveResults = [];
for (const [label, cls, cfg] of pveData) {
  const r = simPvE(cls, LVL, cfg, RUNS);
  const pStr = Object.entries(r.passives).filter(([k]) => !['greed','wisdom','swift'].includes(k)).map(([k,v]) => `${k}:${v}%`).join(', ') || 'none';
  pveResults.push({ label, ...r, pStr });
}
pveResults.sort((a, b) => b.avg - a.avg);
console.log('Rank | Build                          | Avg  | Min  | Max  | Passives (after new caps)');
console.log('─────┼────────────────────────────────┼──────┼──────┼──────┼─────────────────────────');
pveResults.forEach((r, i) => {
  console.log(`  ${String(i+1).padStart(2)} | ${r.label.padEnd(30)} | ${String(r.avg).padStart(4)} | ${String(r.min).padStart(4)} | ${String(r.max).padStart(4)} | ${r.pStr}`);
});

// PvP
console.log('\n── PvP: Lv' + LVL + ' (' + FIGHTS + ' fights per matchup) ──\n');
const pvpData = [
  ['5× Fortify',     'warrior', { fortify: 5 },       '5× Berserker',   'warrior', { berserker: 5 }],
  ['5× Fortify',     'warrior', { fortify: 5 },       '5× Lifesteal',   'warrior', { lifesteal: 5 }],
  ['5× Berserker',   'warrior', { berserker: 5 },     '5× Lifesteal',   'warrior', { lifesteal: 5 }],
  ['5× Precision',   'warrior', { precision: 5 },     '5× Fortify',     'warrior', { fortify: 5 }],
  ['5× Evasion',     'warrior', { evasion: 5 },       '5× Berserker',   'warrior', { berserker: 5 }],
  ['5× Evasion',     'warrior', { evasion: 5 },       '5× Fortify',     'warrior', { fortify: 5 }],
  ['3× Fort + 2× LS','warrior', { fortify: 3, lifesteal: 2 }, '5× Fortify', 'warrior', { fortify: 5 }],
  ['2× Brs+LS+Fort', 'warrior', { berserker: 2, lifesteal: 2, fortify: 1 }, '3× Fort+2× LS', 'warrior', { fortify: 3, lifesteal: 2 }],
  ['Warrior mixed',   'warrior', { berserker: 2, lifesteal: 2, fortify: 1 }, 'Mage mixed', 'mage', { berserker: 2, lifesteal: 2, fortify: 1 }],
  ['Warrior base',    'warrior', {},                   'Mage base',      'mage', {}],
];

let balanced = 0, dominated = 0;
console.log('P1                     vs  P2                     | P1 WR | Verdict');
console.log('───────────────────────────────────────────────────┼───────┼────────');
for (const [l1, c1, p1, l2, c2, p2] of pvpData) {
  const r = simPvP(c1, p1, c2, p2, LVL, FIGHTS);
  const isBalanced = r.p1wr >= 30 && r.p1wr <= 70;
  const v = r.p1wr > 60 ? 'P1 ↑' : r.p1wr < 40 ? 'P2 ↑' : '≈ BAL';
  const flag = (r.p1wr > 70 || r.p1wr < 30) ? ' ⚠️' : ' ✅';
  if (isBalanced) balanced++; else dominated++;
  console.log(`${l1.padEnd(22)} vs  ${l2.padEnd(22)} | ${String(r.p1wr+'%').padStart(5)} | ${v}${flag}`);
}

console.log('\n── Summary ──');
console.log(`Balanced (30-70% WR): ${balanced}/${balanced+dominated}`);
console.log(`Dominated (>70 or <30%): ${dominated}/${balanced+dominated}`);
console.log(`PvE baseline depth: ${pveResults.find(r => r.label.includes('Baseline')).avg} (must be ≥50 = not stuck)`);
console.log('═══════════════════════════════════════════════════════════════');
