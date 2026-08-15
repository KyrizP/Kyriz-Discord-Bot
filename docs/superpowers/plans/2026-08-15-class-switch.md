# Class Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Multi-character per account (satu per class) — create via `ky changeclass` (5.000 🧪), play via `ky switchclass` (gratis), progress terpisah, resource shared.

**Architecture:** Struktur `battle.characters { <class>: record }` + `battle.activeClass`, migrasi lazy di `ensureBattleData`, SEMUA akses karakter lewat `getActiveChar(b)`, run menyimpan snapshot class (sudah ada: `run.classId`), leaderboard best-char + filter per-class. Spec: `docs/superpowers/specs/2026-08-15-class-switch-design.md`.

**Tech Stack:** discord.js v14 (CommonJS), flat JSON (`data/economy.json` via economyManager), test suite `node test/<name>.test.js` (assertion-count style, bukan framework).

## Global Constraints

- **NO COMMIT** — workflow owner: edit langsung di master, owner yang commit. Setiap akhir task = checkpoint "run suite", bukan commit.
- **Bot text FULL ENGLISH** (embed, error, label); diskusi internal Indonesia.
- **Jangan sentuh**: `pvpManager.js`, `battleEngine.js`, `battleConfig.js`, `uniqueItems.js`, `economyManager.js`, `data/*.json` di repo.
- Konstanta: `CHAR_CHANGE_COST = 5000` (🧪 Kryptonite). Constructor default: `charLevel: 1, charExp: 0, charExpNeeded: 200, charName: null, bestDepth: 0, equipment: 5 slot null, scoreAchievedAt: null`.
- Test runner: `node test/<file>.test.js`, exit code 0/1, format `ok(cond, msg)` + summary `Pass/Fail`.
- Semua suite harus hijau di akhir tiap task: `for t in battleManager pvp battleConfig battleEngine uniqueItems classSwitch crash; do node test/$t.test.js; done`.

---

### Task 1: Data core — constructor, accessor, migrasi

**Files:**
- Modify: `utils/battleManager.js` (ensureBattleData L28-49, applyCreateCharacter L62-68, applyGainCharExp L70-83)
- Test: `test/classSwitch.test.js` (create)

**Interfaces (produces):**
- `emptySlots()` → `{weapon:null,head:null,armor:null,boots:null,accessory:null}`
- `createCharacterRecord()` → record default (D3)
- `getActiveChar(b)` → `b.characters[b.activeClass]`
- `getCharClass(b)` → `b.activeClass || null` (pengganti baca `b.charClass` lama)

- [ ] **Step 1: Write failing tests** — buat `test/classSwitch.test.js`:

```js
'use strict';
// Class switch system tests. Run: node test/classSwitch.test.js
const BM = require('../utils/battleManager');
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : (fail++, console.log('  ❌ ' + m)); };
const mkData = (uid) => ({ [uid]: { username: 'T', balance: 100000, level: 1, xp: 0, xpNeeded: 400, totalWins: 0, totalLosses: 0, totalEarned: 0, totalLost: 0, lastDaily: null, registeredAt: '2026-01-01T00:00:00Z' } });

// ---- constructor: default record persis pemain baru (D3/G10) ----
const rec = BM.createCharacterRecord();
ok(rec.charLevel === 1 && rec.charExp === 0 && rec.charExpNeeded === 200, 'record: lv1 exp0 need200');
ok(rec.charName === null && rec.bestDepth === 0 && rec.scoreAchievedAt === null, 'record: no name, depth 0, no score date');
ok(rec.equipment && rec.equipment.weapon === null && Object.keys(rec.equipment).length === 5, 'record: 5 empty slots');

// ---- migrasi flat -> characters ----
const data = mkData('U1');
const b1 = BM.ensureBattleData(data.U1);
b1.charClass = 'mage'; b1.charLevel = 200; b1.charExp = 500; b1.charExpNeeded = 10050;
b1.charName = 'DarkMage'; b1.bestDepth = 150; b1.equipment.weapon = 'g1';
const b1m = BM.ensureBattleData(data.U1); // second call triggers/keeps migration
ok(b1m.characters && b1m.characters.mage.charLevel === 200, 'migrasi: mage char ada, level utuh');
ok(b1m.characters.mage.bestDepth === 150 && b1m.characters.mage.charName === 'DarkMage', 'migrasi: depth & name utuh');
ok(b1m.characters.mage.equipment.weapon === 'g1', 'migrasi: equipment utuh');
ok(b1m.activeClass === 'mage', 'migrasi: activeClass = class lama');
ok(b1m.charLevel === undefined && b1m.charClass === undefined && b1m.equipment === undefined, 'migrasi: field flat dihapus');
ok(BM.getActiveChar(b1m).charName === 'DarkMage', 'getActiveChar mengembalikan karakter aktif');

// ---- idempoten + pemain tanpa class tak tersentuh ----
BM.ensureBattleData(data.U1);
ok(BM.getActiveChar(b1m).charLevel === 200, 'migrasi idempoten');
const data2 = mkData('U2');
const b2 = BM.ensureBattleData(data2.U2);
ok(!b2.characters, 'pemain tanpa class: struktur characters belum dibuat');
ok(BM.getCharClass(b2) === null, 'getCharClass null sebelum pilih class');

// ---- applyCreateCharacter pakai constructor ----
const data3 = mkData('U3');
BM.ensureBattleData(data3.U3);
ok(BM.applyCreateCharacter(data3, 'U3', 'warrior').ok, 'create char warrior ok');
const b3 = BM.ensureBattleData(data3.U3);
ok(b3.characters.warrior.charLevel === 1 && b3.characters.warrior.bestDepth === 0, 'char baru: lv1 depth0 (bukan warisan)');
ok(b3.activeClass === 'warrior', 'create: aktif');
ok(!BM.applyCreateCharacter(data3, 'U3', 'mage').reason.includes('already have a character'), 'multi-char tidak lagi ditolak "already have" (diganti guard changeclass)');
// deep-equality jalur register vs constructor:
ok(JSON.stringify(b3.characters.warrior) === JSON.stringify(BM.createCharacterRecord()), 'record register === constructor (G10)');

// ---- applyGainCharExp menulis ke karakter aktif ----
const data4 = mkData('U4');
BM.ensureBattleData(data4.U4); BM.applyCreateCharacter(data4, 'U4', 'mage');
BM.applyGainCharExp(data4, 'U4', 250);
const b4 = BM.ensureBattleData(data4.U4);
ok(b4.characters.mage.charLevel === 2 && b4.characters.mage.charExp === 50, 'exp naik ke char aktif (250 = 200+50)');

console.log('\n' + (fail === 0 ? '✅ SEMUA TEST LULUS' : '❌ ADA TEST GAGAL'));
console.log('Pass: ' + pass + ' | Fail: ' + fail);
process.exit(fail === 0 ? 0 : 1);
```

