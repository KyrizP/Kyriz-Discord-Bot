# Battle Mode v1 — Engine & Balance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Refinement (2026-08-08):** Drops are now **concrete catalog items with short code ids** (`d83`, not `rusty_sword`) — see spec §10b. ⇒ **Task 1:** add a `DROPS` catalog (items `{ id, name, rarity, value }`) alongside `DROP_RARITIES`. **Task 5:** `rollDrop(floor)` returns an **item id** (pick a rarity tier by weight, then a random item of that tier); `merchantPrice(itemId)` reads that item's value. The `DROP_RARITIES` tiers still drive the weights; items are instances of a tier. (Task 5's tests stay valid — assert by item rarity/value.)

**Goal:** Build the pure, unit-tested combat & economy engine for the Kryptonite battle mode (no Discord coupling) and prove it is balanced via simulation.

**Architecture:** Two new isolated modules — `utils/battleConfig.js` (data catalogs + self-check) and `utils/battleEngine.js` (pure functions: stat math, damage, auto-resolve, drops, enemies, merchant, balance sim). No edits to existing game/economy files. All logic is plain JS, testable with a no-framework harness (matching `test/crash.test.js`).

**Tech Stack:** Node.js (CommonJS), plain `node` test harness (no jest), discord.js v14 (only touched later in Plan 2).

## Global Constraints

- **Branch:** work on `master`. No branches.
- **Commits:** the user (`rizdevs`) handles ALL git commits. At each checkpoint, stage changes (`git add`) and pause for the user to commit — do NOT run `git commit`.
- **Isolation:** create only `utils/battleConfig.js`, `utils/battleEngine.js`, `test/battleEngine.test.js`. **Do NOT modify** `commands/game.js`, `utils/economyManager.js`, or any existing game logic in this plan.
- **Balance:** every magic number lives in `battleConfig.js` as a named constant (tunable). The sim test (Task 8) is the gate — numbers must pass it.
- **No placeholders:** all code below is complete and runnable.
- **Style:** match the repo — CommonJS (`module.exports`), 2-space indent, `const`/`let`, plain functions.

---

## File Structure

| File | Responsibility | Created in |
|---|---|---|
| `utils/battleConfig.js` | Static catalogs: classes, enemy growth, drop rarities, gear items, merchant base values. Data-driven + self-check. | Task 1 |
| `utils/battleEngine.js` | Pure combat/economy math: `computeStats`, `physicalDamage`, `magicDamage`, `resolveFight`, `generateEnemy`, `rollDrop`, `merchantPrice`, `simulateDelve`. | Tasks 2–8 |
| `test/battleEngine.test.js` | Unit + balance-sim tests (no-framework harness). | Tasks 2–8 |

Each task adds its own tests and implementation, then stages. Tasks 2–8 each append to the same two files.

---

### Task 1: `battleConfig.js` — catalogs + self-check

**Files:**
- Create: `utils/battleConfig.js`
- Test: `test/battleConfig.test.js` (tiny, self-check only)

**Interfaces:**
- Produces: `CLASSES` `{ warrior, mage }` each `{ name, emoji, base, growth, rotation }`; `DROP_RARITIES` array of `{ id, value:[lo,hi], weight }` (weight is a fn of floor); `GEAR` object of items; `ENEMY_BASE` growth params; `MERCHANT_FLAT` flag.

- [ ] **Step 1: Write the self-check test**

