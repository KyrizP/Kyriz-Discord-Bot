'use strict';
// PvP duel engine tests. Run: node test/pvp.test.js
const P = require('../utils/pvpManager');
const { CLASSES } = require('../utils/battleConfig');
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : (fail++, console.log('  ❌ ' + m)); };

function mkPlayer(id, stats, cls) {
  return { id, username: 'U' + id, charName: 'C' + id, charLevel: 10, charClass: cls,
    stats, skills: CLASSES[cls].skills, equipment: {}, uniqueItems: {}, cosmetics: {} };
}
const strongWar = { hp: 1000, atk: 200, matk: 10, def: 50, mdef: 50, spd: 30 };
const weakMage = { hp: 600, atk: 10, matk: 120, def: 30, mdef: 60, spd: 10 };

// ---- startFight: HP × PVP_HP_RATIO (1.15), turn order by SPD ----
P.activePvpFights.clear();
let f = P.startFight('F1', mkPlayer('A', strongWar, 'warrior'), mkPlayer('B', weakMage, 'mage'));
ok(f.p1.hp === 1150 && f.p1.hpMax === 1150, 'p1 hp = 1.15× (1150)');
ok(f.p2.hp === 690 && f.p2.hpMax === 690, 'p2 hp = 1.15× (690)');
ok(f.active === 'p1', 'higher SPD (p1) goes first');

// ---- resolvePvpTurn: damage + swap ----
let r = P.resolvePvpTurn('F1', 'A', 'slash');
ok(r.ok && !r.over, 'turn resolved, not over');
ok(f.active === 'p2', 'active swapped to p2 after p1 turn');
ok(f.turnCount === 1, 'turnCount incremented');
let r2 = P.resolvePvpTurn('F1', 'B', 'bolt');
ok(r2.ok && f.active === 'p1', 'back to p1');

// ---- not your turn -> rejected ----
let bad = P.resolvePvpTurn('F1', 'B', 'bolt'); // it's p1's turn
ok(!bad.ok, 'acting out of turn rejected');

// ---- skill on cooldown rejected; cd ticks down on VALID turns (real play: on-cd buttons disabled) ----
P.activePvpFights.clear();
const tank = { hp: 100000, atk: 1, matk: 1, def: 1000, mdef: 1000, spd: 30 };
const tank2 = { hp: 100000, atk: 1, matk: 1, def: 1000, mdef: 1000, spd: 10 };
let f2 = P.startFight('F2', mkPlayer('A', tank, 'warrior'), mkPlayer('B', tank2, 'mage'));
P.resolvePvpTurn('F2', 'A', 'parry'); // cd 2
ok((f2.p1.cdLeft['parry'] || 0) === 2, 'parry cd set to 2');
P.resolvePvpTurn('F2', 'B', 'bolt');
let parryAgain = P.resolvePvpTurn('F2', 'A', 'parry'); // no valid turn since -> still cd 2 -> rejected
ok(!parryAgain.ok, 'parry still on cd — rejected');
// A uses another skill while parry cools down (this is how real play works)
P.resolvePvpTurn('F2', 'B', 'bolt');
P.resolvePvpTurn('F2', 'A', 'slash'); // valid turn -> tick parry 2->1
P.resolvePvpTurn('F2', 'B', 'bolt');
P.resolvePvpTurn('F2', 'A', 'slash'); // valid turn -> tick parry 1->0
P.resolvePvpTurn('F2', 'B', 'bolt');
let parryReady = P.resolvePvpTurn('F2', 'A', 'parry'); // cd 0 now -> ready
ok(parryReady.ok, 'parry ready after 2 valid turns using other skills');

// ---- parry blocks next incoming hit (consumed) ----
// ---- parry: reduces damage ~75% (NOT full block — prevents WvW mutual-parry stall) ----
// (mock random=0.5 so the ±15% damage roll is exactly ×1.0 in both fights)
P.activePvpFights.clear();
const _r0 = Math.random;
Math.random = () => 0.5;
let f3 = P.startFight('F3', mkPlayer('A', { hp: 5000, atk: 5, matk: 5, def: 5, mdef: 5, spd: 30 }, 'warrior'),
                              mkPlayer('B', { hp: 5000, atk: 200, matk: 5, def: 5, mdef: 5, spd: 10 }, 'warrior'));
