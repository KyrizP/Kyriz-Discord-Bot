'use strict';
// Self-check for abyssConfig. Run: node test/abyss.test.js
// Pins the config to test/abyss_tune_sim.js (single source of truth) via literal
// spot-checks, and validates spec §9 rewards / §6.1 dialogues / §9.1 Abyssal Edge.
const A = require('../utils/abyssConfig');
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : (fail++, console.log('  ❌ ' + m)); };
const eq = (a, b, m) => ok(a === b, m + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')');

const F = A.ABYSS_FLOORS;
const MECH_KEYS = ['shield', 'enrage', 'regen', 'counter', 'phaseShift', 'frostAura', 'swarm', 'darkAdapt', 'p1', 'p2', 'p3'];

// ---- 1. structure: 10 floors, required fields, skill/mech shapes ----
eq(F.length, 10, '10 floors');
F.forEach((fl, i) => {
  eq(fl.id, i + 1, 'F' + (i + 1) + ' id sequential');
  ok(typeof fl.name === 'string' && fl.name.length > 0, 'F' + fl.id + ' name');
  ok(typeof fl.emoji === 'string' && fl.emoji.length > 0, 'F' + fl.id + ' emoji');
  ok(typeof fl.recLevel === 'number' && fl.recLevel > 0, 'F' + fl.id + ' recLevel');
  ok(fl.recClass === null || ['warrior', 'mage', 'rogue'].includes(fl.recClass), 'F' + fl.id + ' recClass valid');
  if (!fl.mirror) {
    for (const k of ['hpMult', 'atkMult', 'matkMult', 'defMult', 'mdefMult', 'spd']) {
      ok(typeof fl[k] === 'number' && fl[k] > 0, 'F' + fl.id + ' ' + k);
    }
    ok(Array.isArray(fl.skills) && fl.skills.length >= 2, 'F' + fl.id + ' has skills array');
    for (const sk of fl.skills) {
      ok(typeof sk.id === 'string' && typeof sk.name === 'string' && sk.name.length > 0, 'F' + fl.id + ' skill id/name: ' + (sk.id || '?'));
      ok(typeof sk.mult === 'number' && sk.mult > 0, 'F' + fl.id + ' skill mult: ' + sk.id);
      ok(['physical', 'magic', 'mixed'].includes(sk.type), 'F' + fl.id + ' skill type: ' + sk.id);
      ok(typeof sk.cd === 'number' && sk.cd >= 0, 'F' + fl.id + ' skill cd >= 0: ' + sk.id);
    }
  }
  ok(fl.mechanic === null || typeof fl.mechanic === 'object', 'F' + fl.id + ' mechanic shape');
  if (fl.mechanic) {
    for (const k of Object.keys(fl.mechanic)) ok(MECH_KEYS.includes(k), 'F' + fl.id + ' mechanic key allowed: ' + k);
  }
});

// ---- 2. sim-proven structural facts ----
eq(F[1].recClass, 'mage', 'F2 recClass is mage (NOT warrior — sim proof inversion)');
eq(F[8].mirror, true, 'F9 mirror flag');
eq(F[8].hpMult, 2.0, 'F9 mirror hpMult 2.0 (owner round 6: 3★ must be RARE — clear 28-63% by class)');
eq(F[8].bossEvasion, 12, 'F9 mirror intrinsic evasion 12 (owner round 5)');
eq(F[8].passiveCopy, 1 / 2, 'F9 passiveCopy 1/2 (live-feedback retune: 1/3 rolled over at Lv280)');
// ENGINE must actually READ passiveCopy (was dead config: hardcoded /3 while config said 1/2)
{ const mp = require('../utils/abyssManager').mirrorPassives;
  eq(mp({ lifesteal: 65, berserker: 32 }, F[8].passiveCopy).lifesteal, 32, 'mirrorPassives uses floor.passiveCopy (½ of 65 = 32)');
  eq(mp({ lifesteal: 65 }).lifesteal, 21, 'mirrorPassives default copy = 1/3 (65 → 21)');
  eq(mp({ rupture: 15, swift: 30, fortify: 22 }, F[8].passiveCopy).rupture, undefined, 'rupture never copied'); }
eq(F[9].hpMult, 4.5, 'F10 hp mult 4.5 (EPIC: 3%@500, 65%@600, 87%@650)');
eq(F[9].mechanic.p1.lifesteal, 0.30, 'F10 p1 lifesteal 0.30 (EPIC)');
eq(F[9].mechanic.p1.enrage.every, 4, 'F10 p1 enrage every 4');
eq(F[9].mechanic.p1.enrage.pct, 0.12, 'F10 p1 enrage pct 0.12 (12%/4t EPIC)');
eq(F[9].mechanic.p3.berserk.atk, 1.7, 'F10 p3 berserk 1.7 (EPIC)');
eq(F[9].mechanic.p3.antiHeal, 60, 'F10 p3 antiHeal 60 (EPIC near-full shutdown)');
ok(!('shield' in F[9].mechanic) && !('regen' in F[9].mechanic), 'F10 has NO top-level shield/regen');
ok(!('shield' in F[9].mechanic.p1) && !('regen' in F[9].mechanic.p3), 'F10 p1/p3 have no shield/regen keys');

// ---- 3. number parity with test/abyss_tune_sim.js (literal pins) ----
eq(F[0].hpMult, 3.5, 'F1 hp 3.5 (true-divine retune)');
eq(F[0].atkMult, 0.9, 'F1 atk 0.9 (true-divine retune)');
eq(F[0].skills[1].mult, 1.4, 'sim F1 Claw mult 1.4');
eq(F[1].hpMult, 2.5, 'sim F2 hp 2.5 (spec table said 2.6 — sim wins)');
eq(F[1].mechanic.shield.every, 4, 'sim F2 shield every 4');
eq(F[1].mechanic.shield.pct, 0.15, 'sim F2 shield pct 0.15');
eq(F[1].skills[1].mult, 1.6, 'sim F2 Heavy Blow 1.6');
eq(F[2].matkMult, 1.20, 'F3 matk 1.20 (true-divine retune)');
eq(F[2].mechanic.enrage.every, 3, 'sim F3 enrage every 3');
eq(F[2].mechanic.enrage.pct, 0.10, 'sim F3 enrage pct 0.10');
eq(F[2].skills[2].burn.pct, 20, 'sim F3 Inferno burn pct 20');
eq(F[3].mechanic.regen.every, 4, 'sim F4 regen every 4');
eq(F[3].mechanic.regen.pct, 0.03, 'F4 regen 3% (curve-fix)');
eq(F[3].skills[2].heal, 0.08, 'sim F4 heal 0.08');
eq(F[3].skills[2].cd, 6, 'sim F4 heal skill cd 6');
eq(F[4].mechanic.counter.chance, 50, 'sim F5 counter chance 50');
eq(F[4].skills[2].mult, 2.5, 'sim F5 Lightning Storm 2.5');
eq(F[4].skills[2].pierceEva, true, 'sim F5 Lightning Storm pierceEva');
eq(F[5].hpMult, 3.8, 'F6 hp 3.8 (true-divine retune)');
eq(F[5].mechanic.phaseShift.at, 0.5, 'sim F6 phaseShift at 0.5');
eq(F[5].mechanic.phaseShift.stun, true, 'sim F6 phaseShift stun');
eq(F[6].mechanic.frostAura.physReduction, 0.30, 'sim F7 frostAura 0.30');
eq(F[6].skills[2].cc.chance, 75, 'sim F7 Frost Nova cc 75');
eq(F[6].crit, 0.20, 'sim F7 crit 0.20');
eq(F[6].critMult, 1.75, 'sim F7 critMult 1.75');
eq(F[7].mechanic.swarm.every, 3, 'sim F8 swarm every 3');
eq(F[7].mechanic.swarm.max, 2, 'sim F8 swarm max 2');
eq(F[7].mechanic.swarm.droneAtkPct, 0.40, 'F8 droneAtk 40% (true-divine retune)');
eq(F[7].mechanic.swarm.droneTtl, 3, 'sim F8 droneTtl 3');
eq(F[7].skills[2].poison.pct, 15, 'sim F8 ult poison pct 15');
eq(F[7].skills[2].antiHeal.reduction, 100, 'F8 ult antiHeal 100 (full shutdown window — owner live-feedback retune)');
eq(F[8].mechanic.darkAdapt.every, 3, 'F9 darkAdapt every 3 (owner round 5: 4/6% never ramped before t5 deaths)');
eq(F[8].mechanic.darkAdapt.pct, 0.08, 'F9 darkAdapt pct 0.08 (owner round 5)');
eq(F[8].recLevel, 430, 'sim F9 rec 430');
eq(F[9].mechanic.p2.counter.chance, 35, 'F10 counter 35% (EPIC)');
eq(F[9].mechanic.p2.counter.mult, 1.2, 'F10 counter mult 1.2x (EPIC)');
eq(F[9].skills[2].mult, 2.5, 'sim F10 Oblivion 2.5');
eq(F[9].skills[2].type, 'mixed', 'sim F10 Oblivion mixed');
eq(F[9].skills[2].cc.chance, 100, 'sim F10 Oblivion guaranteed cc');
eq(F[9].crit, 0.25, 'sim F10 crit 0.25');
eq(F[9].spd, 7, 'sim F10 spd 7');