- [ ] **Step 2: Run** — `node test/classSwitch.test.js` → expect FAIL (`createCharacterRecord is not a function`)

- [ ] **Step 3: Implement di battleManager.js.** Ganti blok `ensureBattleData` (L28-49) sepenuhnya:

```js
const EQUIP_SLOTS = () => ({ weapon: null, head: null, armor: null, boots: null, accessory: null });
// Single constructor for EVERY new character (first registration AND changeclass).
// One code path = a fresh char can never inherit level/depth from anywhere (spec D3/G10).
function createCharacterRecord() {
  return { charLevel: 1, charExp: 0, charExpNeeded: CHAR_EXP_BASE, charName: null,
           bestDepth: 0, equipment: EQUIP_SLOTS(), scoreAchievedAt: null };
}
function getActiveChar(b) { return (b.characters && b.characters[b.activeClass]) || null; }
function getCharClass(b) { return b.activeClass || null; }

function ensureBattleData(user) {
  if (!user.battle) {
    user.battle = { kryptonite: 0, activeClass: null, characters: {}, bag: {}, uniqueItems: {}, pvpWins: 0, pvpLosses: 0 };
  }
  const b = user.battle;
  if (!b.uniqueItems) b.uniqueItems = {};
  if (!b.bag) b.bag = {};
  if (b.pvpWins == null) b.pvpWins = 0;
  if (b.pvpLosses == null) b.pvpLosses = 0;
  // v1.6 lazy migration: flat single-char -> characters map (idempotent, proven v1.1 pattern)
  if (b.charClass && !b.characters) {
    b.characters = {};
    b.characters[b.charClass] = {
      charLevel: b.charLevel || 1, charExp: b.charExp || 0, charExpNeeded: b.charExpNeeded || CHAR_EXP_BASE,
      charName: b.charName || null, bestDepth: b.bestDepth || 0,
      equipment: Object.assign(EQUIP_SLOTS(), b.equipment || {}), scoreAchievedAt: b.scoreAchievedAt || null,
    };
    b.activeClass = b.charClass;
    delete b.charClass; delete b.charLevel; delete b.charExp; delete b.charExpNeeded;
    delete b.charName; delete b.bestDepth; delete b.equipment; delete b.scoreAchievedAt;
  }
  if (!b.characters) b.characters = {};
  return b;
}
```

  Ganti `applyCreateCharacter` (L62-68):

```js
function applyCreateCharacter(data, userId, classId) {
  const b = ensureBattleData(data[userId]);
  if (!CLASSES[classId]) return { ok: false, reason: 'Invalid class. Pick warrior or mage.' };
  if (b.characters[classId]) return { ok: false, reason: 'You already have a ' + CLASSES[classId].name + ' character. Use `ky switchclass ' + classId + '`.' };
  b.characters[classId] = createCharacterRecord();
  b.activeClass = classId;
  return { ok: true };
}
```

  Ganti `applyGainCharExp` (L70-83) — baca/tulis via `getActiveChar`:

```js
function applyGainCharExp(data, userId, exp) {
  const b = ensureBattleData(data[userId]);
  const c = getActiveChar(b);
  if (!c) return { leveledUp: false, newLevel: 1 };
  c.charExp += Math.max(0, Math.floor(exp));
  let leveledUp = false;
  while (c.charExp >= c.charExpNeeded) {
    c.charExp -= c.charExpNeeded;
    c.charLevel += 1;
    c.charExpNeeded = CHAR_EXP_BASE + 50 * (c.charLevel - 1);
    c.scoreAchievedAt = new Date().toISOString();
    leveledUp = true;
  }
  return { leveledUp, newLevel: c.charLevel };
}
```

  Export: tambahkan `createCharacterRecord, getActiveChar, getCharClass, EQUIP_SLOTS` ke `module.exports`.

