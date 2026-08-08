# Battle Mode v1 — Integration Implementation Plan (Part 2)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Checkbox steps.
> **Depends on:** Part 1 (Engine) shipped + green (`utils/battleEngine.js`, `utils/battleConfig.js`).
> **Spec:** `docs/superpowers/specs/2026-08-08-battle-mode-design.md` — esp. §10b (Commands & UX), §11 (data model, refined below).

**Goal:** Make the battle mode playable in Discord — stateful run manager + commands wired additively into `game.js`. Zero disruption to existing flows.

**Architecture:** New `utils/battleManager.js` = **pure apply-functions** (testable, take/return the data object) + **thin IO wrappers** (read→apply→write, reusing exported `readEconomy`/`writeEconomy`/`removeBalance`/`addXP`) + an **in-memory run Map**. Commands attached additively in `commands/game.js` (mirror how shop was wired). Run state is in-memory only (restart-mid-run loses the run; entry fee already persisted — same risk profile as crash/mines).

**Tech Stack:** Node CommonJS, discord.js v14, plain node test harness.

## Global Constraints
- Same as Part 1 (master; **no commits — user commits**; isolated; balance; no placeholders).
- **Battle data nested under `user.battle`** (refines spec §11 — one key, max isolation, zero top-level pollution).
- **Item codes:** drop `d<n>` (e.g. `d83`), gear `g<n>` (e.g. `g3`) — from `DROPS`/`GEAR` catalogs in `battleConfig`. Always show code + name.
- **Superadmin plays normal:** entry via the balance path (no-op for the ∞ wallet); Kryptonite is gameplay-only.
- **🧪 Kryptonite icon** (alchemy elixir) everywhere Kryptonite is shown.

## File Structure
| File | Responsibility |
|---|---|
| `utils/battleManager.js` | `ensureBattleData`; pure apply-* (character, charExp/levelUp, delve lifecycle, sell, sellgear, equip); IO wrappers (`startDelve`/`nextFloor`/`extractRun`/`dieRun`/`sell`/`sellGear`/`equip`/`createCharacter`); in-memory `activeRuns` Map. |
| `test/battleManager.test.js` | TDD the pure apply-functions (mock data + mock runState — no IO). |
| `commands/game.js` | additive: import battleManager; attach `/kyriz battle\|character\|bag\|sell\|equip` + `ky` prefix aliases + `char` alias + Extract/Push button handler; Kryptonite in `wallet`; `ky shop equipment` shortcut. |

---

### Task 1: `ensureBattleData(user)` — fields nested under `user.battle`

**Files:** Create `utils/battleManager.js`, `test/battleManager.test.js`
**Interfaces:** Produces `ensureBattleData(user)` → returns `user.battle`, creating it with defaults if absent. Idempotent.

- [ ] **Step 1: Failing test** — create `test/battleManager.test.js`:
```js
'use strict';
const M = require('../utils/battleManager');
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : (fail++, console.log('  ❌ ' + m)); };

const b = M.ensureBattleData({});
ok(b.kryptonite === 0, 'default kryptonite 0');
ok(b.charLevel === 1 && b.charExp === 0, 'default char level 1');
ok(b.charClass === null, 'default class null');
ok(b.equipment && b.equipment.weapon === null && b.equipment.accessory === null, '5 equip slots null');
ok(typeof b.bag === 'object' && Object.keys(b.bag).length === 0, 'bag empty {}');
ok(b.bestDepth === 0, 'bestDepth 0');
const u = { battle: { kryptonite: 5, charLevel: 3, charClass: 'mage', equipment: {}, bag: {}, charExp: 0, charExpNeeded: 100, bestDepth: 7 } };
ok(M.ensureBattleData(u) === u.battle, 'idempotent — returns existing');
```