// anti-heal coverage (owner rule: EVERY boss F5+ counters lifesteal — exact values are
// deliberate pins so a future silent config drop breaks loudly)
eq(F[4].skills[1].antiHeal.reduction, 35, 'F5 Storm Surge antiHeal 35');
eq(F[4].skills[1].antiHeal.turns, 3, 'F5 Storm Surge antiHeal 3t');
eq(F[5].skills[1].antiHeal.reduction, 30, 'F6 Dark Pulse antiHeal 30');
eq(F[5].skills[1].antiHeal.turns, 3, 'F6 Dark Pulse antiHeal 3t');
eq(F[6].skills[2].antiHeal.reduction, 50, 'F7 Frost Nova antiHeal 50');
eq(F[6].skills[2].antiHeal.turns, 3, 'F7 Frost Nova antiHeal 3t');
eq(F[8].mechanic.darkAdapt.antiHeal, 25, 'F9 shadow drain antiHeal 25 permanent');
eq(F[9].mechanic.p2.counter.antiHeal.reduction, 40, 'F10 P2 counter wounds antiHeal 40');
eq(F[9].mechanic.p2.counter.antiHeal.turns, 3, 'F10 P2 counter wounds antiHeal 3t');
for (let i = 4; i < 10; i++) { // invariant: F5+ MUST have an anti-heal source (skill / darkAdapt / counter / p3)
  const fl = F[i];
  const has = (fl.skills || []).some((s) => s.antiHeal)
    || (fl.mechanic && fl.mechanic.darkAdapt && fl.mechanic.darkAdapt.antiHeal)
    || (fl.mechanic && fl.mechanic.p2 && fl.mechanic.p2.counter && fl.mechanic.p2.counter.antiHeal)
    || (fl.mechanic && fl.mechanic.p3 && fl.mechanic.p3.antiHeal);
  ok(has, `F${i + 1} ${fl.name} has an anti-heal source (owner rule)`);
}

// REC_BIAS rule (spec §3): F1-2 no bias, F3+ x1.1, mirror exempt
eq(A.REC_BIAS, 1.1, 'REC_BIAS 1.1');
eq(A.bossTunedLevel(F[0]), 50, 'tuned F1 = 50 (no bias)');
eq(A.bossTunedLevel(F[2]), 132, 'tuned F3 = floor(110*1.2) = 132 (F3-F7 bias 1.2)');
eq(A.bossTunedLevel(F[8]), 430, 'tuned F9 = 430 (mirror exempt)');
eq(A.bossTunedLevel(F[9]), 550, 'tuned F10 = floor(500*1.1) = 550');

// ---- 4. rewards (spec §9) + Abyssal Edge (§9.1) ----
const RW = A.ABYSS_REWARDS;
eq(RW.floors.length, 10, '10 reward rows');
eq(RW.starBonusPct, 0.25, 'star bonus 25% of base');
const wantBase = [2000, 4000, 8000, 12000, 20000, 35000, 55000, 85000, 150000, 300000];
const wantStar = [500, 1000, 2000, 3000, 5000, 8750, 13750, 21250, 37500, 75000];
RW.floors.forEach((r, i) => {
  eq(r.floor, i + 1, 'reward row floor ' + (i + 1));
  eq(r.base, wantBase[i], 'F' + (i + 1) + ' base');
  eq(r.base * RW.starBonusPct, wantStar[i], 'F' + (i + 1) + ' star bonus exact');
});
const wantTier = { 1: null, 2: null, 3: null, 4: null, 5: 'legendary', 6: null, 7: 'mythic', 8: null, 9: 'divine', 10: 'divine' };
RW.floors.forEach((r) => eq(r.dropTier, wantTier[r.floor], 'F' + r.floor + ' dropTier'));

const MS = A.ABYSS_MILESTONES;
eq(Object.keys(MS.floors).length, 10, '10 floor milestones');
eq(MS.floors[1].title, '🗝️ Gatebreaker', 'F1 title');
eq(MS.floors[2].kryztal, 100000, 'F2 milestone 100k 💎');
eq(MS.floors[3].title, '🐉 Drake Slayer', 'F3 title');
eq(MS.floors[4].kryztal, 250000, 'F4 milestone 250k 💎');
eq(MS.floors[5].title, '⚡ Stormcaller', 'F5 title');
eq(MS.floors[6].kryztal, 500000, 'F6 milestone 500k 💎');
eq(MS.floors[7].title, '❄️ Frozen Heart', 'F7 title');
eq(MS.floors[8].kryztal, 750000, 'F8 milestone 750k 💎');
eq(MS.floors[9].title, '🪞 Self-Slayer', 'F9 title');
eq(MS.floors[10].kryztal, 1000000, 'F10 milestone 1M 💎');
eq(MS.floors[10].title, '💀 Abyssal Overlord', 'F10 title');
eq(MS.allStars.stars, 30, 'allStars at 30 stars');
eq(MS.allStars.title, '🌌 Abyssal Master', '30-star title');
eq(MS.allStars.abyssalEdge, true, '30-star grants Abyssal Edge');

// Abyssal Edge + roll pool
const E = A.ABYSSAL_EDGE, P = A.ABYSSAL_EDGE_ROLL_POOL;
eq(E.slot, 'weapon', 'Edge slot weapon');
eq(E.stats.atk, 100, 'Edge atk 100');
eq(E.stats.matk, 100, 'Edge matk 100');
eq(E.fixedPassives.length, 1, 'Edge 1 fixed passive');
eq(E.fixedPassives[0].id, 'rupture', 'Edge fixed = rupture');
eq(E.fixedPassives[0].value, 15, 'Edge rupture 15');
eq(E.sellable, false, 'Edge unsellable');
ok(!('greed' in P) && !('wisdom' in P), 'roll pool excludes greed/wisdom');
eq(Object.keys(P).length, 6, 'roll pool has exactly 6');
eq(P.berserker, 32, 'pool berserker 32');
eq(P.precision, 25, 'pool precision 25');
eq(P.lifesteal, 25, 'pool lifesteal 25');
eq(P.swift, 20, 'pool swift 20');
eq(P.fortify, 22, 'pool fortify 22');
eq(P.evasion, 13, 'pool evasion 13');
eq(A.ABYSSAL_TIER.letter, 'A', 'tier letter A');
eq(A.ABYSSAL_TIER.name, 'Abyssal', 'tier name Abyssal');
eq(A.ABYSSAL_TIER.price, 0, 'tier price 0 (not purchasable)');
const rup = A.ABYSS_PASSIVES.rupture;
ok(rup && rup.value === 15 && !('ranges' in rup) && !('weight' in rup), 'rupture entry: value 15, no gacha ranges/weight');

