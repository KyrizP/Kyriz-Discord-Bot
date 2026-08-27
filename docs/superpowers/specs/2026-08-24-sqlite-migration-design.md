# Economy SQLite Migration — Design Spec v1.4

**Date:** 2026-08-24 · **Status:** FINAL — post-audit ronde-2 (5 lensa × 2 run independen, 73 findings, konvergensi kuat)
**Changelog v1.4:** §5 sentinel-matrix penuh (cabang fresh-DB cek artefak data-sebelumnya → refuse; resume migrasi untuk db-kosong+`.migrating`; JSON `{}` valid → `.suspect` THROW; never-clobber `.pre-sqlite`; economy.json-stray → WARN) · §4 kontrak writePlayer (guard validasi, upsert rowid-preserving, merge spread-only) + withTransaction (wrap db.transaction, sync-only, no raw SQL) + snapshotTo export (no raw db) + aturan binding menyeluruh + invariant sync + env-logging/fresh-under-override-THROW + derived-paths rule · §6 restore = STOP-bot-first + "-wal bukan junk" + backupEconomy skip-empty-no-prune + log di completion + temp naming match housekeeping · §9 deploy = git flow · §11 kanonik-normalizer + tie-semantics competition-rank + fixture-stale=FAIL · koreksi (§2 5 kolom, §8 write×4, §3 10 player tanpa battle, referensi §11.2d)
**Changelog v1.3:** env `KYRIZ_ECONOMY_DB`/`KYRIZ_ECONOMY_JSON` · filter fix (`is_admin=0` HANYA getLeaderboard+getGlobalRank; getAllPlayers superadmin-only) · kontrak superadmin lengkap (getUser sintetik, transfer triple-skip, isRegistered, recordWin/Loss, checkTransferLimits) · `getTransferData` dinamai (mutating getter) · §5 disinkron dengan `.migrating` + transactional-DDL + guards crash-window · §6 detail sendBackupDM + teks restore · §8/§11 koreksi test-matrix + grep test/ · §5.2 gerbang atomisitas eksekusi
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
- **Materialisasi kolom ranking — 5 kolom** (`best_depth`, `battle_score`, `score_achieved_at`, `abyss_best_floor`, `abyss_total_stars`, lihat §3) + konversi LB/rank paths ke SQL indexed (§3.1) — dimasukkan sekarang karena schema sedang dibuat fresh (gratis); menunda = ALTER + backfill di DB live

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

Parity assertion (§11.2d + plan Step 9c) memastikan urutan LB materialized == urutan LB legacy pada data fixture — penangkap drift antara extractor dan logika lama.

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

Sweep aktual snapshot server (v1.3): **48 player, 13 kombinasi field berbeda** — field opsional (`inventory`, `cosmetics`, `activeBoosts`, `transferData`, `isAdmin`) **ABSENT** pada player yang belum menyentuh fiturnya (10 player tanpa battle). Numerik semua bersih (tanpa null/Infinity ter-serialize); `lastDaily` = string ATAU null; `cosmetics.title` semua catalog-ID pasca-fix.

**Aturan normalisasi (WAJIB, dari temuan sweep):** field opsional absent di sumber → INSERT default kolom (`'{}'` kolom JSON, `0` `is_admin`, NULL `last_daily`). `readPlayer` **materialisasi field opsional dengan default** (bentuk kanonik — consumer tak pernah membedakan absent vs `{}`; guard `|| {}` / init-on-demand). Parity & migration deep-equal membandingkan kedua sisi **setelah normalizer yang sama**.

---

## §4 economyManager.js — New API Surface

### Internal: DB singleton — EAGER INIT

