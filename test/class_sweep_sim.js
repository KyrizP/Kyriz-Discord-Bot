'use strict';
// Sweep sim: find optimal growth rates for balanced Warrior vs Mage.
// Tests many combinations, picks the one closest to 50% PvP win rate.
// Run: node test/class_sweep_sim.js

const E = require('../utils/battleEngine');
const P = require('../utils/pvpManager');
const { CLASSES } = require('../utils/battleConfig');

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

function mkPlayer(id, cls, level, passiveConfig) {
  const { uniqueItems, equipment } = buildGear(cls, passiveConfig);
  const stats = E.computeStats(level, cls, equipment, uniqueItems);
  return { id, username: id, charName: id, charLevel: level, charClass: cls, stats, skills: CLASSES[cls].skills, equipment, uniqueItems, cosmetics: {} };
}

function simPvP(cls1, pass1, cls2, pass2, level, fights) {
  let p1wins = 0;
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
    if (fight.winner === 'p1') p1wins++;
    P.endFight(fightId);
  }
  P.activePvpFights.clear();
  return Math.round(p1wins / fights * 100);
}

function simPvE(cls, level, passiveConfig, runs) {
  const { uniqueItems, equipment } = buildGear(cls, passiveConfig);
  const stats = E.computeStats(level, cls, equipment, uniqueItems);
  const passives = E.getPassives(equipment, uniqueItems);
  const skills = CLASSES[cls].skills;
  let totalDepth = 0;
  for (let r = 0; r < runs; r++) {
    let hp = stats.hp, depth = 0;
    for (let floor = 1; floor <= 500; floor++) {
      if (hp <= 0) break;
      const result = E.resolveFight({ stats, hp, skills, passives }, E.generateEnemy(floor));
      if (result.winner === 'player') { hp = result.playerHpLeft; depth = floor; } else break;
    }
    totalDepth += depth;
  }
  return Math.round(totalDepth / runs);
}

// ============================================================
// Sweep
// ============================================================
const FIGHTS = 200;

// Test combinations: Warrior ATK growth × Mage DEF growth × Mage HP growth
const wAtkRange = [2.0, 2.2, 2.3, 2.5];
const mDefRange = [1.0, 1.2, 1.4, 1.5, 1.6, 1.8, 2.1];
const mHpRange  = [12, 13, 15];
const wHpRange  = [20, 22];

// PvP builds to test
const pvpBuilds = [
  ['no pass', {}],
  ['Fort+LS', { fortify: 3, lifesteal: 2 }],
  ['Brs+LS+F', { berserker: 2, lifesteal: 2, fortify: 1 }],
];

// Levels to test
const levels = [20, 50, 100, 200];

console.log('═══════════════════════════════════════════════════════════════════════════');
console.log('  CLASS BALANCE SWEEP — Finding optimal growth rates');
console.log('  Testing ' + (wAtkRange.length * mDefRange.length * mHpRange.length * wHpRange.length) + ' combinations');
console.log('═══════════════════════════════════════════════════════════════════════════\n');

const results = [];

for (const wAtk of wAtkRange) {
  for (const mDef of mDefRange) {
    for (const mHp of mHpRange) {
      for (const wHp of wHpRange) {
        // Apply growth
        Object.assign(CLASSES.warrior.growth, ORIG_W, { atk: wAtk, hp: wHp });
        Object.assign(CLASSES.mage.growth, ORIG_M, { def: mDef, hp: mHp });

        // PvP: average Warrior WR across levels and builds
        let totalWR = 0, count = 0;
        const wrByLevel = {};
        for (const lv of levels) {
          let lvWR = 0, lvN = 0;
          for (const [, cfg] of pvpBuilds) {
            const wr = simPvP('warrior', cfg, 'mage', cfg, lv, FIGHTS);
            totalWR += wr; count++;
            lvWR += wr; lvN++;
          }
          wrByLevel[lv] = Math.round(lvWR / lvN);
        }
        const avgWR = Math.round(totalWR / count);

        // PvE: check neither class is stuck (baseline depth)
        const wPvE = simPvE('warrior', 100, {}, 20);
        const mPvE = simPvE('mage', 100, {}, 20);

        const deviation = Math.abs(avgWR - 50);
        results.push({ wAtk, mDef, mHp, wHp, avgWR, wrByLevel, wPvE, mPvE, deviation });
      }
    }
  }
}

// Sort by closest to 50%
results.sort((a, b) => a.deviation - b.deviation);