Create `test/battleConfig.test.js`:
```js
'use strict';
const C = require('../utils/battleConfig');
let pass = 0, fail = 0;
const ok = (cond, msg) => { cond ? pass++ : (fail++, console.log('  ❌ ' + msg)); };

ok(C.CLASSES.warrior && C.CLASSES.mage, 'both classes exist');
ok(C.CLASSES.warrior.base.hp > C.CLASSES.mage.base.hp, 'warrior tankier than mage');
for (const id of ['hp','atk','matk','def','mdef','spd']) {
  ok(typeof C.CLASSES.warrior.base[id] === 'number', 'warrior base.' + id);
  ok(typeof C.CLASSES.warrior.growth[id] === 'number', 'warrior growth.' + id);
}
ok(C.CLASSES.warrior.rotation.length >= 1, 'warrior has rotation');
ok(C.DROP_RARITIES.length === 6, '6 rarity tiers');
ok(C.DROP_RARITIES.find(r => r.id === 'divine'), 'divine tier exists');
ok(Object.keys(C.GEAR).length >= 5, 'at least 5 gear items');
ok(typeof C.ENEMY_BASE.scale === 'number', 'enemy scale defined');

console.log('\n' + (fail === 0 ? '✅ battleConfig OK' : '❌ FAIL'));
console.log('Pass: ' + pass + ' | Fail: ' + fail);
process.exit(fail === 0 ? 0 : 1);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/battleConfig.test.js`
Expected: FAIL — cannot find module `../utils/battleConfig`.

- [ ] **Step 3: Write `battleConfig.js`**

Create `utils/battleConfig.js`:
```js
'use strict';

// ============================================================
// CLASSES — base stats at lvl 1 + per-level growth + PvE auto rotation
// rotation: each entry { id, mult (skillMult), type: 'physical'|'magic' }
// ============================================================
const CLASSES = {
  warrior: {
    name: 'Warrior',
    emoji: '⚔️',
    base:   { hp: 100, atk: 12, matk: 4,  def: 10, mdef: 5,  spd: 6 },
    growth: { hp: 20,  atk: 2.5, matk: 0.8, def: 2.0, mdef: 1.0, spd: 0.5 },
    rotation: [
      { id: 'slash', mult: 1.0, type: 'physical' },
      { id: 'heavy', mult: 1.6, type: 'physical' },
    ],
  },
  mage: {
    name: 'Mage',
    emoji: '🔮',
    base:   { hp: 70,  atk: 4,  matk: 14, def: 5,  mdef: 9,  spd: 7 },
    growth: { hp: 12,  atk: 0.8, matk: 2.8, def: 1.0, mdef: 1.8, spd: 0.6 },
    rotation: [
      { id: 'bolt',     mult: 1.0, type: 'magic' },
      { id: 'fireball', mult: 1.7, type: 'magic' },
    ],
  },
};

// ============================================================
// ENEMY GROWTH — exponential per floor. scale = ENEMY_BASE.scale^(floor-1)
// ============================================================
const ENEMY_BASE = {
  scale: 1.12,         // +12%/floor (tunable — sim-proven in Task 8)
  hp: 40, atk: 8, matk: 6, def: 5, mdef: 4, spd: 4,
};

// ============================================================
// DROP RARITIES — value:[lo,hi] Kryptonite sell range; weight: fn(floor) (%-ish)
// Divine only appears floor 20+, ultra-rare. Rare+ scale up with depth (capped).
// ============================================================
const DROP_RARITIES = [
  { id: 'common',    value: [2, 5],     weight: () => 70 },
  { id: 'uncommon',  value: [6, 15],    weight: () => 20 },
  { id: 'rare',      value: [20, 40],   weight: (f) => Math.min(8,   2 + f * 0.12) },
  { id: 'epic',      value: [50, 90],   weight: (f) => Math.min(5,   0.5 + f * 0.05) },
  { id: 'legendary', value: [120, 200], weight: (f) => Math.min(1.5, 0.1 + f * 0.015) },
  { id: 'divine',    value: [300, 500], weight: (f) => (f < 20 ? 0 : Math.min(0.05, (f - 20) * 0.001)) },
];

// ============================================================
// GEAR — starter items. stats are flat bonuses. slot ∈ weapon/head/armor/boots/accessory
// More items can be appended; shape stays the same.
// ============================================================
const GEAR = {
  rusty_sword:    { id: 'rusty_sword',    name: 'Rusty Sword',    slot: 'weapon',    rarity: 'common',    stats: { atk: 3 } },
  oak_staff:      { id: 'oak_staff',      name: 'Oak Staff',      slot: 'weapon',    rarity: 'common',    stats: { matk: 4 } },
  leather_cap:    { id: 'leather_cap',    name: 'Leather Cap',    slot: 'head',      rarity: 'common',    stats: { def: 2, hp: 10 } },
  iron_armor:     { id: 'iron_armor',     name: 'Iron Armor',     slot: 'armor',     rarity: 'uncommon',  stats: { def: 6, hp: 30 } },
  swift_boots:    { id: 'swift_boots',    name: 'Swift Boots',    slot: 'boots',     rarity: 'uncommon',  stats: { spd: 3 } },
  power_ring:     { id: 'power_ring',     name: 'Power Ring',     slot: 'accessory', rarity: 'rare',      stats: { atk: 5, spd: 1 } },
  arc_ame:        { id: 'arc_ame',        name: 'Arcane Amulet',  slot: 'accessory', rarity: 'rare',      stats: { matk: 6, mdef: 3 } },
};

// v1 merchant uses flat mid-range prices (v2 adds daily variance via day seed)
const MERCHANT_FLAT = true;

module.exports = { CLASSES, ENEMY_BASE, DROP_RARITIES, GEAR, MERCHANT_FLAT };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/battleConfig.test.js`
Expected: `✅ battleConfig OK` / Pass: 14 | Fail: 0 (count may vary).