```js
const Database = require('better-sqlite3');
// ENV OVERRIDE (WAJIB v1.3): test/self-check/gladi TIDAK PERNAH menyentuh data riil.
// Tanpa ini, eager init berarti sekali `require` dari test runner = migrasi RIIL data dev.
const DB_PATH = process.env.KYRIZ_ECONOMY_DB || path.join(__dirname, '..', 'data', 'economy.db');
const JSON_SRC = process.env.KYRIZ_ECONOMY_JSON || path.join(__dirname, '..', 'data', 'economy.json'); // sumber migrasi
```
**Aturan env (v1.4):** (a) boot log WAJIB `[economy] DB=<resolved> JSON=<resolved> (override: yes/no)` + WARN keras saat override aktif; (b) **override DB aktif TANPA override JSON → THROW** (setengah konfigurasi = salah); **KEDUA env diset = sandbox disengaja (test/gladi) → fresh-create db temp DIBOLEHKAN** — tanpa pengecualian ini semua test isolated akan THROW; (c) **derived-paths rule: SEMUA artefak** (`.migrating`, `.corrupt-*`, `.pre-sqlite*`, `.orphan-*`, `.suspect-*`, backup dir) **= sibling dari env-resolved JSON_SRC/DB_PATH — DILARANG literal `data/economy.*` di luar fallback default**.
```js // (lanjutan)

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
| `getUser(uid)` | **Profil SINTETIK**: `balance: Infinity, level/xp/xpNeeded: '?', isSuperAdmin: true`, username dari row asli (\|\| 'Superadmin') — BUKAN plain SELECT row (wallet/profile owner rusak kalau literal) |
| `isRegistered(uid)` | `return true` — tanpa cek row |
| `recordWin/recordLoss(uid)` | no-op — tanpa write |
| `checkTransferLimits` | bypass semua limit (termasuk receive) |
| `transfer(from=superadmin)` | **Triple-skip**: TIDAK deduct/totalLost sender; TIDAK tulis transferData sender; **TIDAK tambah `receivedTotal` receiver** (literal deduct = row superadmin (balance 0) jadi negatif; literal receivedTotal = korupsi accounting limit receive bansos) |

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
-- HANYA getLeaderboard + getGlobalRank (koreksi v1.3 — jangan over-apply!):
WHERE user_id != ?   -- ? = process.env.SUPERADMIN_ID
  AND is_admin = 0
ORDER BY balance DESC, rowid ASC   -- rowid = insertion order = urutan JSON lama, match stable-sort sekarang

-- getAllPlayers: exclude superadmin SAJA (ADMIN TETAP MASUK — ky players merender tag [Admin],
-- boot player-count menghitung admin):
WHERE user_id != ?
ORDER BY balance DESC, rowid ASC
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
| `getTransferData(userObj)` | **mutating getter** — param USER OBJECT (bukan userId), init/reset transferData saat ganti tanggal WIB; dipakai `ky players` (game.js:4739) + internal transfer | sama — operasi atas objek hasil `readPlayer` |
| `checkTransferLimits`/`getDailySendLimit`/`getDailyReceiveLimit` | pure limit logic | tidak berubah (tanpa DB) |

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
// Snapshot db utk game.js backup — DILARANG export raw `db`
function snapshotTo(destPath) → Promise
```

**Kontrak writePlayer (v1.4, WAJIB):**
- **Guard validasi:** THROW kalau `playerObj` null/undefined, `username` bukan string, `balance` bukan finite number — profil sintetik superadmin (`Infinity`/`'?'`) TIDAK BOLEH pernah tertulis balik
- **Upsert rowid-preserving:** `INSERT … ON CONFLICT(user_id) DO UPDATE SET …` — DILARANG `INSERT OR REPLACE` (DELETE+INSERT = rowid baru tiap write = tiebreak LB `rowid` hancur pelan-pelan)
- **Merge `extra` HANYA object-spread** (own-property) — DILARANG `Object.assign(target-hidup, parsed)` & deep-merge rekursif (prototype pollution via `__proto__`/`constructor` craft)

**Kontrak withTransaction (v1.4, WAJIB):** implement WAJIB wrap `db.transaction(fn)` native (TypeError otomatis pada async fn = fail-loud) · fn WAJIB synchronous · DILARANG SQL raw via handle `db` — hanya readPlayer/writePlayer.

**Aturan SQL menyeluruh:** SEMUA nilai dari luar module (username, kyID, filter) WAJIB bound param `?` — termasuk INSERT blok migrasi; `db.exec()` HANYA PRAGMA/DDL statis; template-literal SQL dilarang; LIKE/GLOB atas input user dilarang (termasuk jalur §12 phase-2).

