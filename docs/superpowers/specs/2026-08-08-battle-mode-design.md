# Battle Mode (Kryptonite RPG) — Design Spec

- **Date:** 2026-08-08
- **Status:** Design (brainstormed with rizdevs) — pending review
- **Bot:** Kyriz (discord.js v14, CommonJS, `data/economy.json` flat-file, Wispbyte ~589MB RAM / ~528MB free)
- **Related:** shop v2.0 spec (`2026-08-07-shop-system-design.md`), economy fixes (`kyriz-economy-fixes`)

## 1. Vision
A standalone RPG battle mode — **"Endless Delve."** You ARE a character (not a pet): pick a class, equip gear head-to-feet, pay Kryztal to enter an endless dungeon, auto-fight floor by floor, **push your luck** for deeper/better loot, extract to bank it, sell drops to a merchant for **Kryptonite** (the RPG currency), buy/upgrade gear, go deeper. Later: async interactive **PvP duels**. Inspired by owo battle, but with equipment builds, enemy-weakness strategy, and crash-style push-your-luck depth.

## 2. Core Tenets
- **Additive & isolated** — new modules, minimal hooks. **Do NOT touch existing game/shop/transfer flow.** Mirror how shop v2.0 was integrated (new `utils/` files, atomic economy ops, subcommands attached in `game.js`).
- **Work on master** — no branches. User commits.
- **Balanced by construction** — anti-exploit via economy design, not whack-a-mole. **Sim-test all numbers before live** (like crash RTP).
- **Accessible & not ribet** — auto PvE, simple commands, fair pacing, no zero-drop frustration, sweep for strong players.
- **Roles (v1):** superadmin & admin play **normally** — same 15k entry, Kryptonite from gameplay only, **no battle-mode privileges**. The owner wants to feel the grind alongside players. (A v2 superadmin "cheat" to generate Kryptonite is explicitly **deferred — not in v1**.)

## 3. Dual-Currency Model (one-way valve)
- **Kryztal** (existing gambling/daily currency) → used here ONLY as **dungeon entry fee**. Doubles as a Kryztal **sink** (serves the inflation goal from the shop spec).
- **Kryptonite** (new · icon **🧪**) → the RPG currency. Earned ONLY by selling dungeon drops to the merchant. Spent on gear/upgrades. 🧪 = alchemy: the merchant is framed as the **alchemist** who refines monster drops into Kryptonite.
- **ONE-WAY:** Kryptonite can NEVER convert back to Kryztal (anti-farm).
- **Anti-inflation reasoning:** Kryptonite supply is gated by the Kryztal entry fee (itself balanced: gambling RTP <100%, daily capped). Kryztal→battle is a valve with no bleed-back. Enemy depth-scaling plateaus yield per run. ⇒ Kryptonite inherits balance and cannot be farmed for free. Wealth = grinding that you paid Kryztal to do (fair).

## 4. Dungeon Structure — Endless Delve
1. **Enter:** `ky battle` / `/kyriz battle` → pay **15,000 Kryztal** (v1 flat; v2 may scale by char level).
2. **Auto-sweep:** instantly resolve floors 1 → `(bestDepth − buffer)`, no animation, compact loot summary. Kills tedium for strong players. Economy-safe (gated by entry fee).
3. **Live delve** (from checkpoint onward): each floor = quick auto-resolved fight (1 embed) + buttons **[💎 Extract]** / **[⏩ Push Deeper]**. Fast — not a multi-step animation like crash.
4. **Per kill:** a drop (rarity-rolled; rarity improves with depth). **No raw Kryptonite.**
5. **Run bag** (drops collected this run) stays **UNBANKED** until Extract.
6. **Push Deeper:** risk the run bag for deeper floors + better drops.
7. **Death:** lose the run bag. **Equipped gear + Character Level + banked inventory = NEVER lost.** Player CHOSE to push (agency → not frustrating).
8. **Extract:** run bag → banked inventory (safe forever, sellable at merchant).
9. **Profile XP:** each run/kill grants profile XP via the existing `addXP` (ties the mode into account progression / daily & transfer limits).

## 5. Death Mechanic — Push + Safety Rails (decided)
- Stake = **run bag only**. Equipped gear is permanent progression (never at risk).
- Player-initiated risk (Extract always available) + full item/level retention = low frustration, high tension.
- Anti-inflation bonus: death losing the run haul ⇒ average yield < theoretical max ⇒ natural throttle.