- [ ] **Step 5: Checkpoint (user commits)**

```bash
git add utils/battleConfig.js test/battleConfig.test.js
```
Summarize for the user: "Task 1 done — battleConfig catalogs + self-check. Stage & commit when ready."

---

### Task 2: `computeStats(charLevel, charClass, equipment)`

**Files:**
- Modify: `utils/battleEngine.js` (create), `test/battleEngine.test.js` (create)

**Interfaces:**
- Consumes: `CLASSES`, `GEAR` from `battleConfig`.
- Produces: `computeStats(charLevel, charClass, equipment = {})` → `{ hp, atk, matk, def, mdef, spd }` (all integers). `base(level-1) + growth(level-1) + gear bonuses`.

- [ ] **Step 1: Write the failing test**

Create `test/battleEngine.test.js`:
```js
'use strict';
const E = require('../utils/battleEngine');
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : (fail++, console.log('  ❌ ' + m)); };

// computeStats
let s = E.computeStats(1, 'warrior', {});
ok(s.hp === 100 && s.atk === 12 && s.spd === 6, 'warrior lvl1 base exact');
let s10 = E.computeStats(10, 'warrior', {});
// hp = 100 + 20*9 = 280 ; atk = 12 + 2.5*9 = 34.5 -> 35 (rounded) ; spd = 6 + 0.5*9 = 10.5 -> 11
ok(s10.hp === 280, 'warrior lvl10 hp = 280');
ok(s10.atk === 35, 'warrior lvl10 atk = 35 (rounded)');
ok(s10.hp > E.computeStats(10, 'mage', {}).hp, 'warrior tankier than mage at same lvl');
let withGear = E.computeStats(1, 'warrior', { weapon: 'rusty_sword' });
ok(withGear.atk === 15, 'gear adds atk: 12 + 3 = 15');
ok(E.computeStats(1, 'mage', {}).matk === 14, 'mage lvl1 matk = 14');

console.log('\n[computeStats] ' + (fail ? '❌ FAIL' : '✅ PASS') + ' (pass ' + pass + ')');
module.exports = { pass, fail }; // re-used by later appended tests
if (fail) process.exit(1);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/battleEngine.test.js`
Expected: FAIL — cannot find module `../utils/battleEngine`.

- [ ] **Step 3: Write minimal implementation**

Create `utils/battleEngine.js`:
```js
'use strict';
const { CLASSES, GEAR } = require('./battleConfig');

const STAT_KEYS = ['hp', 'atk', 'matk', 'def', 'mdef', 'spd'];
const EQUIP_SLOTS = ['weapon', 'head', 'armor', 'boots', 'accessory'];

function computeStats(charLevel, charClass, equipment = {}) {
  const c = CLASSES[charClass];
  if (!c) throw new Error('Unknown class: ' + charClass);
  const lvl = Math.max(1, Math.floor(charLevel));
  const stats = {};
  for (const k of STAT_KEYS) {
    const raw = c.base[k] + c.growth[k] * (lvl - 1);
    stats[k] = Math.round(raw);
  }
  for (const slot of EQUIP_SLOTS) {
    const item = equipment[slot] ? GEAR[equipment[slot]] : null;
    if (item && item.stats) {
      for (const k of Object.keys(item.stats)) {
        if (STAT_KEYS.includes(k)) stats[k] += item.stats[k];
      }
    }
  }
  return stats;
}

module.exports = { computeStats, STAT_KEYS, EQUIP_SLOTS };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/battleEngine.test.js`
Expected: `[computeStats] ✅ PASS`.

