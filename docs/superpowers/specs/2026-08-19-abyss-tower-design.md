# Abyss Tower — Design Spec v3.1

**Date:** 2026-08-19 · **Status:** TUNED (sim-gated) — awaiting owner approval

> **v3.1:** REC_BIAS ditambahkan (keputusan owner): rekomendasi level = **aspirasional**. Boss F3+ di-tune di `recLevel × 1.1` tapi UI tetap menampilkan rec level asli — pemain clear nyaman di ≈ rec+10% ("rec 500, realistisnya 550 — biar berusaha"). F1–F2 bebas bias (onboarding harus epic-friendly) dan F9 mirror exempt (sudah self-scaling). Tambahan: **boss ult gating** (CD≥4 mulai setengah CD — PvP parity, hilangkan turn-1 Oblivion stun). F10: **P1 VAMPIRIC — lifesteal 25%** + enrage 8%/4t, hp ×2.55 (gate) — final **~55%@rec / ~91%@rec+10 / 0%@70%**. F9 gatekeeper: copy ⅓ + self-buff fungsional + adapt 6%/4t + hp ×1.3 (gate) → **69%@rec** average-player (optimizer menggilas — by design).
**Principle #0:** Pemainnya exploiter semua — setiap fitur didesain dengan sudut "kalau aku jahat, aku lewat mana?" dulu.

> **v3 changelog (dari v2):**
> - **Semua angka boss ditune via sim** (`test/abyss_tune_sim.js`) — v2 punya F4 & F10 yang secara matematis TIDAK BISA di-clear, dan rec-class F2/F7 terbalik (kelas rekomendasinya justru kalah). Semua multiplier di bawah = angka sim-green.
> - **Parameter combat dikunci** (§3): PvP-style ×0.7 scalar, ±15% roll, HP ×1.15 — v2 tidak mendefinisikannya.
> - **Kontrak kesulitan ditulis ulang dari data** (§4): GEAR (epic→divine) adalah gerbang progresi, bukan class. Rec level = level nyaman; clear actual F5–F9 ≈ 70–85% rec dengan divine.
> - **F8 disederhanakan**: drone tidak bisa di-target — timed pressure (hilang sendiri). Sistem targeting penuh didorong ke Hard Mode.
> - **F10 disederhanakan**: P1 = enrage saja (shield dihapus), P3 = berserk + anti-heal (regen dihapus).
> - **Weekly reset dihapus total** (v2 sudah memutuskan, v3 membersihkan semua sisa).
> - **Star thresholds dikalibrasi ulang** dari distribusi turn aktual (avg win 10–23 turns).
> - **Cross-locks** dengan delve/PvP/class-switch ditambahkan (§11).

---

## 1. Konsep

Spiral Abyss-style tower challenge: **10 floor**, setiap floor = 1 boss fight **turn-based** (player pilih skill manual, seperti PvP). Boss punya mekanik unik per floor. Rewards 1× permanen, star rating untuk replay value.

**Kenapa ini dibutuhkan:**
- Dungeon Delve = auto-resolve (stat check, no strategy)
- PvP = turn-based tapi butuh lawan online
- Abyss = **turn-based PvE** — strategic content, solo, kapan saja

**Command:** `ky battle abyss`

---

## 2. Core Rules

