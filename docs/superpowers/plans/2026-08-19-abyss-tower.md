# Abyss Tower Implementation Plan v3.1

> **For agentic workers:** PREREQUISITE: Read spec at `docs/superpowers/specs/2026-08-19-abyss-tower-design.md` (v3.1) FIRST. Semua angka boss di plan ini = angka sim-green dari `test/abyss_tune_sim.js`.

**Goal:** Turn-based boss tower (10 floors), star rating, rewards 1× permanen (values TBD). Command: `ky battle abyss`. PvP-style combat (×0.7 scalar, ±15% roll) dengan mekanik per-boss.

**Architecture:** `abyssConfig.js` (boss data, pure — copy dari sim), `abyssManager.js` (state + combat + AI), UI di `battleCommands.js`, routing di `game.js`.

**Tech Stack:** discord.js v14, JSON economy, test `node test/<name>.test.js`.

## Global Constraints

- **NO COMMIT** (owner workflow) — akhir task = run suite gate.
- Bot text FULL ENGLISH.
- **Jangan sentuh**: `economyManager.js` (import OK). **Pengecualian terdokumentasi**: `battleConfig.js` (entri tier [A] Abyssal + passive Rupture di PASSIVES — tanpa gacha range), `battleEngine.js` + `pvpManager.js` (+1 baris rupture: `def × 0.85` bila attacker punya rupture) — dibutuhkan untuk passive baru.
- **Reuse dari battleEngine**: `computeStats()`, `getPassives()`, `getCritChance()`, `physicalDamage()`, `magicDamage()`.
- **Combat parameters (LOCKED — spec §3):** scalar ×0.7, ±15% roll, player HP ×1.15, 30 turn limit (1 turn = 1 player action + 1 boss action), PvP defense chain (parry > dodge charges > evasion 48 > War Cry DR 15 + fortify), burn/poison = `casterStat × pct` per tick 3 turns bypass semua defense, berserker dampened ×0.7.
- **REC_BIAS = 1.1 untuk F3+** (F1–F2 = 1.0, F9 mirror exempt): boss stats dihitung dari `recLevel × 1.1`, UI menampilkan `recLevel` apa adanya. JANGAN tampilkan tuned level / ekspektasi gear di embed apa pun (keputusan owner — aspirational + discovery).
- **AFK 120s** (bukan 60 — boss fight butuh mikir; jangan tulis "same as PvP").
- **No weekly reset** — tidak ada `getWeekId`/`isNewWeek`/reset scheduler apa pun.
- **Angka boss = dari `test/abyss_tune_sim.js` FLOORS[]** — jangan invent ulang. Kalau perlu retune: edit sim, run, baru copy.
- **Cross-locks**: abyss ↔ delve ↔ PvP ↔ class-switch mutual exclusion (spec E4, E10-E12).

## File Map

| File | Action | Scope |
|:---|:---:|:---|
| `utils/abyssConfig.js` | **NEW** | 10 boss definitions (COPY nilai sim), star thresholds, TURN_LIMIT, milestones, reward placeholders (0) |
| `utils/abyssManager.js` | **NEW** | ensureAbyssData backfill, progress apply-fns, fight state, boss AI, combat resolution, mechanic handlers |
| `utils/battleCommands.js` | **MODIFY** | Abyss UI: welcome + dropdown + boss info + fight embed + animasi + result; cross-lock checks |
| `utils/battleManager.js` | **MODIFY** | `ensureBattleData` backfill `b.abyss`; expose `isInAbyssFight` via abyssManager import |
| `commands/game.js` | **MODIFY** | Route `ky battle abyss` (+ valid prefix list) |
| `test/abyss.test.js` | **NEW** | Config sanity + state + combat unit tests |
| `test/abyss_tune_sim.js` | **EXISTS** | Sim tuning — Task 3.5 memakainya sebagai gate |

---

### Task 1: Boss Config — `abyssConfig.js` (Pure Data)

**Files:** Create `utils/abyssConfig.js`, Create `test/abyss.test.js`
**Produces:** `ABYSS_FLOORS[]`, `TURN_LIMIT`, `STAR_THRESHOLDS`, `ABYSS_MILESTONES`, `ABYSS_REWARDS` (FINAL — spec §9: base 2k→300k, star 25%/⭐), `BOSS_DIALOGUES` (intro/victory/defeat-taunt — spec §5).

- [ ] **Step 1:** Transcribe FLOORS dari `test/abyss_tune_sim.js` (10 boss — stats mult, skills, mechanics, crit tier, recLevel/recClass). Struktur per floor:

```js
{
  id: 1, name: 'Feral Guardian', emoji: '🐺',
  recLevel: 50, recClass: null,
  hpMult: 2.5, atkMult: 0.6, matkMult: 0.6, defMult: 0.5, mdefMult: 0.4, spd: 4,
  crit: 0, critMult: 1.0,
  skills: [
    { id: 'bite', name: 'Bite', mult: 1.0, type: 'physical', cd: 0 },
    { id: 'claw', name: 'Claw', mult: 1.4, type: 'physical', cd: 2 },
  ],
  mechanic: null, // { kind: 'shield', every: 4, pct: 0.15 } dst — lihat sim
}
```

Catatan penting: **F2 recClass = 'mage'** (bukan warrior — sim proof), **F9 = mirror** (`mirror: true, hpMult: 2.0, passiveCopy: 1/3` — boss menyalin passives player di floor(v/3), dan skill self-buff hasil copy BERFUNGSI: parry/warcry/shadowdance boss aktif; lihat blok MIRROR di sim), **F10 mekanik = p1 VAMPIRIC (lifesteal 25% dari damage aktual + enrage 8%/4t) / p2 counter / p3 berserk+antiHeal** (tanpa shield/regen), **hp mult 2.5**.

- [ ] **Step 2:** `TURN_LIMIT = 30`, `STAR_THRESHOLDS = { three: { turns: 18, hpPct: 50 }, two: { turns: 25 } }`.
- [ ] **Step 3:** Milestone definitions + titles persis spec §9 + **Abyssal Edge (§9.1)**: tier [A] di TIER_INFO, Rupture di PASSIVES (tanpa ranges), template weapon fixed-stat {atk:100, matk:100} + 4 fixed passives [rupture 15, berserker 40, precision 30, lifesteal 30] — grant 1× di 30⭐, unsellable, tierBadge/passiveDesc entries, **passive Edge kena PASSIVE_CAPS normal via getPassives (tidak menembus cap — owner rule)** — value title SUDAH termasuk emoji: '🗝️ Gatebreaker', '🐉 Drake Slayer', '⚡ Stormcaller', '❄️ Frozen Heart', '🪞 Self-Slayer', '💀 Abyssal Overlord', '🌌 Abyssal Master' (milestone-only, tidak masuk shop) + 💎 milestones (100k/250k/500k/750k/1M).
- [ ] **Step 4:** Reward table FINAL dari spec §9 (base + 25% per ⭐ + gear drop tier F5/F7/F9/F10). Dialog intro/victory/defeat dari spec §5.
- [ ] **Step 5:** `test/abyss.test.js` — assert: 10 floors, field wajib per floor, skill CD valid, F9 mirror flag, angka == angka sim (parse sim file? tidak — assert literal sumber konstanta sama dengan sim via require nilai kunci), star thresholds konsisten.
- [ ] **Step 6:** Run → PASS.

---

### Task 2: State Manager — `abyssManager.js` (Data Layer)

**Files:** Create `utils/abyssManager.js`, Modify `utils/battleManager.js`, Extend `test/abyss.test.js`
**Produces:** `ensureAbyssData`, `canEnterFloor`, `applyRecordClear`, `applyClaimReward`, `getAbyssProgress`.

- [ ] **Step 1:** Backfill di `battleManager.ensureBattleData`:
```js
if (!b.abyss) b.abyss = { stars: Array(10).fill(0), rewarded: Array(10).fill(false), milestones: {} };
```
- [ ] **Step 2:** Pure apply-fns:
  - `applyCanEnterFloor(data, userId, floorIdx)` → sequential (`stars[i-1] > 0`), punya character, tidak ada fight aktif
  - `applyRecordClear(data, userId, floorIdx, turns, hpPct)` → hitung stars (thresholds), update best, unlock milestones
  - `applyClaimReward(data, userId, floorIdx)` → guard `rewarded[i]` 1× selamanya
- [ ] **Step 3:** IO wrappers (read→apply→write, atomic via economyManager writer).
- [ ] **Step 4:** Tests: sequential unlock, 1× reward permanen, star calc (3/2/1 boundary: 18t+50% / 25t / 30t), star improvement on replay, milestone sekali.
- [ ] **Step 5:** Run → PASS.

---

### Task 3: Combat Engine — `abyssManager.js` (Fight Logic)