P.resolvePvpTurn('F3', 'A', 'parry'); // A sets parry
ok(f3.p1.parryBlocks === 1, 'A parry armed (1 block)');
let hpP = f3.p1.hp;
P.resolvePvpTurn('F3', 'B', 'slash'); // B hits A, parried (reduced)
let parriedDmg = hpP - f3.p1.hp;
ok(f3.p1.parryBlocks === 0, 'parry consumed');
// reference: no parry — A slashes instead, B hits A full
P.activePvpFights.clear();
let f3b = P.startFight('F3b', mkPlayer('A', { hp: 5000, atk: 5, matk: 5, def: 5, mdef: 5, spd: 30 }, 'warrior'),
                                mkPlayer('B', { hp: 5000, atk: 200, matk: 5, def: 5, mdef: 5, spd: 10 }, 'warrior'));
P.resolvePvpTurn('F3b', 'A', 'slash'); // A does NOT parry
let hpF = f3b.p1.hp;
P.resolvePvpTurn('F3b', 'B', 'slash'); // B hits A, full
let fullDmg = hpF - f3b.p1.hp;
Math.random = _r0;
ok(parriedDmg > 0 && parriedDmg < fullDmg, 'parry reduced damage (' + parriedDmg + ' < full ' + fullDmg + ')');
ok(parriedDmg <= Math.ceil(fullDmg * 0.35), 'parry mitigated ~75% (parried ' + parriedDmg + ' <= 35% of ' + fullDmg + ')');

// ---- damage roll: ±15% per hit (mock 0.0 = low roll, 1.0 = high roll) ----
P.activePvpFights.clear();
Math.random = () => 0.0;
let fR1 = P.startFight('FR1', mkPlayer('A', { hp: 1000, atk: 200, matk: 5, def: 5, mdef: 5, spd: 30 }, 'warrior'),
                                 mkPlayer('B', { hp: 100000, atk: 5, matk: 5, def: 0, mdef: 0, spd: 10 }, 'mage'));
let hpRLow = fR1.p2.hp;
P.resolvePvpTurn('FR1', 'A', 'slash');
let dmgLow = hpRLow - fR1.p2.hp;
P.activePvpFights.clear();
Math.random = () => 1.0;
let fR2 = P.startFight('FR2', mkPlayer('A', { hp: 1000, atk: 200, matk: 5, def: 5, mdef: 5, spd: 30 }, 'warrior'),
                                 mkPlayer('B', { hp: 100000, atk: 5, matk: 5, def: 0, mdef: 0, spd: 10 }, 'mage'));
let hpRHigh = fR2.p2.hp;
P.resolvePvpTurn('FR2', 'A', 'slash');
let dmgHigh = hpRHigh - fR2.p2.hp;
Math.random = _r0;
ok(dmgLow > 0 && dmgHigh > dmgLow * 1.2, 'damage roll spreads hits (low ' + dmgLow + ' vs high ' + dmgHigh + ')');

// ---- War Cry: self-buff + DR capped at PVP_WARCRY_DR_CAP (15) ----
P.activePvpFights.clear();
let fW = P.startFight('FW', mkPlayer('A', { hp: 5000, atk: 100, matk: 5, def: 5, mdef: 5, spd: 30 }, 'warrior'),
                               mkPlayer('B', { hp: 5000, atk: 5, matk: 5, def: 5, mdef: 5, spd: 10 }, 'mage'));
fW.p1.cdLeft = {}; // bypass ult gate for the unit test
P.resolvePvpTurn('FW', 'A', 'warcry');
ok(fW.p1.buff.atkPct === 25 && fW.p1.buff.turns === 2, 'War Cry atk buff applied');
ok(fW.p1.buff.dmgReduce === 15, 'War Cry DR capped at 15 in PvP (config 35)');

// ---- burn ticks at start of victim turn (dmg = pct × matk × pvpBurnMult) ----
P.activePvpFights.clear();
let f4 = P.startFight('F4', mkPlayer('A', { hp:1000, atk:5, matk:300, def:5, mdef:5, spd:30 }, 'mage'),
                              mkPlayer('B', { hp:1000, atk:5, matk:5, def:5, mdef:5, spd:10 }, 'warrior'));
