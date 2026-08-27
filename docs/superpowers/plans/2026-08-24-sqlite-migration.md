# Economy SQLite Migration — Implementation Plan v1.2

**Date:** 2026-08-24 · **Spec:** `specs/2026-08-24-sqlite-migration-design.md` (v1.2)
**Constraint:** Zero user-facing changes. Auto-migration. No downtime. **Zero regression.**
**Changelog v1.2 (input implementor, terverifikasi):** kategorisasi battleCommands dikoreksi (34=single, 1130/1162=2-player, 539=bulk admin, 1697=SQL kolom materialized) · materialisasi ranking MASUK Step 1 + extractor di battleEngine · LB/rank battleManager & abyss LB → SQL indexed · parity harness di-scope ke API surface economyManager · gzip guard 50MB · Step 15 + abyss lb
**Changelog v1.1:** Step baru: battleCommands adaptation, parity harness, grep verification, gladi data real, rollback runbook · koreksi filter leaderboard · kontrak superadmin & return shapes · backup DM via `db.backup()` · eager init · hapus step .gitignore (redundan)

---

## Pre-flight

- [ ] **Step 0:** `npm install better-sqlite3` — verify compiles & loads on local dev Node. Catat versi Node lokal.
  - CATATAN: install di lokal hanya untuk dev/test. Di server Raznar nanti WAJIB `npm install` ulang di server (native binary, platform beda). `.gitignore` TIDAK perlu diubah — `data/` sudah full-ignored.

---

## Phase 1: Core Persistence Layer

- [ ] **Step 1a:** ADD `battleEngine.extractBattleRanking(battleObj, registeredAt)` → `{ bestDepth, battleScore, scoreAchievedAt }` + `battleEngine.extractAbyssRanking(battleObj)` → `{ bestFloor, totalStars }`
  - Pure functions, di `utils/battleEngine.js` (sudah pure-math, tanpa import economyManager — aman dari circular dep)
  - Logika HARUS identik dengan `buildBattleLeaderboard` sort triple: **bestDepth desc → score desc → scoreAchievedAt asc** (fallback `best.ch.scoreAchievedAt || registeredAt || '9999'`) — dan perhitungan stars/highest `handleAbyssLb`
  - Comment wajib di atas `extractBattleRanking`: *"Formula-dependent — setiap retune `computeStats` WAJIB disertai recompute sweep semua row"* (spec §3.1)

