# Economy SQLite Migration — Implementation Plan v1.4

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Ditambahkan protokol project (CLAUDE.md §Active Project Protocol, 11 aturan) — user instructions MENANG atas skill default: baseline test tiap session, `[x]` hanya setelah test lulus, checkpoint git per phase, STOP & tanya saat bentrok spec.**

**Date:** 2026-08-24 · **Spec:** `specs/2026-08-24-sqlite-migration-design.md` (v1.4)
**Constraint:** Zero user-facing changes. Auto-migration. No downtime. **Zero regression. Zero silent-wipe paths.**
**Changelog v1.4 (final adversarial audit: 5 lensa × 2 run = 73 findings, konvergensi kuat):** pohon boot §5 diberi **sentinel matrix penuh** (cabang fresh-DB wajib cek `.pre-sqlite`/`.migrating*`/`.corrupt-*`/`-wal` yatim/backups → THROW refuse; 6 run independen menemukan jalur boot-kosong-senyap) · **Step 21 rollback DITULIS ULANG TOTAL**: maintenance-mode dulu, BACKUP db sebelum hapus, **JANGAN PERNAH hapus `.migrating`** (itu satu-satunya salinan di window crash), revert RANGE penuh (bukan commit tunggal), opsi checkout dihapus (detached HEAD × egg pull = bot mati) + **runbook recovery db-corrupt via backup terbaru** (jalur least-loss) · **resume migrasi** (db ada-tapi-kosong + `.migrating` tanpa `.pre-sqlite` = resume, bukan THROW) · migrasi JSON `{}` kosong-valid → `.suspect` + THROW (anti insiden 2026-08-17) · **`never-clobber` `.pre-sqlite`** (rename lama ke `.<ts>` dulu) · **Steps 8-11 wajib SET KEDUA env** (`KYRIZ_ECONOMY_JSON` juga — setengah isolasi = migrasi data dev tetap terjadi) + sanity pasca-test · **grep gate BSD-safe** (`--exclude-dir=fixtures` — terbukti empiris pattern berslash gak match di BSD grep macOS) + gate DELETE/DROP · restore DM: **STOP bot dulu** · `db.close()` di SIGTERM/SIGINT (checkpoint WAL) + "-wal bukan junk" · env-override: log resolved paths + WARN + fresh-under-override = THROW · writePlayer: guard validasi + upsert rowid-preserving + merge spread-only · withTransaction: wrap `db.transaction()` (async = TypeError) + larangan raw SQL · backupEconomy skip+no-prune saat COUNT=0 · fixture stale = FAIL bukan SKIP · Step 15 preconditions · Step 13 fixture per-run · derived-paths rule (semua artefak = sibling env-resolved path) · koreksi minor (anchor :42-51, shopManager write×4, §2 5 kolom, 10 player tanpa battle, lettering, §9 git-flow, tie-semantics rank, snapshotTo export, economy.json keluar dari targets array)
**Changelog v1.3:** env vars · gerbang atomisitas · transactional-DDL + guards · filter getAllPlayers · kontrak superadmin lengkap · getTransferData · abyss-LB SQL · fixture Step 0.5 · gladi sandbox · normalisasi absent-field · deploy git
**Changelog v1.2/v1.1:** (riwayat — lihat git)

---

## Pre-flight

- [x] **Step 0:** `npm install better-sqlite3` — Node v22.17.0, better-sqlite3 v13.0.3, load+CRUD roundtrip `:memory:` OK, 0 vulnerabilities. (`package.json` + `package-lock.json` ter-update BERSAMA — keduanya nanti masuk satu commit deploy).

- [x] **Step 0.5: Snapshot fixture legacy** — tersnapshot dari `5f0fa42` (SHA256 8691daac… + HEAD tercatat); layout sandbox terverifikasi: fixture resolve ke `test/fixtures/data/economy.json`, getUser roundtrip OK
  - `mkdir -p test/fixtures/legacy test/fixtures/data`
  - `git show <HEAD>:utils/economyManager.js > test/fixtures/legacy/economyManager.js` (catat commit SHA)
  - SHA-256 fixture → `test/fixtures/legacy/SHA256`
  - Layout sandbox: `__dirname`-fixture = `test/fixtures/legacy` → datanya `test/fixtures/data/economy.json`. Copy VERBATIM.
  - **Hash mismatch saat run = FAIL (exit non-zero), BUKAN SKIP** — harness yang di-SKIP = gerbang hijau palsu (drift-catcher utama gak jalan).

