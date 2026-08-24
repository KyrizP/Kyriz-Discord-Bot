# 🏗️ ABYSS TOWER — Boss Codex
### Referensi internal owner (JANGAN dibagikan ke pemain — berisi ekspektasi gear & angka WR)

> Sumber angka: `test/abyss_tune_sim.js` (sim, formula engine asli, 3 run stabil).
> Spec: `docs/superpowers/specs/2026-08-19-abyss-tower-design.md` (v3.1).

---

## ⚙️ Aturan Global

| Rule | Nilai |
|---|---|
| Entry | **Gratis, tanpa gate level** — rec level murni info (siapa pun yang sudah unlock berurutan boleh masuk, berkali kali) |
| Urutan | Sequential: clear F(n) buka F(n+1). Replay bebas |
| Turn limit | **30** (1 turn = 1 aksi player + 1 aksi boss) — boss belum mati = kalah |
| Combat | PvP-style: damage ×0.7, roll ±15%/hit, player HP ×1.15, defense chain parry > dodge charges > evasion (cap 48) > War Cry DR (15) + fortify |
| Boss ult gating | Skill boss CD≥4 mulai di setengah CD (tidak ada nuke turn-1) |
| DoT | Burn/poison = `stat × pct` per tick ×3 turn, bypass semua defense & scalar |
| REC_BIAS | Boss F3+ di-tune di **rec × 1.1** — UI menampilkan rec asli → rec itu **aspirasional**, clear nyaman ≈ rec +10% |
| AFK | 120 detik per giliran → auto-lose |
| Restart bot | Fight hilang, no penalty, no reward |
| Rewards | 1× per floor permanen, replay = improve stars. Base 2k→300k 🧪 (F1→F10) + 25% per ⭐ |
| Stars | ⭐⭐⭐ ≤18 turn + HP ≥50% · ⭐⭐ ≤25 turn · ⭐ clear |

---

## 📊 Ringkasan 10 Floor

| F | Boss | Rec Class | Rec Lv | Mekanik Inti | Epic @rec | Divine @rec | Divine @70%rec |
|:-:|:--|:--|:-:|:--|:-:|:-:|:-:|
| 1 | 🐺 Feral Guardian | Any | 50 | — (tutorial) | 100% | 100% | 100% |
| 2 | 🛡️ Stone Sentinel | 🔮 Mage | 80 | Shield 15%/4t | 100% | 100% | 100% |
| 3 | 🔥 Infernal Drake | 🗡️ Rogue | 110 | Enrage +10% MATK/3t | **0%** ← epic wall | 100% | 100% |
| 4 | 🌿 Ancient Treant | 🔮 Mage | 150 | Regen 4%/4t + root | 0% | 99% | **3%** ← wall |
| 5 | ⚡ Thunder Wyrm | ⚔️ Warrior | 200 | Counter 50% on CD-skill | 0% | 100% | 99% |
| 6 | 🌑 Shadow Warden | 🗡️ Rogue | 250 | Phase @50% DEF↔MDEF + stun | 0% | 100% | 100% |
| 7 | 🧊 Frost Lich | 🔮 Mage | 300 | Frost Aura −30% phys | 0% | 100% | 39% |
| 8 | 👥 Hive Queen | 🗡️ Rogue | 370 | Swarm drone (TTL 3, max 2) | 1% | 100% | 95% |
| 9 | 🪞 Doppelganger | ⚔️ Warrior* | 430 | Mirror = dirimu + copy ⅓ + adapt 6%/4t | 0% | **69%** ← gatekeeper | 80% |
| 10 | 💀 Abyssal Overlord | Any | 500 | 3 Phase (vampiric→punish→berserk) | 0% | **52%** ← final | 0% |

*F9 mirror: class-nya = class kamu sendiri (rec warrior hanya label).

**Eskalasi:** F1–F8 divine @rec = 100% (temboknya di level/gear pemain, bukan rec) → **F9 69%** (gatekeeper) → **F10 52%** (final, clear nyaman di ~550). Semua angka = GATE (engine riil, test/abyss_verify.js).

---

## 🐺 F1 — Feral Guardian · *Onboarding*
**Rec: Any · Lv 50** · Physical · SPD 4 · Crit 0%

| HP | ATK | MATK | DEF | MDEF |
|:-:|:-:|:-:|:-:|:-:|
| ×2.5 | ×0.6 | ×0.6 | ×0.5 | ×0.4 |

| Skill | Mult | CD | Efek |
|:--|:-:|:-:|:--|
| Bite | 1.0× phys | 0 | — |
| Claw | 1.4× phys | 2 | — |

**Tanpa mekanik.** Boss pemula — semua orang menang.