- [ ] **Step 5: Checkpoint (user commits)**

```bash
git add utils/battleEngine.js test/battleEngine.test.js
```

---

### Task 3: Damage formula — `physicalDamage` / `magicDamage`

**Files:**
- Modify: `utils/battleEngine.js`, `test/battleEngine.test.js`

**Interfaces:**
- Produces: `physicalDamage(atk, def, mult)` → int ≥ 1 ; `magicDamage(matk, mdef, mult)` → int ≥ 1.

- [ ] **Step 1: Write the failing test** (append before the final `console.log`/exit in `battleEngine.test.js`)

```js
ok(E.physicalDamage(40, 20, 1.0) === 30, 'phys 40*1 - 20*0.5 = 30');
ok(E.physicalDamage(10, 100, 1.0) === 1, 'high def floored to 1 chip');
ok(E.magicDamage(30, 10, 1.7) === Math.round(30*1.7 - 5), 'magic with mult 1.7');
ok(E.physicalDamage(50, 0, 2.5) === 125, 'no def = full dmg');
ok(E.magicDamage(5, 5, 1.0) === Math.max(1, Math.round(5 - 2.5)), 'small values floor-safe');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/battleEngine.test.js`
Expected: FAIL — `E.physicalDamage is not a function`.

- [ ] **Step 3: Write minimal implementation** (append inside `battleEngine.js` before `module.exports`)

```js
function physicalDamage(atk, def, mult) {
  return Math.max(1, Math.round(atk * mult - def * 0.5));
}
function magicDamage(matk, mdef, mult) {
  return Math.max(1, Math.round(matk * mult - mdef * 0.5));
}
```
Update the export line:
```js
module.exports = { computeStats, physicalDamage, magicDamage, STAT_KEYS, EQUIP_SLOTS };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/battleEngine.test.js`
Expected: PASS (all assertions).

- [ ] **Step 5: Checkpoint (user commits)** — `git add utils/battleEngine.js test/battleEngine.test.js`

---

### Task 4: `generateEnemy(floor)` + `resolveFight(player, enemy)`

**Files:**
- Modify: `utils/battleEngine.js`, `test/battleEngine.test.js`

**Interfaces:**
- Consumes: `ENEMY_BASE` from `battleConfig`; `physicalDamage`/`magicDamage`.
- Produces:
  - `generateEnemy(floor)` → `{ floor, hp, atk, matk, def, mdef, spd, rotation }` (rotation = `[{ mult:1.0, type: <dominant> }]`).
  - `resolveFight(playerStats, playerRotation, enemy)` → `{ winner:'player'|'enemy', rounds, playerHpLeft, enemyHpLeft }`. Turn order by SPD (player wins ties). HP **persists** (callers track `playerHpLeft` across floors). Round cap = 30; stalemate ⇒ enemy wins. Damage uses the attacker's rotation skills in order.

- [ ] **Step 1: Write the failing test** (append)