- [ ] **Step 1b:** REWRITE `utils/economyManager.js`
  - SQLite singleton **EAGER di module top-level** (bukan lazy): pragma WAL + `synchronous=NORMAL` + schema (termasuk kolom `extra` **dan 5 kolom materialized** `best_depth`/`battle_score`/`score_achieved_at`/`abyss_best_floor`/`abyss_total_stars` + index-nya) + auto-migration (§5 spec) — semua selesai sebelum exports dipakai siapa pun
  - Auto-migration: detect `economy.json` → parse (korup → rename `.corrupt-<ts>` + THROW, jangan boot kosong) → `db.transaction()` native better-sqlite3 (**JANGAN manual BEGIN/COMMIT** — native helper aman dari nested-transaction error) → INSERT per player (flat + JSON kolom + `extra` **+ kolom ranking via extractor Step 1a**) → verify `COUNT(*) == jumlah key JSON` → rename `economy.json` → `economy.json.pre-sqlite` → log `[MIGRATION] ... N players`
  - INSERT migration WAJIB nilai eksplisit SEMUA kolom — jangan andalkan column defaults (data real punya `xpNeeded` ≠ default schema, dll)
  - **Defense-in-depth double-process (adopsi review implementor):** klaim migrasi via rename atomik — `fs.renameSync('economy.json', 'economy.json.migrating')`; yang berhasil rename yang migrasi dari file itu; sukses → rename `.migrating` → `.json.pre-sqlite`. Crash mid-migrasi → boot berikut: db belum ada + `.migrating` ada → **resume dari `.migrating`**. (Raznar stop-then-start, tapi double-click restart / panel glitch tetap mungkin — 2 baris biaya, data real yang dipertaruhkan)
  - Boot guard: `PRAGMA integrity_check` → gagal = THROW; `COUNT(*)=0` padahal `.pre-sqlite` ada = THROW
  - Reimplement semua exported functions dengan prepared statements. **PATUHI kontrak spec §4:**
    - ⛔ Superadmin early-returns PERSIS: `getBalance→Infinity`, `addBalance→{success:true,newBalance:Infinity}` (tanpa write), `removeBalance→{success:true,message:'OK',newBalance:Infinity}`, `addXP→{leveledUp:false,newLevel:0,xp:0,xpNeeded:0}`, `claimDaily→{success:true,message:'Daily claimed.',amount:0,isSuperAdmin:true}`
    - ⛔ Return shapes tidak boleh berubah field apa pun (games membacanya untuk embed)
    - ⛔ Filter LB/rank/getAllPlayers: `WHERE user_id != :superadmin AND is_admin = 0` + `ORDER BY ... , rowid` — superadmin punya row di DB, tanpa filter ini dia MUNCUL di leaderboard dan semua rank bergeser
    - `updateUsername`: pertahankan skip-write kalau username sama
    - `addXP`: level loop + reward level-up 150k-500k (`Math.random()^2` weighting) tetap di JS
    - `transfer`: satu transaction (deduct + credit + transferData kedua sisi)
    - `registerUser`: starting balance 100000 (dari kode, bukan schema default)
  - New exports: `readPlayer(uid)`, `writePlayer(uid, obj)`, `readAllPlayers()`, `withTransaction(fn)`
    - `writePlayer`: serialize flat kolom + JSON kolom + field tak dikenal → kolom `extra`; `battle` undefined → SQL NULL; **auto-update 4 kolom ranking via extractor Step 1a** (single source of truth — dilarang duplikasi logika best-char di tempat lain)
    - `readPlayer`: reconstruct camelCase; `battle` NULL → key **dihilangkan** (bukan null); merge `extra`; kolom ranking TIDAK ikut ke object player (internal-only, kecuali dibutuhkan LB)
    - Round-trip invariant: `readPlayer(writePlayer(obj))` deep-equal `obj`
  - `backupEconomy()` → `db.backup(dest)`; naming `economy-<stamp>.db`; prune 14 (pattern `economy-` prefix, sama seperti sekarang). **`db.backup()` return Promise — satu-satunya API async di better-sqlite3** (docs/api.md: *"returning a promise"*; implementasi chunked via `setImmediate` → non-blocking per tick). Tangkap `.catch` internal + `console.error` keras (aturan loud-failure); jangan sampai unhandledRejection dari interval 6 jam. Catatan: "mutations from other connections restart the backup" — kita single-connection, gak relevan
  - **HAPUS dari exports:** `readEconomy`, `writeEconomy`, `ECONOMY_PATH` — fail-loud untuk callsite yang terlewat
  - Keep unchanged: `isSuperAdmin`, `isAdmin/setAdmin/removeAdmin` (→ kolom `is_admin`), transfer-limit helpers, `getWIBDate` (internal)

---

## Phase 2: Consumer Adaptation

- [ ] **Step 2:** ADAPT `utils/shopManager.js` (8 callsite)
  - `economyManager.readEconomy()` → `readPlayer(userId)`; `writeEconomy(data)` → `writePlayer(userId, player)`
  - Callsites: `getInventoryState`, `equipCosmetic`, `purchase`, `useItem` (+ helper cosmetics)
  - Self-check harness (line ~172-385): monkeypatch `readPlayer/writePlayer` bukan `readEconomy/writeEconomy`; pertahankan semantic test atomicity (deduct+grant dalam satu write)