## 6. Loot & Merchant
- Dungeon gives **drops only** (no raw Kryptonite). Kryptonite is merchant-derived only.
- **Rarity tiers:** Common → Uncommon → Rare → Epic → Legendary → **Divine** (ultra-rare chase, ~0.01–0.05%).
- Rarity chance scales with **floor depth** (deeper = better rolls).
- **Drop value (Kryptonite, small/shard scale):** Common ~2–5 · Rare ~puluhan · Epic ~puluhan · **Divine ~ratusan**. (Exact values sim-tuned.)
- **Merchant:** buys drops. **Buy-price rolls daily within a range** (v2; v1 = flat mid-range) → "sell on good days" meta. Even vendor-trash sells for a minimum → no zero-value frustration.

## 7. Combat Model
- **PvE = auto-resolve** (watch). Character uses its class skill rotation automatically. Player decision is Extract/Push at the floor level, not per-attack.
- **PvP = async interactive turns** (v2). Pick a skill per turn via buttons; opponent responds on their own time (correspondence-style — no real-time sync headaches). Turn order by SPD.
- **SPD = turn order ONLY** (1 action/round each). Self-limiting: once you outrun the enemy, extra SPD is wasted ⇒ can't be stacked into an exploit. Enemy always retaliates unless killed first; over a run, HP attrition ⇒ death ⇒ push-your-luck intact. (Dodge / extra-turn mechanics are v2 and would need hard caps.)
- **Damage formula (symmetric = fair by design):**
  - Physical: `dmg = max(1, ATK × skillMult − DEF × 0.5)`
  - Magic: `dmg = max(1, MATK × skillMult − MDEF × 0.5)`
  - `skillMult`: basic 1.0 · skill 1.4–1.8 · ultimate 2.5
  - Crit (v2, via gear affix or Rogue skill): `×2`

## 8. Stats (6) & Character Level
- **6 stats:** HP, ATK, MATK, DEF, MDEF, SPD.
- **Two decoupled levels:**
  - **Profile Level** (existing): from gambling + daily + **dungeon**. Governs daily reward / transfer limit / prestige. (Battle just adds an XP source; mechanics unchanged.)
  - **Character Level** (new): from **dungeon battles only**. Governs base HP/ATK/MATK/DEF/MDEF/SPD (linear growth per level).
- **Total stat = base (char level + class) + gear bonuses.**
- Level difference ⇒ clear power difference (intended). Exact growth curve sim-tuned.

## 9. Classes (v1: 2 · v2: more)
- ⚔️ **Warrior** — ATK / DEF / MDEF / HP bruiser; physical skills.
- 🔮 **Mage** — MATK / MDEF; glass cannon; low HP.
- 🗡️ **Rogue** (v2) — ATK / SPD; crit-focused. Crit handled via **gear affix** (e.g., ring "Crit +10%") or baked into Rogue skills ⇒ **no 7th core stat needed**; 6 stats stay sufficient.
- Class chosen at character creation. (Re-class for Kryptonite = v2.)
- Each class: base stat allocation + skill rotation (PvE auto) + skill set (PvP interactive).

## 10. Equipment (5 slots)
- **Weapon · Head · Armor · Boots · Accessory.**
- Each item: stat bonuses + rarity tier (Common→Divine).
- Sources: dungeon drops + gear shop (Kryptonite). Equipped gear is permanent (never lost on death).

## 10b. Commands & UX (v1)
- **Item codes** (bukan slug panjang): tiap item punya kode pendek — drop `d<n>` (mis. `d83`), gear `g<n>` (mis. `g3`). Kode + nama SELALU ditampilin di `ky bag` & `ky shop`. *(Refine engine: drops jadi **catalog item konkret** di `battleConfig` — bukan bucket rarity generik. `rollDrop` return **item id**; `merchantPrice(itemId)` baca value item itu. Tier rarity di `DROP_RARITIES` tetap drive weight-nya.)*
- **`ky wallet`**: tampil BOTH 💎 Kryztal + 🧪 Kryptonite.
- **`ky char`** = alias `ky character` (stat + gear equip + char level/exp).
- **`ky bag`** (BARU — terpisah dari `ky inventory` milik shop): loot battle (drop + sell value per item + total stack) + gear milik. Selalu tampil kode item.
- **`ky sell`**: `ky sell all` = semua drop · `ky sell d83` = 1 · `ky sell d83 5` = 5 · `ky sell d83 all` = semua d83. Konfirmasi total 🧪 sebelum eksekusi.
- **Gear shop**: equipment muncul di `ky shop` (di paling belakang) + shortcut **`ky shop equipment`**.
- **Sell-back gear (v1)**: jual gear milik (yg *tdk terpasang*) balik ke merchant w/ discount (~40%). Auto-unequip kalau perlu. v2: **disassemble → materials** (crafting).
- **Superadmin entry**: lewat `removeBalance` (no-op buat wallet ∞); tampilan entry tunjukin ∞ — jangan crash.

