'use strict';
// Naked + geared PvP sim with proper timeout handling.
// If turn cap → report as DRAW (not P1 win).
// Run: node test/naked_pvp_v2.js

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

function mkPlayer(id, cls, level, gear) {
  const equipment = gear ? gear.equipment : {};
  const uniqueItems = gear ? gear.uniqueItems : {};
  const stats = E.computeStats(level, cls, equipment, uniqueItems);
  return { id, username: id, charName: id, charLevel: level, charClass: cls,
    stats, skills: CLASSES[cls].skills, equipment, uniqueItems, cosmetics: {} };
}

function simPvP(cls1, cls2, level, fights, gear1, gear2) {
  let p1wins = 0, p2wins = 0, draws = 0, totalTurns = 0;
  const pattern = [0, 1, 0, 1, 2];
  for (let f = 0; f < fights; f++) {
    P.activePvpFights.clear();
    const fightId = `sim_${f}`;
    const fight = P.startFight(fightId, mkPlayer('P1', cls1, level, gear1), mkPlayer('P2', cls2, level, gear2));
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
    if (fight.timeout) draws++;  // turn cap = draw (nobody killed)
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
    kills: fights - draws,
  };
}

// ============================================================
const FIGHTS = 300;
const levels = [10, 20, 50, 100, 200];

const configs = [
  { label: 'CURRENT', w: {}, m: {} },
  { label: 'A: W-ATK 2.2, M-DEF 1.5 (M-HP keep 15)', w: { atk: 2.2 }, m: { def: 1.5 } },
  { label: 'B: W-ATK 2.3, M-DEF 1.5 (M-HP keep 15)', w: { atk: 2.3 }, m: { def: 1.5 } },
  { label: 'C: W-ATK 2.3, M-DEF 1.4 (M-HP keep 15)', w: { atk: 2.3 }, m: { def: 1.4 } },
];