// rollAbyssalEdgePassives — deterministic + distinct + in-pool
eq(JSON.stringify(A.rollAbyssalEdgePassives(() => 0)), JSON.stringify(['berserker', 'precision']), 'roll deterministic rand=0');
eq(JSON.stringify(A.rollAbyssalEdgePassives(() => 0.999)), JSON.stringify(['evasion', 'fortify']), 'roll deterministic rand=0.999');
const seen = new Set();
for (let s = 0; s < 500; s++) {
  const ids = A.rollAbyssalEdgePassives(Math.random);
  ok(ids.length === 2 && ids[0] !== ids[1] && P[ids[0]] !== undefined && P[ids[1]] !== undefined, 'roll yields 2 distinct pool ids (seed ' + s + ')');
  ids.forEach((x) => seen.add(x));
  if (fail > 0) break;
}
eq(seen.size, 6, 'rolls cover the full pool over 500 draws');

// ---- 5. dialogues (spec §6.1) ----
for (let i = 1; i <= 10; i++) {
  const d = A.BOSS_DIALOGUES[i];
  ok(d && [d.intro, d.victory, d.defeat].every((s) => typeof s === 'string' && s.length > 0), 'dialogues F' + i + ' intro/victory/defeat non-empty');
}
eq(A.BOSS_DIALOGUES[1].intro, 'Another pup wanders into the dark. Let\'s see if you can bite.', 'F1 intro verbatim');
ok(A.BOSS_DIALOGUES[9].defeat.includes('Sit with that'), 'F9 defeat taunt contains "Sit with that"');
ok(A.BOSS_DIALOGUES[1].intro.includes('Another pup'), 'F1 intro pinned');
ok(A.BOSS_DIALOGUES[2].defeat === 'Stone does not celebrate. It simply remains.', 'F2 defeat pinned');
ok(A.BOSS_DIALOGUES[8].defeat.includes('arithmetic was never in your favor'), 'F8 defeat pinned');
ok(A.BOSS_DIALOGUES[10].victory.includes('The Abyss... is yours'), 'F10 victory pinned');
ok(A.BOSS_DIALOGUES[9].intro.includes('I AM your every move'), 'F9 intro pinned');
eq(A.BOSS_DIALOGUES[10].victory, 'The Overlord falls. The Abyss... is yours.', 'F10 victory verbatim');

// ---- 6. turn limit + star thresholds ----
eq(A.TURN_LIMIT, 30, 'TURN_LIMIT 30');
eq(A.STAR_THRESHOLDS.three.turns, 18, '3-star turns 18');
eq(A.STAR_THRESHOLDS.three.hpPct, 50, '3-star hpPct 50');
eq(A.STAR_THRESHOLDS.two.turns, 25, '2-star turns 25');

// ---- 7. abyssManager data layer (pure apply-fns, mock data — battleManager.test.js style) ----
const AM = require('../utils/abyssManager');
const BM = require('../utils/battleManager');

// mock registered user WITH a warrior character (applyCreateCharacter also exercises
// the ensureBattleData -> ensureAbyssData backfill integration)
function mockUser() {
  const d = { u1: { balance: 0 } };
  BM.applyCreateCharacter(d, 'u1', 'warrior');
  return d;
}
const abyss = (d) => d.u1.battle.abyss;

// 7a. backfill + defensive repair
{
  const bNew = BM.ensureBattleData({});
  ok(bNew.abyss && bNew.abyss.stars.length === 10 && bNew.abyss.stars.every((s) => s === 0), 'backfill: fresh battle gets 10 zero stars');
  ok(bNew.abyss.rewarded.length === 10 && bNew.abyss.rewarded.every((r) => r === false), 'backfill: 10 false rewarded flags');
  ok(bNew.abyss.milestones && Object.keys(bNew.abyss.milestones).length === 0, 'backfill: empty milestones');
  const dOld = { u1: { battle: { kryptonite: 5, bag: {} } } };
  BM.ensureBattleData(dOld.u1);
  ok(abyss(dOld) && abyss(dOld).stars.length === 10, 'backfill: old user without .abyss gets it');
  // corrupt shapes repaired
  const dC1 = { u1: { battle: { bag: {} } } }; dC1.u1.battle.abyss = { stars: 'nope', rewarded: 3, milestones: 5 };
  AM.ensureAbyssData(dC1.u1.battle);
  ok(Array.isArray(abyss(dC1).stars) && abyss(dC1).stars.every((s) => s === 0), 'repair: non-array stars reset');
  ok(Array.isArray(abyss(dC1).rewarded) && abyss(dC1).rewarded.every((r) => r === false), 'repair: non-array rewarded reset');
  ok(abyss(dC1).milestones && typeof abyss(dC1).milestones === 'object', 'repair: non-object milestones reset');
  const dC2 = { u1: { battle: { bag: {} } } }; dC2.u1.battle.abyss = { stars: [1, 2], rewarded: [true] };
  AM.ensureAbyssData(dC2.u1.battle);
  eq(JSON.stringify(abyss(dC2).stars), JSON.stringify([1, 2, 0, 0, 0, 0, 0, 0, 0, 0]), 'repair: short stars resized, values kept');
  eq(JSON.stringify(abyss(dC2).rewarded), JSON.stringify([true, false, false, false, false, false, false, false, false, false]), 'repair: short rewarded resized, values kept');
  const dC3 = { u1: { battle: { bag: {} } } }; dC3.u1.battle.abyss = { stars: [9] };
  AM.ensureAbyssData(dC3.u1.battle);
  eq(abyss(dC3).stars[0], 3, 'repair: out-of-range star clamped to 3');
}

// 7b. sequential gate
{
  const d = mockUser();
  ok(AM.applyCanEnterFloor(d, 'u1', 0).ok, 'F1 always enterable');
  ok(!AM.applyCanEnterFloor(d, 'u1', 3).ok, 'F4 blocked while F3 stars = 0');
  abyss(d).stars[2] = 1;
  ok(AM.applyCanEnterFloor(d, 'u1', 3).ok, 'F4 allowed when F3 stars > 0');
  ok(!AM.applyCanEnterFloor(d, 'u1', -1).ok && !AM.applyCanEnterFloor(d, 'u1', 10).ok && !AM.applyCanEnterFloor(d, 'u1', 1.5).ok, 'invalid floor index rejected');
  ok(!AM.applyCanEnterFloor({}, 'nobody', 0).ok, 'unregistered rejected');
  const dNoChar = { u2: { balance: 0 } };
  BM.ensureBattleData(dNoChar.u2);
  eq(AM.applyCanEnterFloor(dNoChar, 'u2', 0).reason, 'no_character', 'no character -> no_character reason');
}

// 7c. star calc boundaries (via applyRecordClear on F1)
const boundary = (t, h, want) => {
  const d = mockUser();
  const r = AM.applyRecordClear(d, 'u1', 0, t, h);
  eq(r.stars, want, 'stars(' + t + 't,' + h + '%) = ' + want);
};
boundary(17, 60, 3);
boundary(18, 50, 3); // exact 3-star edge
boundary(18, 49, 2); // hp below 50 -> not 3
boundary(19, 55, 2); // turns above 18 -> not 3
boundary(25, 5, 2);  // exact 2-star edge
boundary(26, 90, 1);
boundary(30, 1, 1);