---

## 🛡️ F2 — Stone Sentinel · *Shield Teacher*
**Rec: 🔮 Mage · Lv 80** · Physical · SPD 3 · Crit 0%

| HP | ATK | DEF | MDEF |
|:-:|:-:|:-:|:-:|
| ×2.6 | ×0.5 | ×0.6 | ×0.4 |

| Skill | Mult | CD | Efek |
|:--|:-:|:-:|:--|
| Slam | 1.0× | 0 | — |
| Heavy Blow | 1.6× | 3 | — |

**🛡️ SHIELD:** tiap 4 turn → barrier 15% max HP (absorb sampai pecah).
*Anti-fisik — makanya rec mage (magic nembus batu). Pemain baru epic di bawah ±Lv75 akan mentok di sini = gerbang grind pertama.*

---

## 🔥 F3 — Infernal Drake · *Gear Check / Epic Wall*
**Rec: 🗡️ Rogue · Lv 110** · Magic · SPD 10 (cepat!) · Crit 10% ×1.5

| HP | MATK | DEF | MDEF |
|:-:|:-:|:-:|:-:|
| ×2.3 | ×0.95 | ×0.4 | ×0.5 |

| Skill | Mult | CD | Efek |
|:--|:-:|:-:|:--|
| Flame Breath | 1.2× | 0 | — |
| Scorch | 1.0× | 2 | 🔥 Burn 12% MATK / 3t |
| **Inferno** | **2.0×** | 4 | 🔥 Burn 20% MATK / 3t |

**🔥 ENRAGE:** tiap 3 turn → MATK +10% permanen (stacking).
*DPS race — glass cannon cepat. Epic = 0% (dinding gear pertama), divine = 100% t10.*

---

## 🌿 F4 — Ancient Treant · *Gerbang Mekanik (Sustain Marathon)*
**Rec: 🔮 Mage · Lv 150** · Magic · SPD 4 · Crit 15% ×1.5

| HP | MATK | DEF | MDEF |
|:-:|:-:|:-:|:-:|
| ×2.6 | ×0.55 | ×0.6 | ×0.5 |

| Skill | Mult | CD | Efek |
|:--|:-:|:-:|:--|
| Root Slam | 1.0× | 0 | 🌿 20% Root (skip 1 turn) |
| Nature's Wrath | 1.5× | 3 | — |
| **Nature's Embrace** | 1.5× | 6 | 💚 Heal boss 8% + 🌿 Root guaranteed |

**💚 REGEN:** tiap 4 turn → heal 4% max HP.
*Fight paling panjang (t21). Kuncinya DPS net > regen — burst saat Embrace CD. Wall keras: 3% @ 70% rec. Salah passive build (tanpa damage passive) = butuh ~Lv180.*

---

## ⚡ F5 — Thunder Wyrm · *Counter Teacher*
**Rec: ⚔️ Warrior · Lv 200** · Magic · SPD 7 · Crit 15% ×1.5

| HP | MATK | DEF | MDEF |
|:-:|:-:|:-:|:-:|
| ×2.5 | ×0.8 | ×0.5 | ×0.6 |

| Skill | Mult | CD | Efek |
|:--|:-:|:-:|:--|
| Thunder Bolt | 1.2× | 0 | — |
| Storm Surge | 1.8× | 3 | — |
| **Lightning Storm** | **2.5×** | 5 | pierceEvasion (ignores dodge) |

**⚡ COUNTER:** player pakai skill CD>0 → **50%** boss counter-hit 1.0×.
*Dilema: spam skill (kena counter) vs basic saja (DPS rendah). Ult-nya pierce — evasion rogue tidak berguna di sini.*

---

## 🌑 F6 — Shadow Warden · *Phase Teacher*
**Rec: 🗡️ Rogue · Lv 250** · Mixed · SPD 7 · Crit 15% ×1.5

| HP | ATK | MATK | DEF | MDEF |
|:-:|:-:|:-:|:-:|:-:|
| ×3.4 | ×0.8 | ×0.8 | ×0.7 | ×0.3 |

| Skill | Mult | CD | Efek |
|:--|:-:|:-:|:--|
| Shadow Strike | 1.1× phys | 0 | — |
| Dark Pulse | 1.5× magic | 2 | — |
| Umbral Rend | 1.8× phys | 3 | — |

**🌑 PHASE SHIFT @ 50% HP:** DEF↔MDEF swap + guaranteed stun 1×.
*Damage type-mu yang efektif di paruh pertama jadi tidak efektif di paruh kedua — damage campuran / adaptasi. Wall para pemain Lv~170 (0%).*

---

