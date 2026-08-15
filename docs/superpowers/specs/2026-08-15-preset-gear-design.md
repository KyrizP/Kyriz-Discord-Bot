# Preset Gear System — Design Spec v2

**Date:** 2026-08-15 (v2 — slot-numbered, no names, buy via command) · **Status:** APPROVED (owner) · **Order:** ROADMAP #2 — setelah Class Switch

## 1. Konsep

Loadout 5-slot per **akun** (universal), disimpan di **slot bernomor**. Load menukar 5 slot **karakter aktif**; tanpa validasi class (salah preset di class salah = salah pemain). Preset = referensi, BUKAN penyimpanan gear.

## 2. Keputusan owner (final v2)

| # | Keputusan |
|---|---|
| P1 | Per-akun; load menimpa 5 slot karakter aktif |
| P2 | Kapasitas **2 slot gratis**; tambahan via **`ky preset buy slot`** — konfirmasi tombol (tampil slot sekarang X/5 + harga **menanjak**), **cap total 5**. Harga: 2→3 = 🧪 2.000, 3→4 = 🧪 5.000, 4→5 = 🧪 10.000. TIDAK dijual di shop gear |
| P3 | **Tanpa nama custom** — slot bernomor 1..presetSlots. `save 3` saat cuma punya 2 → "You only have 2 preset slots." |
| P4 | **Boleh timpa**: `ky preset save 1` di slot terisi = replace snapshot baru (perilaku natural slot) |
| P5 | Load slot **kosong** → info "Slot 2 is empty" — equipment tak tersentuh. Slot di luar jumlah → info jumlah slot |
| P6 | Snapshot **persis 5 slot** — slot kosong saat save = slot kosong saat load |
| P7 | Panel `ky preset`: **pagination — 1 slot per page** (slot 1 = page 1, dst), navigasi ◀️▶️. Isi page: 5 baris gear format `ky char` (tier badge + stat compact) + ✨ Active Passives, atau "(empty)". Tanpa combat score. **Footer: harga slot BERIKUTNYA + cara beli** |

## 3. Commands

```
ky preset                 → panel daftar slot (+ info cara beli slot)
ky preset save <n>        → snapshot equipment karakter aktif ke slot n (boleh timpa)
ky preset <n>             → load slot n (atomic)
ky preset delete <n>      → kosongkan slot n (alias: del)
ky preset buy [slot]      → embed konfirmasi + tombol (🧪 2.000, +1 slot, max 5)
```

## 4. Guard Matrix

| # | Celah | Guard |
|---|---|---|
| Q1 | Save/load/buy saat run aktif | lock `activeRuns` (sama seperti equip) |
| Q2 | Save/load saat duel / challenge pending | `pvp.isInFight` + pending challenge (UI layer) |
| Q3 | `save/load/delete/buy` nomor invalid / di luar kapasitas | info jelas: "You only have X preset slots." |
| Q4 | Load item yang terjual/hilang | validasi atomic: ky-item harus ada di `uniqueItems`; g-item harus dimiliki. Satu invalid → tolak bulat + sebut item |
| Q5 | Item preset terpasang di karakter LAIN | tolak: "equipped on <class> — unequip there first" |
| Q6 | **Infinite-🧪: jual → equip dari preset → jual lagi** | Lapis 1: SEMUA jalur jual menyapu preset (entry → null). Lapis 2: load tetap divalidasi (Q4). Struktural mustahil |
| Q7 | Beli: dobel-klik tombol / cap / saldo kurang | tombol owner-locked + sekali pakai (disable setelah click) + auto-expire 120s; manager cek cap & saldo → baru potong (atomic) |
| Q8 | Maintenance / T&C / cooldown | command terdaftar normal → semua gate existing berlaku |

## 5. Data Model

```json
"battle": {
  "presets": [ { "slots": { "weapon": "ky1234", "head": "g21", "armor": null, "boots": "g13", "accessory": "g7" } }, null ],
  "presetSlots": 2
}
```
`presets` = array (index 0 = slot 1); `null` = slot kosong. Backfill lazy: `if (!Array.isArray(b.presets)) b.presets = []; if (b.presetSlots == null) b.presetSlots = 2;`

## 6. Load = atomic swap (sama v1)

Resolve slot → kosong → P5 info. Validasi SEMUA entry non-null (Q4+Q5) → ada gagal = tolak, equipment tak tersentuh. Lolos → kembalikan gear lama (g→bag, ky→spare), pasang preset (g dari bag), null→kosong. `scoreAchievedAt = now`.

## 7. Buy flow

`ky preset buy slot` → embed: `Slots: X/5 → X+1/5 · Price: 🧪 <sesuai tabel> · Kryptonite after: Y` + tombol **Confirm/Cancel** (owner-locked, 120s auto-expire, disabled setelah dipakai) → Confirm → `applyBuyPresetSlot` (harga dari tabel menanjak, cek cap & saldo, potong, +1) → reply hasil. Cap 5 / saldo kurang → langsung tolak tanpa tombol.

Tabel harga (konstanta `PRESET_SLOT_PRICES` — key = slot yang DITUJU): `{ 3: 2000, 4: 5000, 5: 10000 }`.

## 8. Files

| File | Scope |
|---|---|
| `utils/battleManager.js` | backfill, konstanta, applyPresetSave/Load/Delete (by slot), purge-on-sell semua jalur, applyBuyPresetSlot, wrapper + lock |
| `utils/battleCommands.js` | handlePreset (dispatch + panel), tombol konfirmasi buy, help text |
| `commands/game.js` | routing `preset` |
| Lainnya | tidak tersentuh |

## 9. Test Plan (test/preset.test.js)

1. Save: nomor valid/invalid, di luar kapasitas (P3), timpa (P4), snapshot persis (P6).
2. Load: exact-restore, slot kosong → info tanpa sentuh equipment (P5), item terjual → tolak (Q4), item di char lain → tolak (Q5), g-item keluar dari bag.
3. **Regresi infinite-🧪 (Q6)**: jual single/bulk → entry preset dinull-kan → load tanpa phantom → jual ulang ditolak.
4. Delete: slot kosong kembali, nomor invalid.
5. Buy slot: harga, cap 5, saldo kurang (tanpa potong).
6. Guards Q1/Q2 di wrapper (mock activeRuns).
