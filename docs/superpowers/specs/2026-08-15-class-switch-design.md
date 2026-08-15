# Class Switch System — Design Spec v2

**Date:** 2026-08-15 · **Status:** DRAFT (awaiting owner approval) · **Supersedes:** `docs/plans/class-switch.md`
**Principle #0:** Pemainnya exploiter semua — setiap fitur didesain dengan sudut "kalau aku jahat, aku lewat mana?" dulu.

---

## 1. Konsep

1 akun = **koleksi karakter** (satu per class), bukan timpa. Karakter lama selalu utuh — level, EXP, nama, best depth, equipment milik masing-masing. Resource & koleksi milik **pemain** (shared): 🧪 Kryptonite, bag drops, seluruh uniqueItems, PvP W/L.

```
battle: {
  activeClass: "mage",
  characters: {
    mage:    { charLevel, charExp, charExpNeeded, charName, bestDepth, equipment, scoreAchievedAt }
    warrior: { ...sama persis... }
  },
  kryptonite, bag, uniqueItems, pvpWins, pvpLosses   // shared, posisinya tetap di battle root
}
```

**Keputusan desain (veto-able):**
| # | Keputusan | Alasan |
|---|---|---|
| D1 | `switchclass` **gratis** | Yang bayar 5.000 🧪 hanya MEMBUAT karakter baru (sink). Memakai yang sudah dimiliki = gratis |
| D2 | `changeclass` **langsung meng-aktifkan** karakter baru | Mental model "aku mau main ini sekarang"; balik ke lama gratis |
| D3 | Karakter baru = **persis pemain baru** (Lv 1, EXP 0, depth 0, tanpa gear, tanpa nama) | Satu konstruktor bersama (lihat §5) |
| D4 | Semua operasi gear hanya ke karakter **aktif** | Pindah gear = unequip → switch → equip (gratis, aman). Nol permukaan "remote modify" |

---

## 2. Commands

| Command | Efek | Biaya |
|---|---|---|
| `ky switch [class]` | **Satu command, auto-detect**: punya → tukar instan; belum punya → embed konfirmasi + tombol (🧪 5,000, bayar hanya setelah klik). Tanpa argumen → usage hint saja (daftar karakter ada di `ky char`). *(rev 2026-08-15: menggantikan pasangan changeclass/switchclass — keduanya jadi alias tersembunyi)* | Gratis / 5,000 🧪 saat create |
| `ky unequip all` | Lepas 5 slot karakter aktif sekaligus (g-item → bag dengan count benar, ky-item tetap di koleksi; guard & lock sama dengan unequip single) | Gratis |
| `ky char [page\|class]` | Panel karakter, **default = karakter aktif** | — |

Registrasi pertama (`ky battle` → pilih class) tetap pakai flow lama → juga memanggil `createCharacterRecord`.

### `ky char` — paging UX
- **Page 1 selalu karakter AKTIF**; page 2+ = karakter lain (urut: urutan class di `battleConfig`).
- Banner atas tiap page:
  - Aktif: `🟢 ACTIVE — ⚔️ Warrior · Lv.150` 
  - Non-aktif: `⚪ INACTIVE — 🔮 Mage · Lv.60` + footer hint `_ky switchclass mage to play this character_`
- Navigasi: tombol ◀️ ▶️ (owner-locked, disabled di page terakhir/pertama) + argumen langsung `ky char 2` / `ky char mage`.
- Admin inspect (`ky char @user`) → paging sama, page 1 = karakter aktif target.

---

## 3. Guard Matrix (anti-exploit — lengkap)

| # | Celah | Guard |
|---|---|---|
| G1 | Switch saat delve run aktif | `battleManager.hasActiveRun(userId)` → tolak |
| G2 | Switch saat PvP fight aktif | `pvp.isInFight(userId)` → tolak |
| G3 | Switch saat **challenge pending** (keluar/masuk) | cek `challengeTimers` → tolak (fight snapshot diambil saat accept — jangan biarkan stats berubah di antara) |
| G4 | Gear ops (equip/unequip/sellgear) saat run/fight | lock yang sudah ada dipertahankan, sekarang juga berlaku per karakter aktif |
| G5 | Satu item terpasang di 2 karakter | `isEquippedOnAnyChar()` — equip ditolak kalau item terpasang di karakter manapun |
| G6 | Jual item yang terpasang di karakter non-aktif | `applySellGear` (single + bulk) skip/tolak item equipped-anywhere |
| G7 | `ky end` menulis ke karakter salah | Run menyimpan **snapshot `charClass` saat delveStart**; extract menulis ke `characters[run.charClass]` — bukan "aktif sekarang" (defense in depth; G1 seharusnya sudah mencegah) |
| G8 | Sweep pakai depth karakter lain | sweep buffer dihitung dari `characters[run.charClass].bestDepth` |
| G9 | Bayar 5k tapi class sudah ada / double-invoke spam | Cek `characters[cls]` ada → **tolak SEBELUM potong 🧪**; potong + create atomic dalam satu write; invoke kedua ketemu char sudah ada → tolak tanpa potong |
| G10 | Karakter baru mewarisi bestDepth/level (bug takut owner) | Konstruktor tunggal §5 + assert test "changeclass record === first-time record" |
| G11 | Pemain benar-benar baru kena migrasi aneh | Migrasi hanya jalan `if (b.charClass && !b.characters)`; pemain baru langsung lahir di struktur baru |
| G12 | Argumen ngawur (`ky switchclass mage` padahal cuma punya warrior) | Tolak dengan daftar karakter yang dimiliki |