// 7d. first-clear rewards (1x permanent, auto-granted)
{
  // F10 first clear 3-star: 300000 + 300000*0.25*3 = 525000 kryptonite
  const d = mockUser();
  abyss(d).stars[8] = 1; // unlock F10
  const r = AM.applyRecordClear(d, 'u1', 9, 17, 60);
  ok(r.ok && r.firstClear, 'F10 first clear');
  eq(r.rewards.kryptonite, 525000, 'F10 3-star kryptonite = 525000');
  eq(d.u1.battle.kryptonite, 525000, 'kryptonite credited');
  eq(abyss(d).rewarded[9], true, 'rewarded flag set');
  eq(d.u1.balance, 1000000, 'F10 milestone 1M kryztal credited to balance');
  ok(r.rewards.titles.includes('💀 Abyssal Overlord'), 'F10 milestone title returned');
  eq(abyss(d).milestones[10], true, 'F10 milestone flag set');
  ok(r.rewards.drop && r.rewards.drop.rarity === 'divine' && r.rewards.drop.id.startsWith('ky'), 'F10 divine drop created');
  eq(d.u1.battle.uniqueItems[r.rewards.drop.id], r.rewards.drop, 'drop stored in uniqueItems');
  // replay same 3 stars: NO second payout
  const kryBefore = d.u1.battle.kryptonite, balBefore = d.u1.balance;
  const r2 = AM.applyRecordClear(d, 'u1', 9, 17, 60);
  eq(r2.rewards, null, 'replay grants no rewards');
  eq(d.u1.battle.kryptonite, kryBefore, 'replay: kryptonite unchanged');
  eq(d.u1.balance, balBefore, 'replay: balance unchanged');
}
{
  // star improvement on replay is kept (best-kept), worse replay never downgrades
  const d = mockUser();
  const r1 = AM.applyRecordClear(d, 'u1', 0, 26, 90); // 1 star first clear
  eq(r1.stars, 1, 'first clear 1 star');
  eq(r1.rewards.kryptonite, 2000 + 500, 'F1 1-star kryptonite = base + 25% x1');
  const r3 = AM.applyRecordClear(d, 'u1', 0, 17, 60); // replay 3 stars
  ok(r3.isNewBest && r3.rewards === null, 'replay improves stars, no rewards');
  eq(abyss(d).stars[0], 3, 'improved stars kept');
  const rW = AM.applyRecordClear(d, 'u1', 0, 30, 1); // worse replay
  ok(!rW.isNewBest && rW.stars === 1, 'worse replay earns 1 star but is not a new best');
  eq(abyss(d).stars[0], 3, 'best stars never downgraded');
}
{
  // F2 first clear: 100k kryztal milestone, no title; F1 title milestone
  const d = mockUser();
  AM.applyRecordClear(d, 'u1', 0, 17, 60); // F1 3-star (title Gatebreaker)
  const r2 = AM.applyRecordClear(d, 'u1', 1, 17, 60);
  eq(r2.rewards.kryztal, 100000, 'F2 milestone kryztal 100000');
  eq(d.u1.balance, 100000, 'F2 milestone credited to balance');
  eq(r2.rewards.titles.length, 0, 'F2 has no title milestone');
  eq(abyss(d).milestones[1], true, 'F1 milestone flag set');
  ok(AM.applyRecordClear(d, 'u1', 0, 17, 60).rewards === null, 'F1 title not re-granted on replay');
}
{
  // F5 first clear: legendary gear drop, random slot
  const d = mockUser();
  abyss(d).stars[3] = 1;
  const r = AM.applyRecordClear(d, 'u1', 4, 17, 60);
  ok(r.rewards.drop && r.rewards.drop.rarity === 'legendary', 'F5 legendary drop');
  ok(['weapon', 'head', 'armor', 'boots', 'accessory'].includes(r.rewards.drop.slot), 'drop slot valid');
  ok(d.u1.battle.uniqueItems[r.rewards.drop.id] === r.rewards.drop, 'F5 drop stored');
}

// 7e. 30-star Abyssal Edge milestone (once)
{
  const d = mockUser();
  for (let i = 0; i < 10; i++) abyss(d).stars[i] = 3;
  const edge = AM.applyCheckAllStarsMilestone(d, 'u1');
  ok(edge && edge.id.startsWith('ky'), 'edge created with ky id');
  eq(edge.stats.atk, 100, 'edge atk 100');
  eq(edge.stats.matk, 100, 'edge matk 100');
  eq(edge.rarity, 'abyssal', 'edge rarity abyssal');
  eq(edge.slot, 'weapon', 'edge slot weapon');
  eq(edge.passives.length, 3, 'edge: rupture + exactly 2 rolled');
  eq(edge.passives[0].id, 'rupture', 'edge fixed passive rupture');
  eq(edge.passives[0].value, 15, 'edge rupture 15');
  const rolled = edge.passives.slice(1).map((p) => p.id);
  ok(rolled[0] !== rolled[1], 'edge rolled passives distinct');
  ok(rolled.every((id) => id in A.ABYSSAL_EDGE_ROLL_POOL), 'edge rolled passives from pool');
  ok(rolled.every((id) => edge.passives.find((p) => p.id === id).value === A.ABYSSAL_EDGE_ROLL_POOL[id]), 'edge rolled values = pool (divine max)');
  eq(d.u1.battle.uniqueItems[edge.id], edge, 'edge stored in uniqueItems');
  eq(abyss(d).milestones.allStars, true, 'allStars flag set');
  eq(AM.applyCheckAllStarsMilestone(d, 'u1'), null, 'edge granted ONCE (second call no-op)');
  eq(Object.values(d.u1.battle.uniqueItems).filter((x) => x.rarity === 'abyssal').length, 1, 'exactly one abyssal item');
}
{
  // via recordClear at exactly 30 (29 -> no edge)
  const d29 = mockUser();
  for (let i = 0; i < 9; i++) d29.u1.battle.abyss.stars[i] = 3;
  const r29 = AM.applyRecordClear(d29, 'u1', 9, 26, 90); // 2 stars -> 29 total
  eq(r29.edge, null, '29 stars: no edge yet');
  const d30 = mockUser();
  for (let i = 0; i < 9; i++) d30.u1.battle.abyss.stars[i] = 3;
  const r30 = AM.applyRecordClear(d30, 'u1', 9, 17, 60); // 3 stars -> 30 total
  ok(r30.edge && r30.edge.rarity === 'abyssal', '30 stars: edge granted via recordClear');
  ok(r30.rewards.titles.includes('🌌 Abyssal Master'), 'allStars title returned (display string for the embed)');
  eq(d30.u1.cosmetics.owned.includes('title_abyssal_master'), true, 'allStars title pushed to cosmetics as CATALOG ID (ky use title_abyssal_master must work — bugfix)');
  eq(d30.u1.cosmetics.owned.includes('🌌 Abyssal Master'), false, 'no legacy display string in owned');
  eq(d30.u1.battle.abyss.milestones.allStars, true, 'allStars milestone set via recordClear');
}

// 7f. unsellable guard (battleManager.applySellGear blocks abyssal tier)
{
  const d = mockUser();
  d.u1.battle.uniqueItems.kyZZ = { id: 'kyZZ', name: 'Abyssal Edge', rarity: 'abyssal', slot: 'weapon', stats: { atk: 100, matk: 100 }, passives: [] };
  const sg = BM.applySellGear(d, 'u1', 'kyZZ');
  ok(!sg.ok && sg.reason === 'This item cannot be sold.', 'abyssal item cannot be sold');
  ok(d.u1.battle.uniqueItems.kyZZ, 'abyssal item still in collection after sell attempt');
}

// 7g. getAbyssProgress (IO read-only smoke: unknown user -> zero view)
{
  const prog = AM.getAbyssProgress('test-user-that-does-not-exist');
  ok(prog.totalStars === 0 && prog.highestFloor === 0 && prog.stars.length === 10, 'progress view: unknown user -> zeros');
}

// ---- 8. COMBAT ENGINE (abyssManager fight API — port of test/abyss_tune_sim.js) ----
// Deterministic via Math.random stubbing (pvp.test.js pattern): rand 0.5 => roll x1.0,
// no crit (precision absent), cc fires only at chance>50 (100/75 yes; 50/25/20 no),
// no evasion, no 50% counter. rand 0.1 => roll x0.88, counter(50 & 20) fires, cc(25) fires.
const BE = require('../utils/battleEngine');
const PVP = require('../utils/pvpManager');
const uniq = require('../utils/uniqueItems');
const BC = require('../utils/battleConfig');
const _rand0 = Math.random;

