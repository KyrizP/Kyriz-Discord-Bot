'use strict';
// ============================================================
// ABYSS TUNING SIM — the balance gate for the Abyss Tower spec.
// Models the spec v3 combat rules (PvP-style: ×0.7 scalar, ±15% roll,
// HP×1.15, 30-turn limit, per-floor mechanics) with REAL engine formulas.
// Run: node test/abyss_tune_sim.js
// Contract (divine baseline — players at Lv100+ already run full divine):
//   rec class + divine @ rec level → 70-90% WR
//   wrong class + divine @ rec level → 35-65% WR
//   rec class + epic  @ rec level → 15-50% WR (come back later)
//   rec class + divine @ rec+50%   → ≥90% (overleveled stomps)
// ============================================================

const E = require('../utils/battleEngine');
const { CLASSES } = require('../utils/battleConfig');

const REC_BIAS = 1.1;        // F3+: boss tuned at rec x1.1 while the UI shows rec — recommendation is
                           // ASPIRATIONAL: displayed rec = entry level, comfortable clear ≈ rec+10%.
                           // F1-F2 stay 1.0 (onboarding must stay epic-friendly). F9 mirror is exempt
                           // (scales with the player by construction — bias would be a no-op anyway).
const SCALAR = 0.7;          // PvP damage scalar
const HP_RATIO = 1.15;       // PvP HP ratio (player HP; boss HP set by mult)
const TURN_LIMIT = 30;
const WARCRY_DR_CAP = 15;    // PvP cap — Abyss uses PvP defense semantics

const DM = { berserker: 32, precision: 25, lifesteal: 25, swift: 20, fortify: 22, evasion: 13, greed: 30, wisdom: 30 };
const DS = { w: { atk: 55 }, m: { matk: 55 }, head: { def: 26 }, armor: { def: 52 }, boots: { spd: 34 }, accA: { atk: 35, spd: 12 }, accM: { matk: 35, spd: 12 } };
const EPIC = { warrior: { weapon: 'g10', head: 'g21', armor: 'g12', boots: 'g13', accessory: 'g14' }, mage: { weapon: 'g11', head: 'g22', armor: 'g23', boots: 'g13', accessory: 'g15' }, rogue: { weapon: 'g10', head: 'g21', armor: 'g12', boots: 'g13', accessory: 'g14' } };

function divineGear(cls, pc) {
  const u = {}, eq = {}; const isM = cls === 'mage';
  const ss = [isM ? DS.m : DS.w, DS.head, DS.armor, DS.boots, isM ? DS.accM : DS.accA];
  const a = []; for (const [p, c] of Object.entries(pc)) for (let i = 0; i < c; i++) a.push(p);
  for (let i = 0; i < 5; i++) {
    const id = 'ky_sim_' + i, ps = [];
    if (i < a.length) ps.push({ id: a[i], value: DM[a[i]] });
    const used = new Set(ps.map(p => p.id));
    for (const f of ['greed', 'wisdom', 'swift']) if (!used.has(f)) { ps.push({ id: f, value: DM[f] }); break; }
    u[id] = { id, name: id, rarity: 'divine', slot: 'x', stats: ss[i], passives: ps };
    eq[['weapon', 'head', 'armor', 'boots', 'accessory'][i]] = id;
  }
  return { u, eq };
}
const RDPS = { berserker: 2, lifesteal: 2, fortify: 1 };

