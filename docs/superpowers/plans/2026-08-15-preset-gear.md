# Preset Gear Implementation Plan (v2 — slot-numbered)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. PREREQUISITE: Class Switch plan (`2026-08-15-class-switch.md`) SELESAI dulu — pakai `getActiveChar` & `isEquippedOnAnyChar` dari sana.

**Goal:** Loadout 5-slot per akun di slot bernomor — `ky preset save/load/delete <n>`, 2 slot gratis, `ky preset buy slot` (konfirmasi tombol, 🧪 2.000, cap 5), anti-exploit jual-gear 3 lapis.

**Architecture:** `battle.presets[]` (array, index = slot-1) + `battle.presetSlots` di battleManager (apply-* pure + wrapper locked), purge-on-sell di semua jalur `applySellGear`, panel + tombol konfirmasi buy di battleCommands. Spec: `docs/superpowers/specs/2026-08-15-preset-gear-design.md` (v2).

**Tech Stack:** discord.js v14, JSON economy, test `node test/<name>.test.js`.

## Global Constraints

- **NO COMMIT** (owner workflow) — akhir task = checkpoint run suite.
- Bot text FULL ENGLISH. Jangan sentuh engine/config/uniqueItems/economyManager/data.
- Konstanta: `PRESET_SLOTS_FREE=2, PRESET_SLOTS_CAP=5, PRESET_SLOT_PRICES={3:2000, 4:5000, 5:10000}` (key = slot yang DITUJU — harga menanjak).
- Suite gate tiap task: `for t in preset battleManager battleConfig battleEngine uniqueItems pvp classSwitch crash; do node test/$t.test.js | tail -1; done` (abaikan yang belum ada).

---

### Task 1: Manager core — backfill + save + delete (by slot)

**Files:** Modify `utils/battleManager.js`; Create `test/preset.test.js`

**Interfaces (produces):** `applyPresetSave(data, userId, n)` → `{ok, reason?}`; `applyPresetDelete(data, userId, n)`; wrapper `presetSave/presetDelete` (lock `activeRuns`).

- [ ] **Step 1 — failing tests** (`test/preset.test.js`):

```js
'use strict';
const BM = require('../utils/battleManager');
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : (fail++, console.log('  ❌ ' + m)); };
const mkData = (uid) => ({ [uid]: { username: 'T', balance: 100000, level: 1, xp: 0, xpNeeded: 400, totalWins: 0, totalLosses: 0, totalEarned: 0, totalLost: 0, lastDaily: null, registeredAt: '2026-01-01T00:00:00Z' } });

const d1 = mkData('U1'); BM.ensureBattleData(d1.U1); BM.applyCreateCharacter(d1, 'U1', 'warrior');
const b1 = BM.ensureBattleData(d1.U1);
b1.uniqueItems.kyw1 = { id: 'kyw1', rarity: 'divine', slot: 'weapon', stats: { atk: 48 }, passives: [] };
BM.getActiveChar(b1).equipment.weapon = 'kyw1';
BM.getActiveChar(b1).equipment.head = 'g21';
ok(BM.applyPresetSave(d1, 'U1', 1).ok, 'save slot 1 ok');
ok(b1.presets[0].slots.weapon === 'kyw1' && b1.presets[0].slots.head === 'g21', 'snapshot 5 slot');
ok(b1.presets[0].slots.armor === null, 'P6: slot kosong ikut');
ok(BM.applyPresetSave(d1, 'U1', 2).ok, 'save slot 2 ok (2 gratis)');
ok(!BM.applyPresetSave(d1, 'U1', 3).ok, 'P3: slot 3 ditolak — cuma punya 2');
ok(!BM.applyPresetSave(d1, 'U1', 0).ok && !BM.applyPresetSave(d1, 'U1', -1).ok, 'nomor invalid ditolak');
// P4: timpa
BM.getActiveChar(b1).equipment.weapon = null;
ok(BM.applyPresetSave(d1, 'U1', 1).ok, 'timpa slot 1 ok');
ok(b1.presets[0].slots.weapon === null, 'P4: isi baru menggantikan lama');
// delete + kapasitas tidak berubah (slot tetap milik user, isinya saja kosong)
ok(BM.applyPresetDelete(d1, 'U1', 2).ok && b1.presets[1] === null, 'delete slot 2 -> null');
ok(!BM.applyPresetDelete(d1, 'U1', 5).ok, 'delete slot di luar kapasitas ditolak');
console.log('\n' + (fail === 0 ? '✅ OK' : '❌ FAIL') + ' — Pass: ' + pass + ' | Fail: ' + fail);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2 — run → FAIL.** **Step 3 — implement:**

`ensureBattleData` backfill tambah:
```js
  if (!Array.isArray(b.presets)) b.presets = [];
  if (b.presetSlots == null) b.presetSlots = PRESET_SLOTS_FREE;