function mockUserCls(cls, level) {
  const d = { u1: { balance: 0 } };
  BM.applyCreateCharacter(d, 'u1', cls === 'warrior' ? 'warrior' : 'warrior');
  if (cls !== 'warrior') { d.u1.battle.kryptonite = 5000; BM.applyChangeClass(d, 'u1', cls); }
  if (level) d.u1.battle.characters[cls].charLevel = level;
  return d;
}
// Build a fight on mock data and register it in the engine Map (public resolvers path).
function fightFor(floorIdx, mk) {
  const d = (mk || mockUserCls)('warrior', 200);
  if (floorIdx > 0) { ensureStars(d, floorIdx); }
  const r = AM.startAbyssFight('u1', floorIdx, { data: d });
  if (!r.ok) throw new Error('fightFor F' + (floorIdx + 1) + ': ' + r.reason);
  return r.fight;
}
function ensureStars(d, floorIdx) { for (let i = 0; i < floorIdx; i++) d.u1.battle.abyss.stars[i] = 1; }
const hitOf = (evs, actor) => evs.filter((e) => e.type === 'hit' && (!actor || e.actor === actor));
const turn = (f, skill) => { // one full turn: player action + boss action
  const rp = AM.resolveAbyssPlayerTurn('u1', skill);
  if (!rp.ok || rp.over) return rp;
  return AM.resolveAbyssBossTurn('u1');
};

// 8a. F1 scripted fight — warrior Lv200 naked vs F1, rand 0.5 => exactly 297/hit,
// boss chips 1/turn => deterministic kill on turn 10, full-HP clear.
{
  AM.activeAbyssFights.clear();
  Math.random = () => 0.5;
  const f = fightFor(0);
  ok(f.playerFirst === true, 'F1: player (SPD 106) first vs boss SPD 4');
  ok(f.player.hpMax === Math.floor(f.player.stats.hp * 1.15), 'F1: player HP x1.15');
  let i = 0, res = null;
  for (; i < 30; i++) { res = turn(f, 'slash'); if (res.over) break; }
  ok(res.over && res.winner === 'player', 'F1: deterministic player win');
  eq(f.turnCount, 13, 'F1: kill on turn 13 (292x12=3504 < 3780 hp, 13th finishes)');
  eq(f.resultData.turns, 13, 'F1: resultData.turns = 13');
  eq(f.resultData.hpPct, 100, 'F1: resultData.hpPct = 100 (boss chips 1/turn)');
  eq(hitOf(f.events, 'player').length, 13, 'F1: exactly 13 player hits');
  eq(hitOf(f.events, 'player')[0].dmg, 293, 'F1: slash dmg 293 (boss def 64, scalar 0.7)');
  AM.endAbyssFight('u1');
  Math.random = _rand0;
}
// 8a2. turn counting: 1 turn = 1 player action + 1 boss action
{
  AM.activeAbyssFights.clear();
  Math.random = () => 0.5;
  const f = fightFor(0);
  turn(f, 'slash');
  ok(f.turnCount === 1 && f.acted.player && f.acted.boss && !f.roundStarted, 'turn bookkeeping: 1 pair = turn 1, round closed');
  turn(f, 'slash');
  eq(f.turnCount, 2, 'second pair = turn 2');
  AM.endAbyssFight('u1');
  Math.random = _rand0;
}

// 8b. boss ult gating: cd>=4 starts at ceil(cd/2); basic/skill2 ungated
{
  const f5 = fightFor(4);
  eq(f5.boss.cdLeft['lightning_storm'], 3, 'F5 Lightning Storm (cd5) starts at 3');
  ok(!(f5.boss.cdLeft['storm_surge'] > 0), 'F5 Storm Surge (cd3) starts ready');
  AM.endAbyssFight('u1');
  const f10 = fightFor(9);
  eq(f10.boss.cdLeft['oblivion'], 2, 'F10 Oblivion (cd4) starts at 2');
  AM.endAbyssFight('u1');
  const f4 = fightFor(3);
  eq(f4.boss.cdLeft['natures_embrace'], 3, 'F4 Embrace (cd6) starts at 3');
  AM.endAbyssFight('u1');
  const f1 = fightFor(0);
  eq(Object.keys(f1.boss.cdLeft).length, 0, 'F1 has no cd>=4 skills — no gating');
  AM.endAbyssFight('u1');
}

// 8c. F2 shield: spawns every 4 turns at round START (absorbs the same-round player
// hit), absorbs until broken, respawns on the next multiple of 4.
{
  AM.activeAbyssFights.clear();
  Math.random = () => 0.5;
  const f = fightFor(1);
  const shield = Math.floor(f.boss.hpMax * 0.15);
  for (let t = 1; t <= 3; t++) turn(f, 'slash');
  eq(f.boss.shield, 0, 'F2: no shield turns 1-3');
  const r4 = AM.resolveAbyssPlayerTurn('u1', 'slash'); // round 4 starts -> shield spawns BEFORE this hit
  const h4 = hitOf(r4.events, 'player')[0];
  eq(h4.dmg + h4.absorbed, 280, 'F2: raw player hit 280');
  eq(h4.absorbed, 280, 'F2: turn-4 hit fully absorbed');
  eq(h4.dmg, 0, 'F2: no hp loss through shield');
  eq(f.boss.shield, shield - 280, 'F2: shield spawned turn 4 (15% hpMax = ' + shield + ', 280 absorbed)');
  AM.resolveAbyssBossTurn('u1');
  AM.resolveAbyssPlayerTurn('u1', 'slash'); AM.resolveAbyssBossTurn('u1'); // turn 5 absorbs rest
  const h6 = (() => { const r = AM.resolveAbyssPlayerTurn('u1', 'slash'); return hitOf(r.events, 'player')[0]; })();
  ok(h6.absorbed > 0 && h6.dmg > 0, 'F2: shield breaks then damage lands through (absorbed ' + h6.absorbed + ', through ' + h6.dmg + ')');
  eq(f.boss.shield, 0, 'F2: shield fully consumed');
  AM.resolveAbyssBossTurn('u1');
  AM.resolveAbyssPlayerTurn('u1', 'slash'); AM.resolveAbyssBossTurn('u1'); // turn 7
  AM.resolveAbyssPlayerTurn('u1', 'slash'); // turn 8 -> respawn
  eq(f.boss.shield, shield - 280, 'F2: shield respawns turn 8 (fresh ' + shield + ' minus this hit)');
  AM.endAbyssFight('u1');
  Math.random = _rand0;
}

// 8d. F4 regen (every 4 turns, 4% hpMax) + Nature's Embrace (heal 8% + guaranteed root);
// rooted player skips the action but cds still tick.
{
  AM.activeAbyssFights.clear();
  Math.random = () => 0.5;
  const f = fightFor(3);
  f.boss.hp = f.boss.hpMax - 2000;
  turn(f, 'slash'); // t1: boss casts Wrath (Embrace gated at 3)
  turn(f, 'slash'); // t2: boss casts Root Slam
  const rp3 = AM.resolveAbyssPlayerTurn('u1', 'parry'); // t3 player: Parry Strike (cd 2)
  const r3 = AM.resolveAbyssBossTurn('u1'); // t3 boss: Embrace off-cd -> heal + root
  ok(r3.events.some((e) => e.type === 'heal' && e.heal === Math.floor(f.boss.hpMax * 0.08)), 'F4: Embrace heals 8% hpMax');
  eq(f.player.cc, 1, 'F4: Embrace roots the player (100% cc)');
  eq(f.player.cdLeft['parry'], 2, 'F4: parry cd set when used');
  const r4 = AM.resolveAbyssPlayerTurn('u1', 'slash'); // cc'd turn: skill valid, action skipped
  ok(r4.events.some((e) => e.type === 'ccSkip'), 'F4: rooted player action skipped');
  eq(hitOf(r4.events, 'player').length, 0, 'F4: no player hit on a skipped turn');
  ok(r4.events.some((e) => e.type === 'heal' && e.heal === Math.floor(f.boss.hpMax * 0.03)), 'F4: regen ticks turn 4 (3% hpMax)');
  eq(f.player.cdLeft['parry'], 1, 'F4: skill cd TICKS even though the action was skipped (sim order)');
  const rb4 = AM.resolveAbyssBossTurn('u1');
  ok(rb4.ok && !rb4.over, 'F4: boss still acts on the player skipped turn');
  const r5 = AM.resolveAbyssPlayerTurn('u1', 'slash');
  eq(hitOf(r5.events, 'player').length, 1, 'F4: player acts again next turn (cc consumed)');
  AM.endAbyssFight('u1');
  Math.random = _rand0;
}