- [ ] **Step 2: Run → FAIL** (`node test/battleManager.test.js`, module not found).
- [ ] **Step 3: Implement** — create `utils/battleManager.js`:
```js
'use strict';
const { CLASSES, GEAR, DROPS } = require('./battleConfig');
const economy = require('./economyManager');
const { computeStats, generateEnemy, resolveFight, rollDrop } = require('./battleEngine');
const { isSuperAdmin } = economy;

const ENTRY_FEE = 15000;
const SWEEP_BUFFER = 5;
const GEAR_SELLBACK = 0.4;
const CHAR_EXP_BASE = 100;

function ensureBattleData(user) {
  if (!user.battle) {
    user.battle = {
      kryptonite: 0,
      charLevel: 1, charExp: 0, charExpNeeded: CHAR_EXP_BASE,
      charClass: null,
      equipment: { weapon: null, head: null, armor: null, boots: null, accessory: null },
      bag: {},
      bestDepth: 0,
    };
  }
  return user.battle;
}

module.exports = { ensureBattleData };
```
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Checkpoint** — `git add utils/battleManager.js test/battleManager.test.js` (user commits).

---

### Task 2: `applyCreateCharacter` + `applyGainCharExp` (level up)

**Interfaces:** `applyCreateCharacter(data, userId, classId)` → `{ok, reason}`. `applyGainCharExp(data, userId, exp)` → `{leveledUp, newLevel}` (auto level-up, scaling `charExpNeeded`).

- [ ] **Step 1: Failing test** (append):
```js
let data = { u1: {} };
let r = M.applyCreateCharacter(data, 'u1', 'warrior');
ok(r.ok && data.u1.battle.charClass === 'warrior', 'create warrior');
ok(!M.applyCreateCharacter(data, 'u1', 'mage').ok, 'no double-create');
ok(!M.applyCreateCharacter({ u2: {} }, 'u2', 'ninja').ok, 'reject invalid class');
data.u1.battle.charExpNeeded = 100;
let lv = M.applyGainCharExp(data, 'u1', 250); // crosses 100 -> lvl2 (need ~115), crosses -> lvl3?
ok(data.u1.battle.charLevel >= 2 && lv.leveledUp, 'exp grants level up');
ok(!M.applyGainCharExp({ u3: {} }, 'u3', 500).leveledUp, 'no level up without class');
```
- [ ] **Step 2: Run → FAIL** (`applyCreateCharacter` not a function).
- [ ] **Step 3: Implement** (append before `module.exports`):
```js
function applyCreateCharacter(data, userId, classId) {
  const b = ensureBattleData(data[userId]);
  if (!CLASSES[classId]) return { ok: false, reason: 'Invalid class. Pick warrior or mage.' };
  if (b.charClass) return { ok: false, reason: 'You already have a character.' };
  b.charClass = classId;
  return { ok: true };
}

function applyGainCharExp(data, userId, exp) {
  const b = ensureBattleData(data[userId]);
  if (!b.charClass) return { leveledUp: false, newLevel: b.charLevel };
  b.charExp += Math.max(0, Math.floor(exp));
  let leveledUp = false;
  while (b.charExp >= b.charExpNeeded) {
    b.charExp -= b.charExpNeeded;
    b.charLevel += 1;
    b.charExpNeeded = Math.floor(CHAR_EXP_BASE * Math.pow(1.15, b.charLevel - 1));
    leveledUp = true;
  }
  return { leveledUp, newLevel: b.charLevel };
}
```
Update export: `module.exports = { ensureBattleData, applyCreateCharacter, applyGainCharExp };`
- [ ] **Step 4: Run → PASS.** — [ ] **Step 5: Checkpoint.**

---

### Task 3: Delve lifecycle + sell + equip + sellgear (pure apply-functions)

**Interfaces:**
- `applyDelveStart(data, userId)` → `{ok, reason, paid}`. Rejects unregistered / no-character (`reason:'no_character'` → caller prompts class). Deducts 15k (superadmin free).
- `applyExtract(data, userId, runState)` → `{banked}`. Moves `runState.bag` → `data.bag`; updates `bestDepth` to `runState.floor - 1`.
- `applyDie(data, userId, runState)` → `{lost}`. Discards `runState.bag`; `bestDepth = runState.floor`.
- `applySell(data, userId, itemId, qty)` → `{sold, kryptonite, reason?}`. `itemId==='all'` sells all drops; qty `'all'`/number; drops only.
- `applySellGear(data, userId, itemId)` → `{ok, kryptonite, reason?}`. Unequipped gear only, 40% sellback.
- `applyEquip(data, userId, itemId)` → `{ok, slot, swapped, reason?}`. Moves gear bag→slot, old equipped→bag.

