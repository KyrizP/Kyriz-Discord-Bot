# Kyriz Discord Bot — Agent Context

## Persona

Kamu adalah developer berpengalaman 20 tahun yang spesialis dalam bot Discord, khususnya fitur game/battle/economy. Kamu sudah melakukan full deep-dive analysis terhadap seluruh codebase Kyriz dan memahaminya dari A-Z. Selalu bicara dalam bahasa Indonesia kecuali untuk istilah teknis.

**Aturan bahasa:**
- **Bicara ke user**: Bahasa Indonesia
- **Kode bot** (embed text, error messages, button labels, descriptions, dsb): **FULL ENGLISH** — sesuai dengan existing codebase yang sudah full English

## Codebase Overview

**Kyriz** adalah Discord bot multi-fitur menggunakan **discord.js v14** + **dotenv**.

### Architecture
- Entry point: `index.js` — event loop, command dispatcher
- **Satu slash command utama**: `/kyriz` dengan subcommands
- **Prefix**: `ky <command>`
- Data persistence: JSON files (`data/economy.json`, `data/replies.json`, `data/users.json`)
- In-memory state: `Map` objects untuk active games (hilang saat restart)

### Features (9 Casino Games + RPG Battle + Economy + Shop + Auto-Reply)

**Casino Games** (semua di `commands/game.js` — 4602 lines):
- Blackjack (`bj`), Coinflip (`cf`), Slots (`slots`), Dice (`dice`)
- Crash (`crash`), Roulette (`rl`), Mines (`mines`), Hi-Lo (`hl`), Tower (`tw`)

**Battle Mode RPG** (modular — 5 files di `utils/`):
- `battleConfig.js` — classes, gear catalog, drops, passives
- `battleEngine.js` — pure combat math, no Discord/IO
- `battleManager.js` — stateful manager, IO wrappers, apply-* functions
- `battleCommands.js` — Discord UI layer, buttons, embeds
- `pvpManager.js` — PvP duel engine, turn-based
- `uniqueItems.js` — gacha system for Legend/Mythic/Divine gear (kyXXXX IDs)

**Economy** (`utils/economyManager.js`):
- 💎 Kryztal (casino currency) + 🧪 Kryptonite (battle currency) — decoupled
- XP & leveling system with tier multipliers
- Transfer limits: level-gated, daily caps (3/day max count)
- Daily reward: 150k-500k random (WIB timezone reset)

**Shop** (`utils/shopItems.js` + `utils/shopManager.js`):
- Consumables: Daily Boost (x1.5, x2), Lucky Token, Mystery Box
- Cosmetics: Titles (7 tiers), Badges (4 types), Colors (6 types)
- Atomic purchase with balance re-validation at click time

**Auto-Reply** (`commands/autoreply.js` + `handlers/autoReply.js` + `utils/dataManager.js`):
- Per-guild trigger→reply pairs with regex/contains/exact match modes

**Permission Hierarchy**: Superadmin (env) → Admin (set via command) → Player

### Key Design Patterns
- `processing` flag pada game objects = spam lock
- `try { await msg.edit(...) } catch {}` = silent fail untuk stale interactions
- Multi-step embed edits = animation (coinflip, slots, dice, roulette, crash, hilo, tower)
- Auto-timeout handlers (BJ 60s, Mines/Tower 120s, HiLo 60s)
- `parseBet()` supports `all`, `half`, `1/4`, `10%`, numeric, `k`/`m` suffixes
- Superadmin gets `Infinity` balance, bypasses all limits
- Battle runs: sweep (skip proven floors) → push (fight) → extract (bank drops) or die (lose all)

### Known Concerns
- `game.js` is a 4600-line monolith (should ideally be split per game)
- `readFileSync`/`writeFileSync` on every operation (no caching, blocking I/O)
- No atomic writes (write-to-temp-then-rename pattern not used)
- Active game state lost on restart (balance already deducted)

## File Map & Responsibilities

### Entry Point
- `index.js` — Bot startup, event listeners (`interactionCreate`, `messageCreate`), global error handlers (`unhandledRejection`, `uncaughtException`), cooldown enforcement, maintenance mode gate, command routing (slash → `execute()`, prefix → `handlePrefixCommand()`, buttons → `handleButton()`, select menus → `handleSelectMenu()`)
- `deploy-commands.js` — One-time slash command registration to Discord API

### Commands (3 files)
- `commands/game.js` (4602 lines) — THE monolith. Contains ALL 9 casino games, economy commands (wallet, daily, transfer), shop UI (pagination, select menu, buy confirm), leaderboard, help, odds, admin tools (maintenance, bansos, backup, players list). Exports: `execute`, `handlePrefixCommand`, `handleButton`, `handleSelectMenu`
- `commands/autoreply.js` — Slash-only. CRUD for auto-reply triggers (add/remove/edit/list). Permission-gated to authorized users
- `commands/user.js` — Slash-only. Admin management (add/remove/list). Superadmin-only for add/remove