// ---- FLOOR CONFIGS (tuned values live here) ----
const FLOORS = [
  { id: 1, name: 'Feral Guardian', rec: 50, recClass: null, hp: 2.5, atk: 0.6, matk: 0.6, def: 0.5, mdef: 0.4, spd: 4, crit: 0, mech: null,
    skills: [{ n: 'Bite', m: 1.0, t: 'physical', cd: 0 }, { n: 'Claw', m: 1.4, t: 'physical', cd: 2 }] },
  { id: 2, name: 'Stone Sentinel', rec: 80, recClass: 'mage', hp: 2.5, atk: 0.5, matk: 0.5, def: 0.6, mdef: 0.4, spd: 3, crit: 0, mech: { shield: { every: 4, pct: 0.15 } },
    skills: [{ n: 'Slam', m: 1.0, t: 'physical', cd: 0 }, { n: 'Heavy Blow', m: 1.6, t: 'physical', cd: 3 }] },
  { id: 3, name: 'Infernal Drake', rec: 110, recClass: 'rogue', hp: 2.3, atk: 0.5, matk: 0.95, def: 0.4, mdef: 0.5, spd: 10, crit: 0.10, critMult: 1.5, mech: { enrage: { every: 3, pct: 0.10 } },
    skills: [{ n: 'Flame Breath', m: 1.2, t: 'magic', cd: 0 }, { n: 'Scorch', m: 1.0, t: 'magic', cd: 2, burn: { pct: 12, turns: 3 } }, { n: 'Inferno', m: 2.0, t: 'magic', cd: 4, burn: { pct: 20, turns: 3 } }] },
  { id: 4, name: 'Ancient Treant', rec: 150, recClass: 'mage', hp: 2.5, atk: 0.5, matk: 0.55, def: 0.6, mdef: 0.5, spd: 4, crit: 0.15, critMult: 1.5, mech: { regen: { every: 4, pct: 0.04 } },
    skills: [{ n: 'Root Slam', m: 1.0, t: 'magic', cd: 0, cc: { chance: 25 } }, { n: "Nature's Wrath", m: 1.5, t: 'magic', cd: 3 }, { n: "Nature's Embrace", m: 1.5, t: 'magic', cd: 6, heal: 0.08, cc: { chance: 100 } }] },
  { id: 5, name: 'Thunder Wyrm', rec: 200, recClass: 'warrior', hp: 2.5, atk: 0.5, matk: 0.8, def: 0.5, mdef: 0.6, spd: 7, crit: 0.15, critMult: 1.5, mech: { counter: { chance: 50, mult: 1.0 } },
    skills: [{ n: 'Thunder Bolt', m: 1.2, t: 'magic', cd: 0 }, { n: 'Storm Surge', m: 1.8, t: 'magic', cd: 3 }, { n: 'Lightning Storm', m: 2.5, t: 'magic', cd: 5, pierceEva: true }] },
  { id: 6, name: 'Shadow Warden', rec: 250, recClass: 'rogue', hp: 3.4, atk: 0.80, matk: 0.80, def: 0.7, mdef: 0.3, spd: 7, crit: 0.15, critMult: 1.5, mech: { phaseShift: { at: 0.5, stun: true } },
    skills: [{ n: 'Shadow Strike', m: 1.1, t: 'physical', cd: 0 }, { n: 'Dark Pulse', m: 1.5, t: 'magic', cd: 2 }, { n: 'Umbral Rend', m: 1.8, t: 'physical', cd: 3 }] },
  { id: 7, name: 'Frost Lich', rec: 300, recClass: 'mage', hp: 2.8, atk: 0.5, matk: 0.7, def: 0.8, mdef: 0.7, spd: 6, crit: 0.20, critMult: 1.75, mech: { frostAura: { physReduction: 0.30 } },
    skills: [{ n: 'Frost Bolt', m: 1.3, t: 'magic', cd: 0, cc: { chance: 20 } }, { n: 'Ice Storm', m: 2.0, t: 'magic', cd: 3 }, { n: 'Frost Nova', m: 1.0, t: 'magic', cd: 5, cc: { chance: 75 } }] },
  { id: 8, name: 'Hive Queen', rec: 370, recClass: 'rogue', hp: 3.0, atk: 0.70, matk: 0.5, def: 0.5, mdef: 0.5, spd: 9, crit: 0.20, critMult: 1.75, mech: { swarm: { every: 3, max: 2, droneAtkPct: 0.30, droneTtl: 3 } },
    skills: [{ n: 'Sting', m: 1.0, t: 'physical', cd: 0 }, { n: 'Toxic Spray', m: 1.4, t: 'physical', cd: 2, poison: { pct: 10, turns: 3 }, cc: { chance: 25 } }, { n: 'Venomous Onslaught', m: 2.0, t: 'physical', cd: 4, poison: { pct: 15, turns: 3 }, antiHeal: { reduction: 50, turns: 3 } }] },
  { id: 9, name: 'Doppelganger', rec: 430, recClass: 'warrior', mirror: true, hpMult: 2.0, passiveCopy: 1/3, crit: 0.20, critMult: 1.75, mech: { darkAdapt: { every: 3, pct: 0.15 } } },
  { id: 10, name: 'Abyssal Overlord', rec: 500, recClass: null, hp: 2.5, atk: 0.7, matk: 0.7, def: 0.7, mdef: 0.7, spd: 7, crit: 0.25, critMult: 1.75,
    mech: { p1: { enrage: { every: 4, pct: 0.08 }, lifesteal: 0.25 }, p2: { counter: { chance: 20, mult: 1.0 } }, p3: { berserk: { atk: 1.5 }, antiHeal: 30 } },
    skills: [{ n: 'Void Slash', m: 1.2, t: 'physical', cd: 0, cc: { chance: 20 } }, { n: 'Abyssal Blast', m: 1.6, t: 'magic', cd: 2 }, { n: 'Oblivion', m: 2.5, t: 'mixed', cd: 4, pierceEva: true, cc: { chance: 100 } }] },
];