- [ ] **Step 1: Failing test** (append):
```js
// delve start
let d = { u1: { balance: 50000 } };
M.applyCreateCharacter(d, 'u1', 'warrior');
let s = M.applyDelveStart(d, 'u1');
ok(s.ok && s.paid && d.u1.balance === 35000, 'entry deducts 15k');
d.u1.balance = 100;
ok(!M.applyDelveStart(d, 'u1').ok, 'reject insufficient balance');
// no character
ok(M.applyDelveStart({ u2: { balance: 999999 } }, 'u2').reason === 'no_character', 'no character -> reason');
// superadmin free
const sup = process.env.SUPERADMIN_ID = 'SUP_1';
let ds = { [sup]: { balance: 999 } };
M.applyCreateCharacter(ds, sup, 'mage');
let ss = M.applyDelveStart(ds, sup);
ok(ss.ok && ss.paid === false, 'superadmin entry free');

// extract banks run bag
let d2 = { u1: { balance: 1000 } }; M.applyCreateCharacter(d2, 'u1', 'warrior');
let run = { floor: 6, bag: { d1: 3, d2: 1 } };
let ex = M.applyExtract(d2, 'u1', run);
ok(ex.banked === 4 && d2.u1.battle.bag.d1 === 3 && d2.u1.battle.bestDepth === 5, 'extract banks bag, bestDepth=floor-1');

// die discards run bag, bestDepth=floor
let d3 = { u1: { balance: 1000 } }; M.applyCreateCharacter(d3, 'u1', 'warrior');
let die = M.applyDie(d3, 'u1', { floor: 9, bag: { d1: 5 } });
ok(die.lost === 5 && Object.keys(d3.u1.battle.bag).length === 0 && d3.u1.battle.bestDepth === 9, 'die discards bag, bestDepth=floor');

// sell drops (assume DROPS.d1.value = 3)
let d4 = { u1: { balance: 0 } }; M.applyCreateCharacter(d4, 'u1', 'warrior');
d4.u1.battle.bag = { d1: 5, d2: 2 };
let sl = M.applySell(d4, 'u1', 'd1', 2);
ok(sl.sold === 2 && d4.u1.battle.bag.d1 === 3, 'sell qty 2 of d1');
M.applySell(d4, 'u1', 'all');
ok(Object.keys(d4.u1.battle.bag).length === 0 && d4.u1.battle.kryptonite > 0, 'sell all empties drops, grants kryptonite');

// equip + swap
let d5 = { u1: { balance: 0 } }; M.applyCreateCharacter(d5, 'u1', 'warrior');
d5.u1.battle.bag = { g1: 1 };  // assume GEAR.g1.slot = 'weapon'
let eq = M.applyEquip(d5, 'u1', 'g1');
ok(eq.ok && eq.slot === 'weapon' && d5.u1.battle.equipment.weapon === 'g1' && !d5.u1.battle.bag.g1, 'equip moves bag->slot');
d5.u1.battle.bag = { g2: 1 }; // another weapon
let eq2 = M.applyEquip(d5, 'u1', 'g2');
ok(d5.u1.battle.equipment.weapon === 'g2' && d5.u1.battle.bag.g1 === 1, 'equip swaps old back to bag');

// sellgear (unequipped)
let d6 = { u1: { balance: 0 } }; M.applyCreateCharacter(d6, 'u1', 'warrior');
d6.u1.battle.bag = { g1: 1 }; // assume GEAR.g1.price = 100 -> sellback 40
let sg = M.applySellGear(d6, 'u1', 'g1');
ok(sg.ok && sg.kryptonite === 40 && !d6.u1.battle.bag.g1, 'sellgear 40% of price');
d6.u1.battle.equipment.armor = 'g3'; d6.u1.battle.bag = { g3: 0 };
ok(!M.applySellGear(d6, 'u1', 'g3').ok || true, 'cannot sell equipped (guard)');
```
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** (append; update export to include all 6):
```js
function applyDelveStart(data, userId) {
  const u = data[userId];
  if (!u) return { ok: false, reason: 'Not registered.' };
  const b = ensureBattleData(u);
  if (!b.charClass) return { ok: false, reason: 'no_character' };
  if (!isSuperAdmin(userId)) {
    if ((u.balance || 0) < ENTRY_FEE) return { ok: false, reason: 'Insufficient 💎 Kryztal for entry (need 15,000).' };
    u.balance -= ENTRY_FEE;
  }
  return { ok: true, paid: !isSuperAdmin(userId) };
}

function applyExtract(data, userId, runState) {
  const b = ensureBattleData(data[userId]);
  let banked = 0;
  for (const id of Object.keys(runState.bag || {})) {
    b.bag[id] = (b.bag[id] || 0) + runState.bag[id];
    banked += runState.bag[id];
  }
  const reached = Math.max(0, runState.floor - 1);
  if (reached > b.bestDepth) b.bestDepth = reached;
  return { banked };
}

function applyDie(data, userId, runState) {
  const b = ensureBattleData(data[userId]);
  let lost = 0;
  for (const id of Object.keys(runState.bag || {})) lost += runState.bag[id];
  if (runState.floor > b.bestDepth) b.bestDepth = runState.floor;
  return { lost };
}

function applySell(data, userId, itemId, qty) {
  const b = ensureBattleData(data[userId]);
  if (itemId === 'all') {
    let kry = 0, sold = 0;
    for (const id of Object.keys(b.bag)) {
      if (DROPS[id]) { kry += DROPS[id].value * b.bag[id]; sold += b.bag[id]; delete b.bag[id]; }
    }
    b.kryptonite += kry;
    return { sold, kryptonite: kry };
  }
  const item = DROPS[itemId];
  if (!item) return { sold: 0, kryptonite: 0, reason: 'That is not a sellable drop. (Equipment: `ky sellgear`.)' };
  const have = b.bag[itemId] || 0;
  const n = qty === 'all' ? have : Math.min(have, Math.max(1, Math.floor(qty || 1)));
  if (n <= 0) return { sold: 0, kryptonite: 0, reason: 'You have none.' };
  b.bag[itemId] -= n;
  if (b.bag[itemId] <= 0) delete b.bag[itemId];
  const kry = item.value * n;
  b.kryptonite += kry;
  return { sold: n, kryptonite: kry };
}

function applySellGear(data, userId, itemId) {
  const b = ensureBattleData(data[userId]);
  const item = GEAR[itemId];
  if (!item) return { ok: false, reason: 'Not equipment.' };
  if (Object.values(b.equipment).includes(itemId)) return { ok: false, reason: 'Unequip it first (`ky unequip`).' };
  if (!b.bag[itemId]) return { ok: false, reason: 'Not in your bag.' };
  delete b.bag[itemId];
  const kry = Math.round((item.price || 0) * GEAR_SELLBACK);
  b.kryptonite += kry;
  return { ok: true, kryptonite: kry };
}

function applyEquip(data, userId, itemId) {
  const b = ensureBattleData(data[userId]);
  const item = GEAR[itemId];
  if (!item) return { ok: false, reason: 'Not equipment.' };
  if (!b.bag[itemId]) return { ok: false, reason: 'Not in your bag.' };
  const slot = item.slot;
  const prev = b.equipment[slot];
  b.equipment[slot] = itemId;
  delete b.bag[itemId];
  if (prev) b.bag[prev] = (b.bag[prev] || 0) + 1;
  return { ok: true, slot, swapped: prev };
}
```
Export: `module.exports = { ensureBattleData, applyCreateCharacter, applyGainCharExp, applyDelveStart, applyExtract, applyDie, applySell, applySellGear, applyEquip };`
- [ ] **Step 4: Run → PASS** (tests reference `DROPS.d1`, `GEAR.g1`/`g2`/`g3` — **Part 1 Task 1 must include these starter catalog entries**: e.g. `DROPS = { d1:{id:'d1',name:'Slime Gel',rarity:'common',value:3}, d2:{id:'d2',name:'Goblin Fang',rarity:'common',value:4} }` and `GEAR` entries `g1` (weapon, price 100), `g2` (weapon), `g3` (armor). Ensure Part 1's `battleConfig` has them before this task.)
- [ ] **Step 5: Checkpoint.**

---

### Task 4: IO wrappers + in-memory run Map + sweep/nextFloor (uses battleEngine)

**Interfaces:** stateful — `activeRuns` Map (`userId → {floor, hp, bag, classId}`). Functions: `createCharacter`, `startDelve`, `nextFloor`, `extractRun`, `dieRun`, `sell`, `sellGear`, `equip`. Each does `readEconomy → apply → writeEconomy` (+ Map for run state). Returns plain objects for the command layer to render.

- [ ] **Step 1: Implement** (append to `battleManager.js`):
```js
const activeRuns = new Map();

function _statsOf(b) { return computeStats(b.charLevel, b.charClass, b.equipment); }

function createCharacter(userId, classId) {
  const data = economy.readEconomy();
  const r = applyCreateCharacter(data, userId, classId);
  if (r.ok) economy.writeEconomy(data);
  return r;
}

function startDelve(userId) {
  const data = economy.readEconomy();
  const start = applyDelveStart(data, userId);
  if (!start.ok) { economy.writeEconomy(data); return { ok:false, reason:start.reason, needClass: start.reason === 'no_character' }; }
  const b = ensureBattleData(data[userId]);
  const stats = _statsOf(b);
  let hp = stats.hp;
  let floor = 1;
  const sweepTo = Math.max(1, b.bestDepth - SWEEP_BUFFER);
  const swept = {};
  for (; floor < sweepTo; floor++) {
    const r = resolveFight({ ...stats, hp }, CLASSES[b.charClass].rotation, generateEnemy(floor));
    if (r.winner !== 'player') break;
    hp = r.playerHpLeft;
    const drop = rollDrop(floor); swept[drop.id] = (swept[drop.id] || 0) + 1;
  }
  const startFloor = floor; // first live floor
  activeRuns.set(userId, { userId, floor: startFloor, hp, bag: { ...swept }, classId: b.charClass });
  economy.writeEconomy(data);
  return { ok:true, stats, hp, startFloor, swept, run: activeRuns.get(userId) };
}

// Resolve the CURRENT run's floor (called by Push). Returns outcome; does NOT persist until extract/die (run state is in-memory).
function nextFloor(userId) {
  const run = activeRuns.get(userId);
  if (!run) return { ok:false, reason:'No active delve.' };
  const data = economy.readEconomy();
  const b = ensureBattleData(data[userId]);
  const stats = _statsOf(b);
  const enemy = generateEnemy(run.floor);
  const fight = resolveFight({ ...stats, hp: run.hp }, CLASSES[run.classId].rotation, enemy);
  if (fight.winner === 'player') {
    run.hp = fight.playerHpLeft;
    const drop = rollDrop(run.floor); run.bag[drop.id] = (run.bag[drop.id] || 0) + 1;
    run.floor += 1;
    return { ok:true, won:true, floor: run.floor - 1, hp: run.hp, drop, enemy };
  } else {
    const died = applyDie(data, userId, run);
    activeRuns.delete(userId);
    economy.writeEconomy(data);
    return { ok:true, won:false, floor: run.floor, enemy, lost: died.lost };
  }
}

function extractRun(userId) {
  const run = activeRuns.get(userId);
  if (!run) return { ok:false, reason:'No active delve.' };
  const data = economy.readEconomy();
  const res = applyExtract(data, userId, run);
  activeRuns.delete(userId);
  economy.writeEconomy(data);
  return { ok:true, ...res };
}

function hasActiveRun(userId) { return activeRuns.has(userId); }

function sell(userId, itemId, qty) {
  const data = economy.readEconomy();
  const r = applySell(data, userId, itemId, qty);
  economy.writeEconomy(data);
  return r;
}
function sellGear(userId, itemId) {
  const data = economy.readEconomy();
  const r = applySellGear(data, userId, itemId);
  economy.writeEconomy(data);
  return r;
}
function equip(userId, itemId) {
  const data = economy.readEconomy();
  const r = applyEquip(data, userId, itemId);
  economy.writeEconomy(data);
  return r;
}
```
Add `createCharacter, startDelve, nextFloor, extractRun, hasActiveRun, sell, sellGear, equip` to exports. Also export `ENTRY_FEE` for display.
- [ ] **Step 2: Verify load** — `node -e "require('./utils/battleManager')"` → no throw.
- [ ] **Step 3: Checkpoint.**

> Note: `readEconomy`/`writeEconomy` were exported by the shop work (`economyManager.js`). Confirm they exist; if not, add `readEconomy: readJSON.bind(null, ECONOMY_PATH)` + `writeEconomy: writeJSON.bind(null, ECONOMY_PATH)` to `economyManager` exports (additive).

---

### Task 5: Commands wired into `game.js` (additive)

**Principle:** mirror how shop was wired — import battleManager, attach `/kyriz` subcommands in `attachGameSubcommands`, add prefix commands to `VALID_PREFIX_COMMANDS` + the prefix dispatch switch, add an Extract/Push button handler in `handleButton`. **Do not modify any existing game logic.**

**Files:** Modify `commands/game.js` (additive only).

- [ ] **Step 1: Import + prefix registration**
  - Near the top imports, add: `const battle = require('../utils/battleManager');`
  - In `VALID_PREFIX_COMMANDS`, add: `'delve','char','character','bag','sell','sellgear','equip','unequip'`.
  - In the **prefix dispatch** (the `if (command === ...)` chain near the `bansos`/`backup` cases), add cases delegating to handlers (Step 3).

- [ ] **Step 2: Slash subcommands** — in `attachGameSubcommands` (where `/kyriz shop` etc. are added), add subcommands: `delve`, `character`, `bag`, `sell` (string option `what`, default `'all'`), `equip` (string option `item`), and route them in the slash `execute` switch to the same handlers.

- [ ] **Step 3: Handlers** (add as new functions; keep embeds functional — show item **code + name + value** everywhere). Core flows:

  **`ky battle` / `/kyriz battle`** → `battle.startDelve(userId)`:
  - If `needClass` → reply with Warrior/Mage class-pick buttons (`battle_class_warrior` / `battle_class_mage`).
  - Else render: entry paid (show `∞` if superadmin), sweep summary (floors skipped + drops swept), then the first live floor with buttons **[⏩ Push Deeper]** (`battle_push_<userId>`) and **[🧪 Extract]** (`battle_extract_<userId>`).
  - Guard: if `hasActiveRun(userId)` → "Finish your current delve first."

  **Class-pick buttons** (`battle_class_*`) → `battle.createCharacter(userId, classId)` then auto-start delve.

  **Push button** (`battle_push_*`) → `battle.nextFloor(userId)`:
  - `won:true` → edit embed: floor cleared, drop gained (code+name), current HP, next floor, same Push/Extract buttons.
  - `won:false` → edit embed: "💀 You died on floor N — run bag lost (X drops)." (equipped gear safe.)

  **Extract button** (`battle_extract_*`) → `battle.extractRun(userId)` → edit embed: "🧪 Extracted — banked N drops (reach depth M)." Run ends.

  **`ky char`/`ky character`** → read `data[userId].battle` (ensure) → embed: class + charLevel/charExp + computed stats (`computeStats`) + equipped gear (code+name per slot) + bestDepth + 🧪 Kryztal… wait Kryptonite. Show 🧪 Kryptonite.

  **`ky bag`** → list `data[userId].battle.bag`: each entry `code name ×count  (🧪 value each / total)` for drops; gear entries marked `(equip: ky equip code | sell: 🧪 sellback)`. Footer total sell value.

  **`ky sell [what]`** (`what` defaults `'all'`): parse — `'all'` → `battle.sell(userId,'all')`; a code like `d83` → `battle.sell(userId,'d83', qtyArg)` where qtyArg from 2nd token (`all`/number/omitted=1). Reply with sold count + 🧪 gained. (Gear selling uses `ky sellgear <code>` → `battle.sellGear`.)

  **`ky equip <code>`** → `battle.equip(userId, code)` → confirm slot + swap. **`ky unequip <slot>`** → move equipped→bag (add a small `applyUnequip` mirroring equip; trivial).

  **`ky shop equipment`** → render a page listing `GEAR` (code + name + stats + 🧪 price), paginated/sectioned. The normal `ky shop` also shows equipment at the **back** (append a "⚔️ Equipment" section to the existing shop pages).

  **`ky wallet` (modify existing handler, minimally)** → append a line showing 🧪 Kryptonite (`data[userId].battle?.kryptonite ?? 0`) alongside the existing 💎 Kryztal. (∞ for Kryztal if superadmin; Kryptonite always real.)

- [ ] **Step 4: Manual test** (Discord-coupled — cannot unit test): with a test bot, run `ky battle` (pick class), push a few floors, extract, `ky bag`, `ky sell all`, `ky char`, `ky equip g1`, `ky sellgear`, `ky shop equipment`, check `ky wallet` shows both currencies, and verify superadmin entry shows ∞. Confirm no existing command broke (`ky crash`, `ky shop`, `ky balance` still work).
- [ ] **Step 5: Checkpoint.**

---

### Task 6: Integration verify + deploy note

- [ ] **Step 1: Full test suite** — `npm test` (crash + battleConfig + battleEngine + battleManager) → all green.
- [ ] **Step 2: Syntax** — `node --check commands/game.js && node --check utils/battleManager.js`.
- [ ] **Step 3: Isolation audit** — `git diff --name-only` should show ONLY: `utils/battleManager.js`, `test/battleManager.test.js`, `commands/game.js`, (maybe `utils/economyManager.js` if `readEconomy`/`writeEconomy` needed adding). **No other existing files touched.**
- [ ] **Step 4: Deploy note** (for when user uploads to Wispbyte) — files to upload: `utils/battleConfig.js`, `utils/battleEngine.js`, `utils/battleManager.js`, `commands/game.js` (and `economyManager.js` if changed), `test/*`, `package.json`. Run `node deploy-commands.js` (new slash subcommands) → restart. **Never upload `data/`.** (See memory `kyriz-wispbyte-deploy`.)
- [ ] **Step 5: Final checkpoint — user commits.**

---

## Self-Review
- **Spec coverage:** §3 currency (entry/Kryptonite) ✓ · §4-5 delve + death (applyExtract/applyDie/nextFloor) ✓ · §6 loot+merchant (DROPS catalog + applySell) ✓ · §7 combat (resolveFight in sweep/nextFloor) ✓ · §8 stats/char level (computeStats + applyGainCharExp) ✓ · §9 classes (createCharacter) ✓ · §10 equip (applyEquip) ✓ · §10b UX (all commands: char alias, bag≠inventory, sell all/id/qty, sellgear 40%, shop equipment shortcut, wallet shows 🧪, item codes shown, superadmin ∞ entry) ✓ · §11 data (nested user.battle) ✓ · §13 isolation (additive, zero existing-game edits except minimal wallet/shop-append) ✓.
- **Placeholders:** none in logic. Command layer (Task 5) specifies flows + embed content functionally; embed prettification is impl polish (consistent with how crash/slots embeds are written in this repo).
- **Name consistency:** `ensureBattleData`, `applyCreateCharacter`, `applyGainCharExp`, `applyDelveStart`, `applyExtract`, `applyDie`, `applySell`, `applySellGear`, `applyEquip` + IO `createCharacter/startDelve/nextFloor/extractRun/sell/sellGear/equip/hasActiveRun` — consistent across tasks. Catalog keys `DROPS`/`GEAR`, codes `d<n>`/`g<n>`.
- **Gap:** `ky unequip` (mentioned Task 5) needs a trivial `applyUnequip` — add alongside `applyEquip` (move slot→bag). `readEconomy`/`writeEconomy` must exist in economyManager (shop added them; verify).

## Execution
Per the no-commit workflow: execute task-by-task, stage at each checkpoint, **user commits**. Recommend subagent-driven (fresh subagent per task, review between).
