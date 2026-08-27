# Economy SQLite Migration — Design Spec v1.2

**Date:** 2026-08-24 · **Status:** REVISED after code-verified review
**Changelog v1.2 (input implementor, terverifikasi):** kategorisasi battleCommands dikoreksi (539=bulk admin scan, 1130/1162=2-player read) · **materialisasi kolom ranking masuk scope** (`best_depth`, `battle_score`, `abyss_best_floor`, `abyss_total_stars`) dengan kontrak extractor tunggal · guard gzip >50MB → cloud · parity harness di-scope ke API surface economyManager (replay battle/shop dilepas ke round-trip + functional) · catatan kyID admin scan
**Changelog v1.1:** battleCommands.js masuk scope (C1) · backup DM via `db.backup()` (C2) · kontrak special-case superadmin (C3) · filter leaderboard diperbaiki (C4) · kolom `extra` catch-all (I1) · kode error `SQLITE_FULL` (I2) · init eager (I3) · runbook Raznar + gladi migrasi data real (I4) · parity harness (I5) · catatan skala 100k · nits

> **Goal:** Migrasi seluruh economy data dari `economy.json` (blocking full-file read/write) ke SQLite (`economy.db`) via `better-sqlite3` — tanpa downtime, tanpa user action, tanpa perubahan behavior. Setelah migrasi, `economy.json` tidak lagi dibaca/ditulis oleh code production mana pun (satu-satunya referensi tersisa: blok auto-migration saat boot, dan file di-rename jadi `.json.pre-sqlite`).

---

## §1 Masalah yang Diselesaikan

| # | Masalah (JSON) | Solusi (SQLite) |
|:---|:---|:---|
| 1 | Setiap operasi = baca & tulis **SELURUH** file (230KB sekarang, ~20MB di 10K player) | Per-row `UPDATE` — microseconds |
| 2 | Blocking `readFileSync`/`writeFileSync` = event loop freeze | `better-sqlite3` sync tapi C-level (10-100x lebih cepat) |
| 3 | Write berukuran besar rentan gagal di disk sempit | Write per-page (KB) — jauh lebih sering lolos |
| 4 | Crash mid-write = corruption risk | WAL mode = crash-safe, ACID |
| 5 | Corrupt JSON → reset diam-diam (insiden 2026-08-17) | Integrity check at boot, refuse to operate, `.pre-sqlite` rename |
| 6 | Backup = copy seluruh file | `.backup()` API (WAL-aware, konsisten) |

---

## §2 Scope

### ✅ IN SCOPE
- `economy.json` → `economy.db` (SQLite)
- Auto-migration saat boot (transparent, satu arah)
- Rolling backup system → SQLite native `.backup()`
- Daily DM backup + `ky backup` → kirim `.db` **hasil `db.backup()`**, bukan file mentah
- Semua economy operations: balance, XP, daily, transfer, leaderboard, shop, battle, abyss
- **Materialisasi kolom ranking** (`best_depth`, `battle_score`, `abyss_best_floor`, `abyss_total_stars`) + konversi LB/rank paths ke SQL indexed (§3.1) — dimasukkan sekarang karena schema sedang dibuat fresh (gratis); menunda = ALTER + backfill di DB live

### ❌ OUT OF SCOPE
- `replies.json`, `users.json`, `botState.json` — kecil, jarang ditulis, tetap JSON
- Game state in-memory (`activeGames`, `activeRuns`, `activePvpFights`)
- Materialisasi kolom battle-score: sebagian BESAR sudah masuk scope v1.2 (§3.1); yang tetap phase 2 dicatat di §12

---

## §3 Schema

### Hybrid Approach: flat columns + JSON columns + catch-all