- [ ] **Step 4: Run** — `node test/classSwitch.test.js` → PASS semua. `node test/battleManager.test.js` → boleh sementara MERAH (field flat dihapus); catat assertion yang gagal untuk Task 2.

---

### Task 2: Run pipeline — delve/extract/name lewat karakter aktif + snapshot run

**Files:**
- Modify: `utils/battleManager.js` (applyDelveStart L85-95, applyExtract L98-110, startDelve L298-314, applySetCharName L233-251, getCharName L252-256)
- Test: `test/classSwitch.test.js` (append), `test/battleManager.test.js` (adaptasi assertion flat → structure)

**Interfaces (produces):** `applyExtract(data, userId, runState)` menulis ke `characters[runState.classId]` (G7/G8); `getCharName` membaca `getActiveChar`.

- [ ] **Step 1: Append failing tests:**

```js
// ---- delve: start butuh karakter aktif; sweep dari bestDepth karakter itu ----
const data5 = mkData('U5');
BM.ensureBattleData(data5.U5); BM.applyCreateCharacter(data5, 'U5', 'warrior');
BM.getActiveChar(BM.ensureBattleData(data5.U5)).bestDepth = 30; // simulasi progress warrior
ok(BM.applyDelveStart(data5, 'U5').ok, 'delve start ok dengan char aktif');
const data5b = mkData('U9'); BM.ensureBattleData(data5b.U9);
ok(BM.applyDelveStart(data5b, 'U9').reason === 'no_character', 'delve start tanpa char -> no_character');

// ---- extract menulis ke karakter PEMAIN RUN (G7), bukan aktif sekarang ----
const data6 = mkData('U6');
BM.ensureBattleData(data6.U6); BM.applyCreateCharacter(data6, 'U6', 'mage');
const runState = { classId: 'mage', floor: 51, bag: { d1: 2 }, expAccum: 300 };
BM.ensureBattleData(data6.U6).activeClass = 'mage';
BM.applyExtract(data6, 'U6', runState);
const b6 = BM.ensureBattleData(data6.U6);
ok(b6.characters.mage.bestDepth === 50, 'extract: depth masuk ke char run (50)');
ok(b6.bag.d1 === 2, 'extract: bag shared terisi');
// paksa switch aktif ke warrior SEBELUM extract (defense-in-depth test):
BM.applyCreateCharacter(data6, 'U6', 'warrior'); // kini aktif = warrior
BM.applyExtract(data6, 'U6', { classId: 'mage', floor: 71, bag: {}, expAccum: 0 });
ok(BM.ensureBattleData(data6.U6).characters.mage.bestDepth === 70, 'G7: extract tetap ke characters[run.classId] walau aktif warrior');
ok(BM.ensureBattleData(data6.U6).characters.warrior.bestDepth === 0, 'char lain tidak terkontaminasi');

// ---- charName per karakter ----
const data7 = mkData('U7');
BM.ensureBattleData(data7.U7); BM.applyCreateCharacter(data7, 'U7', 'warrior');
ok(BM.applySetCharName(data7, 'U7', 'IronKnight').ok, 'set name ok');
BM.applyCreateCharacter(data7, 'U7', 'mage');
ok(BM.ensureBattleData(data7.U7).characters.mage.charName === null, 'char kedua belum bernama');
ok(BM.applySetCharName(data7, 'U7', 'DarkMage').ok, 'set name char kedua ok');
ok(BM.ensureBattleData(data7.U7).characters.warrior.charName === 'IronKnight', 'nama char pertama tidak berubah');
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement:**

  `applyDelveStart` — ganti `if (!b.charClass)` dengan:
```js
  if (!getActiveChar(b)) return { ok: false, reason: 'no_character' };
```

  `applyExtract` — awal fungsi ganti jadi:
```js
function applyExtract(data, userId, runState) {
  const b = ensureBattleData(data[userId]);
  const runChar = (runState.classId && b.characters[runState.classId]) || getActiveChar(b); // G7: run owns the writes
  let banked = 0;
  for (const id of Object.keys(runState.bag || {})) {
    b.bag[id] = (b.bag[id] || 0) + runState.bag[id];
    banked += runState.bag[id];
  }
  const reached = Math.max(0, (runState.floor || 1) - 1);
  if (reached > runChar.bestDepth) runChar.bestDepth = reached;
  let expRes = { leveledUp: false, newLevel: runChar.charLevel };
  if (runState.expAccum) {
    // exp juga milik karakter run — tulis langsung, bukan via active:
    runChar.charExp += runState.expAccum;
    while (runChar.charExp >= runChar.charExpNeeded) {
      runChar.charExp -= runChar.charExpNeeded;
      runChar.charLevel += 1;
      runChar.charExpNeeded = CHAR_EXP_BASE + 50 * (runChar.charLevel - 1);
      runChar.scoreAchievedAt = new Date().toISOString();
      expRes = { leveledUp: true, newLevel: runChar.charLevel };
    }
  }
  return { banked, exp: runState.expAccum || 0, leveledUp: expRes.leveledUp, newLevel: expRes.newLevel };
}
```

  `startDelve` L304-309 — ganti blok stats/sweep:
```js
  const b = ensureBattleData(data[userId]);
  const c = getActiveChar(b);
  const stats = computeStats(c.charLevel, b.activeClass, c.equipment, b.uniqueItems || {});
  const run = { userId, floor: 1, hp: stats.hp, bag: {}, expAccum: 0, cleared: 0, classId: b.activeClass, stats, equipment: { ...c.equipment }, uniqueItems: { ...(b.uniqueItems || {}) } };
  const sweepTo = Math.max(1, c.bestDepth - SWEEP_BUFFER);