**Invariant sync consumer:** `readPlayer → writePlayer` WAJIB sinkron — DILARANG await di antara (atomicitas = event-loop + better-sqlite3 sync, identik garansi JSON hari ini); re-read fresh di tiap step interaksi.
```js // (contoh, ditutup di blok bawah)
```

### ⛔ `readEconomy`/`writeEconomy` DIHAPUS dari exports — fail-loud by design

Setelah semua consumer beradaptasi, dua binding ini **dihapus**. Jika ada callsite yang terlewat, aplikasi gagal **keras dan terlihat** saat test/dev (`economy.readEconomy is not a function`), bukan diam-diam full-scan. Verifikasi wajib (lihat §11): grep `readEconomy|writeEconomy` di `commands/ utils/ handlers/ index.js` = **0 hit** setelah migrasi.

---

## §5 Auto-Migration Flow

**⛔ CHECK-FIRST, OPEN-LAST (v1.4):** SEMUA inspeksi state file (eksistensi, parse JSON, sentinel `.migrating`/`.suspect`/`.corrupt`/`.pre-sqlite`/`-wal` yatim) dilakukan via `fs` **SEBELUM** `new Database()` dibuka. `new Database()` MEMBUAT file — maka jalur THROW apa pun TIDAK BOLEH pernah membuka db lebih dulu, supaya tidak meninggalkan file db setengah-jadi yang di boot berikutnya lolos sebagai "db ADA". Db hanya dibuka setelah cabang final diputuskan (ready / migrate / resume-migration — yang terakhir ini membuka db yang SUDAH ada untuk inspeksi `sqlite_master`/COUNT, itu aman).

```
Module load (eager) → initDb()   [check-first open-last; semua artefak-aware — v1.4]

├── economy.db EXISTS
│     ├── integrity_check FAIL → THROW (refuse to start, log jelas + arahkan Step 21b recovery-backup)
│     ├── players table TIDAK ada ATAU COUNT(*) = 0, DAN .json.migrating ada TANPA .pre-sqlite
│     │     → MIGRASI CRASH PRE-COMMIT (db ter-create saat open, transaksi ter-rollback)
│     │     → HAPUS db kosong itu (dijamin tak berisi data — transactional) → RESUME dari .migrating (§5.1)
│     ├── COUNT(*) = 0 / tabel kosong DAN ADA artefak APA PUN (.pre-sqlite / .migrating* /
│     │     .suspect-* / .corrupt-* / -wal yatim) → THROW refuse-empty (belt untuk kasus db-kosong tersisa dari jalur apa pun)
│     ├── COUNT(*) = 0 DAN economy.json valid ada → THROW (restore era-JSON terdeteksi — bukan merge)
│     ├── COUNT(*) > 0 DAN .json.migrating masih ada → mtime < 30s → wait/recheck (proses lain) →
│     │     tua → archive .migrating.orphan-<ts> + LOG KERAS
│     ├── COUNT(*) > 0 DAN economy.json ada → ready + WARN KERAS ("economy.json DIABAIKAN — DB aktif;
│     │     restore JSON ≠ merge; hapus atau ikuti rollback §7")
│     └── OK → ready ✅
│
└── economy.db NOT EXIST
      ├── .json.migrating ada → mtime < 30s → wait 2s, recheck (maks 10x) → THROW
      │                       └── tua → RESUME migrasi dari .migrating (§5.1, LEWATI claim-rename)
      ├── (.json.migrating + economy.json sama-sama ada → .migrating MENANG, log peringatan)
      ├── JSON_SRC valid tapi 0 key ('{}') → rename .suspect-<ts> + THROW (kelas insiden 2026-08-17)
      ├── JSON_SRC korup/unparsable → rename .corrupt-<ts> + THROW (jangan pernah boot kosong)
      ├── JSON_SRC ada & valid (≥1 key) → AUTO-MIGRATE (§5.1)
      └── JSON_SRC tidak ada → ⛔ CEK SENTINEL DULU: ADA .json.pre-sqlite / .json.migrating* /
            .json.corrupt-* / economy.db-wal yatim / backup economy-*.db di sibling dir?
            → THROW refuse ("data pernah ada — menolak boot kosong" + petunjuk recovery).
            SEMUA bersih → fresh DB ✅ (deploy pertama sejati)
Setiap boot mencatat LOG: player COUNT + resolved DB/JSON paths (boot kosong harus TERLIHAT).

PERILAKU BOOT BERUBAH (disengaja, v1.3): DB korup = refuse-to-start (crash jelas),
BUKAN mode lama "online dengan banner degraded" — blok banner index.js:41-51 dihapus (dead code).
```