```sql
CREATE TABLE IF NOT EXISTS players (
  user_id       TEXT PRIMARY KEY,
  username      TEXT NOT NULL,
  balance       INTEGER NOT NULL DEFAULT 100000,
  level         INTEGER NOT NULL DEFAULT 1,
  xp            INTEGER NOT NULL DEFAULT 0,
  xp_needed     INTEGER NOT NULL DEFAULT 400,
  total_wins    INTEGER NOT NULL DEFAULT 0,
  total_losses  INTEGER NOT NULL DEFAULT 0,
  total_earned  INTEGER NOT NULL DEFAULT 0,
  total_lost    INTEGER NOT NULL DEFAULT 0,
  last_daily    TEXT,
  registered_at TEXT NOT NULL,
  is_admin      INTEGER NOT NULL DEFAULT 0,

  -- Nested data as JSON text (accessed together, rarely queried individually)
  inventory     TEXT NOT NULL DEFAULT '{}',
  active_boosts TEXT NOT NULL DEFAULT '{}',
  cosmetics     TEXT NOT NULL DEFAULT '{}',
  transfer_data TEXT NOT NULL DEFAULT '{}',
  battle        TEXT,                          -- NULL = belum ada data battle

  -- CATCH-ALL: field player masa depan yang belum punya kolom.
  -- writePlayer menyimpan field tak dikenal di sini; readPlayer merge balik.
  -- Tanpa ini, fitur baru yang menambah field akan HILANG DIAM-DIAM.
  extra         TEXT NOT NULL DEFAULT '{}',

  -- MATERIALIZED RANKING (di-update otomatis oleh writePlayer via extractor —
  -- lihat §3.1). best_depth/battle_score untuk `ky lb battle` + battle rank di
  -- profile; abyss_best_floor/abyss_total_stars untuk `ky battle abyss lb`.
  -- Tanpa ini, tiap LB/profile = full-scan + computeStats semua player.
  best_depth        INTEGER NOT NULL DEFAULT 0,
  battle_score      INTEGER NOT NULL DEFAULT 0,
  score_achieved_at TEXT NOT NULL DEFAULT '9999',   -- tiebreak ke-3 legacy: capai duluan menang
  abyss_best_floor  INTEGER NOT NULL DEFAULT 0,
  abyss_total_stars INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_balance ON players(balance DESC);
CREATE INDEX IF NOT EXISTS idx_level ON players(level DESC);
CREATE INDEX IF NOT EXISTS idx_battle_rank ON players(best_depth DESC, battle_score DESC, score_achieved_at ASC);
CREATE INDEX IF NOT EXISTS idx_abyss_rank ON players(abyss_best_floor DESC, abyss_total_stars DESC);
```

### §3.1 Kontrak Materialisasi Ranking (WAJIB)

Kolom ranking adalah nilai derived — ada dua aturan yang menjaga kebenarannya:

1. **Extractor tunggal, satu sumber kebenaran.** `battleEngine.extractBattleRanking(battleObj, registeredAt)` → `{ bestDepth, battleScore, scoreAchievedAt }` (triple lengkap — sort legacy: bestDepth desc → score desc → achievedAt asc, fallback `best.ch.scoreAchievedAt || registeredAt || '9999'`) dan `battleEngine.extractAbyssRanking(battleObj)` → `{ bestFloor, totalStars }` — pure functions di `battleEngine.js` (sudah pure-math, tanpa import balik ke economyManager — aman dari circular dep). `writePlayer` MEMANGGIL extractor ini setiap write; LB global paths **beralih membaca kolom materialized** (bukan menghitung sendiri). Dilarang duplikasi logika pemilihan best-char di dua tempat.
   - **Pembagian jalur LB (kunci, terverifikasi):** yang pindah ke kolom materialized = **global battle rank** (`getBattleGlobalRank` — hot path, dipanggil tiap `ky profile`) + **LB battle global**. Yang TETAP di jalur bulk `readAllPlayers` + computeStats = varian **memberIds** (LB server, `getBattleLeaderboardFor`) dan **classFilter** (`ky lb battle <class>`) — command langka, kolom materialized tidak mengandung info per-class/per-server.
   - ⛔ **Battle LB/rank TIDAK mengecualikan admin/superadmin** (terverifikasi `buildBattleLeaderboard`: hanya filter memberIds + kehadiran `battle`). Filter `user_id != SUPERADMIN AND is_admin = 0` itu **EKSKLUSIF LB Kryztal** — JANGAN salin ke SQL battle rank/LB.