## 🧊 F7 — Frost Lich · *Anti-Physical Identity*
**Rec: 🔮 Mage · Lv 300** · Magic · SPD 6 · Crit 20% ×1.75

| HP | MATK | DEF | MDEF |
|:-:|:-:|:-:|:-:|
| ×2.8 | ×0.7 | ×0.8 | ×0.7 |

| Skill | Mult | CD | Efek |
|:--|:-:|:-:|:--|
| Frost Bolt | 1.3× | 0 | ❄️ 20% Freeze (skip 1 turn) |
| Ice Storm | 2.0× | 3 | — |
| Frost Nova | 1.0× | 5 | ❄️ 75% Freeze |

**🧊 FROST AURA (permanen):** physical damage ke boss **−30%**.
*Floor identitas: physical class (warrior/rogue) dipaksa lebih keras. Wrong-class divine 78% — masih bisa, tapi terasa.*

---

## 👥 F8 — Hive Queen · *Swarm Pressure*
**Rec: 🗡️ Rogue · Lv 370** · Physical · SPD 9 (cepat) · Crit 20% ×1.75

| HP | ATK | DEF | MDEF |
|:-:|:-:|:-:|:-:|
| ×3.0 | ×0.7 | ×0.5 | ×0.5 |

| Skill | Mult | CD | Efek |
|:--|:-:|:-:|:--|
| Sting | 1.0× | 0 | — |
| Toxic Spray | 1.4× | 2 | 🧪 Poison 10% / 3t + ⚡ 25% stun + 🚫 nest venom (LS −25%, 3t) |
| **Venomous Onslaught** | **2.0×** | 4 | 🧪 Poison 15% / 3t + 🚫 **FULL HEAL SHUTDOWN (LS −100%, 3t)** |

**👥 SWARM:** tiap 3 turn spawn drone (max 2 aktif) — drone ATK 30% boss, nyerang tiap giliran, **mati sendiri dalam 3 turn** (tidak bisa di-target).
*Tekanan DPS konstan + window anti-heal dari ult. Burst & poison = jawabannya.*

---

## 🪞 F9 — The Doppelganger · *GATEKEEPER — Beat Your Best Self*
**Rec: ⚔️ Warrior · Lv 430** *(label saja — boss = class KAMU)* · Crit 20% ×1.75

| Komponen | Boss |
|:--|:--|
| Stats | = stats kamu ×1.0 (ikut level, class, flat stats gear) |
| HP | = HP kamu ×1.3 (gate-tuned) |
| **Passives gear kamu** | **disalin sepertiga (v/3)** — brs/crit/LS/fort/eva versi lemah |
| Skills class kamu | **berfungsi penuh** — termasuk parry/warcry/shadowdance-nya |
| SPD | sama dengan kamu (tanpa Swift), tie = boss duluan |

**🌑 DARK ADAPTATION:** tiap 3 turn → ATK/MATK boss +15% permanen (stacking) — DPS race melawan dirimu.
**Hasil:** divine @rec **79–83%** (gatekeeper!), @70% rec 73% (level-independent — selalu fair), epic 0%.
*Warrior-mirror = perang sustain panjang (t25) · rogue-mirror = duel poison-evasion · mage-mirror = burn race cepat (t10).*

---

## 💀 F10 — Abyssal Overlord · *FINAL BOSS*
**Rec: Any · Lv 500** (aspirasional — clear nyaman ±550) · Mixed · SPD 7 · Crit 25% ×1.75

| HP | ATK | MATK | DEF | MDEF |
|:-:|:-:|:-:|:-:|:-:|
| ×2.5 | ×0.7 | ×0.7 | ×0.7 | ×0.7 |

| Skill | Mult | CD | Efek |
|:--|:-:|:-:|:--|
| Void Slash | 1.2× phys | 0 | ⚡ 20% Stun |
| Abyssal Blast | 1.6× magic | 2 | — |
| **Oblivion** | **2.5× MIXED** | 4 | pierceEvasion + ⚡ guaranteed stun |

*Mixed = rata-rata perhitungan physical & magic — def satu sisi tidak cukup.*

**TIGA PHASE:**

| Phase | HP | Mekanik |
|:-:|:--|:--|
| 🩸 **VAMPIRIC** | 100–60% | **Lifesteal 25% dari damage yang dia hukum ke kamu** + Enrage MATK +8%/4t — race dia sebelum dia kenyang (defense/fortify = nilai dobel) |
| ⚡ **PUNISH** | 60–30% | Counter 20% saat kamu pakai skill CD>0 |
| 💀 **BERSERK** | 30–0% | ATK/MATK ×1.5 + 🚫 Anti-Heal permanen (LS −30%) — dia berhenti menyembuhkan diri, main habis-habisan |