### §5.2 ⛔ Gerbang Atomisitas Eksekusi

Plan Steps 1b–7 = **SATU UNIT ATOMIK**. Bot tidak boleh di-start/di-deploy di antaranya: state setengah-adaptasi itu *silent* (consumer pakai namespace-call → require sukses, TypeError per-command; kasino jalan; boot-sweep ditelan try/catch). Fail-loud baru ada setelah grep gate (plan Step 12). Verifikasi antar-phase = `node -c` + test runner, bukan boot.

### §5.1 Migration procedure

```
1. CLAIM-RENAME atomik: JSON_SRC → JSON_SRC.migrating (loser rename → wait+recheck, JANGAN resume). ⛔ RESUME path (§5) MELEWATI langkah ini — .migrating sudah ada, JANGAN overwrite
2. Parse .migrating (gagal → rename .migrating.corrupt-<ts> + THROW; **valid tapi 0 key ('{}') → rename .suspect-<ts> + THROW** — file kosong-valid selalu anomali, bukan data)
3. db.transaction() SATU BLOK (SQLite mendukung DDL transaksional):
     CREATE TABLE + index → INSERT semua player (nilai eksplisit semua kolom)
     → COUNT-verify == jumlah key JSON (mismatch → THROW → rollback)
4. COMMIT  ← schema+data commit atomically; kill -9 sebelum titik ini = rollback bersih,
   db tidak pernah ada dalam keadaan setengah-jadi (menutup crash-window "db kosong boot senyap")
5. **NEVER-CLOBBER:** kalau .pre-sqlite SUDAH ada → rename yang lama dulu ke .pre-sqlite.<ts> (arsip, jangan pernah ditimpa diam-diam) → baru rename .migrating → .pre-sqlite (backup, TIDAK dihapus)
6. Log: "[MIGRATION] JSON → SQLite complete: N players migrated"
```

Crash PRE-COMMIT → db ter-create-kosong oleh open → boot berikut deteksi (players-table hilang / COUNT=0 + `.migrating` tanpa `.pre-sqlite`) → **hapus db kosong + RESUME otomatis dari `.migrating`** (§5). Crash SETELAH step 4 sebelum 5 → db berisi data + `.migrating` orphan → diarsipkan dengan log. **`.migrating` TIDAK PERNAH dihapus oleh code mana pun — di window crash ia satu-satunya salinan data.**

**Gladi wajib sebelum sentuh server produksi (v1.3): dress rehearsal layout server** — sandbox `/tmp/gladi/data/economy.json` (**copy snapshot server, dinamai persis seperti di live**; `server-economy.json` di repo = referensi read-only) → init module via env redirect lokasi → verifikasi alur production penuh (claim-rename, `.pre-sqlite`, log `[MIGRATION] … 48 players`) → deep-equal 48/48 (normalizer §3) → re-init tidak double-migrate → `rm -rf /tmp/gladi`. Data dev tidak pernah tersentuh; di server rill nanti TANPA env var (default path).

---

## §6 Backup System (Updated)

### ⛔ Aturan emas: JANGAN PERNAH attach/copy file `economy.db` mentah saat bot berjalan

WAL mode menyimpan transaksi terbaru di `economy.db-wal` sampai checkpoint — file `.db` mentah bisa **kehilangan jam-jam transaksi**. Semua jalur backup HARUS lewat `db.backup(destPath)` (API online-backup, WAL-aware, snapshot konsisten):