- [ ] **Step 3:** ADAPT `utils/battleManager.js` (30+ callsite)
  - Single-user IO wrappers (`read → ensureUser → apply → write`): `readPlayer`/`writePlayer`
  - **`getBattleGlobalRank` + LB battle GLOBAL → SQL atas kolom materialized** (`ORDER BY best_depth DESC, battle_score DESC, score_achieved_at ASC` / rank = `COUNT(*)+1` dengan triple yang sama) — BUKAN `readAllPlayers` (hot path: rank dipanggil tiap `ky profile`). ⛔ **JANGAN pakai filter admin/superadmin di sini** — battle LB legacy menyertakan semua player bertahan-battle (verifikasi: `buildBattleLeaderboard` hanya filter memberIds + kehadiran `battle`); filter `is_admin` itu milik LB Kryztal
  - **Varian memberIds (`getBattleLeaderboardFor`, LB server) & classFilter (`ky lb battle <class>`) TETAP jalur bulk** `readAllPlayers()` + computeStats — command langka, kolom materialized gak punya info per-class/server (spec §3.1)
  - `migrateAllBattleData` (boot sweep): `readAllPlayers()` — sekali per boot, diterima
  - `recordPvp` (menulis 2 player): **`withTransaction`** — bukan 2 write terpisah
  - `grantKryptonite` dkk: single `writePlayer`

- [ ] **Step 4:** ADAPT `utils/abyssManager.js` (5 callsite)
  - `canEnterFloor`, `recordClear`, `getAbyssProgress`, `getAbyssRunData`, `startAbyssFight` → `readPlayer`/`writePlayer`

- [ ] **Step 5:** ADAPT `utils/battleCommands.js` (5 callsite read-only — kategorisasi terverifikasi v1.2)
  - `:34` `getBattle` → `readPlayer(userId)` (single-user view; `ensureUser` in-memory seperti sekarang)
  - `:1130` duel challenge → **2× `readPlayer`** (`me` + `foe`)
  - `:1162` duel accept → **2× `readPlayer`** (`aU` + `bU`)
  - `:539` admin kyID gear-search → `readAllPlayers()` full-scan — **diterima slow** (admin-only, jarang; spec §12 mencatat jalur lanjutannya)
  - `:1697` `ky battle abyss lb` → **SQL atas kolom materialized** (`ORDER BY abyss_best_floor DESC, abyss_total_stars DESC`), bukan bulk read
  - **Tanpa step ini semua UI battle crash saat runtime** (file ini terlewat di v1.0)

---

## Phase 3: Peripheral Updates

- [ ] **Step 6:** UPDATE `commands/game.js` — HANYA jalur backup
  - `sendBackupDM` (:954-): keluarkan `economy.json` dari array targets; alur baru: `economyManager.backupToTemp()` (atau `db.backup()` via export) → file temp → `AttachmentBuilder(temp)` → hapus temp setelah kirim. **JANGAN attach `economy.db` mentah (WAL = file basi) dan JANGAN masukkan `-wal`/`-shm` ke targets**
  - **Gzip + guard ukuran**: temp di-compress `zlib.gzipSync` (stdlib) → attach sebagai `economy.db.gz` (restore: `gunzip`). Guard: > 8MB → split part ≤ 8MB (restore: `cat economy.db.gz.part* > economy.db.gz && gunzip`); **> 50MB → HARD STOP: jangan split lagi** (risiko partial-send + rate limit multi-attachment) — log keras + DM saran beralih ke cloud object storage (R2/B2/S3, spec §12). Gagal kirim apapun alasannya (termasuk limit) HARUS log keras + DM peringatan ke owner — backup gagal kirim gak boleh diam-diam. Catat ukuran akhir di summary DM (`economy.db.gz — X KB`)
  - Player count (:980): `JSON.parse(readFileSync(...))` → `getAllPlayers().length`
  - `ky backup` command: route ke alur `sendBackupDM`/helper yang sama
  - **JANGAN sentuh 9 game kasino / admin tools / bansos** — mereka hanya pakai exported functions (terverifikasi)