2. **Aturan retune:** `battle_score` ter-derive dari `computeStats` — setiap perubahan formula balance WAJIB disertai one-time recompute sweep (UPDATE tiap row lewat extractor). Tulis aturan ini sebagai comment di `battleEngine.extractBattleRanking`. `abyss_*` bebas dari aturan ini (data mentah, bukan formula).

Parity assertion (§11.2c) memastikan urutan LB materialized == urutan LB legacy pada data fixture — penangkap drift antara extractor dan logika lama.

### Kenapa hybrid, bukan full-relational?

- `battle` object punya kedalaman 4+ (characters → equipment → slots, uniqueItems → passives → [])
- Memecah jadi 10+ tabel = overkill, bikin migrasi sangat berisiko
- Consumer code (`battleManager`, `shopManager`) sudah pattern read-object → mutate → write-object
- JSON column di SQLite = query-able via `json_extract()` kalau perlu
- **Sweet spot**: flat untuk yang sering di-query (leaderboard: `ORDER BY balance DESC`), JSON untuk nested data

### Column mapping dari JSON

| JSON field | Column | Type |
|:---|:---|:---|
| key (userId) | `user_id` | TEXT PK |
| `username` | `username` | TEXT |
| `balance` | `balance` | INTEGER |
| `level` | `level` | INTEGER |
| `xp` | `xp` | INTEGER |
| `xpNeeded` | `xp_needed` | INTEGER |
| `totalWins` | `total_wins` | INTEGER |
| `totalLosses` | `total_losses` | INTEGER |
| `totalEarned` | `total_earned` | INTEGER |
| `totalLost` | `total_lost` | INTEGER |
| `lastDaily` | `last_daily` | TEXT (nullable) |
| `registeredAt` | `registered_at` | TEXT |
| `isAdmin` | `is_admin` | INTEGER (0/1) |
| `inventory` | `inventory` | TEXT (JSON) |
| `activeBoosts` | `active_boosts` | TEXT (JSON) |
| `cosmetics` | `cosmetics` | TEXT (JSON) |
| `transferData` | `transfer_data` | TEXT (JSON) |
| `battle` | `battle` | TEXT (JSON, nullable) |
| (derived: best char depth) | `best_depth` | INTEGER — via extractor §3.1 |
| (derived: best char score) | `battle_score` | INTEGER — via extractor §3.1 |
| (derived: abyss stars) | `abyss_best_floor`, `abyss_total_stars` | INTEGER — via extractor §3.1 |
| **field lain apa pun** | `extra` | TEXT (JSON) |

**Round-trip rule (WAJIB):** `readPlayer(writePlayer(obj))` harus menghasilkan objek yang `deep-equal` dengan `obj` — termasuk: kolom `battle` NULL → key `battle` **tidak ada** di hasil (omit, bukan `battle: null`), dan field tak dikenal selamat lewat `extra`.

### Verifikasi terhadap data real

Field yang benar-benar ada di data live (17 field, dicek terhadap snapshot server): `activeBoosts, balance, battle, cosmetics, inventory, isAdmin, lastDaily, level, registeredAt, totalEarned, totalLosses, totalLost, totalWins, transferData, username, xp, xpNeeded` — semuanya ter-cover mapping di atas.

---

## §4 economyManager.js — New API Surface

### Internal: DB singleton — EAGER INIT

```js
const Database = require('better-sqlite3');
const DB_PATH = path.join(__dirname, '..', 'data', 'economy.db');

// EAGER, di module top-level — BUKAN lazy. Alasan: backupEconomy() dipanggil
// di index.js saat boot; urutan siapa-yang-sentuh-DB-duluan harus deterministik.
// Init di sini = migrasi selesai SEBELUM command/backup/interval apa pun jalan.
const db = initDb(); // pragma + schema + auto-migration (§5)
```

Pragmas: `journal_mode = WAL`, `foreign_keys = ON`, plus `synchronous = NORMAL` (default aman untuk WAL, cukup cepat).

### ⛔ Kontrak Special-Case Superadmin (WAJIB dipertahankan persis)

Kode sekarang **early-return SEBELUM menyentuh data** untuk superadmin. Implementasi SQL **tidak boleh** mengganti ini dengan query literal:

| Function | Superadmin behavior sekarang (pertahankan) |
|:---|:---|
| `addBalance(uid, amt)` | `return { success: true, newBalance: Infinity }` — **tanpa write** |
| `removeBalance(uid, amt)` | `return { success: true, message: 'OK', newBalance: Infinity }` — **tanpa write** |
| `getBalance(uid)` | `return Infinity` — tanpa query |
| `addXP(uid, amt)` | `return { leveledUp: false, newLevel: 0, xp: 0, xpNeeded: 0 }` |
| `claimDaily(uid)` | `return { success: true, message: 'Daily claimed.', amount: 0, isSuperAdmin: true }` |

Ini yang membuat kasino superadmin punya saldo tak terbatas & bypass semua limit. Implementasi literal `SELECT balance...` akan **merusak kasino untuk owner**.

### ⛔ Kontrak Return Shape (dipakai game.js untuk embed — drift = bug UI)

| Function | Return (pertahankan field persis) |
|:---|:---|
| `addBalance` | `{ success: boolean, newBalance }` (+ `message` di branch gagal) |
| `removeBalance` | `{ success, message, newBalance }` |
| `addXP` | `{ leveledUp, levelsGained, newLevel, xp, xpNeeded, ... }` — cek implementasi lama untuk field lengkap |
| `claimDaily` | `{ success, message, amount, ... }` (+ `isSuperAdmin` untuk superadmin) |
| `transfer` | `{ success, message }` |
| `registerUser` | `{ success, message }` — starting balance `100000` |

### Filter Leaderboard/Rank (PARITY — jangan salah)

Kode sekarang mengecualikan **superadmin by env ID** *dan* **admin by flag**:

```sql
-- getLeaderboard / getGlobalRank / getAllPlayers harus memakai filter setara:
WHERE user_id != ?   -- ? = process.env.SUPERADMIN_ID
  AND is_admin = 0
ORDER BY balance DESC, rowid ASC   -- rowid = insertion order = urutan JSON lama, match stable-sort sekarang
```

`getAllPlayers()` tetap return **array** of `{ userId, ...user }` sorted balance desc (bukan dict) — sesuai konsumen `ky players`.

### Exported functions — SAME SIGNATURES, SAME RETURNS

Semua function yang di-export **tetap sama signature dan return value**. Consumer code **ga perlu diubah sama sekali** untuk functions ini:

| Function | Sekarang (JSON) | Nanti (SQLite) |
|:---|:---|:---|
| `isRegistered(userId)` | `readJSON` → `!!data[userId]` | `SELECT 1 FROM players WHERE user_id = ?` |
| `registerUser(userId, username)` | read all → insert → write all | `INSERT INTO players ...` (balance default 100000) |
| `getUser(userId)` | read all → `data[userId]` | `SELECT *` → reconstruct object |
| `updateUsername(userId, username)` | read → update → write | `UPDATE SET username = ?` — **pertahankan skip-write kalau nama sama** |
| `getBalance(userId)` | superadmin → Infinity | superadmin → Infinity; lainnya `SELECT balance` |
| `addBalance(userId, amount)` | read → mutate → write | `UPDATE SET balance = balance + ?, total_earned = total_earned + ?` |
| `removeBalance(userId, amount)` | read → check → mutate → write | `SELECT balance` → check → `UPDATE SET balance = balance - ?, total_lost...` (cek paritas field yang di-update) |
| `transfer(from, to, amount)` | read → mutate 2 rows → write | **Transaction**: `BEGIN` → deduct + credit + transferData → `COMMIT` |
| `addXP(userId, amount)` | read → level loop → write | `SELECT` → level loop di JS (reward random level-up 150k-500k dipertahankan) → `UPDATE` |
| `recordWin`/`recordLoss` | read → increment → write | `UPDATE SET total_wins = total_wins + 1` |
| `claimDaily(userId)` | read → check lastDaily → mutate | `SELECT last_daily` → check WIB → `UPDATE` |
| `getLeaderboard(limit)` | filter → sort → slice | `WHERE user_id != ? AND is_admin = 0 ORDER BY balance DESC, rowid LIMIT ?` |
| `getAllPlayers()` | filter superadmin → map → sort | `SELECT * WHERE user_id != ? ORDER BY balance DESC, rowid` → array |
| `getGlobalRank(userId)` | sort → findIndex | `SELECT COUNT(*)+1 WHERE balance > (subquery) AND filter yang sama` |
| `isAdmin/setAdmin/removeAdmin` | field ops | direct column ops |