for (const cfg of configs) {
  Object.assign(CLASSES.warrior.growth, ORIG_W, cfg.w);
  Object.assign(CLASSES.mage.growth, ORIG_M, cfg.m);

  const wS = E.computeStats(100, 'warrior', {});
  const mS = E.computeStats(100, 'mage', {});
  console.log('\n' + '═'.repeat(80));
  console.log(`  ${cfg.label}`);
  console.log(`  Warrior Lv100: HP=${wS.hp} ATK=${wS.atk} DEF=${wS.def} MDEF=${wS.mdef} SPD=${wS.spd}`);
  console.log(`  Mage    Lv100: HP=${mS.hp} MATK=${mS.matk} DEF=${mS.def} MDEF=${mS.mdef} SPD=${mS.spd}`);
  console.log('═'.repeat(80));

  // ---- NAKED (no gear) ----
  console.log('\n  📦 NAKED (no gear):');
  console.log('  Match     | Level |  P1 WR |  P2 WR | Draw% | Turns | Result');
  console.log('  ──────────┼───────┼────────┼────────┼───────┼───────┼────────');
  for (const lv of levels) {
    const wm = simPvP('warrior', 'mage', lv, FIGHTS, null, null);
    const mark = wm.drawPct > 50 ? 'STALL' : wm.p1wr >= 35 && wm.p1wr <= 65 ? '✅BAL' : wm.p1wr > 65 ? '⚠️W' : '⚠️M';
    console.log(`  W vs M    | Lv${String(lv).padStart(3)} | ${String(wm.p1wr+'%').padStart(6)} | ${String(wm.p2wr+'%').padStart(6)} | ${String(wm.drawPct+'%').padStart(5)} | ${wm.avgTurns.padStart(5)} | ${mark}`);
  }
  // Mirror at Lv100 only
  const ww = simPvP('warrior', 'warrior', 100, FIGHTS, null, null);
  const mm = simPvP('mage', 'mage', 100, FIGHTS, null, null);
  console.log(`  W vs W    | Lv100 | ${String(ww.p1wr+'%').padStart(6)} | ${String(ww.p2wr+'%').padStart(6)} | ${String(ww.drawPct+'%').padStart(5)} | ${ww.avgTurns.padStart(5)} | ${ww.drawPct > 50 ? 'STALL' : '✅'}`);
  console.log(`  M vs M    | Lv100 | ${String(mm.p1wr+'%').padStart(6)} | ${String(mm.p2wr+'%').padStart(6)} | ${String(mm.drawPct+'%').padStart(5)} | ${mm.avgTurns.padStart(5)} | ${mm.drawPct > 50 ? 'STALL' : '✅'}`);

  // ---- WITH DIVINE GEAR (no combat passives) ----
  console.log('\n  ⚔️ DIVINE GEAR (no combat passives):');
  console.log('  Match     | Level |  P1 WR |  P2 WR | Draw% | Turns | Result');
  console.log('  ──────────┼───────┼────────┼────────┼───────┼───────┼────────');
  for (const lv of levels) {
    const wGear = buildGear('warrior', {});
    const mGear = buildGear('mage', {});
    const wm = simPvP('warrior', 'mage', lv, FIGHTS, wGear, mGear);
    const mark = wm.drawPct > 50 ? 'STALL' : wm.p1wr >= 35 && wm.p1wr <= 65 ? '✅BAL' : wm.p1wr > 65 ? '⚠️W' : '⚠️M';
    console.log(`  W vs M    | Lv${String(lv).padStart(3)} | ${String(wm.p1wr+'%').padStart(6)} | ${String(wm.p2wr+'%').padStart(6)} | ${String(wm.drawPct+'%').padStart(5)} | ${wm.avgTurns.padStart(5)} | ${mark}`);
  }
  const wwG = simPvP('warrior', 'warrior', 100, FIGHTS, buildGear('warrior', {}), buildGear('warrior', {}));
  const mmG = simPvP('mage', 'mage', 100, FIGHTS, buildGear('mage', {}), buildGear('mage', {}));
  console.log(`  W vs W    | Lv100 | ${String(wwG.p1wr+'%').padStart(6)} | ${String(wwG.p2wr+'%').padStart(6)} | ${String(wwG.drawPct+'%').padStart(5)} | ${wwG.avgTurns.padStart(5)} | ${wwG.drawPct > 50 ? 'STALL' : '✅'}`);
  console.log(`  M vs M    | Lv100 | ${String(mmG.p1wr+'%').padStart(6)} | ${String(mmG.p2wr+'%').padStart(6)} | ${String(mmG.drawPct+'%').padStart(5)} | ${mmG.avgTurns.padStart(5)} | ${mmG.drawPct > 50 ? 'STALL' : '✅'}`);

  // ---- WITH PASSIVES (Brs+LS+Fort) ----
  console.log('\n  ✨ DIVINE + PASSIVES (2×Brs+2×LS+1×Fort):');
  console.log('  Match     | Level |  P1 WR |  P2 WR | Draw% | Turns | Result');
  console.log('  ──────────┼───────┼────────┼────────┼───────┼───────┼────────');
  const passCfg = { berserker: 2, lifesteal: 2, fortify: 1 };
  for (const lv of [50, 100, 200]) {
    const wGear = buildGear('warrior', passCfg);
    const mGear = buildGear('mage', passCfg);
    const wm = simPvP('warrior', 'mage', lv, FIGHTS, wGear, mGear);
    const mark = wm.drawPct > 50 ? 'STALL' : wm.p1wr >= 35 && wm.p1wr <= 65 ? '✅BAL' : wm.p1wr > 65 ? '⚠️W' : '⚠️M';
    console.log(`  W vs M    | Lv${String(lv).padStart(3)} | ${String(wm.p1wr+'%').padStart(6)} | ${String(wm.p2wr+'%').padStart(6)} | ${String(wm.drawPct+'%').padStart(5)} | ${wm.avgTurns.padStart(5)} | ${mark}`);
  }
}

Object.assign(CLASSES.warrior.growth, ORIG_W);
Object.assign(CLASSES.mage.growth, ORIG_M);
console.log('\n  Growth rates restored. No files modified.\n');