```js
// generateEnemy scales
const e1 = E.generateEnemy(1);
ok(e1.hp === 40 && e1.atk === 8, 'enemy floor1 base');
const e20 = E.generateEnemy(20);
ok(e20.hp > e1.hp * 3 && e20.atk > e1.atk * 3, 'enemy scales hard by floor 20');
ok(e20.rotation.length === 1 && ['physical','magic'].includes(e20.rotation[0].type), 'enemy has a rotation');

// resolveFight — stronger player wins, full hp carried in/out via playerStats copy
let p = E.computeStats(15, 'warrior', {});
const weak = E.generateEnemy(1);
let r = E.resolveFight({ ...p }, p.rotation || require('./../utils/battleConfig').CLASSES.warrior.rotation, weak);
ok(r.winner === 'player', 'strong player beats weak enemy');
ok(r.enemyHpLeft === 0, 'enemy hp depleted');

// player loses to overwhelming enemy
const huge = E.generateEnemy(60);
let r2 = E.resolveFight(E.computeStats(1, 'mage', {}), require('./../utils/battleConfig').CLASSES.mage.rotation, huge);
ok(r2.winner === 'enemy', 'weak mage loses to floor60 enemy');

// SPD order: give player huge spd, enemy should take hits first (player still wins fast)
ok(typeof E.resolveFight(E.computeStats(20,'warrior',{}), require('./../utils/battleConfig').CLASSES.warrior.rotation, E.generateEnemy(5)).rounds === 'number', 'resolve returns rounds');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/battleEngine.test.js`
Expected: FAIL — `E.generateEnemy is not a function`.

- [ ] **Step 3: Write minimal implementation** (append before `module.exports`; add `ENEMY_BASE` to the require)

Update top require: `const { CLASSES, GEAR, ENEMY_BASE } = require('./battleConfig');`
```js
function generateEnemy(floor) {
  const f = Math.max(1, Math.floor(floor));
  const k = Math.pow(ENEMY_BASE.scale, f - 1);
  const atk = Math.round(ENEMY_BASE.atk * k);
  const matk = Math.round(ENEMY_BASE.matk * k);
  const type = atk >= matk ? 'physical' : 'magic';
  return {
    floor: f,
    hp: Math.round(ENEMY_BASE.hp * k),
    atk, matk,
    def: Math.round(ENEMY_BASE.def * k),
    mdef: Math.round(ENEMY_BASE.mdef * k),
    spd: Math.round(ENEMY_BASE.spd * k),
    rotation: [{ mult: 1.0, type }],
  };
}

function _dmg(attacker, defender, skill) {
  return skill.type === 'magic'
    ? magicDamage(attacker.matk, defender.mdef, skill.mult)
    : physicalDamage(attacker.atk, defender.def, skill.mult);
}

const MAX_ROUNDS = 30;

function resolveFight(playerStats, playerRotation, enemy) {
  const rot = (playerRotation && playerRotation.length) ? playerRotation : [{ mult: 1.0, type: playerStats.atk >= playerStats.matk ? 'physical' : 'magic' }];
  let php = playerStats.hp;
  let ehp = enemy.hp;
  const playerFirst = playerStats.spd >= enemy.spd; // ties -> player
  let rounds = 0;
  let pi = 0, ei = 0;
  while (php > 0 && ehp > 0 && rounds < MAX_ROUNDS) {
    rounds++;
    if (playerFirst) {
      ehp -= _dmg(playerStats, enemy, rot[pi % rot.length]); pi++;
      if (ehp <= 0) break;
      php -= _dmg(enemy, playerStats, enemy.rotation[ei % enemy.rotation.length]); ei++;
    } else {
      php -= _dmg(enemy, playerStats, enemy.rotation[ei % enemy.rotation.length]); ei++;
      if (php <= 0) break;
      ehp -= _dmg(playerStats, enemy, rot[pi % rot.length]); pi++;
    }
  }
  const playerDead = php <= 0;
  const enemyDead = ehp <= 0;
  let winner;
  if (playerDead && enemyDead) winner = playerFirst ? 'player' : 'enemy'; // whoever struck last
  else if (enemyDead) winner = 'player';
  else if (playerDead) winner = 'enemy';
  else winner = 'enemy'; // stalemate (round cap) -> enemy overwhelms (forces offense)
  return { winner, rounds, playerHpLeft: Math.max(0, php), enemyHpLeft: Math.max(0, ehp) };
}
```
Update exports:
```js
module.exports = { computeStats, physicalDamage, magicDamage, generateEnemy, resolveFight, STAT_KEYS, EQUIP_SLOTS };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/battleEngine.test.js`
Expected: PASS.

- [ ] **Step 5: Checkpoint (user commits)** — `git add utils/battleEngine.js test/battleEngine.test.js`

---

### Task 5: `rollDrop(floor)` — depth-scaled rarity, Divine ultra-rare