### New functions untuk battleManager/shopManager/battleCommands

Pengganti pola `readEconomy()`/`writeEconomy()`:

```js
// Read satu player sebagai object (format SAMA dengan JSON entry lama)
function readPlayer(userId) → object | null

// Write satu player object kembali ke DB (flat + JSON kolom + extra catch-all
// + auto-update kolom ranking via extractor §3.1)
function writePlayer(userId, playerObj) → void

// Read semua players sebagai { userId: playerObj } — HANYA untuk boot sweeps,
// bansos, dan admin full-scan (kyID search). JANGAN dipakai untuk lookup/LB —
// LB & rank sudah lewat kolom materialized + SQL.
function readAllPlayers() → object

// Transfer/pvP multi-player: bungkus dalam SATU transaction
function withTransaction(fn) → fn(db)   // BEGIN…COMMIT/ROLLBACK
```

### ⛔ `readEconomy`/`writeEconomy` DIHAPUS dari exports — fail-loud by design

Setelah semua consumer beradaptasi, dua binding ini **dihapus**. Jika ada callsite yang terlewat, aplikasi gagal **keras dan terlihat** saat test/dev (`economy.readEconomy is not a function`), bukan diam-diam full-scan. Verifikasi wajib (lihat §11): grep `readEconomy|writeEconomy` di `commands/ utils/ handlers/ index.js` = **0 hit** setelah migrasi.

---

## §5 Auto-Migration Flow

```
Module load (eager) → initDb()
  │
  ├── economy.db EXISTS
  │     ├── PRAGMA integrity_check → FAIL → THROW (refuse to start, log jelas)
  │     └── OK → verify schema (players table ada) → ready ✅
  │
  └── economy.db NOT EXIST
        ├── economy.json korup / unparsable?
        │     └── PERTAHANKAN perilaku lama: rename ke .corrupt-<ts> + THROW
        │         (loud fail — owner restore dari backup; JANGAN pernah boot dengan data kosong)
        ├── economy.json EXISTS & valid → AUTO-MIGRATE (§5.1)
        └── economy.json tidak ada → fresh DB, schema kosong ✅ (deploy pertama)
```

### §5.1 Migration procedure

```
1. Read economy.json (entire file, sekali saja)
2. Parse JSON (gagal → korup path di atas)
3. Create economy.db + schema
4. BEGIN TRANSACTION
5. For each player entry: INSERT (flat fields + JSON-stringify nested + extra catch-all)
6. COMMIT
7. Verify: SELECT COUNT(*) === Object.keys(json).length → mismatch → THROW + hapus db bayaran
8. Rename economy.json → economy.json.pre-sqlite (backup, TIDAK dihapus)
9. Log: "[MIGRATION] JSON → SQLite complete: N players migrated"
```

Kalau step 5/6 gagal → ROLLBACK → `economy.json` masih utuh → bot crash → next restart retry.

**Gladi wajib sebelum sentuh server produksi:** jalankan prosedur ini lokal terhadap **copy data real** (`server-economy.json`, 47 player). Bandingkan tiap field per player antara JSON asli vs `readAllPlayers()` — harus deep-equal 100%.

---

## §6 Backup System (Updated)

### ⛔ Aturan emas: JANGAN PERNAH attach/copy file `economy.db` mentah saat bot berjalan

WAL mode menyimpan transaksi terbaru di `economy.db-wal` sampai checkpoint — file `.db` mentah bisa **kehilangan jam-jam transaksi**. Semua jalur backup HARUS lewat `db.backup(destPath)` (API online-backup, WAL-aware, snapshot konsisten):