P.resolvePvpTurn('F4', 'A', 'fireball'); // burns B: 10% of 300 × burnMult(charLevel 10)
ok(f4.p2.burn.turns === 3 && f4.p2.burn.dmg === Math.round(300 * 0.10 * P.pvpBurnMult(10)), 'B burned pct×matk×pvpBurnMult for 3 turns');
let hpB = f4.p2.hp;
P.resolvePvpTurn('F4', 'B', 'slash'); // B's turn -> burn ticks first
ok(f4.p2.hp < hpB && (hpB - f4.p2.hp) >= 1, 'burn ticked (positive dmg) at start of B turn');

// ---- crit: crit hit > non-crit hit (robust to damage formula/scalar tuning) ----
P.activePvpFights.clear();
let f5 = P.startFight('F5', mkPlayer('A', { hp:1000, atk:100, matk:5, def:5, mdef:5, spd:30 }, 'warrior'),
                              mkPlayer('B', { hp:100000, atk:5, matk:5, def:0, mdef:0, spd:10 }, 'mage'));
f5.p1.passives = { precision: 50 }; // getCritChance -> 0.5
const _r = Math.random;
let seqN = 0;
Math.random = () => (seqN++ === 0 ? 0.9 : 0.0); // 1st call = crit check (0.9 -> no crit), 2nd = damage roll (min)
let hpN = f5.p2.hp;
P.resolvePvpTurn('F5', 'A', 'slash');
let nonCrit = hpN - f5.p2.hp;
P.activePvpFights.clear();
let f5c = P.startFight('F5c', mkPlayer('A', { hp:1000, atk:100, matk:5, def:5, mdef:5, spd:30 }, 'warrior'),
                                mkPlayer('B', { hp:100000, atk:5, matk:5, def:0, mdef:0, spd:10 }, 'mage'));
f5c.p1.passives = { precision: 50 };
let seqC = 0;
Math.random = () => (seqC++ === 0 ? 0.4 : 1.0); // 1st call = crit check (0.4 < 0.5 -> crit), 2nd = damage roll (max)
let hpC = f5c.p2.hp;
P.resolvePvpTurn('F5c', 'A', 'slash');
let crit = hpC - f5c.p2.hp;
ok(nonCrit > 0 && crit > nonCrit * 1.5, 'crit (' + crit + ') deals clearly more than non-crit (' + nonCrit + ')');
Math.random = _r;

// ---- evasion (deterministic) ----
P.activePvpFights.clear();
let f6 = P.startFight('F6', mkPlayer('A', { hp:1000, atk:100, matk:5, def:5, mdef:5, spd:30 }, 'warrior'),
                              mkPlayer('B', { hp:1000, atk:5, matk:5, def:5, mdef:5, spd:10 }, 'mage'));
f6.p2.passives = { evasion: 100 }; // always dodges
Math.random = () => 0.0;
let hpB6 = f6.p2.hp;
P.resolvePvpTurn('F6', 'A', 'slash');
ok(f6.p2.hp === hpB6, '100% evasion -> hit fully dodged');
Math.random = _r;

// ---- lifesteal heals (capped at hpMax) ----
P.activePvpFights.clear();
let f7 = P.startFight('F7', mkPlayer('A', { hp:1000, atk:100, matk:5, def:5, mdef:5, spd:30 }, 'warrior'),
                              mkPlayer('B', { hp:1000, atk:200, matk:5, def:5, mdef:5, spd:10 }, 'warrior'));
f7.p1.passives = { lifesteal: 50 };
f7.p1.hp = 100; // damaged
let hpA7 = f7.p1.hp;
P.resolvePvpTurn('F7', 'A', 'slash');
ok(f7.p1.hp > hpA7, 'lifesteal healed attacker');
ok(f7.p1.hp <= f7.p1.hpMax, 'lifesteal capped at hpMax');

// ---- death ends fight, winner set ----
P.activePvpFights.clear();
let f8 = P.startFight('F8', mkPlayer('A', { hp:1000, atk:9999, matk:5, def:5, mdef:5, spd:30 }, 'warrior'),
                              mkPlayer('B', { hp:100, atk:5, matk:5, def:0, mdef:0, spd:10 }, 'mage'));
let kill = P.resolvePvpTurn('F8', 'A', 'slash');
ok(kill.over && kill.winner === 'p1' && f8.p2.hp === 0, 'kill ends fight, p1 wins');