- [ ] **Step 7:** UPDATE `index.js`
  - Storage-error UX: broaden `error.code === 'ENOSPC'` → `error.code === 'ENOSPC' || error.code === 'SQLITE_FULL'` (SQLite pakai kode sendiri)
  - Tmp-file cleanup (jika menyentuh `data/*.tmp-*`): jangan pernah match `.db-wal`/`.db-shm`/`*.db`
  - `backupEconomy()` calls (boot :70 + interval 6h) — signature sama, tidak berubah

---

## Phase 4: Tests

- [ ] **Step 8:** UPDATE `test/classSwitch.exploit.js` + `test/classSwitch.test.js`
  - Monkeypatch pindah: `readEconomy/writeEconomy` → `readPlayer/writePlayer` (exploit test juga mem-patch `addXP` — sesuaikan target mock)
  - Pertahankan semantic semua kasus (anti-dupe, XP-farm, isolation)

- [ ] **Step 9:** CREATE `test/sqlite.parity.js` — parity harness, scope FINAL v1.2 (jalan tengah review implementor)
  - **(a) Round-trip**: `readPlayer(writePlayer(obj))` deep-equal `obj` — termasuk `extra`, `battle` NULL→key hilang, kolom ranking ter-update benar
  - **(b) Operation replay — economyManager API surface SAJA**: copy legacy economyManager sebagai fixture module dengan `ECONOMY_PATH` ke file temp JSON sendiri — **simpan sebagai `economyManager.fixture-<hash>.js` (hash dari konten asli saat dicopy); test memverifikasi hash masih match — mismatch → SKIP dengan pesan "fixture stale, refresh"** (self-documenting, adopsi review implementor). Kedua implementasi jalan di SATU process atas sequence call identik: register ×N → addBalance/removeBalance (branch cukup/kurang) → claimDaily (fresh/sudah-claim/superadmin) → transfer (semua branch limit) → addXP (cross level-up) → recordWin/Loss → **updateUsername (termasuk branch auto-create superadmin + skip-if-unchanged)** → getLeaderboard/getGlobalRank. Deterministik: `Math.random` di-override seeded-PRNG dan **di-reset antar run** (kedua implementasi konsumsi stream identik)
  - Assert: state akhir semua player deep-equal + semua return value deep-equal. Exit non-zero + print diff field-level kalau gagal
  - **(c) Materialized-order assertion**: urutan LB dari kolom materialized == urutan `buildBattleLeaderboard` legacy atas data fixture
  - **(d) Replay battle/shop ops DILEPAS** — logika consumer tak berubah, hanya seam IO; tercover (a) + migration test + Step 15 functional

- [ ] **Step 10:** VERIFY `test/abyss.test.js` — zero economy IO, expect zero changes; run & confirm PASS

---

## Phase 5: Verification (urutan wajib)

- [ ] **Step 11:** Run ALL tests: `abyss`, `classSwitch.test`, `classSwitch.exploit`, `sqlite.parity`, self-check `shopManager`, `shopItems`
- [ ] **Step 12:** **Grep verification — 0 hit:** `grep -rn "readEconomy\|writeEconomy" commands/ utils/ handlers/ index.js` → kosong. `grep -rn "economy\.json" commands/ utils/ handlers/ index.js` → hanya blok auto-migration di economyManager
- [ ] **Step 13:** Migration test lokal: fixture JSON → boot → semua field deep-equal → `.pre-sqlite` ada → boot kedua tidak re-migrate
- [ ] **Step 14:** **Gladi data real:** copy `data/server-economy.json` → `data/economy.json` di sandbox → jalankan migrasi → deep-equal 47/47 player → **pulihkan** `data/economy.json` lokal setelah selesai
- [ ] **Step 15:** Functional test dev bot: register → wallet → daily → bj/cf 100 → transfer → lb → lb battle → **`ky battle abyss lb`** (sub-flag dari `ky battle abyss`, BUKAN `ky lb abyss`) → profile (battle rank tampil & benar) → battle+end → shop+buy → backup (DM berisi `.db.gz`)
- [ ] **Step 16:** Restart test + kill test: `kill -9` mid-game → restart → `integrity_check` = ok
- [ ] **Step 17:** Backup integrity: transaksi terbaru → `ky backup` → buka `.db` hasil DM dengan sqlite3 CLI → data termutakhir ADA