```
Konstanta + apply:
```js
const PRESET_SLOTS_FREE = 2, PRESET_SLOTS_CAP = 5, PRESET_SLOT_PRICE = 2000;

function presetSlotNum(n) { const v = parseInt(n, 10); return Number.isInteger(v) ? v : NaN; }
function presetSlotValid(b, n) { return Number.isInteger(n) && n >= 1 && n <= b.presetSlots; }

function applyPresetSave(data, userId, n) {
  const b = ensureBattleData(data[userId]);
  const c = getActiveChar(b);
  if (!c) return { ok: false, reason: 'Create a character first (`ky battle`).' };
  const num = presetSlotNum(n);
  if (!presetSlotValid(b, num)) return { ok: false, reason: 'You only have ' + b.presetSlots + ' preset slot' + (b.presetSlots > 1 ? 's' : '') + '.' };
  b.presets[num - 1] = { slots: { ...c.equipment } }; // P4: overwrite by design
  return { ok: true, slot: num };
}

function applyPresetDelete(data, userId, n) {
  const b = ensureBattleData(data[userId]);
  const num = presetSlotNum(n);
  if (!presetSlotValid(b, num)) return { ok: false, reason: 'You only have ' + b.presetSlots + ' preset slot' + (b.presetSlots > 1 ? 's' : '') + '.' };
  if (!b.presets[num - 1]) return { ok: false, reason: 'Slot ' + num + ' is already empty.' };
  b.presets[num - 1] = null;
  return { ok: true, slot: num };
}
```
Wrapper (lock sama seperti equip):
```js
function presetSave(userId, n) {
  if (activeRuns.has(userId)) return { ok: false, reason: 'Finish or end your battle first (`ky end`).' };
  const data = economy.readEconomy(); ensureUser(data, userId);
  const r = applyPresetSave(data, userId, n);
  if (r.ok) economy.writeEconomy(data);
  return r;
}
function presetDelete(userId, n) { /* identik, r.ok -> write */ }
```
Export: `applyPresetSave, applyPresetDelete, presetSave, presetDelete, PRESET_SLOTS_FREE, PRESET_SLOTS_CAP, PRESET_SLOT_PRICE`.

- [ ] **Step 4 — run → PASS.**

---

### Task 2: Load — validasi + atomic swap (by slot)

**Files:** Modify `utils/battleManager.js`; Test append

**Interfaces:** `applyPresetLoad(data, userId, n)` → `{ok, reason?, loaded?}`; wrapper `presetLoad`.

- [ ] **Step 1 — failing tests:**

```js
const d2 = mkData('U2'); BM.ensureBattleData(d2.U2); BM.applyCreateCharacter(d2, 'U2', 'warrior');
const b2 = BM.ensureBattleData(d2.U2);
b2.uniqueItems.kyw1 = { id: 'kyw1', rarity: 'divine', slot: 'weapon', stats: { atk: 48 }, passives: [] };
b2.bag.g21 = 1; b2.bag.g13 = 1;
BM.getActiveChar(b2).equipment.weapon = 'kyw1';
BM.applyPresetSave(d2, 'U2', 1);
BM.getActiveChar(b2).equipment.weapon = null;
BM.getActiveChar(b2).equipment.head = 'g21'; b2.bag.g21 -= 1;
ok(BM.applyPresetLoad(d2, 'U2', 1).ok, 'load slot 1 ok');
const c2 = BM.getActiveChar(b2);
ok(c2.equipment.weapon === 'kyw1', 'weapon terpasang');
ok(c2.equipment.head === null, 'P6: head kosong di snapshot = kosong setelah load');
ok(b2.bag.g21 === 1, 'gear lama kembali ke bag');
BM.getActiveChar(b2).equipment.boots = 'g13'; b2.bag.g13 -= 1;
BM.applyPresetSave(d2, 'U2', 2);
BM.getActiveChar(b2).equipment.boots = null;
ok(BM.applyPresetLoad(d2, 'U2', 2).ok && BM.getActiveChar(b2).equipment.boots === 'g13', 'load g-item dari bag');
ok(!b2.bag.g13, 'g-item habis dari bag saat dipasang');
// P5: slot kosong -> info, tak tersentuh
BM.applyPresetDelete(d2, 'U2', 1);
const before = JSON.stringify(BM.getActiveChar(b2).equipment);
const e1 = BM.applyPresetLoad(d2, 'U2', 1);
ok(!e1.ok && /Slot 1 is empty/.test(e1.reason), 'P5: slot kosong -> info');
ok(JSON.stringify(BM.getActiveChar(b2).equipment) === before, 'P5: equipment tak tersentuh');
const e2 = BM.applyPresetLoad(d2, 'U2', 7);
ok(!e2.ok && /only have 2/.test(e2.reason), 'P3: slot 7 -> info jumlah slot');
```

- [ ] **Step 2 — FAIL.** **Step 3 — implement:**

```js
function applyPresetLoad(data, userId, n) {
  const b = ensureBattleData(data[userId]);
  const c = getActiveChar(b);
  if (!c) return { ok: false, reason: 'Create a character first (`ky battle`).' };
  const num = presetSlotNum(n);
  if (!presetSlotValid(b, num)) return { ok: false, reason: 'You only have ' + b.presetSlots + ' preset slot' + (b.presetSlots > 1 ? 's' : '') + '.' };
  const p = b.presets[num - 1];
  if (!p) return { ok: false, reason: 'Slot ' + num + ' is empty. Save it first: `ky preset save ' + num + '`.' }; // P5
  // validate ALL non-null entries — atomic (Q4/Q5)
  const active = b.activeClass;
  for (const [slot, id] of Object.entries(p.slots)) {
    if (!id) continue;
    if (id.startsWith('ky')) {
      if (!b.uniqueItems[id]) return { ok: false, reason: `Preset item '${id}' is no longer in your collection — save the preset again.` };
    } else {
      const owned = (b.bag[id] || 0) > 0 || c.equipment[slot] === id;
      if (!GEAR[id] || !owned) return { ok: false, reason: `Preset item '${id}' (${slot}) is not owned anymore — save the preset again.` };
    }
    for (const [cls2, ch2] of Object.entries(b.characters)) { // Q5: on ANOTHER char
      if (cls2 === active) continue;
      if (ch2.equipment && Object.values(ch2.equipment).includes(id)) {
        return { ok: false, reason: `'${id}' is equipped on your ${CLASSES[cls2].name} — unequip it there first.` };
      }
    }
  }
  // swap: return old gear, apply preset
  for (const slot of Object.keys(c.equipment)) {
    const prev = c.equipment[slot];
    if (prev && prev.startsWith('g')) b.bag[prev] = (b.bag[prev] || 0) + 1; // ky stays spare in uniqueItems
  }
  for (const [slot, id] of Object.entries(p.slots)) {
    if (id && !id.startsWith('ky') && c.equipment[slot] !== id) {
      b.bag[id] -= 1; if (b.bag[id] <= 0) delete b.bag[id];
    }
    c.equipment[slot] = id || null;
  }
  c.scoreAchievedAt = new Date().toISOString();
  return { ok: true, loaded: num };
}
```
Wrapper `presetLoad` (lock + write-if-ok). Export.

- [ ] **Step 4 — PASS + suite.**

---

### Task 3: Purge-on-sell + buy slot (inti anti-exploit)

**Files:** Modify `utils/battleManager.js` (applySellGear semua jalur, baru applyBuyPresetSlot); Test append

**Interfaces:** `purgePresetsItem(b, itemId)` (internal+export), `applyBuyPresetSlot(data, userId)`, `buyPresetSlot(userId)`.

- [ ] **Step 1 — failing tests (termasuk regresi infinite-🧪):**

```js
const d3 = mkData('U3'); BM.ensureBattleData(d3.U3); BM.applyCreateCharacter(d3, 'U3', 'warrior');
const b3 = BM.ensureBattleData(d3.U3);
b3.uniqueItems.kyw2 = { id: 'kyw2', rarity: 'divine', slot: 'weapon', stats: { matk: 48 }, passives: [] };
BM.getActiveChar(b3).equipment.weapon = 'kyw2';
b3.kryptonite = 0;
BM.applyPresetSave(d3, 'U3', 1);
BM.getActiveChar(b3).equipment.weapon = null;
const kryBefore = b3.kryptonite;
ok(BM.applySellGear(d3, 'U3', 'kyw2', 1).ok, 'jual kyw2 ok');
ok(b3.kryptonite > kryBefore, 'dapat 🧪 sekali');
ok(b3.presets[0].slots.weapon === null, 'Q6 lapis1: preset dinull-kan saat jual');
ok(!b3.uniqueItems.kyw2, 'item hilang dari koleksi');
ok(BM.applyPresetLoad(d3, 'U3', 1).ok, 'load preset (slot weapon kini null) tidak error');
ok(BM.getActiveChar(b3).equipment.weapon === null, 'Q6 lapis2: tidak ada phantom item');
ok(!BM.applySellGear(d3, 'U3', 'kyw2', 1).ok, 'jual ulang -> tolak');
// bulk juga purge:
b3.uniqueItems.kyw3 = { id: 'kyw3', rarity: 'divine', slot: 'head', stats: { def: 20 }, passives: [] };
b3.presets[0].slots.head = 'kyw3';
ok(BM.applySellGear(d3, 'U3', 'divine', 'all').ok, 'bulk divine jual');
ok(b3.presets[0].slots.head === null, 'bulk juga purge preset');
// g-item spare terjual juga purge:
b3.bag.g10 = 1; b3.presets[0].slots.weapon = 'g10';
ok(BM.applySellGear(d3, 'U3', 'g10', 1).ok, 'jual g10 spare');
ok(b3.presets[0].slots.weapon === null, 'g-item juga purge');