| # | Rule | Detail |
|---|---|---|
| R1 | **Sequential** | Harus clear Floor 1 sebelum unlock Floor 2, dst. |
| R2 | **Lv50→Lv500** | 10 floor, rec level 50–500. Expandable ke 11–20 later |
| R3 | **Class = hint, gear = gerbang** | Rec class hanya hint (semua class bisa clear semua floor). Gerbang progresi nyata = gear tier (epic wall mulai F3) dan level. _Data sim: wrong-class divine @ rec = 96–100% WR_ |
| R4 | **Replayable** | Floor cleared bisa dimasuki lagi. **Rewards 1× per floor selamanya** |
| R5 | **No Weekly Reset** | Rewards permanent 1×. Replay = improve stars only |
| R6 | **Fixed Boss Stats** | Boss stats dari rec level. **Exception: Floor 9 (Doppelganger) scales dengan player** |
| R7 | **Free Entry** | Tidak ada entry fee |
| R8 | **Full Heal per floor** | HP reset 100% sebelum setiap floor (×1.15 seperti PvP) |
| R9 | **Gear/Class Switch antar floor** | Boleh `ky preset load` / `ky switch` SEBELUM enter floor. Blokir saat fight aktif |
| R10 | **Restart Safety** | Bot restart mid-fight → fight hilang, no penalty, no reward |
| R11 | **30 Turn Limit** | 1 turn = 1 aksi player + 1 aksi boss. Boss belum mati di turn 30 = kalah |
| R12 | **Boss Must Die** | Satu-satunya win condition = boss HP ≤ 0 |

---

## 3. Combat Parameters ⚖️ (BARU di v3 — sebelumnya tidak terdefinisi)

Abyss memakai **semantik PvP** penuh (karena fight-nya turn-based PvP-style melawan bot):

| Parameter | Nilai | Catatan |
|---|---|---|
| Damage scalar | **×0.7** | Sama dengan PvP — fight harus cukup panjang supaya mekanik hidup |
| Damage roll | **±15% per hit** | Berlaku dua arah (player & boss) — comeback real |
| Player HP | `stats.hp × 1.15` | PvP ratio |
| Damage formula | `atk×mult − def×0.5` | `physicalDamage()`/`magicDamage()` dari battleEngine (dipakai pvpManager juga) |
| Berserker player | ×0.7 dampened | Konsisten PvP |
| Crit player | `getCritChance()` (precision, cap 50%, ×1.75) | |
| Defense chain player | parry > dodge charges > evasion (cap 48) > War Cry DR (cap 15) + fortify | Identik PvP — semua class identity jalan |
| Burn/Poison | Formula PvP: `matk/atk × pct` per tick, 3 turns, bypass semua defense & scalar 0.7 | Tick di awal turn korban |
| Boss crit | Per floor (§6) | Tier naik per floor |
| Lifesteal player | Penuh, dikurangi anti-heal boss (F4–F10; semua boss F5+ wajib punya sumber — v3.3) | |
| **Boss ult gating** | Skill boss CD≥4 mulai di **setengah CD** (PvP parity) | Tanpa ini F10 buka Oblivion+guaranteed stun di turn 1 sebelum player sempat act — feel-bad; gate menghilangkan turn-1 nuke, angka sudah di-tune dengannya |
| Boss stats | `computeStats(recLevel × 1.1, 'warrior'/'mage') × mult` untuk F3+; F1–F2 tanpa bias; F9 mirror exempt (§6) | PvE-style raw level; **REC_BIAS = aspirational rec** (UI menampilkan recLevel, bukan tuned level) |

---

## 4. Difficulty Contract 📊 (ditulis ulang dari data sim)

Baseline: **pemain Lv100+ sudah full divine** (info owner). Sim: `test/abyss_tune_sim.js`.

| Kondisi | F1–F2 (onboarding) | F3–F5 (gear check) | F6–F9 (challenge) | F10 (final, aspirational) |
|---|---|---|---|---|
| Divine @ rec (ditampilkan) | 100% (t10–12) | 99–100% (t10–22) | 100% (t15–20) | **35%** (t26) |
| Divine @ rec+10% (≈ tuned level) | 100% | 100% | 100% | **91%** (t24) |
| Divine @ 70% rec | 100% | 3–100% (F4 = 3% wall) | 36–100% (F7 = 36%) | **0%** (wall) |
| Epic @ rec | **97–100%** | 0% (**epic wall** mulai F3) | 0% | 0% |
| Divine SALAH passive @ rec | — | F4: 55%→94% di +20% level (rec 150→180) | F5: 14%→97% di +20% | 18% |