---

## Phase 1: Core Persistence Layer

- [x] **Step 1a:** DONE — kedua extractor masuk `battleEngine.js` (+import `ABYSS_FLOORS` dari abyssConfig, pure). **Parity probe atas data server asli 48 player**: battle LB 28 baris urutan+triple-nilai IDENTIK vs `getBattleLeaderboardFor`; abyss 9 baris IDENTIK (zero-skip cocok); null-battle → zeros. Engine tests tetap hijau (45+630) → `{ bestDepth, battleScore, scoreAchievedAt }` + `extractAbyssRanking(battleObj)` → `{ bestFloor, totalStars }`
  - Pure, di `battleEngine.js`. Sort triple identik `buildBattleLeaderboard` (bestDepth desc → score desc → achievedAt asc; fallback `|| registeredAt || '9999'`); stars/highest identik `handleAbyssLb`
  - Comment: *"Formula-dependent — retune `computeStats` WAJIB disertai recompute sweep"*

- [x] **Step 1b:** REWRITE DONE — sentinel tree terverifikasi 13 state via sandbox probes (happy migrate / refuse-empty / resume stale & crashed / suspect / corrupt / stray-json WARN / liveness race ditolak / kill-9 mid-tx pulih / double-boot / half-env THROW / fresh bersih). **3 bug tertangkap probe & difix**: (1) SUPERADMIN_ID unset → bind NULL membunuh semua baris LB (fix: `|| ''`), (2) `-wal` di samping db-nya sendiri dianggap yatim (fix: walOrphan hanya saat db hilang), (3) race crashed-migration tanpa cek liveness (fix: checkMigratingLiveness di semua cabang resume, tanpa swallow). Kontrak superadmin + transfer triple-skip + XP/daily/LB-filter/allPlayers-boolean terverifikasi perilaku
  - **Env override:** `DB_PATH = process.env.KYRIZ_ECONOMY_DB || <default>`; `JSON_SRC = process.env.KYRIZ_ECONOMY_JSON || <default>`. **Boot log WAJIB**: `[economy] DB=<resolved> JSON=<resolved> (override: yes/no)` + WARN keras kalau override aktif. **Override DB tanpa override JSON → THROW (setengah konfigurasi); KEDUA env diset = sandbox disengaka → fresh-create temp DIBOLEHKAN** (tanpa ini semua test THROW). **Derived-paths rule: SEMUA artefak** (`.migrating`, `.corrupt-<ts>`, `.pre-sqlite*`, `.orphan-<ts>`, `.suspect-<ts>`, backup dir) **= sibling dari env-resolved JSON_SRC/DB_PATH — DILARANG hardcode `data/economy.*`** di luar fallback default
  - Eager init top-level: WAL + `synchronous=NORMAL` + schema + auto-migration — sebelum exports dipakai siapa pun
  - **⛔ CHECK-FIRST, OPEN-LAST:** semua cek state (sentinel/parse) via `fs` SEBELUM `new Database()` (open = membuat file — jalur THROW tidak boleh meninggalkan db setengah-jadi; db hanya dibuka setelah cabang final diputuskan; resume-inspeksi `sqlite_master`/COUNT boleh karena db-nya sudah ada)
  - **Pohon boot lengkap (implement persis spec §5 v1.4):**
    - db EXISTS: integrity fail → THROW · `players` table tidak ada ATAU COUNT=0 **+ `.migrating` ada TANPA `.pre-sqlite`** → **migrasi crash pre-commit → HAPUS db kosong itu (dijamin tak berisi data — transactional) → RESUME dari `.migrating`** · COUNT=0/kosong + `.pre-sqlite` ada → THROW refuse-empty · COUNT=0/kosong + artefak APA PUN (`.suspect-*`/`.corrupt-*`/`.migrating*`/`-wal` yatim) → THROW (belt) · COUNT=0 + `economy.json` valid ada → THROW (restore era-JSON dideteksi) · COUNT>0 + `.migrating` ada → **wait mtime<30s (proses lain?) → archive `.migrating.orphan-<ts>` + LOG** · COUNT>0 + `economy.json` ada → ready + **WARN keras** ("economy.json diabaikan — DB aktif; restore JSON ≠ merge") · else ready
    - db NOT EXIST: `.migrating` ada → (mtime<30s → wait/recheck ×10 → THROW; tua → RESUME) · **`JSON_SRC` valid `{}` kosong (0 key) → rename `.suspect-<ts>` + THROW** (kelas insiden 2026-08-17) · `JSON_SRC` korup → rename `.corrupt-<ts>` + THROW · `JSON_SRC` valid → MIGRASI §5.1 · **`JSON_SRC` tidak ada → CEK SENTINEL dulu: kalau ADA `.pre-sqlite` / `.migrating*` / `.corrupt-*` / `economy.db-wal` yatim / file backup `data/backups/economy-*.db` → THROW refuse** ("data pernah ada — menolak boot kosong; recovery: …") · **baru kalau SEMUA bersih → fresh DB ✅**
    - Setiap boot LOG: player COUNT + resolved paths (boot kosong harus terlihat, bukan senyap)
  - **Migrasi §5.1 (v1.4):** claim-rename `JSON_SRC → .migrating` (kalau `.migrating` SUDAH ada = resume path, JANGAN overwrite — lewati langkah 1) → parse (gagal → `.migrating.corrupt-<ts>` + THROW; 0-key → `.suspect-<ts>` + THROW) → `db.transaction()` satu blok: CREATE + INSERT + COUNT-verify → COMMIT → **`never-clobber`: kalau `.pre-sqlite` sudah ada, rename yang lama ke `.pre-sqlite.<ts>` DULU** → rename `.migrating → .pre-sqlite` → log `[MIGRATION] N players`
  - INSERT eksplisit semua kolom; field opsional absent → default kolom; normalisasi bentuk kanonik di readPlayer; **`is_admin` dibaca balik sebagai boolean**; `last_daily` NULL → key hadir bernilai null; `battle` NULL → key dihilangkan
  - **Filter:** `is_admin = 0` HANYA getLeaderboard+getGlobalRank; getAllPlayers exclude superadmin saja. **Tie-semantics rank (kunci): pakai COMPETITION rank** (`COUNT(*)+1 WHERE balance > mine` — pemain seri dapat rank sama) — beda dari findIndex-legacy pada seri; harness men-assert semantik INI (dokumentasikan sebagai perubahan sadar yang lebih adil)
  - **Kontrak superadmin LENGKAP** (spec §4): Infinity/sintetik/no-op/triple-skip — persis
  - `getTransferData` (mutating getter, param objek) + limit helpers — keep-list eksplisit
  - New exports: `readPlayer`/`writePlayer`/`readAllPlayers`/`withTransaction`/`snapshotTo(destPath)→Promise` (wrapper db.backup untuk game.js — **DILARANG export raw `db`**)
  - **writePlayer guard:** THROW kalau obj null/undefined, username bukan string, balance bukan finite number (profil sintetik superadmin `Infinity/'?'` gak boleh pernah tertulis balik). **Upsert rowid-preserving:** `INSERT … ON CONFLICT(user_id) DO UPDATE` — DILARANG `INSERT OR REPLACE` (churn rowid = hancurkan tiebreak LB). **Merge `extra` HANYA object-spread** (own-property) — DILARANG `Object.assign(target-hidup, parsed)` dan deep-merge rekursif (prototype pollution)
  - **withTransaction:** WAJIB wrap `db.transaction(fn)` native (TypeError otomatis kalau fn async = fail-loud) · fn WAJIB sync · **DILARANG raw SQL via handle db — hanya readPlayer/writePlayer**
  - **Aturan SQL menyeluruh:** SEMUA nilai (username, kyID, filter) via bound param `?` — termasuk INSERT blok migrasi; `db.exec()` HANYA untuk PRAGMA/DDL statis tanpa data; template-literal SQL dilarang; LIKE/GLOB atas input user dilarang
  - **Invariant sync consumer:** urutan `readPlayer → writePlayer` WAJIB tetap sinkron — DILARANG await di antara (atomicitas = event-loop + better-sqlite3 sync; re-read fresh di tiap step interaksi)
  - `backupEconomy()`: **skip + JANGAN prune kalau COUNT(*)=0** (jaga backup JSON-era lama tetap hidup; log `[DATA SAFETY] refusing to snapshot/prune on empty db`) · db.backup Promise → `.catch` + **log sukses di completion callback** (bukan sebelum) · naming/prune 14