- **Rolling local backup** — `backupEconomy()` → `db.backup(dest)`; dest `data/backups/economy-YYYY-MM-DDTHH-MM.db`; keep 14 terbaru; tetap dipanggil dari index.js (boot + interval 6 jam), signature tidak berubah
- **Daily DM / `ky backup`** — `sendBackupDM` TIDAK lagi memasukkan `economy.db` ke array targets untuk di-attach langsung. Alur baru: `db.backup()` → file temp (mis. `data/tmp-backup.db`) → **gzip (`zlib.gzipSync`, stdlib)** → attach sebagai `economy.db.gz` → hapus temp setelah kirim. File `-wal`/`-shm` TIDAK PERNAH masuk daftar backup
  - **Guard ukuran**: gzip hasil > 8MB → split jadi part ≤ 8MB (beberapa attachment per DM; restore `cat` + `gunzip`). **Hard stop di 50MB**: di atas itu JANGAN terus split (risiko partial-send + rate limit multi-attachment; restore manual rawan error) — log keras + DM saran beralih ke cloud object storage (R2/B2/S3). Gagal kirim apapun alasannya = log keras + DM peringatan — **backup gagal tidak boleh gagal diam-diam**. Dengan gzip 5-10x, DM aman sampai ~5-10k player
- **Player count di summary DM** — ganti `JSON.parse(readFileSync('economy.json'))` → `getAllPlayers().length` (atau `SELECT COUNT(*)`)

---

## §7 Anti-Reset / Anti-Corrupt Protection

| # | Protection | Detail |
|:---|:---|:---|
| 1 | **WAL mode** | Write-Ahead Log — crash mid-write ga corrupt |
| 2 | **Integrity check at boot** | `PRAGMA integrity_check` → gagal = refuse to start (loud) |
| 3 | **Refuse empty** | `SELECT COUNT(*) = 0` padahal `economy.json.pre-sqlite` ada → refuse (sesuatu salah) |
| 4 | **No DROP/DELETE ALL** | Tidak ada code path yang bisa wipe table |
| 5 | **Backup before migration** | `.json` di-rename jadi `.pre-sqlite`, bukan dihapus |
| 6 | **Transaction for migration** | All-or-nothing + count verify |
| 7 | **`extra` catch-all column** | Field baru masa depan tidak hilang diam-diam |
| 8 | **Rolling backup** | 14 snapshot `.db`, max 6h data loss |
| 9 | **Off-server DM** | Daily `.db` (via `db.backup()`) ke DM superadmin |
| 10 | **Rollback path jelas** | Kalau pasca-migrasi ada masalah: stop bot → hapus `economy.db`(+`-wal`/`-shm`) → rename `.pre-sqlite` balik → `economy.json` → jalankan kode pra-migrasi. Tuliskan prosedur ini di README/plan |

---

## §8 Files Impact Matrix

### 🔴 REWRITE (core persistence layer)

| File | Perubahan |
|:---|:---|
| `utils/economyManager.js` | **REWRITE**: SQLite eager singleton + auto-migration + semua exported functions via prepared statements; `readEconomy`/`writeEconomy`/`ECONOMY_PATH` **dihapus dari exports** |

### 🟠 ADAPT (ganti pola readEconomy/writeEconomy → per-player ops)

| File | Callsite | Perubahan |
|:---|:---|:---|
| `utils/shopManager.js` | 8 (read×4, write×3, self-check harness) | → `readPlayer`/`writePlayer`; update self-check monkeypatch |
| `utils/battleManager.js` | 30+ | → `readPlayer`/`writePlayer`; bulk (LB, migrasi battle) → `readAllPlayers`; `recordPvp` (2 player) → `withTransaction` |
| `utils/abyssManager.js` | 5 | → `readPlayer`/`writePlayer` |
| **`utils/battleCommands.js`** | **5 read-only — kategorisasi (terverifikasi v1.2):** `:34` getBattle = single-user → `readPlayer`; `:1130` duel challenge + `:1162` duel accept = **2-player read** → 2× `readPlayer`; `:539` admin kyID gear-search = **full-scan semua player** → `readAllPlayers` (diterima slow — admin-only & jarang; lihat §12 untuk jalur lanjutan); `:1697` `ky battle abyss lb` = bulk → **SQL atas kolom materialized** (§3.1). **FILE INI WAJIB DI-ADAPT — terlewat di v1.0 = semua UI battle crash** |