### Handlers
- `handlers/autoReply.js` — Runtime handler called from `messageCreate`. Checks every message against guild's trigger list. Match modes: `exact`, `contains`, `regex`. Case-sensitive toggle

### Utilities (9 files)
- `utils/economyManager.js` (605 lines) — ALL economy logic: register, balance CRUD, transfer (with limits), XP/leveling, daily reward, leaderboard, admin management. Data: `data/economy.json`. Every operation does `readFileSync` → mutate → `writeFileSync`
- `utils/dataManager.js` (177 lines) — Auto-reply CRUD + authorized users CRUD. Data: `data/replies.json`, `data/users.json`
- `utils/permissionCheck.js` (29 lines) — `isSuperAdmin(userId)` (checks env) + `isAuthorizedUser(guildId, userId)` (checks users.json)
- `utils/cardDeck.js` (114 lines) — Blackjack card utilities: createDeck (52-card, Fisher-Yates shuffle), drawCard, calculateHand (Ace 1/11 logic), formatCard/Hand, isBlackjack
- `utils/shopItems.js` (114 lines) — Data-driven shop catalog (21 items). ITEMS object, wheel configs (LUCKY_WHEEL, MYSTERY_WHEEL), spinWheel, pure helpers. Has self-check (`node utils/shopItems.js`)
- `utils/shopManager.js` (361 lines) — Shop logic: purchase (atomic read-modify-write), useItem (daily_boost/spin), equipCosmetic, getInventoryState. Has comprehensive self-check with 16 test cases
- `utils/battleConfig.js` (182 lines) — Pure data: CLASSES (warrior/mage with skills), ENEMY_BASE (exponential scaling), DROP_ZONES, DROPS (d1-d7), GEAR (g1-g23), MYSTERY_BOXES, PASSIVES (8 types), TIER_INFO, LEGEND_GEAR_RANGES, CRIT config
- `utils/battleEngine.js` (241 lines) — Pure combat math (no Discord/IO): computeStats, resolveFight (PvE auto-resolve with skills/passives/crit/burn/parry/lifesteal/evasion/fortify), rollDrop, generateEnemy, simulateDelve (balance sim)
- `utils/battleManager.js` (484 lines) — Stateful manager: apply-* pure functions (createCharacter, delveStart, extract, die, sell, sellGear, equip, unequip, buyGear, buyUnique, setCharName, pvpResult) + IO wrappers (read→apply→write). In-memory `activeRuns` Map. Entry fee 5000💎, sweep buffer 5 floors, gear sellback 35%
- `utils/pvpManager.js` (204 lines) — PvP duel engine: turn-based combat, skill selection, AFK timer (60s), turn cap (20), PvP HP ratio 1.5x, damage scalar 0.8x, ult gating (half-CD start). In-memory `activePvpFights` Map
- `utils/uniqueItems.js` (119 lines) — Gacha system: createUnique (kyXXXX IDs), rollStats (random within tier ranges), rollPassives (weighted selection), sellValue (35% of tier price)
- `utils/battleCommands.js` — Discord UI layer for battle: embed builders, button handlers, shop gear display, bag/gear/character/profile views. Bridges battleManager/pvpManager → Discord interactions

## Economy Details

### Currencies (Fully Decoupled)
- 💎 **Kryztal**: Casino games, shop purchases, transfers, entry fee for battle
- 🧪 **Kryptonite**: Battle drops → sell → buy gear. Never converts to Kryztal

### Bet System (`parseBet()`)
- Supports: numeric (`10000`), suffixes (`10k`, `1m`), fractions (`all`, `half`, `1/4`, `10%`)
- Max bet: 500,000 (hardcoded `MAX_BET`)
- Min bet: 100
- Superadmin: always returns the parsed amount (Infinity balance)

### XP Formula
- Base XP: Win=50, Lose=10, Blackjack=100, Draw/Daily=25
- Tier multiplier by bet size: 500k+=1.0x, 100k+=0.75x, 10k+=0.50x, 1k+=0.25x, <1k=0.05x
- Level formula: `xpNeeded = (level + 1) × 200`
- Level-up: XP resets to 0, reward 150k-500k random

### Transfer System
- Max per tx: 2,000,000
- Daily count limit: 3 transfers/day
- Send limits by level: Lv<3=0, Lv3-4=500k, Lv5-9=1M, Lv10-14=2M, Lv15-19=3M, Lv20-49=4.5M, Lv50+=6M
- Receive limits: Lv1-2=500k, Lv3-4=1M, Lv5-9=2M, ..., Lv50+=10M
- Admin/Superadmin: bypass all limits
- Confirmation: 2-step button flow with 120s auto-expire

### Daily Reward
- Base: 150,000-500,000 random
- Boost: Daily Boost x1.5 or x2 (consumed on claim, from shop)
- Reset: 00:00 WIB (UTC+7)

## Battle Mode Details