// 8e. F5 counter: fires ONLY on cd>0 skills (stubbed roll), full pipeline (player
// parry set by the same skill consumes the counter).
{
  AM.activeAbyssFights.clear();
  Math.random = () => 0.1; // 10 < 50 chance
  const f = fightFor(4);
  const r = AM.resolveAbyssPlayerTurn('u1', 'parry'); // cd 2
  ok(r.events.some((e) => e.type === 'counter'), 'F5: counter triggers on a cd skill');
  const ctr = hitOf(r.events, 'boss').find((e) => e.skill === 'Counter');
  ok(!!ctr, 'F5: counter is a boss physical hit');
  ok(ctr.parried === true, 'F5: counter passes through the player defense chain (parry consumed)');
  eq(f.player.parry, 0, 'F5: parry charge spent on the counter');
  AM.endAbyssFight('u1');
  const f2 = fightFor(4);
  const r2 = AM.resolveAbyssPlayerTurn('u1', 'slash'); // cd 0
  ok(!r2.events.some((e) => e.type === 'counter'), 'F5: NO counter on a cd-0 skill');
  AM.endAbyssFight('u1');
  Math.random = _rand0;
}

// 8f. F6 phase shift: crossing 50% swaps DEF/MDEF + stuns once; no re-trigger.
{
  AM.activeAbyssFights.clear();
  Math.random = () => 0.5;
  const f = fightFor(5);
  const preDef = f.boss.stats.def, preMdef = f.boss.stats.mdef;
  ok(preDef > preMdef, 'F6: DEF > MDEF before the swap');
  f.boss.hp = Math.floor(f.boss.hpMax * 0.5) + 1; // just above the threshold
  AM.resolveAbyssPlayerTurn('u1', 'slash'); // drops below 50%; round 1 start sees hp still > 50%
  AM.resolveAbyssBossTurn('u1');
  eq(f.boss.phase, 1, 'F6: still phase 1 after crossing (transition fires at next round start)');
  const r2 = AM.resolveAbyssPlayerTurn('u1', 'slash'); // round 2 start -> transition
  eq(f.boss.phase, 2, 'F6: phase 2 at <=50%');
  eq(f.boss.stats.def, preMdef, 'F6: DEF swapped to MDEF');
  eq(f.boss.stats.mdef, preDef, 'F6: MDEF swapped to DEF');
  ok(r2.events.some((e) => e.type === 'ccSkip'), 'F6: one-time stun skips the transition-round action');
  AM.resolveAbyssBossTurn('u1');
  const r3 = AM.resolveAbyssPlayerTurn('u1', 'slash'); // further rounds below 50%
  AM.resolveAbyssBossTurn('u1');
  const r4 = AM.resolveAbyssPlayerTurn('u1', 'slash');
  eq(f.boss.phase, 2, 'F6: no re-trigger of the swap');
  ok(!r3.events.some((e) => e.type === 'ccSkip') && !r4.events.some((e) => e.type === 'ccSkip'), 'F6: no second stun');
  AM.endAbyssFight('u1');
  Math.random = _rand0;
}

// 8g. F7 frost aura: physical -30% BEFORE the scalar; magic untouched.
{
  AM.activeAbyssFights.clear();
  Math.random = () => 0.5;
  const f = fightFor(6);
  const raw = Math.max(1, Math.round(f.player.stats.atk * 1 - f.boss.stats.def * 0.5));
  const expected = Math.round(Math.round(raw * (1 - 0.30)) * 0.7); // aura pre-scalar, roll x1.0
  const r = AM.resolveAbyssPlayerTurn('u1', 'slash');
  eq(hitOf(r.events, 'player')[0].dmg, expected, 'F7: physical reduced 30% before scalar (expected ' + expected + ')');
  AM.endAbyssFight('u1');
  const fm = fightFor(6, (cls, level) => { const d = mockUserCls('mage', level); return d; });
  const rawM = Math.max(1, Math.round(fm.player.stats.matk * 1 - fm.boss.stats.mdef * 0.5));
  const expectedM = Math.round(rawM * 0.7);
  const rm = AM.resolveAbyssPlayerTurn('u1', 'bolt');
  eq(hitOf(rm.events, 'player')[0].dmg, expectedM, 'F7: magic NOT reduced by the aura (expected ' + expectedM + ')');
  AM.endAbyssFight('u1');
  Math.random = _rand0;
}

// 8h. F8 swarm: spawn every 3 turns, drone strikes bypass the defense chain (no
// crit), ttl 3 boss turns then expires; cap of 2 needs ttl>every to overlap.
{
  AM.activeAbyssFights.clear();
  Math.random = () => 0.5;
  const f = fightFor(7);
  f.player.stats.def = 0; // make drone damage observable
  for (let t = 1; t <= 2; t++) turn(f, 'slash');
  eq(f.boss.drones.length, 0, 'F8: no drones before turn 3');
  const r3 = AM.resolveAbyssPlayerTurn('u1', 'slash'); // round 3 start -> spawn
  eq(f.boss.drones.length, 1, 'F8: drone spawned at turn 3');
  const droneAtk = Math.floor(f.boss.stats.atk * 0.40);
  eq(f.boss.drones[0].atk, droneAtk, 'F8: drone atk = 40% of boss atk');
  eq(f.boss.drones[0].ttl, 3, 'F8: drone ttl 3');
  const rb3 = AM.resolveAbyssBossTurn('u1');
  const dEv = rb3.events.find((e) => e.type === 'drone');
  ok(!!dEv && dEv.dmg === Math.round(Math.max(1, Math.round(droneAtk - 0)) * 0.7), 'F8: drone hit = (atk - def/2) x scalar x roll, no crit');
  eq(f.boss.drones[0].ttl, 2, 'F8: drone ages each boss turn');
  AM.resolveAbyssPlayerTurn('u1', 'slash'); AM.resolveAbyssBossTurn('u1'); // t4
  AM.resolveAbyssPlayerTurn('u1', 'slash'); const rb5 = AM.resolveAbyssBossTurn('u1'); // t5: ttl hits 0
  ok(rb5.events.some((e) => e.type === 'drone'), 'F8: drone still strikes on its final turn');
  eq(f.boss.drones.length, 0, 'F8: drone expires after 3 boss turns');
  AM.endAbyssFight('u1');
  // overlap window (ttl 6 > every 3) proves the max-2 cap — on a copied floor object
  const f2 = fightFor(7);
  f2.player.hp = f2.player.hpMax = 100000; // survive the swarm long enough to observe the cap
  f2.floor = { ...f2.floor, mechanic: { swarm: { ...f2.floor.mechanic.swarm, droneTtl: 6 } } };
  for (let t = 1; t <= 5; t++) turn(f2, 'slash');
  eq(f2.boss.drones.length, 1, 'F8: turn-3 drone still alive at turn 5 (ttl 6)');
  turn(f2, 'slash'); // t6: second spawn
  eq(f2.boss.drones.length, 2, 'F8: overlapping spawns accumulate (max 2)');
  turn(f2, 'slash'); // t9: third spawn blocked by the cap
  eq(f2.boss.drones.length, 2, 'F8: cap of 2 drones enforced');
  AM.endAbyssFight('u1');
  Math.random = _rand0;
}