### 🟡 MINOR ADJUST

| File | Perubahan |
|:---|:---|
| `commands/game.js` | `sendBackupDM`: alur `.db` via `db.backup()` temp (§6), player count via query; `ky backup` ikut alur yang sama. **Game kasino & admin tools TIDAK disentuh** (semua via exported functions — terverifikasi grep) |
| `index.js` | Broaden storage-error UX: cek `error.code === 'ENOSPC' \|\| error.code === 'SQLITE_FULL'` untuk pesan "storage unavailable"; tmp-cleanup jangan sentuh `.db-wal`/`.db-shm` |

### 🟢 TIDAK BERUBAH

`commands/user.js`, `commands/autoreply.js`, `handlers/autoReply.js`, `utils/battleEngine.js`, `utils/battleConfig.js`, `utils/abyssConfig.js`, `utils/pvpManager.js` (terverifikasi: zero economy IO), `utils/uniqueItems.js`, `utils/cardDeck.js`, `utils/shopItems.js`, `utils/botState.js`, `utils/dataManager.js`, `utils/permissionCheck.js`

### 🧪 Tests

| File | Perubahan |
|:---|:---|
| `test/classSwitch.exploit.js` | Monkeypatch `readEconomy/writeEconomy/addXP` → pindah ke `readPlayer/writePlayer` (atau stub level DB) |
| `test/classSwitch.test.js` | Same |
| `test/abyss.test.js` | Zero economy IO (terverifikasi) — tidak berubah, run & confirm PASS |
| **`test/sqlite.parity.js` (BARU)** | Golden-master parity harness — lihat §11.2 |

**Catatan `.gitignore`:** `data/` sudah di-ignore penuh — `.db`, `-wal`, `-shm` otomatis ter-cover. Tidak perlu entry baru (koreksi dari v1.0).

---

## §9 Dependency & Deployment (Raznar)

```bash
npm install better-sqlite3
```

- Synchronous C++ SQLite binding — cocok dengan codebase sync pattern
- **Native module — `npm install` HARUS dijalankan DI SERVER Raznar** (binary Linux ≠ binary Mac; jangan upload `node_modules/better-sqlite3` dari lokal)
- Pin **versi Node mayor** yang sama antara dev & server (prebuilt binaries spesifik ABI)
- Fallback jika gagal compile: `sql.js` (pure WASM, lebih lambat) — keputusan terakhir saja

### Urutan deploy produksi

1. Semua perubahan sudah lulus parity harness + test + gladi migrasi data real (§11)
2. Upload code ke Raznar → **`npm install` di server** → verifikasi `node -e "require('better-sqlite3')"` OK
3. Pastikan `data/economy.json` (data live) ada di tempatnya
4. Start bot → watch console: harus muncul `[MIGRATION] JSON → SQLite complete: N players migrated` dengan N = jumlah player live
5. Spot-check: `ky wallet`, `ky lb`, `ky profile`, `ky battle` (UI jalan), satu bet kecil, `ky backup` (DM berisi `.db`)
6. Verifikasi `economy.json.pre-sqlite` ada

---

## §10 Risiko & Mitigasi

| Risiko | Prob. | Mitigasi |
|:---|:---:|:---|
| `better-sqlite3` gagal compile di Raznar | Low | Prebuilt binaries; install di server; fallback `sql.js` |
| Consumer terlewat → runtime crash | Medium | Fail-loud (exports dihapus) + **grep verification = 0 hit** (§11.4) + parity harness |
| Drift return-shape → UI bug | Medium | Kontrak §4 + parity harness diff return values |
| Migration gagal mid-way | Low | Transaction rollback; JSON intact; retry on next boot |
| Data loss saat migration | Very Low | `.pre-sqlite` rename; count verify; gladi di copy data real |
| Backup DM kirim file basi | — | Diblok §6: hanya via `db.backup()` |
| Superadmin behavior berubah | — | Kontrak §4 (early-return Infinity) |

---

## §11 Verification Plan