- **Rolling local backup** — `backupEconomy()` → `db.backup(dest)`; dest sibling-DB `backups/economy-YYYY-MM-DDTHH-MM.db` (derived-path rule §4); keep 14; dipanggil index.js (boot + interval 6h). ⛔ **COUNT(*)=0 → SKIP snapshot DAN SKIP prune + log `[DATA SAFETY] refusing to snapshot/prune on empty db`** (backup JSON-era lama harus tetap hidup sampai manusia konfirmasi). Log sukses di **completion callback** backup (bukan sebelum call — backup async chunked)
- **Daily DM / `ky backup`** — `sendBackupDM` TIDAK lagi memasukkan `economy.db` ke array targets untuk di-attach langsung. Alur baru: `db.backup()` → file temp (mis. `data/tmp-backup.db`) → **gzip (`zlib.gzipSync`, stdlib)** → attach sebagai `economy.db.gz` → hapus temp setelah kirim. File `-wal`/`-shm` TIDAK PERNAH masuk daftar backup
  - **Guard ukuran**: gzip hasil > 8MB → split jadi part ≤ 8MB (beberapa attachment per DM; restore `cat` + `gunzip`). **Hard stop di 50MB**: di atas itu JANGAN terus split (risiko partial-send + rate limit multi-attachment; restore manual rawan error) — log keras + DM saran beralih ke cloud object storage (R2/B2/S3). Gagal kirim apapun alasannya = log keras + DM peringatan — **backup gagal tidak boleh gagal diam-diam**. Dengan gzip 5-10x, DM aman sampai ~5-10k player
  - **Detail implementasi sendBackupDM (v1.3):** (a) attachment `economy.db.gz` di-push ke array `attachments` yang SAMA, **SEBELUM** guard `attachments.length === 0` (game.js:969); (b) ikut dihitung di count/summary (game.js:997/1011); (c) reason codes: `gzip-fail`, `backup-too-large`, `no-files`, `no-superadmin`, `dm-closed` — `dailyBackupDM` index.js:78-84 log SEMUA reason non-sent; (d) **REWRITE teks restore DM (game.js:985)**: file JSON → taruh di `data/`; **`economy.db.gz` → `gunzip` → taruh sebagai `data/economy.db` → hapus `-wal`/`-shm` lama** (copy mentah .gz = boot economy KOSONG). **Langkah 0 WAJIB: STOP bot DULU** (panel Stop, bukan restart) — menimpa db di bawah koneksi WAL hidup = korupsi/torn-write. **`-wal`/`-shm` BUKAN junk — JANGAN pernah dihapus saat bot hidup ATAU antara stop-start kecuali mengikuti prosedur restore lengkap** (menghapus -wal dengan commit yang belum ter-checkpoint = kehilangan transaksi diam-diam; integritas file tetap "valid" sehingga tak ada yang menangkap). Temp file backup dinamai `economy.db.tmp-backup` (match pola housekeeping `.tmp-` — sisa gagal-kirim kebersihkan otomatis di boot). Backup era-JSON (`economy.json` DM lama) TIDAK berlaku pasca-migrasi — jalur restore SQLite saja
- **Player count di summary DM** — ganti `JSON.parse(readFileSync('economy.json'))` → `getAllPlayers().length` (atau `SELECT COUNT(*)`)

---

## §7 Anti-Reset / Anti-Corrupt Protection