// ---- combat helpers (PvP semantics) ----
const roll = () => 1 - 0.15 + Math.random() * 0.30;
const phys = (a, d, m) => Math.max(1, Math.round(a * m - d * 0.5));
const mag = (a, d, m) => Math.max(1, Math.round(a * m - d * 0.5));

function bossStats(fl, pLevel, pClass, pStats) {
  if (fl.mirror) {
    return { hp: Math.floor(pStats.hp * (fl.hpMult || 1.5)), atk: pStats.atk, matk: pStats.matk, def: pStats.def, mdef: pStats.mdef, spd: pStats.spd };
  }
  const tuned = Math.floor(fl.rec * (fl.id <= 2 || fl.mirror ? 1.0 : REC_BIAS));
  const w = E.computeStats(tuned, 'warrior', {}, {});
  const m = E.computeStats(tuned, 'mage', {}, {});
  return { hp: Math.floor(w.hp * fl.hp), atk: Math.floor(w.atk * fl.atk), matk: Math.floor(m.matk * fl.matk), def: Math.floor(w.def * fl.def), mdef: Math.floor(m.mdef * fl.mdef), spd: fl.spd };
}

function simulate(fl, level, cls, gearType, fights) {
  const divine = gearType === 'divine';
  const gear = divine ? divineGear(cls, RDPS) : { u: {}, eq: EPIC[cls] };
  const pStats0 = E.computeStats(level, cls, gear.eq, divine ? gear.u : {});
  const passives = E.getPassives(gear.eq, divine ? gear.u : {});
  const clsDef = CLASSES[cls];
  let wins = 0; const turnDist = [];
  for (let f = 0; f < fights; f++) {
    const pStats = { ...pStats0 };
    const p = {
      hpMax: Math.floor(pStats.hp * HP_RATIO), hp: Math.floor(pStats.hp * HP_RATIO),
      cd: {}, buff: { atkPct: 0, turns: 0, dr: 0 }, burn: { dmg: 0, turns: 0 }, poison: { dmg: 0, turns: 0 },
      parry: 0, dodge: 0, eva: Math.min((clsDef.baseEvasion || 0) + (passives.evasion || 0), 48),
      cc: 0, antiHeal: 0,
    };
    const bS = bossStats(fl, level, cls, pStats0);
    const b = {
      hpMax: bS.hp, hp: bS.hp, cd: {}, atkMultStack: 1, shield: 0, phase: 1, stunned: false,
      burn: { dmg: 0, turns: 0 }, poison: { dmg: 0, turns: 0 }, healPct: 0,
      drones: [], adaptStack: 1,
      parry: 0, dodge: 0, buff: { atkPct: 0, turns: 0, dr: 0 },
      // MIRROR: copies ONE-THIRD of the player's passive values ("it learned from you — you keep the edge")
      mPassives: fl.mirror ? Object.fromEntries(Object.entries(passives).map(([k, v]) => [k, Math.floor(v / 3)])) : null,
    };
    const mirrorSkills = fl.mirror ? clsDef.skills.map(s => ({ n: s.name, m: s.mult, t: s.type, cd: s.cd || 0, burn: s.effect && s.effect.kind === 'burn' ? { pct: s.effect.pct, turns: s.effect.turns } : undefined, poison: s.effect && s.effect.kind === 'poison' ? { pct: s.effect.pct, turns: s.effect.turns } : undefined, parry: s.effect && s.effect.kind === 'parry' ? 1 : undefined, dodge: s.effect && s.effect.kind === 'dodge' ? 1 : undefined, buff: s.effect && s.effect.kind === 'buff' ? 1 : undefined })) : null;
    const skills = mirrorSkills || fl.skills;
    for (const sk of skills) if ((sk.cd || 0) >= 4) b.cd[sk.n] = Math.ceil(sk.cd / 2); // PvP ult gating: boss ults start at half-CD — no turn-1 nukes/stuns
    const playerFirst = pStats.spd >= bS.spd;
    let pi = 0, turns = 0, over = false;

    const healBoss = (pct) => { b.hp = Math.min(b.hpMax, b.hp + Math.floor(b.hpMax * pct)); };
    const playerHitBoss = (skill) => {
      const atkMult = p.buff.turns > 0 ? 1 + p.buff.atkPct / 100 : 1;
      if (p.buff.turns > 0) p.buff.turns--;
      let dmg;
      if (skill.t === 'magic') dmg = mag(pStats.matk * atkMult, bS.mdef, skill.m);
      else if (skill.t === 'mixed') dmg = Math.round((phys(pStats.atk * atkMult, bS.def, skill.m) + mag(pStats.matk * atkMult, bS.mdef, skill.m)) / 2);
      else { dmg = phys(pStats.atk * atkMult, bS.def, skill.m); if (fl.mech && fl.mech.frostAura) dmg = Math.round(dmg * (1 - fl.mech.frostAura.physReduction)); }
      if ((passives.berserker || 0) > 0) dmg = Math.round(dmg * (1 + passives.berserker / 100 * 0.7));
      const crit = (passives.precision || 0) > 0 && Math.random() * 100 < passives.precision;
      if (crit) dmg = Math.floor(dmg * 1.75);
      // MIRROR boss defense: copied parry > dodge charges > copied evasion > copied fortify/buff DR
      if (b.mPassives) {
        const pierceEvaP = !!skill.pierceEva;
        if (b.parry > 0) { dmg = Math.max(1, Math.round(dmg * 0.25)); b.parry -= 1; }
        else {
          if (b.dodge > 0) { b.dodge -= 1; if (!pierceEvaP) dmg = 0; }
          else if (!pierceEvaP && (b.mPassives.evasion || 0) > 0 && Math.random() * 100 < b.mPassives.evasion) dmg = 0;
          if (dmg > 0) {
            if (b.buff.turns > 0 && b.buff.dr > 0) dmg = Math.round(dmg * (1 - b.buff.dr / 100));
            if ((b.mPassives.fortify || 0) > 0) dmg = Math.round(dmg * (1 - b.mPassives.fortify / 100));
            if (dmg < 1) dmg = 1;
          }
        }
      }
      dmg = Math.round(dmg * SCALAR * roll());
      // MIRROR boss lifesteal (copied, half value) heals boss from damage taken? NO — from damage it DEALS (correct in bossAttack)
      if (b.shield > 0) { const absorbed = Math.min(b.shield, dmg); b.shield -= absorbed; dmg -= absorbed; }
      b.hp -= dmg;
      // player DoTs / self-effects on boss
      if (skill.burn) { b.burn.dmg = Math.round(pStats.matk * skill.burn.pct / 100); b.burn.turns = skill.burn.turns; }
      if (skill.poison) { b.poison.dmg = Math.round(pStats.atk * skill.poison.pct / 100); b.poison.turns = skill.poison.turns; }
      if (skill.parry) p.parry = 1;
      if (skill.dodge) p.dodge = 2;
      if (skill.buff) { p.buff = { atkPct: 25, turns: 2, dr: WARCRY_DR_CAP }; }
      // lifesteal (anti-heal aware)
      if (dmg > 0 && (passives.lifesteal || 0) > 0) {
        const ls = passives.lifesteal * (p.antiHeal > 0 ? (1 - 0.5) : 1); // 50% reduction from antiHeal stack
        const heal = Math.floor(dmg * ls / 100);
        p.hp = Math.min(p.hpMax, p.hp + heal);
      }
      // F5/F10P2 counter: player used a CD skill
      if (fl.mech && fl.mech.counter && skill.cd > 0 && Math.random() * 100 < fl.mech.counter.chance) bossAttack({ n: 'Counter', m: fl.mech.counter.mult, t: 'physical' });
      if (fl.mech && fl.mech.p2 && fl.mech.p2.counter && b.phase === 2 && skill.cd > 0 && Math.random() * 100 < fl.mech.p2.counter.chance) bossAttack({ n: 'Counter', m: fl.mech.p2.counter.mult, t: 'physical' });
    };
    const bossAttack = (skill) => {
      const buffMult = b.buff.turns > 0 ? 1 + b.buff.atkPct / 100 : 1;
      if (b.buff.turns > 0) b.buff.turns--;
      const stack = b.atkMultStack * buffMult * (fl.mech && fl.mech.p3 && b.phase === 3 ? fl.mech.p3.berserk.atk : 1);
      if (skill.parry) b.parry = 1;               // mirror self-effects actually WORK now
      if (skill.dodge) b.dodge = 2;
      if (skill.buff) b.buff = { atkPct: 25, turns: 2, dr: 15 };
      let dmg;
      const pierceEva = !!skill.pierceEva;
      if (skill.t === 'magic') dmg = mag(bS.matk * stack, pStats.mdef, skill.m);
      else if (skill.t === 'mixed') dmg = Math.round((phys(bS.atk * stack, pStats.def, skill.m) + mag(bS.matk * stack, pStats.mdef, skill.m)) / 2);
      else dmg = phys(bS.atk * stack, pStats.def, skill.m);
      let critDone = false;
      if (fl.crit > 0 && Math.random() < fl.crit) { dmg = Math.floor(dmg * (fl.critMult || 1.5)); critDone = true; }
      // MIRROR: copied berserker (dampened like player's) + copied precision as extra crit chance
      if (b.mPassives) {
        if ((b.mPassives.berserker || 0) > 0) dmg = Math.round(dmg * (1 + b.mPassives.berserker / 100 * 0.7));
        if (!critDone && (b.mPassives.precision || 0) > 0 && Math.random() * 100 < b.mPassives.precision) dmg = Math.floor(dmg * 1.75);
      }
      // player defense chain: parry > dodge charges > evasion > fortify/WarCry DR
      if (p.parry > 0) { dmg = Math.max(1, Math.round(dmg * 0.25)); p.parry -= 1; }
      else {
        if (p.dodge > 0) { p.dodge -= 1; if (!pierceEva) dmg = 0; }
        else if (!pierceEva && p.eva > 0 && Math.random() * 100 < p.eva) dmg = 0;
        if (dmg > 0) {
          if (p.buff.turns > 0 && p.buff.dr > 0) dmg = Math.round(dmg * (1 - p.buff.dr / 100));
          if ((passives.fortify || 0) > 0) dmg = Math.round(dmg * (1 - passives.fortify / 100));
          if (dmg < 1) dmg = 1;
        }
      }
      dmg = Math.round(dmg * SCALAR * roll());
      if (dmg > 0) {
        p.hp -= dmg;
        // P1 VAMPIRIC: boss heals from damage dealt (actual, post-defense/roll)
        if (fl.mech && fl.mech.p1 && fl.mech.p1.lifesteal && b.phase === 1) b.hp = Math.min(b.hpMax, b.hp + Math.floor(dmg * fl.mech.p1.lifesteal));
      }
      if (skill.cc && Math.random() * 100 < skill.cc.chance) p.cc = 1; // skip next player turn
      if (skill.burn) { p.burn.dmg = Math.round(bS.matk * skill.burn.pct / 100); p.burn.turns = skill.burn.turns; }
      if (skill.poison) { p.poison.dmg = Math.round(bS.atk * skill.poison.pct / 100); p.poison.turns = skill.poison.turns; }
      if (skill.antiHeal) p.antiHeal = skill.antiHeal.turns;
      if (skill.heal) healBoss(skill.heal);
    };
    const bossPickSkill = () => {
      const byCd = [...skills].sort((a, z) => (z.cd || 0) - (a.cd || 0)); // ult > s2 > basic
      for (const s of byCd) if ((s.cd || 0) === 0 || !(b.cd[s.n] > 0)) {
        if (s.cd) b.cd[s.n] = s.cd;
        return s;
      }
      return skills[0];
    };
    const tickBossCds = () => { for (const k of Object.keys(b.cd)) if (b.cd[k] > 0) b.cd[k]--; };

    let round = 0;
    while (!over && round < TURN_LIMIT) {
      round++;
      // --- mechanics ticks (start of boss's round action ordering, applied before boss acts) ---
      if (fl.mech) {
        if (fl.mech.shield && round % fl.mech.shield.every === 0) b.shield = Math.floor(b.hpMax * fl.mech.shield.pct);
        if (fl.mech.enrage && round % fl.mech.enrage.every === 0) b.atkMultStack += fl.mech.enrage.pct;
        if (fl.mech.regen && round % fl.mech.regen.every === 0) healBoss(fl.mech.regen.pct);
        if (fl.mech.darkAdapt && round % fl.mech.darkAdapt.every === 0) b.adaptStack += fl.mech.darkAdapt.pct;
        if (fl.mech.swarm && round % fl.mech.swarm.every === 0 && b.drones.length < fl.mech.swarm.max) b.drones.push({ ttl: fl.mech.swarm.droneTtl, atk: Math.floor(bS.atk * fl.mech.swarm.droneAtkPct) });
        if (fl.mech.p1 && b.phase === 1) {
          if (fl.mech.p1.shield && round % fl.mech.p1.shield.every === 0) b.shield = Math.floor(b.hpMax * fl.mech.p1.shield.pct);
          if (fl.mech.p1.enrage && round % fl.mech.p1.enrage.every === 0) b.atkMultStack += fl.mech.p1.enrage.pct;
        }
        if (fl.mech.p3 && fl.mech.p3.regen && b.phase === 3 && round % fl.mech.p3.regen.every === 0) healBoss(fl.mech.p3.regen.pct);
      }
      // phase transitions
      if (fl.mech && fl.mech.phaseShift && b.phase === 1 && b.hp <= b.hpMax * fl.mech.phaseShift.at) { b.phase = 2; const d = bS.def; bS.def = bS.mdef; bS.mdef = d; if (fl.mech.phaseShift.stun) p.cc = 1; }
      if (fl.mech && fl.mech.p1 && fl.mech.p2) {
        if (b.phase === 1 && b.hp <= b.hpMax * 0.6) b.phase = 2;
        else if (b.phase === 2 && b.hp <= b.hpMax * 0.3) { b.phase = 3; if (fl.mech.p3 && fl.mech.p3.antiHeal) p.antiHeal = 999; }
      }

      const playerAct = () => {
        // player DoTs tick at own turn start
        if (p.burn.turns > 0) { p.hp -= p.burn.dmg; p.burn.turns--; }
        if (p.poison.turns > 0) { p.hp -= p.poison.dmg; p.poison.turns--; }
        if (p.antiHeal > 0) p.antiHeal--;
        for (const k of Object.keys(p.cd)) if (p.cd[k] > 0) p.cd[k]--;
        if (p.hp <= 0) return;
        if (p.cc > 0) { p.cc = 0; return; } // stunned/rooted/frozen — skip
        const want = clsDef.skills[([0, 1, 0, 1, 2])[pi % 5]]; pi++;
        const skill = !(p.cd[want.id] > 0) ? want : clsDef.skills[0];
        if (skill.cd) p.cd[skill.id] = skill.cd;
        const sim = mirrorSkills
          ? (mirrorSkills[clsDef.skills.indexOf(skill)] || mirrorSkills[0])
          : null;
        playerHitBoss(sim || { n: skill.name, m: skill.mult, t: skill.type, cd: skill.cd || 0, burn: skill.effect && skill.effect.kind === 'burn' ? { pct: skill.effect.pct, turns: skill.effect.turns } : undefined, poison: skill.effect && skill.effect.kind === 'poison' ? { pct: skill.effect.pct, turns: skill.effect.turns } : undefined, parry: skill.effect && skill.effect.kind === 'parry' ? 1 : undefined, dodge: skill.effect && skill.effect.kind === 'dodge' ? 1 : undefined, buff: skill.effect && skill.effect.kind === 'buff' ? 1 : undefined, pierceEva: skill.effect && skill.effect.pierceEvasion });
      };
      const bossAct = () => {
        // boss DoTs (from player) tick at boss turn start
        if (b.burn.turns > 0) { b.hp -= b.burn.dmg; b.burn.turns--; }
        if (b.poison.turns > 0) { b.hp -= b.poison.dmg; b.poison.turns--; }
        tickBossCds();
        bossAttack(bossPickSkill());
        for (const d of b.drones) { const dd = Math.max(1, Math.round(d.atk * 1.0 - pStats.def * 0.5)); p.hp -= Math.round(dd * SCALAR * roll()); d.ttl--; }
        b.drones = b.drones.filter(d => d.ttl > 0);
      };

      if (playerFirst) { playerAct(); if (b.hp <= 0 || p.hp <= 0) { over = true; break; } bossAct(); if (b.hp <= 0 || p.hp <= 0) { over = true; break; } }
      else { bossAct(); if (b.hp <= 0 || p.hp <= 0) { over = true; break; } playerAct(); if (b.hp <= 0 || p.hp <= 0) { over = true; break; } }
    }
    turns = round;
    if (b.hp <= 0) { wins++; turnDist.push(round); }
  }
  return { wr: Math.round(wins / fights * 100), avgWinTurns: turnDist.length ? Math.round(turnDist.reduce((a, b2) => a + b2, 0) / turnDist.length) : 0 };
}