## 11. Data Model (`economy.json` — ADDITIVE, no migration)
New per-player fields (old players get defaults on first access):
- `kryptonite` (number, default 0)
- `charLevel` (1), `charExp` (0), `charExpNeeded`
- `charClass` (`'warrior' | 'mage' | null`)
- `equipment` (`{ weapon, head, armor, boots, accessory }` — item id or null)
- `battleInventory` (`{ dropId: count }` — banked drops, sellable)
- `bestDepth` (0 — sweep checkpoint)
- (optional) `battleStats` (`{ runs, kills, deaths, pvpWins, pvpLosses }`)

**Ephemeral run state = in-memory Map** (NOT persisted): active run, current floor, run bag, current HP. Matches the crash/mines pattern. Kryptonite/inventory writes use atomic read-modify-write (via `readEconomy`/`writeEconomy`, like `shopManager`).

## 12. Module Structure (ISOLATED — new files)
- **`utils/battleConfig.js`** — static catalogs: classes (base stats + skills), enemies (per floor tier), drop tables (rarity + items), gear items, merchant base prices. Data-driven + self-check (like `shopItems.js`).
- **`utils/battleEngine.js`** — pure combat math: stat computation, damage formula, auto-resolve simulator, drop rolling, merchant pricing. **Fully unit-testable** (import + assert, like `test/crash.test.js`).
- **`utils/battleManager.js`** — stateful: run lifecycle (Map), entry fee (`removeBalance`), sweep, extract/death, equip/unequip, merchant sell, character level/exp, atomic persist to `economy.json`.
- **Commands:** new `/kyriz battle | duel | character | equip | merchant` subcommands + `ky` prefix aliases. Hook into `game.js` = **additive only** (import + attach subcommands + `VALID_PREFIX_COMMANDS` + dispatch). Mirror shop integration.

## 13. Hooks into Existing Code (minimal, additive)
- `commands/game.js`: import battle module, attach subcommands (`attachGameSubcommands`), add prefix commands to `VALID_PREFIX_COMMANDS` + dispatch. **No change to any existing game logic.**
- `utils/economyManager.js`: **NONE.** Battle reuses already-exported helpers (`removeBalance`, `addXP`, `readEconomy`, `writeEconomy` — all exposed by the shop work).
- **Zero changes** to crash / roulette / slots / dice / mines / hilo / tower / blackjack / transfer / shop.

## 14. v1 vs v2 Phasing
- **v1 (MVP):** Endless Delve PvE loop · entry 15k · sweep · extract/death (push+rails) · drops + merchant (flat prices) · 6 stats · Warrior + Mage · 5 EQ slots · Character Level · Kryptonite · profile XP from dungeon · `battleEngine` unit tests. _(Starter gear caps at **rare** → deliberate low floor-ceiling; reach higher floors via char level + rare gear. Drops can still roll up to Divine as future-chase sellable loot.)_
- **v2:** **PvP async interactive duels** (high priority — needs characters/economy to exist first, hence after PvE) · daily merchant price variance · Rogue + more classes · crit gear affixes · boss / server-wide raids · entry-fee scaling · battle leaderboard · re-class · **expand gear to epic/legendary/divine (data-driven → raises the floor ceiling so very high floors become reachable)**.

## 15. Balance & Anti-Exploit Summary
1. One-way currency (no Kryptonite→Kryztal). 2. Entry fee gates every run. 3. Push-your-luck death throttles yield. 4. Depth scaling plateaus yield/run. 5. SPD self-limiting (turn-order only). 6. Symmetric damage formula. 7. Divine ultra-rare. 8. **Sim-test all numbers before live** (RTP-style: economy yield, damage fairness, drop rates, progression pace).

## 16. Numbers to Sim-Tune (before live — not hard-coded blindly)
- Entry fee (15k) vs daily/levelup/bansos income → runs/day pacing.
- Drop rates per rarity × floor depth.
- Drop merchant values (Common → Divine).
- Gear prices vs drop income → progression pace.
- Base stats per Character Level + per-class growth.
- Enemy stat scaling per floor (exponential curve + plateau).
- Damage formula constants (`DEF × 0.5` factor, `skillMult` values).