**Kesimpulan desain dari data:**
- Tower ini **gear-gated**: epic clear F1–F2, wall mulai F3. Divine = tiket masuk. Itu sesuai realitas playerbase.
- **F4 = gerbang mekanik pertama** (sustain fight, 3% @ 70% rec) — teacher fight untuk mekanik.
- **F10 = final wall aspirasional** — 35% di rec (500) ≈ clear dalam 3–4 percobaan (retry gratis, ~turn 26 dramatis), **91% di rec+10% (≈550)**, 0% di 70%. Last boss yang beneran terasa: 3 phase bergigi (vampiric → punish → berserk).
- Rec class = hint strategis, bukan gerbang. Salah PASSIVE build = gerbang lunak: F4 salah build 55% di rec → butuh +20% level (150→180).
- **Presige = stars**, bukan clear: 3⭐ (≤18 turns + HP ≥50%) itu yang membedakan player bagus.

---

## 5. UX Flow

### 5.1 Entry — `ky battle abyss`

**Step 1: Welcome Embed** — progress summary (highest floor, total stars), dropdown pilih floor (cleared + next uncompleted; F+ dan belum unlock tidak tampil), tombol [⚔️ Enter] (disabled sampai dropdown dipilih) + [🚪 Flee]. **Timer 60s** auto-flee; timer di-cancel di semua exit path.

**Step 2: Floor Info** (setelah dropdown) — edit embed: nama boss, archetype, skills lengkap dengan efek, deskripsi mekanik, rec class+level, star thresholds. Enter enabled. **Timer LANJUT dari sisa** (anti-stall).

**Step 3: Enter** — timer cancel → boss intro delay 1.5s → fight embed, player pick skill pertama.

### 5.2 Fight UI

- HP bar boss + player, `Turn X/30`, status efek aktif (burn/poison/root/shield/enrage/anti-heal)
- Tombol = 1 per skill (label CD), disabled saat CD/CC
- **AFK 120s per turn → auto-lose** (bukan 60s — boss fight butuh mikir; ini BUKAN "same as PvP")
- Boss turn: **buttons removed** (`components: []`) → sleep 1.5s → "preparing an attack..." → sleep 1.5s → hasil + buttons kembali. Semua edit `try/catch` silent-fail (pattern casino games)
- Player kena CC → tampil status + auto-skip turn (boss tetap jalan)

### 5.3 Fight End

- **Win**: stars, rewards breakdown, milestone, tombol [📋 View Progress] [➡️ Next Floor]
- **Lose (death)**: boss HP tersisa, turn kematian, [🔄 Retry] [📋 View Progress]
- **Lose (timeout)**: 30/30 turns, [🔄 Retry] [📋 View Progress]

---

## 6. Boss Definitions (TUNED — semua angka sim-green)

Boss stats = `computeStats(recLevel × 1.1, 'warrior')` untuk HP/ATK/DEF dan `computeStats(recLevel × 1.1, 'mage')` untuk MATK/MDEF (F3+; F1–F2 faktor 1.0), × multiplier berikut. **UI tidak pernah menampilkan tuned level — hanya recLevel** (aspirational by design; ekspektasi gear/passive juga tidak ditampilkan — discovery pemain). SPD fixed per boss. Semua nilai ini = **sumber: `test/abyss_tune_sim.js` FLOORS[]** — itu single source of truth angka; `abyssConfig.js` meng-copy nilai yang sama.

### Boss Crit Tiers

| Floors | Crit | Mult |
|:---:|:---:|:---:|
| 1–2 | 0% | — |
| 3 | 10% | ×1.5 |
| 4–6 | 15% | ×1.5 |
| 7–9 | 20% | ×1.75 |
| 10 | 25% | ×1.75 |

---

#### Floor 1 — 🐺 Feral Guardian *(onboarding)*
**Rec: Any class · Lv 50** — tutorial, tanpa mekanik.

| HP | ATK | MATK | DEF | MDEF | SPD |
|:---:|:---:|:---:|:---:|:---:|:---:|
| ×2.5 | ×0.6 | ×0.6 | ×0.5 | ×0.4 | 4 |

Skills: Bite 1.0× phys (CD0) · Claw 1.4× phys (CD2). AI: Claw > Bite.