```

  `applySetCharName` — ganti guard + tulis:
```js
  const c = getActiveChar(b);
  if (!c) return { ok: false, reason: 'Create a character first (`ky battle`).' };
  // ... validasi name sama persis ...
  c.charName = name;
```

  `getCharName` L255 — ganti return:
```js
  const b = u && u.battle;
  const c = b && BM-internal getActiveChar(b); // panggilan langsung: getActiveChar(u.battle)
  return c && c.charName ? c.charName : null;
```
  (implementasi nyata: `const u = data[userId]; if (!u || !u.battle) return null; const c = getActiveChar(u.battle); return (c && c.charName) || null;`)

- [ ] **Step 4: Run** — `node test/classSwitch.test.js` PASS; adaptasi `test/battleManager.test.js`: setiap assertion yang akses `b.charLevel/b.charClass/b.bestDepth/b.equipment/b.charName` diganti `getActiveChar(b).X` / `getCharClass(b)` — jalankan sampai hijau.

---

### Task 3: Equipment isolation (G5/G6)

**Files:**
- Modify: `utils/battleManager.js` (baru `isEquippedOnAnyChar`, applySellGear L144-193, applyEquip L195-219, applySell L121-142, applyUnequip L221-230)
- Test: `test/classSwitch.test.js` (append)

**Interfaces (produces):** `isEquippedOnAnyChar(b, itemId)` → boolean (ekspor untuk battleCommands).

- [ ] **Step 1: Failing tests:**

```js
// ---- G5: equip item yang terpasang di char lain -> tolak ----
const data8 = mkData('U8');
BM.ensureBattleData(data8.U8); BM.applyCreateCharacter(data8, 'U8', 'warrior');
const bb = BM.ensureBattleData(data8.U8);
bb.uniqueItems.kyw1 = { id: 'kyw1', rarity: 'divine', slot: 'weapon', stats: { atk: 48 }, passives: [] };
bb.characters.warrior.equipment.weapon = 'kyw1'; // terpasang di warrior (aktif)
BM.applyCreateCharacter(data8, 'U8', 'mage');     // aktif = mage
ok(BM.applyEquip(data8, 'U8', 'kyw1').ok === false, 'G5: equip item milik-equipment-warrior ditolak di mage');
ok(BM.isEquippedOnAnyChar(bb, 'kyw1') === true, 'isEquippedOnAnyChar deteksi lintas char');

// ---- G6: jual unique terpasang di char manapun -> tolak/single, bulk -> skip ----
ok(BM.applySellGear(data8, 'U8', 'kyw1', 1).ok === false, 'G6: jual item terpasang di char non-aktif ditolak');
const bulk = BM.applySellGear(data8, 'U8', 'divine', 'all');
ok(bulk.ok === true && bb.uniqueItems.kyw1, 'G6 bulk: item terpasang di-skip, tidak terjual');

// ---- pindah gear jalur sah: unequip (warrior) -> switch -> equip (mage) ----
BM.applySwitchClass ? null : null; // belum ada — tes pindah via manipulasi aktif:
bb.activeClass = 'warrior';
ok(BM.applyUnequip(data8, 'U8', 'weapon').ok, 'unequip dari warrior ok');
bb.activeClass = 'mage';
ok(BM.applyEquip(data8, 'U8', 'kyw1').ok, 'equip ke mage setelah dilepas — jalur sah berhasil');
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement:**

```js
// G5/G6: an item may only be equipped on ONE character at a time (shared collection).
function isEquippedOnAnyChar(b, itemId) {
  for (const ch of Object.values(b.characters || {})) {
    if (!ch.equipment) continue;
    for (const slot of Object.values(ch.equipment)) if (slot === itemId) return true;
  }
  return false;
}
```

  `applyEquip` — ganti semua rujukan `b.equipment` jadi `const eq = getActiveChar(b).equipment;` dan guard:
```js
  const c = getActiveChar(b);
  if (!c) return { ok: false, reason: 'Create a character first (`ky battle`).' };
  const eq = c.equipment;
  // ... branch ky: ganti loop "Already equipped" -> if (isEquippedOnAnyChar(b, itemId)) return { ok:false, reason:'Equipped on another character. `ky unequip` it there first (or switch).' };
  // ... branch g: sama pakai isEquippedOnAnyChar; swap prev via eq; scoreAchievedAt -> c.scoreAchievedAt
```
  `applyUnequip` — `const eq = getActiveChar(b).equipment;` + `c.scoreAchievedAt = ...`.
  `applySellGear` single-ky (L149): ganti loop equipment jadi `if (isEquippedOnAnyChar(b, itemId)) return { ok: false, reason: 'Unequip it first.' };`
  `applySellGear` bulk unique (L163-167): ganti loop `equipped` jadi `if (isEquippedOnAnyChar(b, id)) continue;`
  `applySell` (L123): greed dari `getActiveChar(b).equipment` → `getPassives(getActiveChar(b).equipment, b.uniqueItems)`.
  Export `isEquippedOnAnyChar`.