// Show top 10
console.log('Top 10 most balanced combinations (closest to 50% Warrior WR):\n');
console.log('Rank | W-ATK | W-HP | M-DEF | M-HP | Avg WR | Lv20 | Lv50 | Lv100 | Lv200 | W PvE | M PvE | Gap');
console.log('─────┼───────┼──────┼───────┼──────┼────────┼──────┼──────┼───────┼───────┼───────┼───────┼─────');
for (let i = 0; i < Math.min(15, results.length); i++) {
  const r = results[i];
  const gap = r.wPvE - r.mPvE;
  const gapStr = gap > 0 ? `W+${gap}` : gap < 0 ? `M+${-gap}` : 'even';
  console.log(`  ${String(i + 1).padStart(2)} | ${String(r.wAtk).padStart(5)} | ${String(r.wHp).padStart(4)} | ${String(r.mDef).padStart(5)} | ${String(r.mHp).padStart(4)} | ${String(r.avgWR + '%').padStart(6)} | ${String(r.wrByLevel[20] + '%').padStart(4)} | ${String(r.wrByLevel[50] + '%').padStart(4)} | ${String(r.wrByLevel[100] + '%').padStart(5)} | ${String(r.wrByLevel[200] + '%').padStart(5)} | ${String(r.wPvE).padStart(5)} | ${String(r.mPvE).padStart(5)} | ${gapStr}`);
}

// Show worst 5 for contrast
console.log('\n\nWorst 5 (most imbalanced):');
console.log('Rank | W-ATK | W-HP | M-DEF | M-HP | Avg WR');
console.log('─────┼───────┼──────┼───────┼──────┼────────');
for (let i = results.length - 5; i < results.length; i++) {
  const r = results[i];
  console.log(`  ${String(i + 1).padStart(2)} | ${String(r.wAtk).padStart(5)} | ${String(r.wHp).padStart(4)} | ${String(r.mDef).padStart(5)} | ${String(r.mHp).padStart(4)} | ${String(r.avgWR + '%').padStart(6)}`);
}

// Detailed view of #1
const best = results[0];
console.log('\n═══════════════════════════════════════════════════════════════════════════');
console.log(`  🏆 BEST: W-ATK=${best.wAtk} W-HP=${best.wHp} M-DEF=${best.mDef} M-HP=${best.mHp}`);
console.log(`  Avg PvP WR: ${best.avgWR}% | PvE: W=${best.wPvE} M=${best.mPvE}`);
console.log('═══════════════════════════════════════════════════════════════════════════\n');

// Full test with best config
Object.assign(CLASSES.warrior.growth, ORIG_W, { atk: best.wAtk, hp: best.wHp });
Object.assign(CLASSES.mage.growth, ORIG_M, { def: best.mDef, hp: best.mHp });

console.log('── Full PvP breakdown (best config) ──\n');
for (const lv of [10, 20, 50, 100, 150, 200]) {
  const line = [`Lv${String(lv).padStart(3)}:`];
  for (const [label, cfg] of [...pvpBuilds, ['full Fort', { fortify: 5 }], ['full Brs', { berserker: 5 }]]) {
    const wr = simPvP('warrior', cfg, 'mage', cfg, lv, FIGHTS);
    const flag = (wr >= 35 && wr <= 65) ? '✅' : '⚠️';
    line.push(`${label}=${wr}%${flag}`);
  }
  console.log('  ' + line.join(' | '));
}

console.log('\n── PvE depth with passives (best config, Lv100) ──\n');
const pveBuilds = [
  ['No passives', {}], ['Fort+LS', { fortify: 3, lifesteal: 2 }],
  ['Brs+LS+Fort', { berserker: 2, lifesteal: 2, fortify: 1 }],
  ['Full Fort', { fortify: 5 }], ['Full LS', { lifesteal: 5 }], ['Full Brs', { berserker: 5 }],
];
console.log('Build              | W depth | M depth | Gap');
console.log('───────────────────┼─────────┼─────────┼─────');
for (const [label, cfg] of pveBuilds) {
  const w = simPvE('warrior', 100, cfg, 30);
  const m = simPvE('mage', 100, cfg, 30);
  const gap = w - m;
  console.log(`${label.padEnd(18)} | ${String(w).padStart(7)} | ${String(m).padStart(7)} | ${gap > 0 ? 'W+' + gap : gap < 0 ? 'M+' + (-gap) : 'even'}`);
}

// Restore
Object.assign(CLASSES.warrior.growth, ORIG_W);
Object.assign(CLASSES.mage.growth, ORIG_M);
console.log('\n  Original growth rates restored. No files modified.');
console.log('═══════════════════════════════════════════════════════════════════════════');