// ---- turn cap 20 -> highest HP% wins ----
P.activePvpFights.clear();
let f9 = P.startFight('F9', mkPlayer('A', { hp:1000, atk:0, matk:0, def:9999, mdef:9999, spd:30 }, 'warrior'),
                              mkPlayer('B', { hp:500, atk:0, matk:0, def:9999, mdef:9999, spd:10 }, 'warrior'));
let turns = 0, overInfo = null;
while (turns < 40) {
  const actor = f9.active === 'p1' ? 'A' : 'B';
  const rr = P.resolvePvpTurn('F9', actor, 'slash');
  turns++;
  if (rr.over) { overInfo = rr; break; }
}
ok(overInfo && overInfo.timeout, 'hit turn cap (no one dies from chip dmg vs 9999 def)');
ok(overInfo && overInfo.winner === 'p1', 'turn cap: p1 higher HP% (both full) wins');

// ---- forfeitByAfk: active player loses; stale guard (no-op after end) ----
P.activePvpFights.clear();
let f10 = P.startFight('F10', mkPlayer('A', strongWar, 'warrior'), mkPlayer('B', weakMage, 'mage'));
ok(f10.active === 'p1', 'p1 active before afk');
let afk = P.forfeitByAfk('F10');
ok(afk.ok && f10.over && f10.winner === 'p2', 'AFK: active p1 loses, p2 wins');
let afk2 = P.forfeitByAfk('F10');
ok(!afk2.ok, 'forfeitByAfk no-op after already over (stale guard)');

// ---- forfeitManual: the forfeiting player loses ----
P.activePvpFights.clear();
let f11 = P.startFight('F11', mkPlayer('A', strongWar, 'warrior'), mkPlayer('B', weakMage, 'mage'));
let fm = P.forfeitManual('F11', 'B');
ok(fm.ok && f11.winner === 'p1', 'manual forfeit by B -> A wins');
ok(!P.forfeitManual('F11', 'Z').ok, 'non-participant cannot forfeit');

// ---- endFight clears map ----
P.endFight('F11');
ok(!P.activePvpFights.has('F11'), 'endFight removes fight');
ok(!P.isInFight('A') && !P.isInFight('B'), 'isInFight false after endFight');

// ---- mutual exclusion helper ----
P.activePvpFights.clear();
P.startFight('F12', mkPlayer('A', strongWar, 'warrior'), mkPlayer('B', weakMage, 'mage'));
ok(P.isInFight('A') && P.isInFight('B'), 'isInFight true for both combatants mid-fight');
ok(!P.isInFight('Z'), 'non-combatant not in fight');

// ---- burn-kill: the burn CASTER wins (NOT the burned victim) — regression for inverted winner ----
P.activePvpFights.clear();
let fB = P.startFight('FB', mkPlayer('A', { hp: 1000, atk: 1, matk: 1000, def: 5, mdef: 5, spd: 30 }, 'mage'),
                              mkPlayer('B', { hp: 50, atk: 1, matk: 1, def: 5, mdef: 9999, spd: 10 }, 'warrior'));
P.resolvePvpTurn('FB', 'A', 'fireball'); // A burns B: 10% of 1000 × burnMult; direct hit ~1 (B mdef huge)
ok(fB.p2.burn.dmg === Math.round(1000 * 0.10 * P.pvpBurnMult(10)) && fB.p2.burn.turns === 3, 'B burned pct×matk×pvpBurnMult for 3 turns');
let bk = P.resolvePvpTurn('FB', 'B', 'slash'); // B's turn: burn ticks first → B dies
ok(bk.over && bk.winner === 'p1', 'burn-kill: caster (p1 mage) wins, NOT the burned victim');
ok(fB.p2.hp === 0, 'B died from burn tick');

// ---- pvpBurnMult: level-scaled burn compensation (v1.5) ----
ok(Math.abs(P.pvpBurnMult(1) - 0.96) < 1e-9, 'burn mult at Lv1 = 0.96 (base only)');
ok(P.pvpBurnMult(100) < P.pvpBurnMult(400), 'burn mult grows with level (tracks class growth gap)');

console.log('\n' + (fail === 0 ? '✅ SEMUA TEST LULUS' : '❌ ADA TEST GAGAL'));
console.log('Pass: ' + pass + ' | Fail: ' + fail);
process.exit(fail === 0 ? 0 : 1);