#### Floor 2 — 🛡️ Stone Sentinel *(onboarding + shield teacher)*
**Rec: 🔮 Mage · Lv 80** — ⚠️ v2 rec warrior TERBALIK (warrior 8%, mage 100% — batu anti-fisik harus direkomendasikan ke mage).

| HP | ATK | MATK | DEF | MDEF | SPD |
|:---:|:---:|:---:|:---:|:---:|:---:|
| ×2.5 | ×0.5 | ×0.5 | ×0.6 | ×0.4 | 3 |

Skills: Slam 1.0× phys (CD0) · Heavy Blow 1.6× phys (CD3).
**Mechanic — 🛡️ SHIELD:** setiap 4 turn → barrier 15% max HP (absorb sampai pecah).

#### Floor 3 — 🔥 Infernal Drake *(gear check: epic wall pertama)*
**Rec: 🗡️ Rogue · Lv 110**

| HP | ATK | MATK | DEF | MDEF | SPD |
|:---:|:---:|:---:|:---:|:---:|:---:|
| ×2.3 | ×0.5 | ×0.95 | ×0.4 | ×0.5 | 10 |

Skills: Flame Breath 1.2× magic (CD0) · Scorch 1.0× magic +burn 12% 3t (CD2) · **Inferno 2.0× magic +burn 20% 3t (CD4)**.
**Mechanic — 🔥 ENRAGE:** turn 3/6/9... → MATK +10% permanen (stacking).

#### Floor 4 — 🌿 Ancient Treant *(gerbang mekanik: sustain marathon)*
**Rec: 🔮 Mage · Lv 150** — v2 TIDAK BISA di-clear (regen 8%/2t + heal 15% > DPS apapun). v3 ditune: clearable 100% @ rec (t20), 44% @ 70% rec.

| HP | ATK | MATK | DEF | MDEF | SPD |
|:---:|:---:|:---:|:---:|:---:|:---:|
| ×2.6 | ×0.5 | ×0.55 | ×0.6 | ×0.5 | 4 |

Skills: Root Slam 1.0× magic +20% root (CD0) · Nature's Wrath 1.5× magic (CD3) · **Nature's Embrace 1.5× magic +heal 8% +guaranteed root (CD6)**.
**Mechanic — 💚 REGEN:** setiap 4 turn → heal 4% max HP.

#### Floor 5 — ⚡ Thunder Wyrm *(counter teacher)*
**Rec: ⚔️ Warrior · Lv 200**

| HP | ATK | MATK | DEF | MDEF | SPD |
|:---:|:---:|:---:|:---:|:---:|:---:|
| ×2.5 | ×0.5 | ×0.8 | ×0.5 | ×0.6 | 7 |

Skills: Thunder Bolt 1.2× magic (CD0) · Storm Surge 1.8× magic (CD3) · **Lightning Storm 2.5× magic, pierceEvasion (CD5)**.
**Mechanic — ⚡ COUNTER:** player pakai skill CD>0 → 50% boss counter-hit 1.0×.

#### Floor 6 — 🌑 Shadow Warden *(phase teacher)*
**Rec: 🗡️ Rogue · Lv 250**

| HP | ATK | MATK | DEF | MDEF | SPD |
|:---:|:---:|:---:|:---:|:---:|:---:|
| ×3.4 | ×0.80 | ×0.80 | ×0.7 | ×0.3 | 7 |

Skills: Shadow Strike 1.1× phys (CD0) · Dark Pulse 1.5× magic (CD2) · Umbral Rend 1.8× phys (CD3).
**Mechanic — 🌑 PHASE SHIFT:** di 50% HP → DEF↔MDEF swap + guaranteed stun 1×.

#### Floor 7 — 🧊 Frost Lich *(anti-physical identity floor)*
**Rec: 🔮 Mage · Lv 300** — v2 aura 40% bikin rogue 0%; v3 = 30% (rogue divine 97%, identitas tetap terasa di epic/menengah).