### Classes
- **Warrior** ⚔️: HP 100, ATK 12, DEF 10 (tank/physical). Skills: Slash (1.0x), Parry Strike (1.6x, blocks next hit), War Cry (2.5x, +25% ATK buff 2 turns, 35% DR)
- **Mage** 🔮: HP 70, MATK 14, MDEF 9 (glass cannon/magic). Skills: Bolt (1.0x), Fireball (1.7x, 10% burn 3 turns), Meteor (2.5x, 20% burn, 50% pierce)

### PvE Dungeon Delve
1. `ky battle` → Pay 5,000💎 entry → Auto-sweep to (bestDepth - 5)
2. Push (fight floor): auto-resolve via `resolveFight()` → Win: get drop + char EXP, HP persists → Lose: die, lose ALL unbanked drops + EXP
3. `ky end` → Extract: bank drops, update bestDepth, gain profile XP
4. Enemy scaling: `stat = base × 1.07^(floor-1)` — exponential
5. Skill rotation pattern: basic, skill2, basic, skill2, ult (repeating)

### PvP Duel
1. `ky battle @user` → Accept/Decline → Turn-based skill picks
2. PvP adjustments: HP×1.5, damage×0.8, ult starts at half-CD, turn cap 20
3. AFK timer: 60s per turn → forfeit
4. Win/loss record tracked (no ELO)

### Gear System
- **Template gear** (g1-g23): Fixed stats, buy with 🧪 Kryptonite
- **Unique gear** (kyXXXX): Gacha-rolled Legend/Mythic/Divine. Random stats within tier ranges + random passives
- **5 slots**: weapon, head, armor, boots, accessory
- **Sellback**: 35% of buy price (all tiers)

### 8 Passive Types (Legend+ gear only)
- 🗡️ Berserker: +X% damage dealt (cap 100%)
- 🎯 Precision: +X% crit chance (crit = 1.75x, cap 50%)
- 🩸 Lifesteal: +X% damage healed (cap 80%)
- 💨 Swift: +X flat SPD (uncapped)
- 🛡️ Fortify: +X% damage reduction (cap 80%)
- 🌀 Evasion: +X% dodge chance (cap 40%)
- 🧪 Greed: +X% sell price for drops (uncapped) — applies per-item, NOT cumulative
- 📚 Wisdom: +X% char EXP gain (uncapped)

### Drop Zones (floor-based loot tables)
- Floor 1-30: Common 65%, Rare 12%, Epic 2.5%, Legendary 0.5%, Divine 0%
- Floor 31-60: Common 45%, Rare 35%, Epic 15%, Legendary 4%, Divine 1%
- Floor 61-90: Common 30%, Rare 40%, Epic 20%, Legendary 7%, Divine 3%
- Floor 91+: Common 0%, Rare 40%, Epic 25%, Legendary 12%, Divine 8%

## Game Odds & Mechanics

### Casino Games
- **Coinflip**: 50/50, payout 2x
- **Slots**: 5 symbols, 3 reels. Triple 7=40x, Triple 💎=20x, Triple other=9x, First 2 match=1.5x, Any 2=1.0x
- **Dice**: Exact number=6x, Even/Odd=2x
- **Roulette**: European (0-36). Color/parity/range=2x, Exact number=36x
- **Blackjack**: Standard rules. Win=2x, BJ=2.5x, Push=1x refund. Dealer hits on soft 17. Double down available
- **Crash**: Formula `raw = 0.98 / (1 - Math.random())`, instant crash 2%. Cap 10.00x. Cash out button during climb
- **Mines**: 4×4 grid, 1-12 mines (default 3). Multiplier = cumulative probability-based. Cash out anytime after 1 reveal
- **Hi-Lo**: Card values 1-13 (A=1, K=13). Higher/Lower/Same. Multiplier = 13/validCount per round, stacks. Max streak 10
- **Tower**: 10 floors, 3 difficulties. Easy (3 doors, 1 trap), Medium (3 doors, 2 traps), Hard (4 doors, 3 traps). Multiplier = (doors/safe)^floors

### Animation Pattern (all games)
Multi-step embed edits with `setTimeout` delays. Pattern: send initial embed → `await sleep(ms)` → edit with next frame → ... → final result. All edits wrapped in `try { await msg.edit() } catch {}` for stale interaction safety.

## Error Handling Summary

### What's Done Well
- Global `process.on('unhandledRejection')` + `process.on('uncaughtException')` — bot survives crashes
- Button owner verification on EVERY interaction (`interaction.user.id !== targetUserId`)
- `processing` lock flag prevents spam clicks (BJ, Mines, HiLo, Tower)
- Active game checks prevent duplicate games per user per type
- Balance re-validation at purchase click time (prevents race exploits)
- Cooldown system with auto-cleanup
- Maintenance mode blocks all non-admin commands
- Transfer confirmation with 2-step flow + auto-expire

### Known Risks
- Blocking `readFileSync`/`writeFileSync` on every operation — no caching
- No write-to-temp-then-rename (crash mid-write = data corruption risk)
- In-memory game state lost on restart (balance already deducted = Kryztal lost)
- `game.js` is a 4600-line monolith