**Hasil (GATE):** divine @500 = **~55%** (≈2 percobaan, t26) · @550 = **~91%** · @350 = 0%. Epic 0%.

---

## 💎 Rewards (FINAL — owner approved)

| Floor | 🧪 Base | 🧪 per ⭐ | Gear Drop | Milestone |
|:-:|:-:|:-:|:--|:--|
| F1 | 2,000 | 500 | — | Title: 🗝️ Gatebreaker |
| F2 | 4,000 | 1,000 | — | 💎 100,000 |
| F3 | 8,000 | 2,000 | — | Title: 🐉 Drake Slayer |
| F4 | 12,000 | 3,000 | — | 💎 250,000 |
| F5 | 20,000 | 5,000 | 🟠 Legendary drop | Title: ⚡ Stormcaller |
| F6 | 35,000 | 8,750 | — | 💎 500,000 |
| F7 | 55,000 | 13,750 | 🟡 Mythic drop | Title: ❄️ Frozen Heart |
| F8 | 85,000 | 21,250 | — | 💎 750,000 |
| F9 | 150,000 | 37,500 | 🔶 Divine drop | Title: 🪞 Self-Slayer |
| F10 | **300,000** | 75,000 | 🔶 Divine drop | 💎 1,000,000 + Title: 💀 Abyssal Overlord |
| 30⭐ | — | — | 🌌 **Abyssal Edge** | Title: 🌌 Abyssal Master |

**🌌 Abyssal Edge**: weapon class-neutral, tier baru **[A] Abyssal** (atas Divine) — +100 ATK & +100 MATK fixed, 🕳️ Rupture 15% + 🗡️ Berserker 40% + 🎯 Precision 30% + 🩸 Lifesteal 30% (all fixed, no roll). Unsellable, 1×/akun. Sim: pemegang ≈ autowin di mirror setara — accepted (eligibility: ~1 pemain, berbulan-bulan).

**Total max:** ~1.17jt 🧪 + 2.6jt 💎 + 4 gear + 7 title — sekali selamanya.

**Semua title milestone-only (tidak dijual di shop), emoji nempel di value-nya — tampil di LB/PvP/profile otomatis.**

## 🗣️ Dialog Boss (intro → victory → defeat taunt)

| Boss | Intro | Victory | Defeat |
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

### Boss Passive Kits (live-feedback v3.2)

| Boss | Kit baru |
|:--|:--|
| F3 Drake | 🐲 Evasion 10% (Fireproof Scales) |
| F4 Treant | 🌿 Ult: anti-heal −50%/3t (roots drain vitality) |
| F5 Wyrm | ⚡ Evasion 15% (Stormform) |
| F6 Warden | 🌑 Evasion 20% (Living Shadow) |
| F7 Lich | 👻 Evasion 15% (Frost Form) + CC = "Frozen" |
| F8 Queen | 🧪 Nest venom −25% konstan + ult FULL SHUTDOWN −100% |
| F9 Mirror | 🪞 passiveCopy ⅓→**½** |
| F10 Overlord | 💀 P2 lifesteal 15% + P3 anti-heal 50% |

## 🎯 Mapping ke Pemain Live (saat tuning, 2026-08-19)

| Pemain | Level | Tembok | Wortel |
|:--|:-:|:--|:--|
| showtimesaann / damarafdhal | 51–56 | F2 (epic) | gear + level pertama |
| zurg505 / naleung_ijo | 87–109 | F3 (epic wall) | divine pertama |
| kyriz / schriiftt | 169–170 | F6–F8 | F9 mirror |
| kyyoou | 284 | F7 (56% — fight hidup) | F8–F9 → F10 |
| some.one11 | 440 | F10 (0% @440) | grind ke 500-an |
| viciousgod / kaelloml | 504–509 | F10 (38% — zona perjuangan) | clear F10 + 30⭐ |

---

## 🔮 Knob Darurat (kalau perlu adjust pasca-rilis)

| Keluhan | Knob | File |
|:--|:--|:--|
| Floor X terlalu susah/gympang | `hpMult` / `atkMult` floor itu saja | `abyssConfig.js` |
| Pemain baru mentok F2 | hp F2 2.6 → 2.4 | `abyssConfig.js` |
| CC kejam (chain freeze F7) | `cc.chance` per skill | `abyssConfig.js` |
| F10 terlalu kejam | enrage 8→6% atau hp 2.5→2.4 | `abyssConfig.js` |
| Ingin lebih menantang buat para 500+ | **Hard Mode** ×1.5 + star track terpisah (sudah di roadmap) | — |