| HP | ATK | MATK | DEF | MDEF | SPD |
|:---:|:---:|:---:|:---:|:---:|:---:|
| ×2.8 | ×0.5 | ×0.7 | ×0.8 | ×0.7 | 6 · **bossEvasion 15%** |

Skills: Frost Bolt 1.3× magic +20% freeze (CD0) · Ice Storm 2.0× magic (CD3) · Frost Nova 1.0× magic +75% freeze (CD5).
**👻 FROST FORM: 15% chance to fully evade any non-pierce attack** (attacks phase through the Lich).
**Mechanic — 🧊 FROST AURA:** permanen — physical damage ke boss −30%.

#### Floor 8 — 👥 Hive Queen *(swarm pressure — SIMPLIFIED v3)*
**Rec: 🗡️ Rogue · Lv 370** — v2 punya sistem targeting penuh (setengah kompleksitas fitur untuk 1 floor). v3: **drone tidak bisa di-target** — timed pressure.

| HP | ATK | MATK | DEF | MDEF | SPD |
|:---:|:---:|:---:|:---:|:---:|:---:|
| ×3.0 | ×0.70 | ×0.5 | ×0.5 | ×0.5 | 9 |

Skills: Sting 1.0× phys (CD0) · Toxic Spray 1.4× phys +poison 10% 3t +25% stun +**nest venom (LS −25%, 3t)** (CD2) · **Venomous Onslaught 2.0× phys +poison 15% 3t +FULL SHUTDOWN (LS −100%, 3t)** (CD4).
**Mechanic — 👥 SWARM:** setiap 3 turn spawn 1 drone (max 2 aktif). Drone: ATK 30% boss, nyerang tiap giliran boss, **mati sendiri setelah 3 turn**. Tidak ada targeting — player selalu hit boss (poison DoT player + burst = jawabannya).

#### Floor 9 — 🪞 The Doppelganger *(beat your best self)*
**Rec: ⚔️ Warrior · Lv 430** — boss = salinan player.

| Komponen | Dicopy? |
|:---|:---|
| Base stats (level + class player, gear flat stats ikut `computeStats`) | ✅ ×1.0 |
| HP | **×1.3** (gate-tuned) |
| **Passives player (gear)** | ✅ **sepertiga nilai (v/3)** — "dia belajar dari dirimu, kamu tetap unggul" |
| Swift | ❌ — SPD sama, tie = boss first |
| Skills class player (termasuk self-buff: parry/warcry/shadowdance) | ✅ **berfungsi penuh** |

Crit boss: 20% ×1.75 (fixed).
**Mechanic — 🌑 DARK ADAPTATION:** setiap 4 turn → ATK/MATK boss +6% permanen (stacking).
_Data GATE (engine riil, average-player rotation): **69% divine @ rec** (band 35–80 ✓), 80% @ 70% rec (level-independent ✓), epic 0%. **Catatan desain: pemain OPTIMAL (cd-priority play) menggilas mirror** — mirror by-construction pro-pemain ber-passive penuh vs boss copy-⅓; F9 = tantangan untuk pemain rata-rata, speedrun untuk optimizer. Warrior mirror = perang sustain (t18), mage = burn race cepat._

#### Floor 10 — 💀 Abyssal Overlord *(final wall — SIMPLIFIED v3)*
**Rec: Any · Lv 500** — v2 TIDAK BISA di-clear (shield+regen+berserk+counter stacking > 30 turns). v3: 94% @ rec divine (t23), 0% @ 70% rec.

| HP | ATK | MATK | DEF | MDEF | SPD |
|:---:|:---:|:---:|:---:|:---:|:---:|
| ×2.55 | ×0.7 | ×0.7 | ×0.7 | ×0.7 | 7 |

Skills: Void Slash 1.2× phys +20% stun (CD0) · Abyssal Blast 1.6× magic (CD2) · **Oblivion 2.5× MIXED +pierceEvasion +guaranteed stun (CD4)**. _Mixed = avg(hitungan phys, hitungan magic)._

**Mechanic — 💀 THREE PHASES:**