// ================= RUN =================
const FIGHTS = 400;
console.log('═'.repeat(96));
console.log('ABYSS TUNING — divine baseline (rec class + divine = target 70-90% WR)');
console.log('═'.repeat(96));
console.log('Floor  Boss                | recCls   @recDIV | @rec+10%DIV | wrongDIV | @recEPIC | @70%rec');
console.log('─'.repeat(96));
const altClass = { warrior: 'mage', mage: 'rogue', rogue: 'warrior' };
for (const fl of FLOORS) {
  const rc = fl.recClass || 'warrior';
  const alt = fl.recClass ? altClass[rc] : 'mage';
  const a = simulate(fl, fl.rec, rc, 'divine', FIGHTS);
  const b = simulate(fl, fl.rec, alt, 'divine', FIGHTS);
  const c = simulate(fl, fl.rec, rc, 'epic', FIGHTS);
  const d = simulate(fl, Math.floor(fl.rec * 1.1), rc, 'divine', FIGHTS);
  const e = simulate(fl, Math.floor(fl.rec * 0.7), rc, 'divine', FIGHTS);
  console.log(`F${String(fl.id).padStart(2)} ${fl.name.padEnd(19)} | ${(fl.recClass ? CLASSES[fl.recClass].emoji + ' ' + fl.recClass : 'any').padEnd(8)} | ${String(a.wr).padStart(3)}% t${String(a.avgWinTurns).padStart(2)} | ${String(d.wr).padStart(4)}% t${String(d.avgWinTurns).padStart(2)} | ${String(b.wr).padStart(4)}% | ${String(c.wr).padStart(4)}% | ${String(e.wr).padStart(3)}%`);
}
console.log('─'.repeat(96));
console.log('Contract v3.1 (aspirational rec): onboarding F1-2 @rec >=90 | others @rec 40-75, @rec+10% >=85 | 70%rec <=50')

// ================= PROGRESSION PROBE =================
console.log('\n═'.repeat(96));
console.log('PROGRESSION — divine @ 70% rec level (when does a floor "unlock" for the playerbase?)');
console.log('═'.repeat(96));
for (const fl of FLOORS) {
  const rc = fl.recClass || 'warrior';
  const lv = Math.max(30, Math.floor(fl.rec * 0.7));
  const r = simulate(fl, lv, rc, 'divine', 300);
  console.log(`F${String(fl.id).padStart(2)} ${fl.name.padEnd(19)} | Lv${String(lv).padStart(3)} divine ${rc.padEnd(7)} → ${String(r.wr).padStart(3)}% (t${r.avgWinTurns})`);
}