**Files:** Modify `utils/abyssManager.js`
**Produces:** `startAbyssFight`, `resolvePlayerTurn`, `resolveBossTurn`, `bossChooseSkill`, mechanic handlers, `activeAbyssFights` Map + `isInAbyssFight`.

**REFERENSI IMPLEMENTASI: logika fight di `test/abyss_tune_sim.js` fungsi `simulate()`** — struktur turn, defense chain, DoT, CC, mekanik tick, boss AI sudah dimodelkan lengkap di sana. Port ke manager (state per-fight, bukan loop sinkron), JANGAN redesign.

- [ ] **Step 1:** `computeBossStats(floor, playerStats)` — persis formula sim, termasuk REC_BIAS (`floor.id <= 2 || floor.mirror ? 1.0 : 1.1`) (mirror F9: player stats ×1.0, HP ×2.0, SPD tanpa Swift).
- [ ] **Step 2:** Fight state (userId-keyed Map): player {stats, passives, hp/hpMax ×1.15, cd, buff, burn, poison, parry, dodgeCharges, evasion, ccTurns, antiHealTurns}, boss {stats, hp, cd, enrageStack, shieldHp, phase, burn, poison}, drones[], turnCount, over, winner, events[], processing. **Init boss cd: skill CD≥4 mulai di ceil(cd/2)** (ult gating — sim melakukannya, angka ter-tune dengannya).
- [ ] **Step 3:** `resolvePlayerTurn(userId, skillId)` — validate (fight ada, !over, !processing, skill valid, CD 0) → player DoT tick → CC skip → damage (scalar+roll+berserker dampen+crit) → mekanik player-side (frost aura F7, shield absorb F2) → efek skill (burn/poison/parry/dodge/buff) → lifesteal (anti-heal aware) → **counter check F5/F10-P2 (skill CD>0)** → boss death check → events.
- [ ] **Step 4:** `resolveBossTurn(fight)` — mechanic ticks (order: shield → enrage → regen → summon → phase → darkAdapt) → phase transitions (F6 @50% swap+stun; F10 @60/@30) → boss DoT tick → bossChooseSkill (ult > s2 > basic, CD-gated) → attack (crit per floor, defense chain player, CC apply, DoT apply, anti-heal apply, self-heal F4) → drones attack → player death check → turnCount++ → 30-limit check → events.
- [ ] **Step 5:** Mechanic handlers modular: shield/enrage/regen/counter/phaseShift/frostAura/swarm(TTL-3 drones, untargetable)/**mirror (F9: stats player ×1.0, HP ×2.0, passives floor(v/3) — brs dampened + crit + LS + fort + eva boss-side; skill self-buff copy berfungsi: boss parry/dodge charges/warcry buff)**/darkAdapt/berserk+antiHeal/**bossLifesteal (F10-P1: heal = actualDmg × 0.25, hanya phase 1)**.
- [ ] **Step 6:** End: win → stars + recordClear + rewards claim path; lose/timeout → embed data. `endAbyssFight(userId)` cleanup + AFK timer clear.
- [ ] **Step 7:** Tests: F1 basic fight menang; F2 shield absorb; F4 regen+root; F6 phase swap; F9 mirror pakai stats player; F10 phase transitions; CC skip; anti-heal mengurangi lifesteal; counter trigger; turn-limit timeout.
- [ ] **Step 8:** Run → PASS.

---

### Task 3.5: ⚖️ BALANCE GATE — Sim Verifikasi Engine Riil (WAJIB sebelum UI)

**Files:** Extend `test/abyss_tune_sim.js` (mode verify), Modify `utils/abyssConfig.js` jika drift
**Why:** sim tuning memodelkan mekanik; engine riil = implementasi. Gate ini membuktikan keduanya match.

- [ ] **Step 1:** Tambah mode `node test/abyss_tune_sim.js verify` — ganti internal `simulate()` loop dengan driver yang memanggil **abyssManager fight API** (`startAbyssFight` + auto-player pattern [0,1,0,1,2] via `resolvePlayerTurn`/`resolveBossTurn`) per floor × {rec class divine, wrong class divine, epic, 70% level}.
- [ ] **Step 2:** Assert band per tier (spec §4, v3.1): F1–F2 semua kondisi ≥ 90% (epic included), epic F3+ ≤ 10%, divine @rec+10% ≥ 90% SEMUA floor, F10 divine @rec 40–70%, F10 @70%rec ≤ 10%, avg win turns ≤ 27.
- [ ] **Step 3:** Kalau ada drift > ±10pt: tune `abyssConfig.js` (bukan engine), rerun sampai hijau. Log hasil akhir di file spec bagian §4 (update angka jika berubah).
- [ ] **Step 4:** Run gate → PASS → baru lanjut Task 4.

---

### Task 4: UI — `battleCommands.js` + Routing & Cross-Locks

**Files:** Modify `utils/battleCommands.js`, Modify `commands/game.js`

- [ ] **Step 1: Entry flow** — welcome embed (progress + stars), StringSelectMenu floor list (cleared + next uncompleted, format `Floor 4 — 🌿 Ancient Treant 🔒 NEW` / `⭐⭐⭐`), Enter (disabled awal) + Flee, 60s timer (cancel di semua exit; **timer lanjut dari sisa** saat dropdown dipilih).
- [ ] **Step 2: Boss info** — edit embed: skills + efek, mekanik, rec class+level (satu saja), star thresholds. Enter enabled.
- [ ] **Step 3: Fight embed** — HP bars dua sisi, Turn X/30, efek aktif, log turn terakhir, skill buttons (CD di label, disabled saat CC), AFK **120s** auto-lose.
- [ ] **Step 4: Animasi boss turn** — buttons `components: []` → sleep 1.5s → "preparing..." → sleep 1.5s → hasil + buttons balik. `try { await msg.edit() } catch {}` semua.
- [ ] **Step 5: Result embeds** — win (stars, rewards, milestone, [📋 Progress] [➡️ Next Floor]) / lose / timeout ([🔄 Retry] [📋 Progress]).
- [ ] **Step 6: Progress panel** — 10 floor, stars, reward claimed, total stars.
- [ ] **Step 6b: Rupture di Active Passives** — `ky char` (buildCharEmbed) **dan** `ky preset` panel (dua-duanya): baris rupture dirender dengan deskripsi inline karena passive-nya baru/asing:
  `🕳️ Rupture 15% — attacks ignore 15% of target's DEF/MDEF`
  (passive lain tetap format lama tanpa deskripsi. Rupture otomatis mengalir ke passSum via entri PASSIVES catalog — pastikan catalog entry ada + kasus khusus render di KEDUA lokasi.)
- [ ] **Step 7: Cross-locks (spec E4/E10/E11/E12)**:
  - `ky battle` (delve start): tolak jika `abyss.isInAbyssFight(userId)`
  - Abyss entry: tolak jika `battle.hasActiveRun(userId)` ATAU `pvp.isInFight(userId)`
  - PvP challenge + accept: tolak jika salah satu `isInAbyssFight`
  - `ky switch`/`ky preset load`/buyclass: tolak jika `isInAbyssFight` (pattern sama pending-challenge lock)
- [ ] **Step 8: Routing `game.js`** — pastikan arg `ky battle abyss` mengalir: handler battle existing menerima args; tambah `'abyss'` ke prefix valid list; `ky battle abyss lb` (bonus, sort floor → stars).
- [ ] **Step 9:** Manual test full flow di server test.

---

### Task 5: Help & Polish

**Files:** Modify `battleCommands.js`, `commands/game.js`

- [ ] **Step 1:** Section Abyss di `ky battle help` (page 1): konsep, command, star, catatan "gear matters — epic hits a wall at Floor 3".
- [ ] **Step 2:** Warna embed per archetype (red=aggro, blue=tank, green=sustain, purple=chaos).
- [ ] **Step 3:** Smoke test: entry → select → fight → win → lose → timeout → replay → cross-locks semua jalan.
- [ ] **Step 4:** Full suite gate.

---

## Verification Plan

```bash
node test/abyss.test.js            # config + state + combat
node test/abyss_tune_sim.js verify # BALANCE GATE (Task 3.5)
for t in battleManager pvp classSwitch preset battleEngine battleConfig botState; do node test/$t.test.js | tail -1; done
```

### Manual Verification
1. `ky battle abyss` → welcome, dropdown, timer expire → flee
2. Select → boss info → Enter → fight start (animasi benar, buttons hilang saat boss turn)
3. Win → stars+rewards benar; replay → no reward, star improvement jalan
4. Sequential lock; cross-locks (delve/PvP/switch saat fight) tolak
5. Timeout 30 turns → lose embed; AFK 120s → auto-lose
6. Restart bot mid-fight → no crash, fight gone, bebas re-enter
7. F9 → boss = stats player (ganti class → boss ikut beda di fight berikutnya)
8. Epic gear @ F3+ → kalah (wall) sesuai kontrak