// buy slot — harga menanjak: 2→3 = 2000, 3→4 = 5000, 4→5 = 10000
const d4 = mkData('U4'); BM.ensureBattleData(d4.U4); BM.applyCreateCharacter(d4, 'U4', 'mage');
const b4 = BM.ensureBattleData(d4.U4);
b4.kryptonite = 5000;
ok(BM.applyBuyPresetSlot(d4, 'U4').ok && b4.presetSlots === 3 && b4.kryptonite === 3000, '2→3: +1 slot, 2000 terpotong');
ok(BM.applyPresetSave(d4, 'U4', 3).ok, 'slot baru bisa dipakai');
b4.kryptonite = 4000;
ok(!BM.applyBuyPresetSlot(d4, 'U4').ok && b4.kryptonite === 4000, '3→4 butuh 5000: kurang -> tolak tanpa potong');
b4.kryptonite = 6000;
ok(BM.applyBuyPresetSlot(d4, 'U4').ok && b4.presetSlots === 4 && b4.kryptonite === 1000, '3→4: 5000 terpotong');
b4.kryptonite = 10000;
ok(BM.applyBuyPresetSlot(d4, 'U4').ok && b4.presetSlots === 5 && b4.kryptonite === 0, '4→5: 10000 terpotong');
b4.kryptonite = 999999;
ok(!BM.applyBuyPresetSlot(d4, 'U4').ok, 'cap 5 ditolak');
b4.presetSlots = 4; b4.kryptonite = 100;
ok(!BM.applyBuyPresetSlot(d4, 'U4').ok && b4.kryptonite === 100, 'saldo kurang: tolak tanpa potong');
```

- [ ] **Step 2 — FAIL.** **Step 3 — implement:**

```js
// Q6 layer 1: every sell path must drop the item from all presets.
function purgePresetsItem(b, itemId) {
  for (const p of b.presets) {
    if (!p) continue;
    for (const slot of Object.keys(p.slots)) if (p.slots[slot] === itemId) p.slots[slot] = null;
  }
}
```
Panggil `purgePresetsItem(b, itemId)` di `applySellGear` SETIAP cabang yang menghapus item: single-ky (setelah `delete b.uniqueItems[itemId]`), bulk-unique (per id terjual), template single & bulk (per id yang `delete b.bag[id]`).
```js
function applyBuyPresetSlot(data, userId) {
  const b = ensureBattleData(data[userId]);
  const price = PRESET_SLOT_PRICES[b.presetSlots + 1];
  if (!price) return { ok: false, reason: 'Preset slots maxed out (' + PRESET_SLOTS_CAP + ').' };
  if ((b.kryptonite || 0) < price) return { ok: false, reason: 'The next preset slot costs 🧪 ' + price.toLocaleString() + ' Kryptonite.' };
  b.kryptonite -= price;
  b.presetSlots += 1;
  return { ok: true, presetSlots: b.presetSlots, kryptonite: b.kryptonite, price };
}
function buyPresetSlot(userId) {
  if (activeRuns.has(userId)) return { ok: false, reason: 'Finish or end your battle first (`ky end`).' };
  const data = economy.readEconomy(); ensureUser(data, userId);
  const r = applyBuyPresetSlot(data, userId);
  if (r.ok) economy.writeEconomy(data);
  return r;
}
```
Export semuanya.

- [ ] **Step 4 — PASS + suite.**

---

### Task 4: battleCommands — panel, dispatch, tombol konfirmasi buy, help

**Files:** Modify `utils/battleCommands.js`

- [ ] **Step 1 — ekstrak helper** `formatGearLine(id, b)` dari inline-gear-lines `handleCharacter` (tier badge + nama + stat compact; `null` → `—`) — char panel & panel preset pakai bersama (DRY, visual char tidak berubah).
- [ ] **Step 2 — handlePreset:**

```js
async function handlePreset(context, userId, args) {
  if (pvp.isInFight(userId)) return context.reply({ content: 'Finish your duel first.' });
  if (hasPendingChallenge(userId)) return context.reply({ content: 'You have a pending duel challenge — settle it first.' });
  const sub = (args[0] || '').toLowerCase();
  if (!sub) return context.reply({ embeds: [buildPresetPanel(userId)] });
  if (sub === 'save') { const r = battle.presetSave(userId, args[1]); return context.reply({ content: r.ok ? `✅ Preset ${r.slot} saved.` : r.reason }); }
  if (sub === 'delete' || sub === 'del') { const r = battle.presetDelete(userId, args[1]); return context.reply({ content: r.ok ? `🗑️ Preset ${r.slot} cleared.` : r.reason }); }
  if (sub === 'buy') return handlePresetBuy(context, userId);            // 'slot' opsional
  const r = battle.presetLoad(userId, args[0]);
  return context.reply({ content: r.ok ? `✅ Preset ${r.loaded} equipped.` : r.reason });
}
```
- [ ] **Step 3 — buildPresetPanel + pagination:** **1 slot per page** (slot 1 = page 1 … slot N = page N), navigasi ◀️ (`battle_presetpage_<userId>_<n-1>`) / ▶️ (`battle_presetpage_<userId>_<n+1>`), disabled di ujung, owner-locked. Isi page slot N: judul `🎒 Gear Presets — Slot N/TOTAL`, 5 baris `formatGearLine` + `✨ Active Passives` (getPassives compact), atau `(empty)`; footer: `Next slot: 🧪 <harga menanjak> · ky preset buy slot` (atau `Max slots reached` kalau sudah 5). handleButton: branch prefix `battle_presetpage_` → rebuild page.
- [ ] **Step 4 — handlePresetBuy + tombol:**
  - Cap tercapai / saldo kurang → langsung reply reason (tanpa tombol).
  - Kalau lolos → embed `Slots: X/5 → X+1/5 · Price: 🧪 <PRESET_SLOT_PRICES[X+1]> · Kryptonite after: Y` + ActionRow **Confirm** (`battle_presetbuy_<userId>`) / **Cancel** (`battle_presetcancel_<userId>`), auto-disable 120s.
  - handleButton branch prefix `battle_presetbuy_` / `battle_presetcancel_` (owner-locked seperti battle_ lain): Confirm → `battle.buyPresetSlot(userId)` → edit message hasil; Cancel → edit "Cancelled.".
- [ ] **Step 5 — help:** `ky help` battle section += `preset [n|save n|delete n|buy slot]`; `ky battle help` += paragraf pendek.
- [ ] **Step 6 — `node --check` + suite.**

---

### Task 5: game.js routing + full gate

**Files:** Modify `commands/game.js`; smoke E2E

- [ ] **Step 1:** `VALID_PREFIX_COMMANDS` += `'preset'`; prefix `requiresRegistration` += `'preset'`; dispatch: `case 'preset': return battleCmd.handlePreset(message, userId, args);`
- [ ] **Step 2:** SEMUA suite → `Fail: 0`.
- [ ] **Step 3 — smoke E2E lokal:** equip 5 gear → `ky preset save 1` → ganti gear → `ky preset 1` (balik persis) → `ky preset` panel → jual satu item preset → panel slot null → `ky preset buy slot` (konfirmasi tombol, 2k🧪) → `ky preset save 3` → `ky preset delete 3`. Catat untuk owner.
- [ ] **Step 4 (owner):** review → commit → deploy (`battleManager.js`, `battleCommands.js`, `game.js`).

---

## Self-Review (done)

- **Spec v2 coverage:** P1-P7 (Task 1/2/4), Q1-Q8 (Task 1-4 + routing), buy via tombol konfirmasi bukan shop (Task 4), purge semua jalur (Task 3). ✓
- **Placeholder:** manager code full literal; UI Task 4 kerangka lengkap dengan isi reply eksplisit. ✓
- **Konsistensi:** `presetSlotNum/presetSlotValid`, `applyPresetSave/Load/Delete(n)`, `purgePresetsItem`, `applyBuyPresetSlot`, customId `battle_presetbuy_<uid>` seragam antar-task; `getActiveChar`/`isEquippedOnAnyChar` dari plan class-switch. ✓