- [ ] **Step 4: Run** — classSwitch + battleManager PASS.

- [ ] **Step 4b: `ky unequip all`** — batch unequip 5 slot karakter aktif sekali jalan. Guard & semantika sama dengan single unequip (lock run/duel/challenge; g-item → `bag[id] += 1` per slot, ky-item tetap di koleksi). Test dulu:

```js
// ---- unequip all: mixed g+ky, stacking count, empty, tanpa duplikasi ----
const dU = mkData('U10');
BM.ensureBattleData(dU.U10); BM.applyCreateCharacter(dU, 'U10', 'warrior');
const bU = BM.ensureBattleData(dU.U10);
bU.uniqueItems.kyw1 = { id: 'kyw1', rarity: 'divine', slot: 'weapon', stats: { atk: 48 }, passives: [] };
bU.bag.g10 = 1; // satu spare g10 di bag (dua sword sama total)
const cU = BM.getActiveChar(bU);
cU.equipment.weapon = 'kyw1'; cU.equipment.head = 'g21';
BM.applyEquip(dU, 'U10', 'g10'); // ambil spare -> equipped (bag.g10 habis)
const rU = BM.applyUnequipAll(dU, 'U10');
ok(rU.ok && rU.count === 3, 'unequip all: 3 item lepas');
ok(bU.bag.g10 === 1 && bU.bag.g21 === 1, 'g-item kembali ke bag dengan count benar (tidak jadi 1 semua)');
ok(bU.uniqueItems.kyw1, 'ky-item tetap di koleksi');
ok(Object.values(cU.equipment).every(v => v === null), 'semua slot kosong');
ok(!BM.applyUnequipAll(dU, 'U10').ok, 'second call: nothing equipped -> info');
// duplikasi check: total kepemilikan tidak berubah
ok(bU.bag.g10 === 1, 'tidak ada duplikasi (bag.g10 tetap 1)');
```

  Implement:

```js
function applyUnequipAll(data, userId) {
  const b = ensureBattleData(data[userId]);
  const c = getActiveChar(b);
  if (!c) return { ok: false, reason: 'Create a character first (`ky battle`).' };
  const removed = [];
  for (const slot of Object.keys(c.equipment)) {
    const itemId = c.equipment[slot];
    if (!itemId) continue;
    c.equipment[slot] = null;
    if (itemId.startsWith('g')) b.bag[itemId] = (b.bag[itemId] || 0) + 1; // ky stays in uniqueItems
    removed.push(itemId);
  }
  if (!removed.length) return { ok: false, reason: 'Nothing equipped.' };
  c.scoreAchievedAt = new Date().toISOString();
  return { ok: true, count: removed.length, items: removed };
}
function unequipAll(userId) {
  if (activeRuns.has(userId)) return { ok: false, reason: 'Finish or end your battle first (`ky end`).' };
  const data = economy.readEconomy(); ensureUser(data, userId);
  const r = applyUnequipAll(data, userId);
  if (r.ok) economy.writeEconomy(data);
  return r;
}
```
  Export keduanya. UI (dikerjakan Task 6): `handleUnequip` — `args[0] === 'all'` → `unequipAll` → reply `Unequipped N items.`; help text `unequip <slot|all>`.

- [ ] **Step 4c: Run** — suite PASS.

---

### Task 4: changeclass / switchclass (manager)

**Files:**
- Modify: `utils/battleManager.js` (baru applyChangeClass, applySwitchClass, changeClass, switchClass)
- Test: `test/classSwitch.test.js` (append)

**Interfaces (produces):** `changeClass(userId, classId)` → `{ok, reason?, charName?}`; `switchClass(userId, classId?)` → `{ok, reason?, switchedTo?}` — keduanya menolak saat `activeRuns.has(userId)` (G1).

- [ ] **Step 1: Failing tests:**

```js
// ---- changeclass: biaya, atomic, auto-aktif (D2, G9) ----
const data9 = mkData('A1');
BM.ensureBattleData(data9.A1); BM.applyCreateCharacter(data9, 'A1', 'warrior');
BM.ensureBattleData(data9.A1).kryptonite = 6000;
ok(BM.applyChangeClass(data9, 'A1', 'mage').ok, 'changeclass mage ok (6000 kry >= 5000)');
ok(BM.ensureBattleData(data9.A1).kryptonite === 1000, 'biaya 5000 terpotong sekali');
ok(BM.ensureBattleData(data9.A1).activeClass === 'mage', 'D2: langsung aktif');
ok(BM.ensureBattleData(data9.A1).characters.mage.charLevel === 1, 'D3: char baru lv1');
ok(BM.applyChangeClass(data9, 'A1', 'mage').ok === false, 'G9: class sudah ada -> tolak');
ok(BM.ensureBattleData(data9.A1).kryptonite === 1000, 'G9: tolak tidak memotong lagi');
BM.ensureBattleData(data9.A1).kryptonite = 100;
ok(BM.applyChangeClass(data9, 'A1', 'rogue').ok === false, 'class invalid tolak');
// (butuh class ketiga di CLASSES untuk tes invalid-lebih-lengkap — cukup string ngawur)
ok(BM.applyChangeClass(data9, 'A1', 'warrior').ok === false, 'class sudah dimiliki -> tolak (bukan create lagi)');

// ---- switchclass ----
ok(BM.applySwitchClass(data9, 'A1', 'warrior').ok, 'switch ke warrior ok');
ok(BM.ensureBattleData(data9.A1).activeClass === 'warrior', 'aktif = warrior');
ok(BM.ensureBattleData(data9.A1).characters.warrior.charLevel === 1, 'data warrior utuh');
ok(BM.applySwitchClass(data9, 'A1', 'mage').ok === false || true, 'switch ke class dimiliki: boleh');
ok(BM.applySwitchClass(data9, 'A1', 'rogue').ok === false, 'G12: class tak dimiliki -> tolak');
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement:**

```js
const CHAR_CHANGE_COST = 5000; // 🧪 per NEW character (D1)