1. **Unit/regression**: semua test lama PASS (`abyss`, `classSwitch.*`, self-check `shopManager`, `shopItems`)
2. **Parity harness — scope FINAL (v1.2, jalan tengah review implementor):**
   - **(a) Round-trip test** — `readPlayer(writePlayer(obj))` deep-equal `obj`, termasuk kolom `extra`, `battle` NULL→key hilang, kolom ranking ter-update benar. WAJIB.
   - **(b) Migration test** — JSON fixture → SQLite → `readAllPlayers()` deep-equal source per player. WAJIB.
   - **(c) Operation replay — DI-SCOPE ke API surface economyManager saja**: legacy module (copy sebagai fixture dengan `ECONOMY_PATH` sendiri) vs module baru dijalankan di satu process atas sequence call identik: register ×N → addBalance/removeBalance (branch cukup & kurang) → claimDaily (fresh/sudah claim/superadmin) → transfer (semua branch limit) → addXP (cross level-up) → recordWin/Loss → getLeaderboard/getGlobalRank. Deterministik via seeded `Math.random` yang di-reset antar run (kedua implementasi konsumsi stream random identik). Assert: state akhir semua player deep-equal + semua return value deep-equal. ~200 baris, nol mock module. WAJIB — ini satu-satunya penangkap drift *perilaku* (UPDATE salah field, filter LB, loop XP); round-trip & migration test hanya menangkap drift *bentuk data*.
   - **(d) Materialized-order assertion**: urutan LB dari kolom materialized == urutan `buildBattleLeaderboard` legacy pada data fixture (penangkap drift extractor §3.1). WAJIB.
   - **(e) Replay battle/shop ops** — DILEPAS dari harness (kompleksitas mock module tinggi, nilai rendah): logika consumer tidak berubah, hanya seam IO — sudah tercover (a)+(b)+Step 15 functional.
3. **Migration test**: JSON fixture → boot → semua field ter-migrasi (deep-equal per player, termasuk player TANPA battle data → key `battle` tidak ada) → `.pre-sqlite` ada → double-boot tidak re-migrate
4. **Grep verification**: `grep -rn "readEconomy\|writeEconomy" commands/ utils/ handlers/ index.js` → **0 hit**. `economy.json` hanya boleh muncul di blok auto-migration economyManager
5. **Gladi data real**: migrasi `server-economy.json` (copy, 47 player) → deep-equal 47/47
6. **Functional test dev bot**: register/wallet/daily/bj/cf/transfer/lb/lb battle/battle+end/shop+buy/backup
7. **Restart test**: stop → start → data persist
8. **Kill test**: `kill -9` mid-game → restart → `PRAGMA integrity_check` = ok, no corruption
9. **Backup integrity**: jalankan bot, lakukan transaksi, `ky backup` → restore file `.db` dari DM ke lokasi lain → buka dengan sqlite3 → data termutakhir ADA (bukti WAL-aware)

---

## §12 Skala 100k — sisa jalur lanjutan (phase 2)

*(v1.2: materialisasi kolom ranking untuk `ky lb battle`, battle rank di profile, dan `ky battle abyss lb` sudah MASUK scope — lihat §3.1. Yang tersisa sebagai phase 2:)*

1. **Admin kyID gear-search (`battleCommands:539`)** — full-scan `readAllPlayers` per pencarian. Diterima untuk sekarang: admin-only, jarang dipakai. Kalau jadi lambat di puluhan ribu player: lookup table `unique_items(ky_id PK, owner_id)` (maintained saat grant/sell) atau `json_extract` per-row — putuskan saat waktunya, jangan spekulatif sekarang.
2. **Backup di atas ~10k player** — DM gzip + split mentok di guard 50MB (§6); saat itu wajib cloud object storage (R2/B2, 10GB free) dengan versioning.
3. **`migrateAllBattleData` boot sweep + bansos sweep** — bulk read O(N) sekali per boot / per round; baru relevan kalau boot makin lambat di 100k (batching).
4. **Tembok non-DB** — rate limit Discord dan single-process event loop jadi batas SEBELUM SQLite core. Kalau 100k beneran terjadi: gateway sharding + multi-proses — proyek berbeda.