| Phase | HP | Mekanik |
|:---:|:---:|:---|
| 1 — 🩸 VAMPIRIC | 100–60% | **Lifesteal 25% dari damage yang dia hukum ke kamu** + 🔥 Enrage MATK +8% / 4 turn (stacking) — race dia sebelum dia kenyang |
| 2 — ⚡ PUNISH | 60–30% | Counter 20% saat player pakai skill CD>0 |
| 3 — 💀 BERSERK | 30–0% | Berserk (ATK/MATK ×1.5) + 🚫 Anti-Heal permanen (LS −30%) — dia berhenti menyembuhkan diri, main habis-habisan |

_Lifesteal P1 dihitung dari damage AKTUAL. Final F10 (GATE): **52% @ rec 500** (≈ 2 percobaan), **91% @ rec+10% (550)**, 14% salah-class, 0% @ 70%._

### 6.1 Boss Dialogues — ✅ FINAL (intro + victory + defeat taunt)

Intro muncul di floor-info embed + delay sebelum fight; victory line di result embed menang; **defeat taunt di result embed kalah** (owner request: bossnya ngejek). Data ini jadi bagian `BOSS_DIALOGUES` di abyssConfig (plan Task 1).

| Boss | Intro | Victory | Defeat (taunt) |
|:--|:--|:--|:--|
| 🐺 F1 | "Another pup wanders into the dark. Let's see if you can bite." | "The guardian falls. The tower takes notice." | "Was that a bite? Come back when you have teeth." |
| 🛡️ F2 | "Stone does not bleed. Stone does not break. Stone waits." | "Even mountains crumble. Climb." | "Stone does not celebrate. It simply remains." |
| 🔥 F3 | "You smell of fear and kryptonite. Both burn beautifully." | "The drake's fire gutters out. You are still standing." | "You burned for a while. Not long enough." |
| 🌿 F4 | "The forest has claimed greater heroes than you. It is... patient." | "The ancient roots wither. The path opens." | "The forest keeps what it takes. Including you." |
| ⚡ F5 | "You reach for power. Power reaches back." | "The storm is silenced. Something above stirs." | "You reached for power. It reached back. Told you." |
| 🌑 F6 | "I am every mistake you have ever made. Shall we begin?" | "The shadow dissolves — but it saw everything." | "I told you — I know your every move. Even the fatal one." |
| 🧊 F7 | "Warm-blooded. Brief. Come, freeze forever." | "The Lich shatters. Cold no longer lives here." | "Frozen. Forever. As promised." |
| 👥 F8 | "You are one. We are legion. Do the arithmetic." | "The hive falls silent. The queen was the arithmetic." | "One divided by legion. The arithmetic was never in your favor." |
| 🪞 F9 | "I know your every move. I AM your every move." | "You defeated the only opponent who truly knew you." | "You lost to yourself. Sit with that." |
| 💀 F10 | "Mortals climb my tower seeking meaning. I am the meaning at the top." | "The Overlord falls. The Abyss... is yours." | "The meaning at the top was never yours to take. Climb again, mortal." |

---

### Boss Passive Kits (live-feedback v3.2 + v3.3 anti-heal rule)

| Boss | Kit baru |
|:--|:--|
| F3 Drake | 🐲 Evasion 10% (Fireproof Scales) |
| F4 Treant | 🌿 Ult: anti-heal −50%/3t (roots drain vitality) |
| F5 Wyrm | ⚡ Evasion 12% (Stormform) + Storm Surge: anti-heal −35%/3t |
| F6 Warden | 🌑 Evasion 15% (Living Shadow) + Dark Pulse: anti-heal −30%/3t |
| F7 Lich | 👻 Evasion 18% (Frost Form) + Frost Nova: anti-heal −50%/3t + CC = "Frozen" |
| F8 Queen | 🧪 Nest venom −25%/3t + ult FULL SHUTDOWN −100% |
| F9 Mirror | 🪞 passiveCopy ⅓→**½** + hp **2.0** + evasion 12% + darkAdapt **3t/+8%** + shadow drain −25% permanen **dari round 1** (owner round 4-6: clear 19-56% per class, **3★ 0-11% — rare by design**, mage = satu-satunya class dgn pelanggan 3★ realistis) |
| F10 Overlord | 💀 P1 vampiric 30% + P2 counter 35% ×1.2 + wounds anti-heal −40%/3t + P3 anti-heal −60% permanen |