| # | Protection | Detail |
|:---|:---|:---|
| 1 | **WAL mode** | Write-Ahead Log — crash mid-write ga corrupt |
| 2 | **Integrity check at boot** | `PRAGMA integrity_check` → gagal = refuse to start (loud) |
| 3 | **Refuse empty/fresh** | db-ADA + COUNT=0 padahal `.pre-sqlite` ada → refuse; **db-TIDAK-ADA + JSON tidak ada tapi artefak data-sebelumnya ada (`.pre-sqlite`/`.migrating*`/`.corrupt-*`/`-wal` yatim/backup) → refuse fresh-boot** — menutup jalur boot-kosong-senyap (6 temuan audit independen) |
| 4 | **No DROP/DELETE ALL** | Tidak ada code path yang bisa wipe table |
| 5 | **Backup before migration** | `.json` di-rename jadi `.pre-sqlite`, bukan dihapus; **never-clobber** (yang lama diarsipkan `.<ts>`); **`.migrating` tidak pernah dihapus oleh code** |
| 6 | **Transaction for migration** | All-or-nothing + count verify |
| 7 | **`extra` catch-all column** | Field baru masa depan tidak hilang diam-diam |
| 8 | **Rolling backup** | 14 snapshot `.db`, max 6h data loss |
| 9 | **Off-server DM** | Daily `.db.gz` (via `db.backup()` + gzip) ke DM superadmin |
| 10 | **Recovery dulu, rollback terakhir** | db-corrupt → pulihkan dari `data/backups/` terbaru / DM `.db.gz` (maks hilang 6 jam) SEBELUM rollback penuh; rollback = progres pasca-migrasi hilang (keputusan sadar) |
| 11 | **Rollback path jelas** | Kalau pasca-migrasi ada masalah: stop bot → hapus `economy.db`(+`-wal`/`-shm`) → rename `.pre-sqlite` balik → `economy.json` → jalankan kode pra-migrasi. Tuliskan prosedur ini di README/plan |

---

## §8 Files Impact Matrix

### 🔴 REWRITE (core persistence layer)

| File | Perubahan |
|:---|:---|
| `utils/economyManager.js` | **REWRITE**: SQLite eager singleton + auto-migration + semua exported functions via prepared statements; `readEconomy`/`writeEconomy`/`ECONOMY_PATH` **dihapus dari exports** |

### 🟠 ADAPT (ganti pola readEconomy/writeEconomy → per-player ops)

| File | Callsite | Perubahan |
|:---|:---|:---|
| `utils/shopManager.js` | 8 (read×4, **write×4**, + self-check harness) | → `readPlayer`/`writePlayer`; update self-check monkeypatch |
| `utils/battleManager.js` | 30+ | → `readPlayer`/`writePlayer`; bulk (LB, migrasi battle) → `readAllPlayers`; `recordPvp` (2 player) → `withTransaction` |
| `utils/abyssManager.js` | 5 di **4 fungsi** (`getAbyssRunData` TIDAK ADA di repo — koreksi v1.3): `canEnterFloor` :175, `recordClear` :180+:182, `getAbyssProgress` :187, `startAbyssFight` :330 | → `readPlayer`/`writePlayer` |
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
| `test/abyss.test.js` | **KOREKSI v1.3: BUKAN zero-IO** — `:373 getAbyssProgress` = real economy read. Run dengan `KYRIZ_ECONOMY_DB` temp; assert unknown-user tetap zeros |
| `test/battleManager.test.js`, `test/preset.test.js`, `test/crash.test.js`, `test/abyss_verify.js` | **Run-list v1.3** — transitively require economyManager → WAJIB `KYRIZ_ECONOMY_DB` temp. `node deploy-commands.js` juga requires game.js → isolate sama |
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
2. **Deploy = GIT (egg AUTO_UPDATE): commit final (package.json+lock bersama) → push ke origin → restart server** — console mengeksekusi `git pull` → `npm ci` (download binary Linux better-sqlite3) → `node index.js`. TIDAK ada upload manual (upload di luar git = working tree dirty = pull konflik)
3. Pastikan `data/economy.json` (data live) ada di tempatnya & panel env TIDAK berisi `KYRIZ_ECONOMY_*`
4. Start bot → watch console: harus muncul `[MIGRATION] JSON → SQLite complete: N players migrated` dengan N = jumlah player live
5. Spot-check: `ky wallet`, `ky lb`, `ky profile`, `ky battle` (UI jalan), satu bet kecil, `ky backup` (DM berisi `.db.gz`)
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

