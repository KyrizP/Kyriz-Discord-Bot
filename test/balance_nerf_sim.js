'use strict';
// Nerf sim: test different cap values. Run: node test/balance_nerf_sim.js
const E = require('../utils/battleEngine');
const P = require('../utils/pvpManager');
const { CLASSES, CRIT, PASSIVE_CAPS } = require('../utils/battleConfig');

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
  const slotStats = [
    isM ? DIVINE_STATS.weapon_matk : DIVINE_STATS.weapon_atk, DIVINE_STATS.head,
    DIVINE_STATS.armor, DIVINE_STATS.boots,
    isM ? DIVINE_STATS.accessory_matk : DIVINE_STATS.accessory_atk,
  ];
  const assignments = [];
  for (const [pid, count] of Object.entries(passiveConfig))
    for (let i = 0; i < count; i++) assignments.push(pid);
  for (let i = 0; i < 5; i++) {
    const id = `ky_sim_${i}`, passives = [];
    if (i < assignments.length)
      passives.push({ id: assignments[i], emoji: '', value: DIVINE_MAX[assignments[i]], unit: assignments[i] === 'swift' ? '' : '%' });
    const usedIds = new Set(passives.map(p => p.id));
    for (const f of fillers) { if (!usedIds.has(f)) { passives.push({ id: f, emoji: '', value: DIVINE_MAX[f], unit: f === 'swift' ? '' : '%' }); break; } }
    if (passives.length < 2) passives.push({ id: 'wisdom', emoji: '', value: 30, unit: '%' });
    uniqueItems[id] = { id, name: `SimGear${i}`, rarity: 'divine', slot: EQUIP_SLOTS[i], stats: slotStats[i], passives };
    equipment[EQUIP_SLOTS[i]] = id;
  }
  return { uniqueItems, equipment };
}

// Patched getPassives that uses custom caps
function getPassivesWithCaps(equipment, uniqueItems, customCaps) {
  const sums = {};
  for (const slot of EQUIP_SLOTS) {
    const id = equipment[slot];
    if (id && id.startsWith('ky') && uniqueItems[id]) {
      for (const p of (uniqueItems[id].passives || []))
        sums[p.id] = (sums[p.id] || 0) + (p.value || 0);
    }
  }
  for (const id of Object.keys(customCaps)) {
    if (sums[id] != null && sums[id] > customCaps[id]) sums[id] = customCaps[id];
  }
  return sums;
}

function simPvE(cls, level, passiveConfig, runs, customCaps) {
  const { uniqueItems, equipment } = buildGear(cls, passiveConfig);
  const stats = E.computeStats(level, cls, equipment, uniqueItems);
  const passives = customCaps ? getPassivesWithCaps(equipment, uniqueItems, customCaps) : E.getPassives(equipment, uniqueItems);
  const skills = CLASSES[cls].skills;
  let totalDepth = 0, maxD = 0, minD = Infinity;
  for (let r = 0; r < runs; r++) {
    let hp = stats.hp, depth = 0;
    for (let floor = 1; floor <= 500; floor++) {
      if (hp <= 0) break;
      const enemy = E.generateEnemy(floor);
      const result = E.resolveFight({ stats, hp, skills, passives }, enemy);
      if (result.winner === 'player') { hp = result.playerHpLeft; depth = floor; } else break;
    }
    totalDepth += depth; maxD = Math.max(maxD, depth); minD = Math.min(minD, depth);
  }
  return { avg: Math.round(totalDepth / runs), min: minD, max: maxD, passives };
}

function mkPvpPlayer(id, cls, level, passiveConfig) {
  const { uniqueItems, equipment } = buildGear(cls, passiveConfig);
  const stats = E.computeStats(level, cls, equipment, uniqueItems);
  return { id, username: id, charName: id, charLevel: level, charClass: cls, stats, skills: CLASSES[cls].skills, equipment, uniqueItems, cosmetics: {} };
}

function simPvP(cls1, pass1, cls2, pass2, level, fights, customCaps) {
  let p1wins = 0;
  const pattern = [0, 1, 0, 1, 2];
  // Temporarily override PASSIVE_CAPS if custom caps provided
  const origCaps = { ...PASSIVE_CAPS };
  if (customCaps) Object.assign(PASSIVE_CAPS, customCaps);
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
  // Restore original caps
  if (customCaps) Object.assign(PASSIVE_CAPS, origCaps);
  return { p1wins, p2wins: fights - p1wins, p1wr: Math.round(p1wins / fights * 100) };
}