**Owner rule (v3.3): SEMUA boss F5+ wajib punya sumber anti-heal** — lifesteal build tidak boleh jadi win-all. Di bawah F5 opsional (F4 punya via ult).

## 7. Passive Interactions

Semua passive gear player jalan natural (PvP semantics): Berserker (dampened), Precision, Lifesteal (dikejar anti-heal F4–F10, semua boss F5+ wajib counter), Swift (initiative vs SPD boss), Fortify, Evasion (dipierce ult F5/F10), Greed/Wisdom (non-combat). Class identity jalan: parry warrior, dodge charges rogue, burn mage — semua via defense chain PvP.

---

## 8. Star Rating (kalibrasi v3 — dari distribusi turn sim: avg win 10–23)

| Stars | Condition |
|:---:|:---|
| ⭐⭐⭐ | Clear dalam **≤18 turns** DAN HP ≥ **50%** |
| ⭐⭐ | Clear dalam **≤25 turns** |
| ⭐ | Clear (boss mati ≤30 turns) |

Max 30 stars. Best kept. _F4 (sustain) & F10 (final) = mastery floors: 3⭐-nya memang sulit — itu desain._

---

## 9. Rewards — ✅ FINAL (keputusan owner: F10 base 300k 🧪)

**Structure:** 1× per floor permanen · star bonus 25% base per ⭐ · gear drops · milestones permanen.

| Floor | 🧪 Base | 🧪 per ⭐ | Gear Drop | Milestone |
|:-:|:-:|:-:|:--|:--|
| F1 | 2,000 | 500 | — | Title: 🗝️ Gatebreaker |
| F2 | 4,000 | 1,000 | — | 💎 100,000 |
| F3 | 8,000 | 2,000 | — | Title: 🐉 Drake Slayer |
| F4 | 12,000 | 3,000 | — | 💎 250,000 |
| F5 | 20,000 | 5,000 | 🟠 Legendary-tier drop | Title: ⚡ Stormcaller |
| F6 | 35,000 | 8,750 | — | 💎 500,000 |
| F7 | 55,000 | 13,750 | 🟡 Mythic-tier drop | Title: ❄️ Frozen Heart |
| F8 | 85,000 | 21,250 | — | 💎 750,000 |
| F9 | 150,000 | 37,500 | 🔶 Divine-tier drop | Title: 🪞 Self-Slayer |
| F10 | **300,000** | 75,000 | 🔶 Divine-tier drop | 💎 1,000,000 + Title: 💀 **Abyssal Overlord** |
| 30⭐ | — | — | 🌌 **Abyssal Edge** (lihat §9.1) | Title: 🌌 **Abyssal Master** |

**Total maksimum:** ~671k 🧪 base (≈1.17M dengan full 3⭐) + 2.6jt 💎 + 4 gear drop + 7 title. 1× permanen = inflation-proof.

### 9.1 🌌 Abyssal Edge — hadiah 30⭐ (keputusan owner)