---

## Phase 6: Production Deploy (Raznar)

- [ ] **Step 18:** Upload semua file yang berubah → **`npm install` DI SERVER** → `node -e "require('better-sqlite3')"` OK (verifikasi native binary)
- [ ] **Step 19:** Pastikan `data/economy.json` live ada → start bot → watch console `[MIGRATION] ... N players migrated` (N = player live) → verifikasi `economy.json.pre-sqlite` muncul
- [ ] **Step 20:** Smoke test produksi: wallet/lb/profile/battle beberapa player, satu bet kecil, `ky backup`
- [ ] **Step 21 (runbook, simpan di README):** ROLLBACK — kalau pasca-migrasi ada masalah: (1) stop bot, (2) hapus `data/economy.db` + `economy.db-wal` + `economy.db-shm`, (3) rename `economy.json.pre-sqlite` → `economy.json`, (4) deploy kode pra-migrasi. Data JSON tidak pernah ter-modify oleh migrasi — rollback selalu mungkin.

---

## File Checklist

| # | File | Action | Step |
|:---|:---|:---|:---:|
| 1 | `package.json` | Add `better-sqlite3` | 0 |
| 2 | **`utils/battleEngine.js`** | **MODIFY (BARU v1.2): tambah `extractBattleRanking` + `extractAbyssRanking`** | 1a |
| 3 | `utils/economyManager.js` | **REWRITE** (schema + kolom materialized + auto-extract) | 1b |
| 4 | `utils/shopManager.js` | ADAPT | 2 |
| 5 | `utils/battleManager.js` | ADAPT (LB/rank → SQL materialized) | 3 |
| 6 | `utils/abyssManager.js` | ADAPT | 4 |
| 7 | **`utils/battleCommands.js`** | **ADAPT** (kategorisasi v1.2: 1 single + 2 dual + 1 bulk + 1 SQL) | 5 |
| 8 | `commands/game.js` | MINOR (backup path saja) | 6 |
| 9 | `index.js` | MINOR | 7 |
| 10 | `test/classSwitch.exploit.js` | ADAPT | 8 |
| 11 | `test/classSwitch.test.js` | ADAPT | 8 |
| 12 | **`test/sqlite.parity.js`** | **CREATE** (scope v1.2) | 9 |
| 13 | `test/abyss.test.js` | VERIFY (expect no change) | 10 |
| 14 | ~~`.gitignore`~~ | ~~Add db files~~ — **N/A**: `data/` sudah full-ignored | — |

---

## Execution Order Rationale

1. **economyManager FIRST** — semua consumer bergantung padanya. Kalau ini benar, sisanya follow.
2. **shopManager → battleManager → abyssManager → battleCommands** — dari sedikit callsite ke banyak, terakhir UI layer.
3. **game.js + index.js** — peripheral.
4. **Parity harness SEBELUM functional test** — dia yang menangkap drift semantic yang smoke test tidak lihat.
5. **Grep verification sebagai gerbang** — bukti mekanis bahwa tidak ada consumer terlewat.
6. **Gladi data real sebelum produksi** — data live 47 player adalah test case paling jujur.
7. **Rollback runbook selalu tersedia** — migrasi satu arah, tapi jalan pulang tidak pernah ditutup.