- [x] **Step 1c: ⛔ GERBANG ATOMISITAS — Steps 1b–7 = SATU UNIT** — DONE: no push terjadi sepanjang eksekusi (7 commit lokal, 0 push); no boot penuh dilakukan (semua via sandbox env)
  - No boot/no deploy/**no push** (`push = deploy` di egg AUTO_UPDATE) sampai Step 7 selesai. Verifikasi antar-phase = `node -c` + test runner saja

---

## Phase 2: Consumer Adaptation

- [x] **Step 2:** ADAPT shopManager DONE — 4 read + 4 write → readPlayer/writePlayer; self-check harness re-shim (per-player, deep-copy isolate) + assertion per-player shape; komentar stale dibersihkan (grep bersih: 0 hit). Self-check HIJAU di sandbox (4 read :37/:62/:91/:135, **4 write** :75/:115/:152/:162 + self-check harness)
  - → `readPlayer`/`writePlayer`; monkeypatch target pindah; **pertahankan invariant sync** (no await read→write); bersihkan comment literal `economy.json` (:2/:33/:173/:203) **dan** `readEconomy/writeEconomy` (:172/:257) agar grep gate bersih
- [x] **Step 3:** ADAPT battleManager DONE — 33 IO site → loadUserDict/saveUserDict (apply-* bekerja unchanged atas dict 1-player); global LB/rank → materialized (getBattleTopIds+readPlayersByIds hydrate top-N / getBattleRank SQL triple+rowid); recordPvp → withTransaction 2-player; migrateAllBattleData → readAllPlayers + per-user writePlayer (dirty-check per user). 0 referensi tersisa; test 53+43+44+82 hijau — single-user → readPlayer/writePlayer (sync invariant); `migrateAllBattleData` → readAllPlayers; `recordPvp` → withTransaction; global rank+LB → SQL kolom materialized (⛔ tanpa filter admin); varian memberIds/classFilter tetap bulk
- [x] **Step 4:** ADAPT abyssManager DONE — 5 site → readPlayer/writePlayer (dict-1-player inline); opts.data test-injection tetap. abyss.test 630 hijau (termasuk smoke read real :373) — 5 callsite di 4 fungsi (`canEnterFloor` :175, `recordClear` :180+:182, `getAbyssProgress` :187, `startAbyssFight` :330)
- [x] **Step 5:** ADAPT battleCommands DONE — :34 getBattle → readPlayer (+placeholder superadmin in-memory); :539 admin scan → readAllPlayers; :1130/:1162 duel → 2× readPlayer (makePlayer baca aU/bU closure); :1697 abyss LB → getAbyssTopRows SQL (zero-skip + no-admin-filter + empty-state dipertahankan). 0 referensi. (Step 8 exploit-shim terpaksa maju: readPlayer/writePlayer mock — 75 pass + 38/38 probes) — `:34` readPlayer · `:1130`+`:1162` 2× readPlayer · `:539` readAllPlayers (admin-only, diterima) · `:1697` SQL `WHERE abyss_best_floor > 0 OR abyss_total_stars > 0 ORDER BY … LIMIT 10` + empty-state branch + ⛔ tanpa filter admin

---

## Phase 3: Peripheral Updates

- [x] **Step 6:** DONE — economy.json keluar dari targets; snapshotTo → gzipSync → `economy.db.gz` (push sebelum guard, ikut count, cleanup temp di finally); player count via getAllPlayers; reason `gzip-fail` + 3 existing; teks restore = STOP-bot-first + instruksi gunzip + catatan era-JSON usang (literal filename dihilangkan demi gate)
  - **Keluarkan `'economy.json'` dari array `targets` (:958)** (sisakan replies/users/botState) + **hapus fallback `JSON.parse(readFileSync('economy.json'))` (:980-982)**
  - Alur: `snapshotTo(temp)` → gzip → push ke `attachments` SAMA **sebelum** guard length → include di count/summary · guard >8MB split, >50MB hard-stop+saran cloud · reason codes: **2 baru** (`gzip-fail`, `backup-too-large`) + 3 existing (`no-files`, `no-superadmin`, `dm-closed`) — semua gagal = log keras + DM peringatan
  - **Teks restore DM (rewrite :985):** "**1. STOP bot dulu** (panel → Stop, bukan restart) → 2. JSON: taruh di `data/` · `economy.db.gz`: `gunzip` → taruh sebagai `data/economy.db` → hapus `-wal`/`-shm` lama → 3. start bot → 4. cek `ky wallet` beberapa player". Tambah: "backup era-JSON (`economy.json` dari DM lama) TIDAK berlaku lagi pasca-migrasi — jalur restore SQLite saja"
  - Game kasino/admin/bansos TIDAK disentuh
- [x] **Step 7:** DONE — dead banner :42-51 diganti count polos (perilaku refuse-to-start tercatat); dailyBackupDM log SEMUA reason; ENOSPC||SQLITE_FULL di prefix+button; SIGTERM/SIGINT `closeDatabase()` (WAL checkpoint); namespace import economyManager
  - **Dead banner block :42-51** (bukan :41 — baris 41 opener `client.once('ready')` HIDUP) — hapus catch+banner-nya, ganti `playerCount = getAllPlayers().length` polos. Perilaku boot baru (korup = refuse-to-start) = keputusan tercatat spec §5
  - **SIGTERM/SIGINT: `try { db.close(); } catch {}` SEBELUM `process.exit(0)`** — checkpoint WAL ke file utama (tutup window "-wal berisi commit saat bot mati")
  - Broaden `error.code`: `ENOSPC` || `SQLITE_FULL` · `dailyBackupDM` log SEMUA reason non-sent · log snapshot boot dari completion callback · tmp-cleanup: jangan match `.db-wal`/`.db-shm`/`*.db`; **temp backup dinamai `economy.db.tmp-backup`** (match pola housekeeping `.tmp-` yang ada — file sisa gagal-kirim kebersihkan otomatis di boot)

---

## Phase 4: Tests

- [x] **Step 8:** DONE — exploit shim readPlayer/writePlayer (75 pass + 38/38 probes); classSwitch.test hijau tanpa perubahan (82); env isolate via harness sandbox
- [x] **Step 9:** DONE — **19/19 PASS**: fixture-hash gate (stale=FAIL) · replay 43-op identik (seeded RNG reset, timestamp-scrub, sorted-key canon, player-shape kanonik §3) · final-state deep-equal · round-trip + extra + __proto__-craft + rowid-stabilitas · battle LB order + abyss LB rows/zero-skip vs legacy
  - Fixture dari Step 0.5; **hash mismatch = FAIL**. Module baru via KEDUA env (fixture copy per-run — **migrasi mengonsumsi fixture** (rename), jadi salin segar sebelum tiap run)
  - (a) Round-trip: `deep-equal(readPlayer(writePlayer(obj)), normalize(obj))` — **invariant atas bentuk KANONIK** (bukan obj mentah); + assert rowid row TIDAK berubah across writePlayer; + player `extra` berisi `__proto__`/`constructor` craft → round-trip dengan Object.prototype tak tersentuh
  - (b) Replay API-surface (seeded Math.random reset antar run): register ×N → balance/daily/transfer/addXP/recordWin-Loss/updateUsername → **getUser(superadmin)** → **transfer sender-superadmin (triple-skip)** → getTransferData (rollover) → leaderboard/rank/getAllPlayers (admin TETAP di getAllPlayers, HILANG di leaderboard; **tie-semantics = competition rank, assert eksplisit**) → whitelist sadar: `getLeaderboard` legacy `cosmetics: null` vs baru `{}` (behavior identik — semua consumer `|| {}`)
  - (c) Materialized-order: battle LB + abyss LB (rows/order/zero-skip/empty-state) == legacy
- [x] **Step 10:** DONE — :373 real read berjalan via sandbox; unknown-user zeros terverifikasi (630 asserts hijau); klaim zero-IO lama terkoreksi di spec §8

---

## Phase 5: Verification

- [x] **Step 11:** ALL GREEN — abyss 630, battleManager 53, preset 43, pvp 44, battleEngine 45, battleConfig 60, botState 11, uniqueItems 5307, classSwitch 82, exploit 38/38, **parity 19/19**, crash 200038, shopManager+shopItems self-check, abyss_verify GATE PASS (1× fluka stokastik pita win-rate; 3× re-run PASS — kode combat tak tersentuh migrasi) — semua yang transitively require economyManager pakai **KEDUA env** temp: abyss, classSwitch×2, sqlite.parity, self-check shopManager + shopItems, battleManager.test, preset.test, crash.test, abyss_verify, pvp, battleEngine, battleConfig, botState, uniqueItems. **`node deploy-commands.js` bila dijalankan: isolate sama. POST-CHECK: `data/economy.json` dev masih ada & tak tersentuh (mtime+size) — kalau berubah: ada require telanjang yang kelewat**
- [x] **Step 12:** ALL GATES 0-HIT — g1 prod readEconomy/writeEconomy=0 · g2 test (excl fixtures + parity-duck-typing)=0 · g3 economy.json di luar economyManager=0 · g4 DELETE/DROP=0 (BSD-safe — dijalankan di macOS dev): (a) `grep -rn "readEconomy\|writeEconomy" commands/ utils/ handlers/ index.js` → 0 hit; `grep -rn "readEconomy\|writeEconomy" test/ --exclude-dir=fixtures --exclude=sqlite.parity.js` → 0 hit (parity harness boleh duck-type API legacy — itu komparatornya) (**`--exclude-dir=fixtures` basename — pattern berslash TIDAK match di BSD grep, terbukti empiris**) · (b) `grep -rn "economy\.json" commands/ utils/ handlers/ index.js` → hanya blok auto-migration · (c) `grep -rn "DELETE FROM players\|DROP TABLE" utils/ commands/` → **0 hit** (gerbang mekanis untuk §7 #4)
- [x] **Step 13:** DONE — `test/sqlite.migration.test.js` **10/10**: deep-equal per player (normalizer), .pre-sqlite di samping fixture, double-boot no re-migrate, materialized columns benar (depth 12/score>0/abyss 1★1, charless zeros), refuse-fresh THROW, resume-from-stale ✓
- [x] **Step 14:** DONE — `test/sqlite.gladi.test.js` **7/7**: data ASLI 48 player (snapshot → sandbox dinamai `economy.json` persis server live) migrasi **0 diff**, process-2 no re-migrate, repo economy.json + snapshot untouched (mtime+size) ✓
- [ ] **Step 15:** `npm start` lokal TANPA env — **PRECONDITION: `data/economy.json` ADA dan `data/economy.db` TIDAK ADA** (kalau db sudah ada: ada require telanjang yang memigrasi duluan — STOP, verifikasi count vs json, catat). Boot HARUS mencetak `[MIGRATION] … N players` — **tidak muncul = FAIL, bukan pass**. Lalu: register → wallet → daily → bj/cf → transfer → lb → lb battle → `ky battle abyss lb` → profile → battle+end → shop+buy → `ky backup` (`.db.gz`). (Jangan jalanin lokal+server token sama barengan.)
- [x] **Step 16:** DONE — `test/sqlite.resilience.test.js` **4/4**: SIGKILL mid-write-loop (20 player) → integrity_check ok + semua utuh; kill-9 mid-MIGRASI → resume otomatis (diprobe Step 1b) ✓
- [x] **Step 17:** DONE — snapshotTo → gzip → gunzip → restored db terbuka readonly dengan data termutakhir (jalur DM-restore tervalidasi end-to-end); SIGTERM-checkpoint terpasang via closeDatabase (Step 7) ✓

---

## Phase 6: Production Deploy (Raznar — git)

- [ ] **Step 18:** Commit final (package.json+lock satu commit) → **push = deploy**. Restart server → console: `git pull` → `npm ci` (download binary Linux) → `node index.js`. `data/` & `.env` tak tersentuh pull. Boot lebih lama = normal
- [ ] **Step 19:** Watch `[MIGRATION] … 48 players migrated` + `.pre-sqlite` muncul di `data/` server — **angka N ≠ 48 = STOP & investigasi**
- [ ] **Step 20:** Smoke: wallet/lb/profile/battle beberapa player, satu bet kecil, `ky backup`. **Cek panel env: PASTIKAN tidak ada `KYRIZ_ECONOMY_*` tersisa** (env nyasar = boot di db kosong di lokasi lain)
- [ ] **Step 21 (ROLLBACK — ditulis ulang total v1.4, urutan WAJIB):**
  1. **Maintenance window: matikan auto-restart/watchdog panel** (bukan cuma stop — restart liar di tengah sequence = re-migrate tak terduga → wipe via mekanisme 2026-08-17)
  2. **BACKUP DULU: `cp data/economy.db data/economy.db.pre-rollback-<ts>`** (+`-wal`/`-shm`) — db memuat SELURUH progres pasca-migrasi; `.pre-sqlite` hanya snapshot hari-H. **Rollback = progres sejak migrasi hilang** — keputusan sadar, bukan implisit
  3. **Sumber JSON — pilih SATU yang ada, JANGAN PERNAH `rm` `.migrating*`** (di window crash ia satu-satunya salinan): `.pre-sqlite` ada → rename → `economy.json`; else `.migrating` ada → rename → `economy.json`; else → **JANGAN lanjut** — pulihkan dari backup (langkah 2 / `data/backups/` / DM `.db.gz` — jalur recovery db-corrupt, BUKAN rollback)
  4. **Kode: `git revert <range-lengkap-commit-migrasi>` di lokal (urut tua→muda) → push.** Bot down sampai push mendarat — katakan eksplisit. **OPSI `git checkout` DIHAPUS** (detached HEAD × egg `git pull` + `set -euo pipefail` = bot tidak akan pernah nyala lagi)
  5. **Verifikasi `data/economy.json` ADA di disk SEBELUM setiap start** kode lama (kode lama: ENOENT → `{}` → wipe senyap)
  6. Re-enable auto-restart → start → verifikasi count
  - **Step 21b (RECOVERY db-corrupt — jalur least-loss, COBA DULU sebelum rollback):** integrity fail / db rusak → stop bot → **ambil `data/backups/economy-<terbaru>.db`** (atau DM `.db.gz` → gunzip) → taruh sebagai `data/economy.db` (hapus `-wal`/`-shm` lama) → start → verifikasi count+integrity. Progres maksimal hilang = 6 jam, bukan sejak migrasi

---

## File Checklist

| # | File | Action | Step |
|:---|:---|:---|:---:|
| 1 | `package.json` + `package-lock.json` | Add better-sqlite3 (satu commit) | 0 |
| 2 | `test/fixtures/legacy/*` + `test/fixtures/data/` | CREATE snapshot pra-rewrite | 0.5 |
| 3 | `utils/battleEngine.js` | MODIFY: 2 extractor | 1a |
| 4 | `utils/economyManager.js` | **REWRITE** (sentinel matrix + resume + contracts) | 1b |
| 5 | `utils/shopManager.js` | ADAPT + comment cleanup (:172/:257 juga) | 2 |
| 6 | `utils/battleManager.js` | ADAPT | 3 |
| 7 | `utils/abyssManager.js` | ADAPT (5 site / 4 fungsi) | 4 |
| 8 | `utils/battleCommands.js` | ADAPT | 5 |
| 9 | `commands/game.js` | MINOR (targets array, backup, teks restore) | 6 |
| 10 | `index.js` | MINOR (:42-51, db.close, logging) | 7 |
| 11-12 | `test/classSwitch.*` | ADAPT (KEDUA env) | 8 |
| 13 | `test/sqlite.parity.js` | CREATE | 9 |
| 14 | battleManager.test / preset.test / crash.test / abyss_verify | VERIFY (KEDUA env) | 11 |
| 15 | `deploy-commands.js` | NOTE: isolate saat dijalankan lokal | 11 |

---

## Execution Order Rationale

Step 0.5 sebelum 1b (sumber fixture musnah) → economyManager dulu → consumer urut kompleksitas → peripheral → parity sebelum functional → grep gates BSD-safe → gladi env-based → **rollback = last resort; recovery-backup = first resort** → push sekali di akhir = deploy.