| Aspek | Nilai |
|---|---|
| Tier baru | **[A] Abyssal** (di atas Divine, di bawah Immortal) — huruf A bebas |
| Bentuk | SATU weapon class-neutral: `🌌 Abyssal Edge` — pilihan 3 senjata DIBATALKAN (atk+matk dua-duanya menyelesaikan masalah class) |
| Stat | **+100 ATK & +100 MATK** fixed (divine max 55; off-stat = dead stat per class — tidak OP lintas class) |
| Passive | 🕳️ **Rupture 15%** (BARU: semua hit mengabaikan 15% DEF/MDEF target — tidak ada di gacha pool) + **roll 2 passive dari pool combat** di nilai MAX divine: brs 32 / prec 25 / LS 25 / swift 20 / fort 22 / eva 13 (greed/wisdom dikecualikan — trophy puncak tidak boleh ngerol sampah) |
| Guard | Tidak bisa dijual · 1 per akun · fixed stat (bukan re-roll) |
| **Cap rules** | **Semua passive Edge tetap kena cap normal** — weapon masuk pipeline `getPassives()` yang sama (brs→100, prec→50, evasion→40+base 48). Abyssal Edge TIDAK menembus cap apa pun. Rupture tidak stack (fixed 15%, tidak ada sumber lain) |
| **Display** | Rupture tampil di Active Passives `ky char` **dan** `ky preset` dengan deskripsi inline: `🕳️ Rupture 15% — attacks ignore 15% of target's DEF/MDEF` (passive lain format lama) |
| Dampak PvP (sim) | Pemegang ≈ autowin vs rival setara di mirror — **accepted by design**: eligibility super sempit (30⭐ = 3⭐ semua floor termasuk F10 ≤18t+HP50%), ~1 pemain pertama, berbulan-bulan. Knob darurat kalau komplain: nilai stat weapon di config |

**Implementasi rupture:** `battleEngine.resolveFight` + `pvpManager.resolvePvpTurn` masing-masing +1 baris (`def × 0.85` bila attacker punya rupture) — PENGECUALIAN terdokumentasi dari constraint "jangan sentuh engine" (dibutuhkan karena passive baru).

**Titles (milestone-only, TIDAK dijual di shop):** emoji nempel di value title (`🗝️ Gatebreaker`, `🐉 Drake Slayer`, `⚡ Stormcaller`, `❄️ Frozen Heart`, `🪞 Self-Slayer`, `💀 Abyssal Overlord`, `🌌 Abyssal Master`) — tampil otomatis di semua tempat title dirender (LB/PvP/profile) tanpa perubahan engine. Equip via sistem cosmetics yang sudah ada.

---

## 10. Data Structure

```json
{
  "battle": {
    "abyss": {
      "stars": [3, 2, 0, 0, 0, 0, 0, 0, 0, 0],
      "rewarded": [true, true, false, false, false, false, false, false, false, false],
      "milestones": { "f1": true, "f3_title": true, "master": false }
    }
  }
}
```

Account-level (satu progress untuk semua character — class switch antar floor legal by design). `stars[i]` = best (0 = belum clear). `rewarded[i]` = 1× selamanya. Tidak ada weekId.

---

## 11. Anti-Exploit + Cross-Locks

| # | Vektor | Guard |
|---|---|---|
| E1 | Replay farm | `rewarded[i]` 1× permanen |
| E2 | Skip floor | Sequential: `stars[i-1] > 0` |
| E3 | RNG reroll via restart | Restart = fight hilang, no reward, no penalty |
| E4 | Switch class/preset mid-fight | **Blokir saat `isInAbyssFight`** (sama seperti pending PvP challenge) |
| E5 | Double milestone | Boolean flag |
| E6 | Fight dobel | `activeAbyssFights` Map, 1 per user |
| E7 | Button spam | `processing` flag |
| E8 | Click setelah timer | Timer callback disable components |
| E9 | Klik button orang lain | Owner check semua interaksi |
| **E10** | **Delve saat abyss / abyss saat delve** | `ky battle` (delve) cek `isInAbyssFight`; abyss cek `hasActiveRun` |
| **E11** | **PvP saat abyss / abyss saat PvP** | Mutual: `isInFight` ↔ `isInAbyssFight` |
| **E12** | **Challenge PvP masuk saat abyss** | `ky battle @user` target yang lagi abyss → tolak dengan pesan |

---

## 12. Future Expansion

| Phase | Content | Trigger |
|:---|:---|:---|
| Floor 11–15 | Lv 550–750 | 5+ pemain clear F10 |
| Hard Mode | Floor yang sama ×1.5, star track terpisah, **di sini sistem targeting F8 penuh masuk** | Demand |