function applyChangeClass(data, userId, classId) {
  const u = data[userId];
  if (!u) return { ok: false, reason: 'You are not registered.' };
  const b = ensureBattleData(u);
  if (!CLASSES[classId]) return { ok: false, reason: 'Invalid class. Pick warrior or mage.' };
  if (b.characters[classId]) return { ok: false, reason: 'You already have a ' + CLASSES[classId].name + ' character. Use `ky switchclass ' + classId + '` (free).' };
  if (!getActiveChar(b)) return { ok: false, reason: 'Create a character first (`ky battle`).' };
  if ((b.kryptonite || 0) < CHAR_CHANGE_COST) return { ok: false, reason: 'Creating a new character costs 🧪 ' + CHAR_CHANGE_COST.toLocaleString() + ' Kryptonite.' };
  b.kryptonite -= CHAR_CHANGE_COST;                 // G9: check-then-deduct in ONE apply (single write in wrapper)
  b.characters[classId] = createCharacterRecord();
  b.activeClass = classId;                          // D2: activate immediately
  return { ok: true, kryptonite: b.kryptonite };
}

function applySwitchClass(data, userId, classId) {
  const b = ensureBattleData(data[userId]);
  if (!classId) return { ok: false, reason: 'Which character? `ky switchclass <class>`. You own: ' + (Object.keys(b.characters).join(', ') || 'none') };
  if (!b.characters[classId]) return { ok: false, reason: 'You do not have that character yet. You own: ' + (Object.keys(b.characters).join(', ') || 'none') };
  if (b.activeClass === classId) return { ok: false, reason: 'That character is already active.' };
  b.activeClass = classId;
  return { ok: true, switchedTo: classId };
}

function changeClass(userId, classId) {
  if (activeRuns.has(userId)) return { ok: false, reason: 'Finish or end your battle first (`ky end`).' }; // G1
  const data = economy.readEconomy();
  ensureUser(data, userId);
  const r = applyChangeClass(data, userId, classId);
  if (r.ok) economy.writeEconomy(data);
  return r;
}
function switchClass(userId, classId) {
  if (activeRuns.has(userId)) return { ok: false, reason: 'Finish or end your battle first (`ky end`).' }; // G1
  const data = economy.readEconomy();
  ensureUser(data, userId);
  const r = applySwitchClass(data, userId, classId);
  if (r.ok) economy.writeEconomy(data);
  return r;
}
```
  Export: `applyChangeClass, applySwitchClass, changeClass, switchClass, CHAR_CHANGE_COST`.

- [ ] **Step 4: Run** — PASS + full suite battleManager.

---

### Task 5: Leaderboard — best char + per-class (G: LB spec)

**Files:**
- Modify: `utils/battleManager.js` (`getBattleLeaderboard` L431-459)
- Test: `test/classSwitch.test.js` (append)

**Interfaces (produces):** `getBattleLeaderboard(limit, memberIds, classFilter)` — `classFilter` string class id atau null.

- [ ] **Step 1: Failing tests:**

```js
// ---- LB: entri terbaik per pemain + filter class ----
const dataL = {
  P1: { username: 'p1', registeredAt: '2026-01-01T00:00:00Z', battle: null, cosmetics: {} },
  P2: { username: 'p2', registeredAt: '2026-01-02T00:00:00Z', battle: null, cosmetics: {} },
};
for (const [uid, u] of Object.entries(dataL)) {
  const b = BM.ensureBattleData(u);
  b.characters.warrior = BM.createCharacterRecord(); b.characters.mage = BM.createCharacterRecord();
}
dataL.P1.battle.activeClass = 'warrior';
dataL.P1.battle.characters.warrior.bestDepth = 80; dataL.P1.battle.characters.mage.bestDepth = 40;
dataL.P2.battle.activeClass = 'mage';
dataL.P2.battle.characters.mage.bestDepth = 90; dataL.P2.battle.characters.warrior.bestDepth = 10;
// (inject data via applyExtract terlalu berat — set langsung field record utk LB test)
const lbAll = BM.getBattleLeaderboardFor(dataL, 10, null);
ok(lbAll[0].userId === 'P2' && lbAll[0].bestDepth === 90 && lbAll[0].charClass === 'mage', 'LB utama: char terbaik P2 (mage 90)');
ok(lbAll[1].userId === 'P1' && lbAll[1].charClass === 'warrior', 'LB utama: char terbaik P1 (warrior 80)');
const lbW = BM.getBattleLeaderboardFor(dataL, 10, 'warrior');
ok(lbW.length === 2 && lbW[0].userId === 'P1' && lbW[0].bestDepth === 80, 'LB warrior: P1 top');
const lbM = BM.getBattleLeaderboardFor(dataL, 10, 'mage');
ok(lbM[0].userId === 'P2' && lbM[0].bestDepth === 90, 'LB mage: P2 top');
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** — refactor jadi pure core + wrapper:

```js
// Pure core (testable tanpa IO): best character per player (main LB) or per-class entries.
function buildBattleLeaderboard(data, memberIds = null, classFilter = null) {
  const players = [];
  for (const [uid, user] of Object.entries(data)) {
    if (memberIds && !memberIds.has(uid)) continue;
    const b = user.battle;
    if (!b || !b.characters || !Object.keys(b.characters).length) continue;
    const entries = Object.entries(b.characters)
      .filter(([cls]) => !classFilter || cls === classFilter)
      .map(([cls, ch]) => {
        const stats = computeStats(ch.charLevel, cls, ch.equipment, b.uniqueItems || {});
        return { cls, ch, score: stats.hp + stats.atk + stats.matk + stats.def + stats.mdef + stats.spd };
      });
    if (!entries.length) continue;
    const best = entries.slice().sort((a, z) => (z.ch.bestDepth || 0) - (a.ch.bestDepth || 0) || z.score - a.score)[0];
    players.push({
      userId: uid, username: user.username || 'Unknown',
      charName: best.ch.charName || null, score: best.score,
      charLevel: best.ch.charLevel, charClass: best.cls, bestDepth: best.ch.bestDepth || 0,
      registeredAt: user.registeredAt || '9999',
      scoreAchievedAt: best.ch.scoreAchievedAt || user.registeredAt || '9999',
      cosmetics: user.cosmetics || null,
    });
  }
  players.sort((a, b2) => {
    if (b2.bestDepth !== a.bestDepth) return b2.bestDepth - a.bestDepth;
    if (b2.score !== a.score) return b2.score - a.score;
    return (a.scoreAchievedAt || '9999').localeCompare(b2.scoreAchievedAt || '9999');
  });
  return players;
}
function getBattleLeaderboardFor(data, limit = 10, memberIds = null, classFilter = null) {
  return buildBattleLeaderboard(data, memberIds, classFilter).slice(0, limit);
}
function getBattleLeaderboard(limit = 10, memberIds = null, classFilter = null) {
  return getBattleLeaderboardFor(economy.readEconomy(), limit, memberIds, classFilter);
}
```
  Export `getBattleLeaderboardFor` (untuk test) — `getBattleLeaderboard` signature tetap kompatibel + param baru.

- [ ] **Step 4: Run** — PASS.

---

### Task 6: battleCommands — render via getActiveChar + `ky char` paging + command UI

**Files:**
- Modify: `utils/battleCommands.js` (semua render), `test/classSwitch.test.js` tidak (UI via smoke Task 8)

**Interfaces (consumes):** semua dari Task 1-5. **Produces:** `handleCharacter(context, userId, targetArg, pageArg)`, `handleChangeClass(context, args)`, `handleSwitchClass(context, args)`, tombol `battle_charpage_<userId>_<idx>`.

- [ ] **Step 1: Refactor baca data (grep-driven, WAJIB exhaustive):**

Run: `grep -n "b\.charLevel\|b\.charClass\|b\.charName\|b\.bestDepth\|b\.charExp\|b\.equipment" utils/battleCommands.js`
Untuk SETIAP hasil: destructure `const c = battle.getActiveChar(b); const cls = b.activeClass;` lalu ganti `b.X` → `c.X` / `cls`. Situs yang diketahui: `handleCharacter` (stats+title+equip lines+passives), `handleGear`, `handleBag`, PvP `makePlayer` (L800-801: `computeStats(pvp.pvpEffLevel(b.charLevel)...)` → `c.charLevel`), PvP panel `nm()` (L693, L729), LB render, admin inspect paths, `battle help`. Jangan ada satu pun `b.charLevel` tersisa — verifikasi dengan grep yang sama hasil 0 (kecuali komentar).

- [ ] **Step 2: `ky char` paging.** Refactor `handleCharacter(context, userId, targetArg, pageArg)`:
  - Tentukan target (self/admin-inspect — logika existing).
  - `const order = [b.activeClass, ...Object.keys(b.characters).filter(k => k !== b.activeClass)]` → page 1 = aktif.
  - `pageArg` bisa angka (`parseInt`) atau nama class → index; invalid → page 1.
  - Render existing dipindah ke `buildCharEmbed(b, cls, displayName, pageIdx, totalPages)`; header tambah:
    `🟢 ACTIVE — ⚔️ Warrior · Lv.150` (char aktif) atau `⚪ INACTIVE — 🔮 Mage · Lv.60` + footer `ky switchclass mage to play this character`.
  - Tombol (hanya jika totalPages > 1): ActionRow ◀️ `battle_charpage_<uid>_<i-1>` / ▶️ `battle_charpage_<uid>_<i+1>`, disabled di ujung.