**Files:**
- Modify: `utils/battleEngine.js`, `test/battleEngine.test.js`

**Interfaces:**
- Consumes: `DROP_RARITIES` from `battleConfig`.
- Produces: `rollDrop(floor)` → `{ rarity, value }` (value = random int in the rarity's `[lo,hi]` Kryptonite range), picked by weighted rarity where weights come from each tier's `weight(floor)`.

- [ ] **Step 1: Write the failing test** (append)

```js
// rollDrop distribution
let d = E.rollDrop(5);
ok(['common','uncommon','rare','epic','legendary','divine'].includes(d.rarity), 'valid rarity');
ok(d.value >= 2, 'value positive');
// divine impossible before floor 20
let divineLow = 0;
for (let i = 0; i < 5000; i++) if (E.rollDrop(10).rarity === 'divine') divineLow++;
ok(divineLow === 0, 'no divine below floor 20');
// deeper floors skew rarer: count rare+ at floor 5 vs floor 40
function rarePlus(floor, n) { let c = 0; for (let i = 0; i < n; i++) { const r = E.rollDrop(floor).rarity; if (['rare','epic','legendary','divine'].includes(r)) c++; } return c; }
ok(rarePlus(40, 3000) > rarePlus(5, 3000), 'deeper floor -> more rare+ drops');
// value within its rarity range
const R = require('./../utils/battleConfig').DROP_RARITIES;
for (let i = 0; i < 1000; i++) { const x = E.rollDrop(30); const tier = R.find(t => t.id === x.rarity); ok(x.value >= tier.value[0] && x.value <= tier.value[1], 'value in range ' + x.rarity); }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/battleEngine.test.js`
Expected: FAIL — `E.rollDrop is not a function`.

- [ ] **Step 3: Write minimal implementation**

```js
function _weightedPick(floor) {
  const weights = DROP_RARITIES.map(r => Math.max(0, r.weight(floor)));
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = Math.random() * total;
  for (let i = 0; i < weights.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return DROP_RARITIES[i];
  }
  return DROP_RARITIES[0];
}

function rollDrop(floor) {
  const tier = _weightedPick(floor);
  const value = Math.floor(Math.random() * (tier.value[1] - tier.value[0] + 1)) + tier.value[0];
  return { rarity: tier.id, value };
}
```
Add `DROP_RARITIES` to the top require; add `rollDrop, _weightedPick` to exports.

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/battleEngine.test.js`
Expected: PASS.

- [ ] **Step 5: Checkpoint (user commits)** — `git add utils/battleEngine.js test/battleEngine.test.js`

---

### Task 6: `merchantPrice(drop)` (v1 flat)

**Files:**
- Modify: `utils/battleEngine.js`, `test/battleEngine.test.js`

**Interfaces:**
- Produces: `merchantPrice(drop)` → int Kryptonite. v1 = mid of the drop's tier value range (`(lo+hi)/2`). Structured so v2 can swap in daily variance without changing call sites.

- [ ] **Step 1: Write the failing test** (append)

```js
ok(E.merchantPrice({ rarity: 'common', value: 3 }) > 0, 'common sells > 0');
ok(E.merchantPrice({ rarity: 'divine', value: 400 }) > E.merchantPrice({ rarity: 'common', value: 3 }) * 50, 'divine >> common');
const midCommon = Math.round((2 + 5) / 2);
ok(E.merchantPrice({ rarity: 'common', value: 3 }) === midCommon, 'v1 flat = mid range (independent of rolled value)');
```

- [ ] **Step 2: Run test to verify it fails** — `node test/battleEngine.test.js` → FAIL (not a function).

- [ ] **Step 3: Write minimal implementation**

```js
function merchantPrice(drop) {
  const tier = DROP_RARITIES.find(r => r.id === drop.rarity) || DROP_RARITIES[0];
  return Math.round((tier.value[0] + tier.value[1]) / 2); // v1 flat mid; v2: vary by day seed
}
```
Add `merchantPrice` to exports.

- [ ] **Step 4: Run test to verify it passes** — PASS.

- [ ] **Step 5: Checkpoint (user commits)** — `git add utils/battleEngine.js test/battleEngine.test.js`

---

### Task 7: Wire the full test summary

**Files:**
- Modify: `test/battleEngine.test.js`

- [ ] **Step 1: Replace the tail** of `battleEngine.test.js` so it prints a single consolidated summary and exits non-zero on any failure. Replace the existing tail block (`console.log('\n[computeStats]...` onward) with:
```js
console.log('\n' + (fail === 0 ? '✅ SEMUA TEST LULUS' : '❌ ADA TEST GAGAL'));
console.log('Pass: ' + pass + ' | Fail: ' + fail);
process.exit(fail === 0 ? 0 : 1);
```
(Remove the `module.exports` line added in Task 2 — it is no longer needed.)

- [ ] **Step 2: Run the full suite** — `node test/battleEngine.test.js` → expect `✅ SEMUA TEST LULUS`.

- [ ] **Step 3: Add npm script.** In `package.json`, change the `scripts.test` line to run both suites:
```json
"test": "node test/crash.test.js && node test/battleConfig.test.js && node test/battleEngine.test.js"
```
Run `npm test` → expect all three pass.

- [ ] **Step 4: Checkpoint (user commits)** — `git add test/battleEngine.test.js package.json`

---

### Task 8: Balance sim — `simulateDelve` + the anti-exploit / pacing gate

**Files:**
- Modify: `utils/battleEngine.js`, `test/battleEngine.test.js`

**Interfaces:**
- Produces: `simulateDelve(charLevel, charClass, equipment, opts)` → `{ deathFloor, floorsCleared, kryptonitePotential, dropsByRarity }`. Player starts at full HP; HP **persists** across floors (no heal in v1); each floor = `generateEnemy` + `resolveFight`; on loss the run ends and that floor's drop is **not** collected (unbanked = lost, per the death mechanic); collected drops feed `kryptonitePotential = sum(merchantPrice)`.
  - `opts.maxFloors` default 100 (safety cap).

- [ ] **Step 1: Write the failing test** (append) — this is the balance gate

```js
// simulateDelve — balance & anti-exploit gate
function avgKry(level, cls, n) {
  let sum = 0, deathFloorSum = 0;
  for (let i = 0; i < n; i++) {
    const r = E.simulateDelve(level, cls, {}, { maxFloors: 100 });
    sum += r.kryptonitePotential;
    deathFloorSum += r.deathFloor;
  }
  return { kry: sum / n, df: deathFloorSum / n };
}

// (a) stronger char delves deeper + earns more
const weak = avgKry(1, 'warrior', 2000);
const strong = avgKry(20, 'warrior', 2000);
ok(strong.df > weak.df * 2, 'lvl20 reaches ~2x+ depth of lvl1');
ok(strong.kry > weak.kry, 'lvl20 earns more Kryptonite');

// (b) yield bounded — no runaway (lvl20 avg Kryptonite/run within sane band)
ok(strong.kry < 4000, 'lvl20 avg Kryptonite/run bounded (< 4000)');

// (c) Divine ultra-rare over many deep runs
let divineCount = 0, totalDrops = 0;
for (let i = 0; i < 2000; i++) {
  const r = E.simulateDelve(20, 'mage', {}, { maxFloors: 100 });
  divineCount += r.dropsByRarity.divine || 0;
  for (const k of Object.keys(r.dropsByRarity)) totalDrops += r.dropsByRarity[k];
}
ok(totalDrops > 0, 'drops actually happen');
const divineRate = divineCount / totalDrops;
ok(divineRate < 0.005, 'divine drop rate < 0.5% (ultra-rare), got ' + divineRate.toFixed(4));

// (d) no infinite run — every run terminates (deathFloor <= maxFloors)
let maxReached = 0;
for (let i = 0; i < 500; i++) maxReached = Math.max(maxReached, E.simulateDelve(15, 'warrior', {}).deathFloor);
ok(maxReached <= 100, 'no run exceeds maxFloors (terminates)');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/battleEngine.test.js`
Expected: FAIL — `E.simulateDelve is not a function`.

- [ ] **Step 3: Write minimal implementation**

```js
function simulateDelve(charLevel, charClass, equipment, opts = {}) {
  const maxFloors = opts.maxFloors || 100;
  const stats = computeStats(charLevel, charClass, equipment);
  const cls = CLASSES[charClass];
  let php = stats.hp;
  let deathFloor = 0;
  let floorsCleared = 0;
  let kryptonitePotential = 0;
  const dropsByRarity = {};

  for (let floor = 1; floor <= maxFloors; floor++) {
    if (php <= 0) { deathFloor = floor - 1; break; }
    const enemy = generateEnemy(floor);
    const result = resolveFight({ ...stats, hp: php }, cls.rotation, enemy);
    if (result.winner === 'player') {
      floorsCleared = floor;
      php = result.playerHpLeft; // HP persists (no heal v1)
      const drop = rollDrop(floor);
      kryptonitePotential += merchantPrice(drop);
      dropsByRarity[drop.rarity] = (dropsByRarity[drop.rarity] || 0) + 1;
    } else {
      // died on this floor — this floor's drop is unbanked (lost), run ends
      deathFloor = floor;
      php = 0;
      break;
    }
  }
  if (deathFloor === 0) deathFloor = maxFloors; // survived to cap
  return { deathFloor, floorsCleared, kryptonitePotential, dropsByRarity };
}
```
Add `simulateDelve` to exports.

- [ ] **Step 4: Run the full suite + tune if needed**

Run: `node test/battleEngine.test.js`
Expected: `✅ SEMUA TEST LULUS`.

**If the balance gate fails** (e.g., `lvl20 avg Kryptonite/run bounded` or `2x+ depth`), do NOT relax the test — tune the constants in `utils/battleConfig.js` (`ENEMY_BASE.scale`, class `growth`, or `DROP_RARITIES` weights) until the sim passes. This is the "sim-test before live" gate from the spec (§15/§16). Re-run until green.

- [ ] **Step 5: Checkpoint (user commits)** — `git add utils/battleEngine.js test/battleEngine.test.js`

---

## Self-Review (run after writing)

**1. Spec coverage (Plan 1 scope = engine + balance):**
- §3 dual-currency one-way → N/A here (currency plumbing is Plan 2); engine only deals in `kryptonitePotential` (drops→merchant value). ✓ covered by `merchantPrice`/`simulateDelve`.
- §6 loot rarity + Divine ultra-rare + depth scaling → Task 5, validated Task 8. ✓
- §7 damage formula + SPD turn order + auto-resolve + symmetric → Tasks 3–4. ✓
- §8 6 stats + base from char level + class → Task 2. ✓
- §9 Warrior/Mage classes → Task 1. ✓
- §10 gear (5 slots, stat bonuses) → Task 1 (GEAR) + Task 2 (equip). ✓
- §15/§16 balance sim + numbers tuned → Task 8 (the gate). ✓
- §12 module structure (battleConfig + battleEngine, pure, testable) → Tasks 1–8. ✓
- §13 isolation (no edits to existing files) → respected; only new files + `package.json` test script. ✓

**2. Placeholder scan:** none. All code blocks are complete and runnable. Starter GEAR/drop data is intentionally tunable (named constants), not a TODO.

**3. Type/name consistency:** `computeStats`, `physicalDamage`, `magicDamage`, `generateEnemy`, `resolveFight`, `rollDrop`, `merchantPrice`, `simulateDelve` — names match across tasks and exports. `DROP_RARITIES`/`CLASSES`/`GEAR`/`ENEMY_BASE` consistent between config and engine. `rotation` shape `{mult, type}` consistent in classes and enemies.

**Gap:** none for Plan 1 scope. (PvP, sweep, stateful run lifecycle, commands, economy.json persistence → Plan 2.)

---

## Plan 2 (next, after Plan 1 is green) — preview

`utils/battleManager.js` (run lifecycle: entry fee via `removeBalance`, sweep, live floors, extract/death, char level/exp, equip, merchant sell → atomic Kryptonite via `readEconomy`/`writeEconomy`) + `/kyriz battle|character|bag|sell|equip` subcommands & `ky` prefix aliases wired additively into `commands/game.js`. Additive economy.json fields (§11). Discord-coupled → manual test.