1. **Unit/regression**: SEMUA runner lama PASS — daftar 14 file lengkap mengikuti plan Step 11 (termasuk battleManager.test, preset.test, crash.test, abyss_verify — semua env-isolated)
2. **Parity harness — scope FINAL (v1.2, jalan tengah review implementor):**
   - **(a) Round-trip test** — `deep-equal(readPlayer(writePlayer(obj)), normalize(obj))` — **invariant atas bentuk KANONIK** (objek mentah field-absent tidak dipakai langsung), termasuk: `extra`, `battle` NULL→key hilang, `last_daily` NULL→key hadir bernilai null, **`is_admin` dibaca balik boolean**, kolom ranking benar, **rowid stabil across writePlayer**, `extra` craft `__proto__`/`constructor` round-trip tanpa menyentuh Object.prototype. WAJIB.
   - **(b) Migration test** — JSON fixture → SQLite → `readAllPlayers()` deep-equal source per player. WAJIB.
   - **(c) Operation replay — DI-SCOPE ke API surface economyManager saja**: legacy module (copy sebagai fixture dengan `ECONOMY_PATH` sendiri) vs module baru dijalankan di satu process atas sequence call identik: register ×N → addBalance/removeBalance (branch cukup & kurang) → claimDaily (fresh/sudah claim/superadmin) → transfer (semua branch limit) → addXP (cross level-up) → recordWin/Loss → updateUsername → **getUser(superadmin sintetik)** → **transfer sender-superadmin (triple-skip)** → getTransferData (date-rollover) → getLeaderboard/getGlobalRank/getAllPlayers. Deterministik: seeded `Math.random` di-reset antar run. **Tie-semantics rank = COMPETITION rank** (`COUNT(*)+1` — pemain seri dapat rank SAMA; sadar beda dari findIndex-legacy; di-assert eksplisit). Whitelist sadar satu bentuk: legacy `getLeaderboard` `cosmetics: null` vs baru `{}` (behavior identik — semua consumer `|| {}`). Assert: state akhir semua player deep-equal (normalizer kedua sisi) + semua return value deep-equal. ~200 baris, nol mock module. WAJIB — ini satu-satunya penangkap drift *perilaku* (UPDATE salah field, filter LB, loop XP); round-trip & migration test hanya menangkap drift *bentuk data*.
   - **(d) Materialized-order assertion**: urutan LB dari kolom materialized == urutan `buildBattleLeaderboard` legacy pada data fixture (penangkap drift extractor §3.1) — **PLUS abyss LB: rows + order + zero-skip + empty-state == legacy `handleAbyssLb`** (v1.3). WAJIB.
   - **(e) Sumber fixture (v1.3, WAJIB):** snapshot legacy diambil **SEBELUM** rewrite (plan Step 0.5, `git show <HEAD>:utils/economyManager.js`) — copy dari utils/ pasca-rewrite = parity baru-vs-baru = PASS palsu. Redirect path TANPA edit isi: layout `test/fixtures/legacy/economyManager.js` (verbatim, hash-checked) + `test/fixtures/data/economy.json`; module baru pakai **KEDUA env** (`KYRIZ_ECONOMY_JSON` juga — setengah isolasi = migrasi data dev tetap terjadi). **Hash mismatch = FAIL (exit non-zero)** — SKIP = gerbang hijau palsu. Fixture disalin segar per-run (migrasi mengonsumsinya via rename).
   - **(g) Replay battle/shop ops** — DILEPAS dari harness (kompleksitas mock module tinggi, nilai rendah): logika consumer tidak berubah, hanya seam IO — sudah tercover (a)+(b)+Step 15 functional.
3. **Migration test**: JSON fixture → boot → semua field ter-migrasi (deep-equal per player, termasuk player TANPA battle data → key `battle` tidak ada) → `.pre-sqlite` ada → double-boot tidak re-migrate
4. **Grep verification**: `grep -rn "readEconomy\|writeEconomy" commands/ utils/ handlers/ index.js test/ --exclude-dir=test/fixtures` → **0 hit** (termasuk test/; **`--exclude-dir=test/fixtures`** — fixture verbatim legacy memang berisi literal itu by design). `economy.json` hanya boleh di blok auto-migration economyManager (comment literal usang dibersihkan — plan Steps 2/7)
5. **Gladi data real**: migrasi `server-economy.json` (copy, **48 player**) → deep-equal 48/48 (kedua sisi lewat normalizer §3)
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