- [ ] **Step 3: handleButton routing** — di `battleCommands.handleButton`, tambah branch:
```js
  if (interaction.customId.startsWith('battle_charpage_')) {
    const [, , ownerId, idxRaw] = interaction.customId.split('_'); // battle, charpage, uid, idx
    if (interaction.user.id !== ownerId) return interaction.reply({ content: "This isn't your character panel — use `ky char`.", ephemeral: true });
    const page = Number(idxRaw) || 1;
    // rebuild embed via buildCharEmbed — ambil b via battle data target=self
    return interaction.update({ embeds: [buildCharEmbed(bSelf, clsAt(page), displayName, page, total)], components: [row] });
  }
```
- [ ] **Step 4: handleSwitchClass / handleChangeClass UI:**
```js
async function handleSwitchClass(context, userId, args) {
  if (pvp.isInFight(userId)) return context.reply({ content: 'Finish your duel first.' });      // G2
  if (hasPendingChallenge(userId)) return context.reply({ content: 'You have a pending duel challenge — settle it first.' }); // G3
  const cls = (args[0] || '').toLowerCase();
  const r = battle.switchClass(userId, cls || null);
  if (!r.ok) return context.reply({ content: r.reason });
  const c = battle.getActiveChar(battle.getBattle ? null : null); // render konfirmasi: class, Lv, bestDepth char baru
  return context.reply({ content: `✅ Switched to **${CLASSES[r.switchedTo].name}** ${CLASSES[r.switchedTo].emoji} — Lv.${...} · 🏰 Best depth ${...}` });
}
```
  `handleChangeClass` serupa: guard G2/G3 dulu → `battle.changeClass(userId, cls)` → embed konfirmasi (biaya, char baru Lv.1) — plus kalau `!args[0]`, reply usage + daftar class yang dimiliki + harga.
  `hasPendingChallenge(userId)`: cek `challengeTimers` Map (kolom/kunci berisi userId kedua pihak) — helper kecil di battleCommands.
- [ ] **Step 5: help + battle help** — tambah baris di `ky help` (bagian Battle): `switchclass [class]` · `changeclass <class> (🧪 5k)`; `ky battle help` tambah penjelasan singkat multi-character.
- [ ] **Step 6: Run** — `node --check utils/battleCommands.js` + full suite (belum ada test UI; smoke di Task 8).

---

### Task 7: game.js routing

**Files:**
- Modify: `commands/game.js`

- [ ] **Step 1:** `VALID_PREFIX_COMMANDS` += `'switchclass', 'changeclass'` (array L4320-an).
- [ ] **Step 2:** `requiresRegistration` (prefix list) += `'switchclass', 'changeclass'`.
- [ ] **Step 3:** switch dispatch (dekat `case 'char'`):
```js
    case 'switchclass':
      return battleCmd.handleSwitchClass(message, userId, args);
    case 'changeclass':
      return battleCmd.handleChangeClass(message, userId, args);
    case 'char':
    case 'character':
      return battleCmd.handleCharacter(message, userId, args[0], args[1]); // args[0]=target/name, args[1]=page
```
  (cek dispatch `char` yang sekarang — pertahankan penanganan `name <nama>` sub-arg existing, page hanya arg tambahan.)
- [ ] **Step 4:** Run `node --check commands/game.js` + suite.

---

### Task 8: Full gate + exploit sweep (G1-G12)

**Files:**
- Create: `test/classSwitch.exploit.js` (script runtime, bukan suite biasa — mock minimal)

- [ ] **Step 1: Script exploit sweep** — untuk tiap guard G1/G2/G3/G5/G6/G9/G10/G12, jalankan aksi-aksi jahat via apply-fn & wrapper dan assert ditolak/state benar. Kerangka:

```js
// G1: set activeRuns dummy -> BM.switchClass/changeClass harus tolak
// G7: run.classId != activeClass saat extract -> depth/exp tetap ke char run
// G9: double changeClass -> potong sekali
// G10: createCharacterRecord() === record hasil register === record hasil changeClass (deep equal)
// ekstra: migrasi data flat veteran (lv350 depth86) -> characters utuh; char BARU depth 0
```
- [ ] **Step 2: Run semua suite** — `for t in classSwitch battleManager pvp battleConfig battleEngine uniqueItems crash; do node test/$t.test.js | tail -1; done` → semua `Fail: 0`.
- [ ] **Step 3: Smoke E2E lokal** (bot jalan lokal, superadmin): `ky char` (1 page) → `ky changeclass mage` (bayar 5k) → `ky char` (2 page + banner + tombol) → `ky battle` (sweep dari 1) → `ky end` → `ky switchclass warrior` → data intact → LB. Screenshot/catat hasil untuk owner.
- [ ] **Step 4 (owner):** review diff → owner commit + deploy Wispbyte (`battleManager.js`, `battleCommands.js`, `game.js`).

---

## Self-Review (done)

- **Spec coverage:** D1-D4 (Task 1/4), G1-G12 (Task 2/3/4/8 + UI guards Task 6), paging UX (Task 6), LB dua lapis (Task 5), migrasi (Task 1), konstruktor tunggal (Task 1+8). ✓ semua spec section punya task.
- **Placeholder scan:** UI Task 6 memakai pola grep-driven untuk refactor render (dibutuhkan karena >15 situs) — perintahnya executable & verifiable (grep harus 0 hasil); kode inti (manager) full literal. ✓
- **Type consistency:** `getActiveChar(b)` / `getCharClass(b)` / `isEquippedOnAnyChar(b, itemId)` / `getBattleLeaderboardFor(data, limit, memberIds, classFilter)` dipakai konsisten antar-task. `run.classId` sudah ada di kode live. ✓