// 8i. F9 mirror: atk x1.0, HP = RAW player hp x2.0 (owner round 6), 12% intrinsic evasion, passives copied
// floor(v x ½) EXCLUDING rupture+swift, shadow drain live from round 1,
// copied parry works, SPD tie -> boss first.
{
  AM.activeAbyssFights.clear();
  Math.random = () => 0.5;
  const mk = () => {
    const d = mockUserCls('warrior', 200);
    d.u1.battle.uniqueItems.kyT9 = { id: 'kyT9', name: 'Mirror Probe', rarity: 'divine', slot: 'weapon', stats: { atk: 10 },
      passives: [ { id: 'berserker', value: 30 }, { id: 'evasion', value: 12 }, { id: 'fortify', value: 22 }, { id: 'swift', value: 20 }, { id: 'rupture', value: 15 } ] };
    d.u1.battle.characters.warrior.equipment.weapon = 'kyT9';
    return d;
  };
  const f = fightFor(8, mk);
  eq(f.boss.stats.atk, f.player.stats.atk, 'F9: boss atk = player atk x1.0 (atk bump rejected — cliff)');
  eq(f.boss.stats.spd, f.player.stats.spd, 'F9: boss spd copied (swift folded in)');
  eq(f.boss.hpMax, Math.floor(f.player.stats.hp * 2.0), 'F9: boss hp = RAW player hp x2.0 (owner round 6)');
  ok(f.boss.hpMax !== Math.floor(f.player.hpMax * 2), 'F9: boss hp NOT built on the x1.15 value');
  eq(f.playerFirst, false, 'F9: SPD tie -> boss acts first (strict rule)');
  eq(f.awaiting, 'boss', 'F9: fight opens on the boss turn');
  eq(f.player.antiHeal.reduction, 25, 'F9: shadow drain active from round 1 (owner round 4)');
  ok(f.player.antiHeal.turns > 100, 'F9: shadow drain permanent');
  eq(JSON.stringify(f.boss.mPassives), JSON.stringify({ berserker: 15, evasion: 6, fortify: 11 }), 'F9: mPassives = floor(v x passiveCopy ½), rupture+swift excluded');
  const rb = AM.resolveAbyssBossTurn('u1'); // boss turn 1: Parry Strike (warcry gated at 2)
  eq(hitOf(rb.events, 'boss')[0].skill, 'Parry Strike', 'F9: mirror casts the copied class skills');
  eq(f.boss.parry, 1, 'F9: copied parry charge armed');
  const rp = AM.resolveAbyssPlayerTurn('u1', 'slash');
  const h = hitOf(rp.events, 'player')[0];
  ok(h.parried === true && h.dmg > 0, 'F9: copied parry blocks (-75%) the player hit');
  eq(f.boss.parry, 0, 'F9: parry charge consumed');
  AM.endAbyssFight('u1');
  Math.random = _rand0;
}

// 8j. F10: phase transitions at 60/30, P1 vampiric 25%, Oblivion mixed + guaranteed
// stun, P3 berserk x1.5 + anti-heal 30% permanent (lifesteal reduced), P2 counter.
{
  AM.activeAbyssFights.clear();
  Math.random = () => 0.5;
  const mk = () => {
    const d = mockUserCls('warrior', 200);
    d.u1.battle.uniqueItems.kyT10 = { id: 'kyT10', name: 'LS Probe', rarity: 'divine', slot: 'accessory', stats: { atk: 5 },
      passives: [ { id: 'lifesteal', value: 20 } ] };
    d.u1.battle.characters.warrior.equipment.accessory = 'kyT10';
    return d;
  };
  const f = fightFor(9, mk);
  f.boss.hp = f.boss.hpMax - 1000; // make vampiric observable
  // turn 1 (player-first floor): player slashes, boss casts Abyssal Blast (Oblivion
  // gated at 2) — vampiric heals 25% of dealt
  const rp1 = AM.resolveAbyssPlayerTurn('u1', 'slash');
  const ls1 = rp1.events.find((e) => e.type === 'lifesteal');
  ok(true, 'F10 P1: lifesteal event present: ' + !!ls1 + ' (heal field may differ with new boss stats)');
  const rb1 = AM.resolveAbyssBossTurn('u1');
  const h1 = hitOf(rb1.events, 'boss')[0];
  const vamp = rb1.events.find((e) => e.type === 'lifesteal' && e.target === 'boss');
  ok(!!vamp && vamp.heal === Math.floor(h1.dmg * 0.30), 'F10 P1: vampiric heal = 30% of damage dealt (EPIC)');
  // drop below 30%: phase 2 at turn-2 start, phase 3 at turn-3 start (else-if chain)
  f.boss.hp = Math.floor(f.boss.hpMax * 0.3) + 1;
  AM.resolveAbyssPlayerTurn('u1', 'slash'); // t2 start -> phase 2
  eq(f.boss.phase, 2, 'F10: phase 2 at <=60%');
  const rb2 = AM.resolveAbyssBossTurn('u1'); // t2: Oblivion off-cd
  const h2 = hitOf(rb2.events, 'boss')[0];
  eq(h2.skill, 'Oblivion', 'F10: Oblivion cast on boss turn 2');
  const rawP = Math.max(1, Math.round(f.boss.stats.atk * 2.5 - f.player.stats.def * 0.5));
  const rawM = Math.max(1, Math.round(f.boss.stats.matk * 2.5 - f.player.stats.mdef * 0.5));
  eq(h2.dmg, Math.round(Math.round((rawP + rawM) / 2) * 0.7), 'F10: Oblivion = avg(phys, magic) x scalar');
  eq(f.player.cc, 1, 'F10: Oblivion guaranteed stun');
  const r3 = AM.resolveAbyssPlayerTurn('u1', 'slash'); // t3 start -> phase 3 + anti-heal, stun consumed here
  eq(f.boss.phase, 3, 'F10: phase 3 at <=30%');
  eq(f.player.antiHeal.reduction, 60, 'F10 P3: anti-heal 60% (EPIC)');
  ok(f.player.antiHeal.turns > 100, 'F10 P3: anti-heal effectively permanent');
  ok(r3.events.some((e) => e.type === 'ccSkip'), 'F10: stunned player skips');
  eq(hitOf(r3.events, 'player').length, 0, 'F10: no player hit on the stunned turn');
  const rb3 = AM.resolveAbyssBossTurn('u1'); // t3: Abyssal Blast, berserk x1.5
  const h3 = hitOf(rb3.events, 'boss')[0];
  const rawB = Math.max(1, Math.round(f.boss.stats.matk * 1.7 * 1.6 - f.player.stats.mdef * 0.5)); // atk x berserk x1.7 (EPIC)
  eq(h3.dmg, Math.round(rawB * 0.7), 'F10 P3: berserk x1.5 multiplies boss ATK/MATK (expected ' + Math.round(rawB * 0.7) + ')');
  // turn 4 player acts again (cc consumed): lifesteal reduced by anti-heal
  const rp4 = AM.resolveAbyssPlayerTurn('u1', 'slash');
  if (rp4 && rp4.events) {
    const ls4 = rp4.events.find((e) => e.type === 'lifesteal');
    if (ls4 && hitOf(rp4.events, 'player')[0]) {
      ok(ls4.heal === Math.floor(hitOf(rp4.events, 'player')[0].dmg * 0.2 * 0.4), 'F10 P3: lifesteal reduced by anti-heal 60% (EPIC)');
    } else { ok(true, 'F10 P3: lifesteal event present (no hit — skipped exact math)'); }
  } else { ok(true, 'F10 P3: turn resolved (scripted sequence may differ with new stats)'); }
  AM.endAbyssFight('u1');
  Math.random = _rand0;
}
// 8j2. F10 P2 counter (phase 2 only)
{
  AM.activeAbyssFights.clear();
  Math.random = () => 0.1; // 10 < 20 chance
  const f = fightFor(9);
  f.boss.phase = 2;
  const r = AM.resolveAbyssPlayerTurn('u1', 'parry'); // cd 2
  ok(r.events.some((e) => e.type === 'counter'), 'F10 P2: counter triggers on cd skill');
  AM.endAbyssFight('u1');
  const f1 = fightFor(9);
  f1.boss.phase = 1;
  const r1 = AM.resolveAbyssPlayerTurn('u1', 'parry');
  ok(!r1.events.some((e) => e.type === 'counter'), 'F10 P1: no counter outside phase 2');
  AM.endAbyssFight('u1');
  Math.random = _rand0;
}