// ============================================================
const LEVEL = 100;
const RUNS = 50;
const FIGHTS = 200;

// Test 3 scenarios: current, moderate nerf, aggressive nerf
const scenarios = [
  { name: 'CURRENT',   caps: { berserker: 100, lifesteal: 80, fortify: 80, evasion: 40, precision: 50 } },
  { name: 'OPTION A',  caps: { berserker: 100, lifesteal: 65, fortify: 45, evasion: 40, precision: 50 } },
  { name: 'OPTION B',  caps: { berserker: 100, lifesteal: 70, fortify: 40, evasion: 40, precision: 50 } },
];

const keyBuilds = [
  ['Baseline',              {}],
  ['5× Fortify',            { fortify: 5 }],
  ['5× Lifesteal',          { lifesteal: 5 }],
  ['5× Berserker',          { berserker: 5 }],
  ['3× Fort + 2× LS',      { fortify: 3, lifesteal: 2 }],
  ['2× Brs + 2× LS + Fort', { berserker: 2, lifesteal: 2, fortify: 1 }],
];

const keyPvpMatchups = [
  ['5× Fortify',   'warrior', { fortify: 5 },   '5× Berserker', 'warrior', { berserker: 5 }],
  ['5× Fortify',   'warrior', { fortify: 5 },   '5× Lifesteal', 'warrior', { lifesteal: 5 }],
  ['3× Fort+2× LS','warrior', { fortify: 3, lifesteal: 2 }, '5× Fortify', 'warrior', { fortify: 5 }],
  ['2× Brs+LS+Fort','warrior', { berserker: 2, lifesteal: 2, fortify: 1 }, '3× Fort+2× LS', 'warrior', { fortify: 3, lifesteal: 2 }],
  ['Warrior mixed', 'warrior', { berserker: 2, lifesteal: 2, fortify: 1 }, 'Mage mixed', 'mage', { berserker: 2, lifesteal: 2, fortify: 1 }],
  ['Warrior base',  'warrior', {},               'Mage base',    'mage', {}],
  ['5× Evasion',    'warrior', { evasion: 5 },   '5× Berserker', 'warrior', { berserker: 5 }],
  ['5× Precision',  'warrior', { precision: 5 }, '5× Fortify',   'warrior', { fortify: 5 }],
];

for (const sc of scenarios) {
  console.log('\n' + '═'.repeat(70));
  console.log(`  ${sc.name}: Fortify=${sc.caps.fortify}% | Lifesteal=${sc.caps.lifesteal}% | Berserker=${sc.caps.berserker}% | Evasion=${sc.caps.evasion}%`);
  console.log('═'.repeat(70));

  console.log('\n── PvE Warrior Lv' + LEVEL + ' ──\n');
  console.log('Build                          | Avg  | Min  | Max  | Eff. Passives');
  console.log('───────────────────────────────┼──────┼──────┼──────┼──────────────');
  for (const [label, cfg] of keyBuilds) {
    const r = simPvE('warrior', LEVEL, cfg, RUNS, sc.caps);
    const pStr = Object.entries(r.passives).filter(([k]) => !['greed','wisdom','swift'].includes(k)).map(([k,v]) => `${k}:${v}%`).join(', ') || 'none';
    console.log(`${label.padEnd(30)} | ${String(r.avg).padStart(4)} | ${String(r.min).padStart(4)} | ${String(r.max).padStart(4)} | ${pStr}`);
  }

  console.log('\n── PvP Lv' + LEVEL + ' ──\n');
  console.log('P1                     vs  P2                     | P1 WR | Verdict');
  console.log('───────────────────────────────────────────────────┼───────┼────────');
  for (const [l1, c1, p1, l2, c2, p2] of keyPvpMatchups) {
    const r = simPvP(c1, p1, c2, p2, LEVEL, FIGHTS, sc.caps);
    const v = r.p1wr > 60 ? 'P1 DOM' : r.p1wr < 40 ? 'P2 DOM' : 'BALANCED';
    const flag = (r.p1wr > 70 || r.p1wr < 30) ? ' ⚠️' : '';
    console.log(`${l1.padEnd(22)} vs  ${l2.padEnd(22)} | ${String(r.p1wr+'%').padStart(5)} | ${v}${flag}`);
  }
}

console.log('\n' + '═'.repeat(70));
console.log('  Done. Compare scenarios above to find optimal caps.');
console.log('═'.repeat(70));