---


### charName safety (rev 2026-08-15)
- Rename hanya menyentuh karakter AKTIF.
- Charset ketat `/^[\w\s\-']{1,20}$/` (koma/titik/tilde/backtick/emoji/markdown semua ditolak).
- **Denylist impersonasi**: kata reserved (admin/superadmin/owner/mod/staff/kyriz/system/bot dll., case-insensitive) + tidak boleh sama dengan username Discord pemain mana pun.

## 4. Data Migration (lazy, backwards compatible)

Di `ensureBattleData()` — pola backfill v1.1 yang sudah terbukti:

```js
if (b.charClass && !b.characters) {
  b.characters = { [b.charClass]: {
    charLevel: b.charLevel, charExp: b.charExp, charExpNeeded: b.charExpNeeded,
    charName: b.charName, bestDepth: b.bestDepth || 0,
    equipment: b.equipment || emptySlots(), scoreAchievedAt: b.scoreAchievedAt || null,
  } };
  b.activeClass = b.charClass;
  delete b.charClass; delete b.charLevel; delete b.charExp; delete b.charExpNeeded;
  delete b.charName; delete b.bestDepth; delete b.equipment; delete b.scoreAchievedAt;
}
```

Setelah migrasi, **semua** akses data karakter WAJIB lewat satu pintu:

```js
function getActiveChar(b) { return b.characters[b.activeClass]; }
```

`battleCommands` punya ~belasan bacaan langsung `b.charLevel`/`b.charClass`/`b.equipment` (panel char, LB, PvP panel, admin inspect, battle panel) — semuanya diganti `getActiveChar(b)`. Ini blast radius terbesar dan sumber regresi utama; dikerjakan dengan grep-exhaustive, bukan setengah-setengah.

---

## 5. Konstruktor Tunggal (nyawa anti-bug D3/G10)

```js
function createCharacterRecord() {
  return { charLevel: 1, charExp: 0, charExpNeeded: 100 (CHAR_EXP_BASE), charName: null,
           bestDepth: 0, equipment: emptySlots(), scoreAchievedAt: null };
}
```

Dipakai oleh: (a) registrasi pemain baru, (b) `changeclass`. Tidak ada tempat lain yang boleh bikin record karakter. Test wajib: `assertEqual(createViaRegister(), createViaChangeClass())` — kalau ada yang iseng nambah field bawaan di satu jalur, test meledak.

---

## 6. Leaderboard

- **LB utama** (`ky lb battle [all]`): 1 entri per pemain → pakai karakter dengan `bestDepth` tertinggi (tampilkan class karakter itu, bukan class aktif). Tiebreak: combat score karakter itu → `scoreAchievedAt`.
- **LB per-class (baru)**: `ky lb battle warrior [all]` / `ky lb battle mage [all]` — filter karakter class itu; satu pemain boleh muncul di dua LB.
- Parsing arg: `all` tetep seperti sekarang; tambahan valid value `warrior|mage` (invalid → usage hint).

---

## 7. Blast Radius & Files

| File | Scope | Catatan |
|---|---|---|
| `utils/battleManager.js` | **Major** | migrasi, `getActiveChar`, `createCharacterRecord`, applyChangeClass (atomic 5k🧪), applySwitchClass, semua apply-* baca tulis via karakter aktif/snapshot run, leaderboard (main+per-class), `isEquippedOnAnyChar` di sell/equip |
| `utils/battleCommands.js` | **Major** (naik dari "Medium") | semua render pakai `getActiveChar`; `ky char` paging + banner + tombol; `ky switchclass [class]` UI + picker; `ky changeclass` UI; help text; admin inspect paging; LB arg class |
| `commands/game.js` | Minor | route `changeclass`/`switchclass` (VALID_PREFIX_COMMANDS, requiresRegistration, switch dispatch), `ky char` arg page/class |
| `utils/pvpManager.js`, `battleEngine.js`, `battleConfig.js`, `uniqueItems.js`, `economyManager.js` | **No change** | engine tetap pure; makePlayer di battleCommands sudah baca dari data → cukup ganti sumbernya |

---

## 8. Test Plan (gate sebelum deploy)

1. Suite lama semua hijau (adaptasi assertion yang baca field flat).
2. **Migrasi**: flat → characters utuh (level/depth/equipment/scoreAchievedAt sama persis); idempoten (jalan 2× aman); pemain tanpa class tak tersentuh.
3. **Konstruktor**: record register === record changeclass (field-by-field).
4. **changeclass**: biaya terpotong sekali; class exist → tolak TANPA potong; 🧪 kurang → tolak; langsung aktif.
5. **switchclass**: aktif berganti; data tidak berubah; G1/G2/G3 ditolak.
6. **Isolasi gear**: equip item yang terpasang di char lain → tolak; jual single & bulk equipped-di-mana-pun → skip/tolak; pindah gear via unequip→switch→equip berhasil.
7. **`ky end`**: EXP/depth masuk ke karakter yang menjalankan (ubah activeClass paksa di tengah → tetap ke yang benar).
8. **LB**: entri terbaik; per-class filter; pemain 2 class muncul di 2 LB.
9. **Exploit sweep manual**: coba semua G1-G12 di runtime.