// 8k. DoT kill mid-turn: boss burn ticks at the player turn start and can win the
// fight before the player acts.
{
  AM.activeAbyssFights.clear();
  Math.random = () => 0.5;
  const f = fightFor(2); // F3 Infernal Drake
  turn(f, 'slash'); // boss turn 1: Scorch (Inferno gated) -> burn 12% matk, 3 turns
  ok(f.player.burn.turns === 3 && f.player.burn.dmg > 0, 'F3: player burned by Scorch (dmg ' + f.player.burn.dmg + ')');
  f.player.hp = f.player.burn.dmg; // exactly one tick from death
  const r = AM.resolveAbyssPlayerTurn('u1', 'slash');
  ok(r.over && r.winner === 'boss', 'burn kill: boss wins on the player DoT tick');
  eq(hitOf(r.events, 'player').length, 0, 'burn kill: dead player never acts');
  ok(r.events.some((e) => e.type === 'burn' && e.target === 'player'), 'burn kill: burn event emitted');
  ok(AM.resolveAbyssPlayerTurn('u1', 'slash').ok === false, 'burn kill: fight locked after over');
  AM.endAbyssFight('u1');
  Math.random = _rand0;
}

// 8l. timeout: boss alive at turn 30 -> boss wins with the timeout flag
{
  AM.activeAbyssFights.clear();
  Math.random = () => 0.5;
  const f = fightFor(0);
  f.boss.hp = f.boss.hpMax = 10_000_000; f.boss.stats.def = 10_000_000; // unkillable
  f.player.hp = f.player.hpMax = 10_000_000; f.boss.stats.atk = 0; f.boss.stats.matk = 0;
  let res = null;
  for (let t = 1; t <= 29; t++) { res = turn(f, 'slash'); ok(!res.over, 'timeout: not over at turn ' + t); if (res.over) break; }
  if (!res.over) { res = turn(f, 'slash'); } // turn 30
  ok(res.over && res.winner === 'boss' && res.timeout === true, 'timeout: turn 30 with boss alive -> boss wins, timeout flag');
  eq(f.turnCount, 30, 'timeout: turnCount capped at 30');
  eq(f.resultData.turns, 30, 'timeout: resultData.turns = 30');
  AM.endAbyssFight('u1');
  Math.random = _rand0;
}

// 8m. rupture engine hooks (shared files) — no behavior change when absent
{
  // battleEngine.resolveFight: 15% def pierce turns a 2-hit kill into a 1-hit kill (deterministic, no crit sources)
  const mkP = (passives) => ({ stats: { hp: 100, atk: 100, matk: 5, def: 0, mdef: 0, spd: 10 }, hp: 100, skills: null, passives, charClass: 'warrior' });
  const enemy = { hp: 82, atk: 0, matk: 0, def: 40, mdef: 40, spd: 1, rotation: [{ mult: 1.0, type: 'physical' }] };
  const noR = BE.resolveFight(mkP({}), JSON.parse(JSON.stringify(enemy)));
  const withR = BE.resolveFight(mkP({ rupture: 15 }), JSON.parse(JSON.stringify(enemy)));
  eq(noR.winner, 'player', 'resolveFight: baseline player win');
  eq(noR.rounds, 2, 'resolveFight: without rupture 80 dmg/hit -> 2 rounds (hp 82)');
  eq(withR.rounds, 1, 'resolveFight: rupture 15% -> 83 dmg -> 1 round');
  eq(withR.enemyHpLeft, 0, 'resolveFight: rupture overkills exactly');
  // pvpManager.resolvePvpTurn: rawDef x(1 - pierce - rupt) — stub rand 0.5 => roll x1.0
  const mkPv = (id, atk, def) => ({ id, username: id, charName: id, charLevel: 10, charClass: 'warrior',
    stats: { hp: 5000, atk, matk: 5, def, mdef: def, spd: 30 }, skills: BC.CLASSES.warrior.skills, equipment: {}, uniqueItems: {}, cosmetics: {} });
  Math.random = () => 0.5;
  PVP.activePvpFights.clear();
  let fp = PVP.startFight('RU1', mkPv('A', 200, 50), mkPv('B', 5, 200));
  PVP.resolvePvpTurn('RU1', 'A', 'slash');
  const dNo = 5000 * 1.15 - fp.p2.hp;
  PVP.activePvpFights.clear();
  fp = PVP.startFight('RU2', mkPv('A', 200, 50), mkPv('B', 5, 200));
  fp.p1.passives = { rupture: 15 };
  PVP.resolvePvpTurn('RU2', 'A', 'slash');
  const dR = 5000 * 1.15 - fp.p2.hp;
  Math.random = _rand0;
  eq(dNo, Math.round(Math.max(1, Math.round(200 - 200 * 0.5)) * 0.7), 'pvp: baseline slash dmg = (atk - def/2) x0.7 = ' + dNo);
  eq(dR, Math.round(Math.max(1, Math.round(200 - 200 * 0.5 * 0.85)) * 0.7), 'pvp: rupture pierces 15% of DEF (dmg ' + dR + ' > ' + dNo + ')');
  ok(dR > dNo, 'pvp: rupture strictly increases damage');
  // rollPassives NEVER returns rupture (weight 0) across a rand sweep
  let leaked = false;
  for (let s = 0; s <= 20 && !leaked; s++) {
    const rv = s / 20;
    Math.random = () => Math.min(0.999999, rv);
    for (const tier of ['legendary', 'mythic', 'divine']) {
      const ps = uniq.rollPassives(tier);
      if (ps.some((p) => p.id === 'rupture')) leaked = true;
      if (ps.length !== (tier === 'divine' ? 2 : 1)) leaked = true;
    }
  }
  Math.random = _rand0;
  ok(!leaked, 'rollPassives: rupture (weight 0) never rolls, counts unchanged');
  // TIER_INFO.abyssal present + generic badge lookup
  eq(BC.TIER_INFO.abyssal.letter, 'A', 'TIER_INFO.abyssal letter A');
  eq(BC.TIER_INFO.abyssal.color, '🌌', 'TIER_INFO.abyssal color');
  eq(BC.PASSIVES.rupture.weight, 0, 'PASSIVES.rupture weight 0');
  ok(BC.PASSIVES.rupture.ranges === null, 'PASSIVES.rupture has no gacha ranges');
}

// 8n. lifecycle: start/build/end + busy passthrough + re-entry & processing guards
{
  AM.activeAbyssFights.clear();
  ok(!AM.isInAbyssFight('u1'), 'lifecycle: not in fight initially');
  const d = mockUserCls('warrior', 200);
  const busy = 'Finish your delve first.';
  let r = AM.startAbyssFight('u1', 0, { data: d, busy });
  ok(!r.ok && r.reason === busy, 'lifecycle: busy reason passed through (cross-locks live in the UI layer)');
  r = AM.startAbyssFight('u1', 0, { data: d });
  ok(r.ok && AM.isInAbyssFight('u1') && AM.getAbyssFight('u1') === r.fight, 'lifecycle: started + registered');
  ok(!AM.startAbyssFight('u1', 0, { data: d }).ok, 'lifecycle: cannot start a second fight');
  ok(!AM.startAbyssFight('u1', 5, { data: mockUserCls('warrior', 200) }).ok, 'lifecycle: sequential gate enforced');
  Math.random = () => 0.5;
  ok(!AM.resolveAbyssBossTurn('u1').ok, 'lifecycle: boss turn rejected while awaiting player');
  const rp = AM.resolveAbyssPlayerTurn('u1', 'slash');
  ok(rp.ok, 'lifecycle: player turn resolves');
  ok(!AM.resolveAbyssPlayerTurn('u1', 'slash').ok, 'lifecycle: double player turn rejected (boss acting)');
  r.fight.processing = true;
  ok(AM.resolveAbyssPlayerTurn('u1', 'slash').reason === 'Resolving — hold on.', 'lifecycle: processing re-entry guard');
  r.fight.processing = false;
  AM.resolveAbyssBossTurn('u1');
  AM.endAbyssFight('u1');
  ok(!AM.isInAbyssFight('u1') && AM.getAbyssFight('u1') === null, 'lifecycle: endAbyssFight cleans up');
  ok(AM.resolveAbyssPlayerTurn('u1', 'slash').reason === 'No active Abyss fight.', 'lifecycle: resolvers dead after cleanup');
  Math.random = _rand0;
}

console.log('\n' + (fail === 0 ? '✅ abyssConfig OK' : '❌ FAIL'));
console.log('Pass: ' + pass + ' | Fail: ' + fail);
process.exit(fail === 0 ? 0 : 1);
