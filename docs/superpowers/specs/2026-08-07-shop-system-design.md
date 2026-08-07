# Kyriz v2.0 — Shop, Cosmetics & Profile System Design

**Date:** 2026-08-07
**Status:** Design (pending review)
**Bundle:** Kyriz v2.0 (package.json currently stale at `1.0.0`; working version ~1.2.2)

---

## 1. Goals

Add a **shop system** as the primary Kryztal sink to fight economy inflation, plus **cosmetics** (flex + whale drain) and a rich **profile** command. Bundle with a currency display rebrand (💎 Kryztal) as release **v2.0**.

### Why now (the problem)
Kryztal is constantly injected — daily (~325k), level-up (~267k) — with almost no sink. The games are now RTP-neutral (≤99.5%) after the recent fix, so they neither leak nor drain. Result: slow inflation, balances piling up. The current global leaderboard shows a **30× wealth spread** (rank 10: 1.3M → rank 1: 40M). The shop is the remedy: a place for Kryztal to leave circulation **voluntarily**.

### Decision: NO balance reset
Existing balances are **not touched** (pulling money from players on a live bot causes drama and churn). The shop drains inflated balances organically through voluntary cosmetic / whale-tier purchases.

### UI language
All user-facing strings in the bot are **English** (the bot's existing UI language). Design discussion with the owner is in Indonesian; shipped text is English.

---

## 2. Scope

### In scope (v2.0)
- Shop: browse / buy / use / inventory
- Consumable items (6): Shield 50%, Shield 100%, Daily ×1.5, Daily ×2, Lucky Token, Mystery Box
- Cosmetics: Titles (7 tiers), Badges (4), Colors (6)
- `profile` command (rich — full stats + cosmetic showcase); `wallet` **simplified to balance-only** to drive profile adoption
- Currency rebrand: 💎 Kryztal everywhere
- Version bump to 2.0.0

### Out of scope (later)
- **XP Booster** — dropped from v1. Inflation-coupled (XP → level → Kryztal reward). Revisit after the shop is live and real grind-rate can be measured.
- **Cooldown Cutter** — dropped (mild XP-inflation coupling; low value).
- **Game mechanic tweaks** — separate spec.
- **Hunting / battle features** — future. The profile is extensible to receive their stats later (no pre-built hooks now).
- **Sell-back / refund** — future.
- **Rich profile extras** (achievements, bio, detailed history) — future. v1 profile shows existing data only.
- **Seasonal / limited cosmetics & extra consumables** (Shield Trio, Lucky Token ×5 bundle, Cashback Ticket, event items) — saved for periodic future shop updates (live-ops / FOMO sink).

---

## 3. Economy anchors (pricing basis)

| Source | Amount | Note |
|---|---|---|
| Daily | ~325k/day | 150k–500k uniform; everyone claims |
| Level-up | ~267k/level | 150k–500k weighted low |
| Gambling | net-negative | RTP ≤99.5% (already a sink) |
| Typical active player net income | ~600k–1M/day | daily + level rewards |
| Max bet | 500k | Caps any bet-based refund mechanic |

Wealth distribution (current global top 10): rank 1 = 40M … rank 10 = 1.3M (30× spread). Whale-tier cosmetics are required to actually drain the top.

---

## 4. Architecture

### 4.1 Data model — inventory inside economy.json
Per-user state lives in the existing `data/economy.json` user object (same file as balance), so a purchase is **one atomic read-modify-write** (deduct balance + grant item in a single write). Splitting inventory into a separate file would break atomicity and open exploit gaps (item without payment, or payment without item).

New fields on each user object (all **additive** — no existing field removed, so live data is safe):
```js
user = {
  // ...existing: balance, level, xp, xpNeeded, totalWins, totalLosses,
  //              totalEarned, totalLost, lastDaily, registeredAt, transferData, isAdmin
  inventory: { 'lucky_token': 2, 'shield_100': 1 },        // consumable itemId -> count
  cosmetics: {
    title: 'legend',        // equipped title id (or null)
    badge: 'crown',         // equipped badge id (or null)
    color: 'gold',          // equipped color id (or null)
    owned: ['legend','crown','gold'],                      // all owned cosmetic ids
  },
  activeBoosts: { daily_mult: 'pending', shield_100: 'pending' }, // boost/shield id -> flag/state
}
```

### 4.2 Item catalog — `utils/shopItems.js`
Data-driven definitions. Adding an item = editing this file + re-deploy (no logic change). Schema:
```js
{ id, name, emoji, category: 'consumable'|'cosmetic', price, type: 'consumable'|'permanent',
  effect: { kind, ...params }, description }
```

### 4.3 Logic — `utils/shopManager.js`
Mirrors the `economyManager.js` pattern. Functions: `purchase(userId, itemId)`, `use(userId, itemId)`, `getInventory(userId)`, `equipCosmetic(userId, kind, id)`, `getActiveBoosts(userId)`, plus effect-application helpers.

### 4.4 Commands — flat subcommands under `/kyriz`
Matches the existing flat pattern (`/kyriz wallet`, `/kyriz daily`, …).

| Command | Prefix | Function |
|---|---|---|
| `/kyriz shop` | `ky shop` | Browse catalog (embed) |
| `/kyriz buy <item>` | `ky buy <item>` | Buy (slash: dropdown + confirm button; prefix: instant) |
| `/kyriz use <item>` | `ky use <item>` | Use consumable / equip cosmetic (instant) |
| `/kyriz inventory` | `ky inv` | View owned items + active boosts + equipped cosmetics |
| `/kyriz profile [user]` | `ky profile [@user]` | Rich profile card (self or others) |
| `/kyriz wallet [user]` | `ky wallet` | **Simplified: balance-only** (superadmin can peek others) |

### 4.5 Boosts & shields — flag/state, no background timer
Active boosts/shields stored as simple flags/state on the user, lazily checked at the relevant action (daily claim, loss settlement). No `setInterval` / background process — survives free-hosting restarts.

---

## 5. Item catalog & pricing

### Pricing methodology
- **Consumables:** price set **above** the Kryztal-value the item can extract, so every purchase is a guaranteed net sink (**un-farmable by construction**). Bet-based refunds are capped relative to the 500k max bet.
- **Cosmetics:** priced by **prestige tier** (they generate zero Kryztal; pure status/sink), with tiers spanning the whole wealth distribution so whales have drain targets.

### Consumables (v1 = 6 items)
Shield refund caps are tied to the 500k max bet, so they can't be exploited via large bets.

| Item | id | Effect | EV/value max | Price | Sink/use |
|---|---|---|---|---|---|
| 🛡️ Shield 50% | `shield_50` | Refund 50% of next loss, cap 250k | ~137k | **175k** | ~38k |
| 🛡️ Shield 100% | `shield_100` | Refund 100% of next loss, cap 500k | ~275k | **325k** | ~50k |
| 📅 Daily ×1.5 | `daily_boost_15` | Next daily claim ×1.5 | +162k | **200k** | ~38k |
| 📅 Daily ×2 | `daily_boost_20` | Next daily claim ×2 | +325k | **400k** | ~75k |
| 🎟️ Lucky Token | `lucky_token` | Spin small wheel (top 1M) | ~167k | **250k** | ~83k |
| 📦 Mystery Box | `mystery_box` | Spin big wheel (top 3M) | ~410k | **500k** | ~90k |

Deferred to future updates: Shield Trio (3× bundle), Lucky Token ×5 bundle, Cashback Ticket (% session refund — needs real data to price safely), seasonal consumables.

### Cosmetics (prestige ladder, permanent)
| Cosmetic | Price | Target |
|---|---|---|
| Title [Rookie] | 250k | New players |
| Title [Gambler] | 1M | Lower-mid |
| Title [High Roller] | 5M | Mid |
| Title [Whale] | 15M | Rank 1–3 |
| Title [Mythic] (+ exclusive badge) | 30M | Rank 1–2 |
| Title [Celestial] (+ badge + exclusive color) | 50M | Aspirational |
| Title [Divine] (+ badge + super-exclusive color) | 100M | Ultimate flex (currently unaffordable — long-game target) |
| Badges: 👑 Crown 500k · 🔥 Inferno 1M · 🏆 Champion 3M · 💀 Skull 5M | 500k–5M | Collection |
| Colors — Standard (750k): Crimson, Emerald, Sapphire · Premium (2M): Gold, Royal, Obsidian | 750k–2M | Mid |

Ultra tiers (Mythic / Celestial / Divine) are **bundles** (title + exclusive badge/color) so the price feels worth it. The 15M–30M tiers do near-term whale draining; 50M–100M are long-term aspirational targets (cost nothing to list).

**Cosmetic ownership model = Model A:** permanent ownership, **free switching** (equip/unequip anytime at no cost). Chosen over lose-on-switch because "collect them all" drains more total Kryztal and avoids player resentment. Exclusive colors bundled with Celestial/Divine are not sold separately (keeps ultra titles special).

---

## 6. Command UX

### Buy flow
- **Slash `/kyriz buy`:** item chosen via Discord **choices** dropdown (shows friendly name + emoji + price; bot receives the stable `id`) → bot replies with a confirm embed (price + balance before→after) + **[✅ Beli][❌ Batal]** buttons → on confirm, execute. The confirm prevents misclicks (important: no sell-back in v1).
- **Prefix `ky buy <id>`:** instant purchase + receipt. No confirm (typing is deliberate; misclick doesn't apply).

### Use flow (slash & prefix): instant
- Consumable → activate (arm shield / queue daily boost / spin wheel).
- Cosmetic → equip (set active title/badge/color, free).

### Catalog selection mechanic
- v1: Discord **choices** enum, generated from `shopItems.js` at deploy time.
> `ponytail:` Discord caps choices at **25**. v1 (~23 items: 6 consumables + 7 titles + 4 badges + 6 colors) is close to the cap but fine. Switch to **autocomplete** if the catalog grows past 25 (e.g. when seasonal items are added).

---

## 7. Cosmetic display

Cosmetics must be **visible** (otherwise no reason to buy):
- **`/kyriz profile`** — personal showcase (title prefix, badge, embed color). Primary display surface.
- **`/kyriz leaderboard`** — public flex (title + badge next to name).
- **`/kyriz wallet`** — **simplified to balance-only** (just 💎 Kryztal + a nudge to `/kyriz profile`). All level/XP/stats moved to `profile` to drive profile adoption.
- Embed **color** of profile / wallet / game-result embeds = equipped color (or level-based default).

---

## 8. Profile (rich v1 — the full player card)

Display of **existing data** + equipped cosmetics. No new systems. Viewable for self or others (`profile user:@x`) to enable the social flex loop.

```
[avatar]  👑 [Legend] rizdevs
          🏆 Rank #3 Global

⭐ LEVEL 12
▰▰▰▰▰▰▱▱▱▱  340/600 XP (57%)
────────────────────
💎 Kryztal
4.619.742
────────────────────
📊 Net Profit   +5.2M   (Earned 89M · Lost 84M)
🎰 W/L  247/312   ·   Win Rate 44%
────────────────────
🎨 Equipped: [Legend] · 👑 · Gold
Member since 4 Aug 2026
```

- **Avatar:** `user.displayAvatarURL()` — references Discord's CDN, **zero bot storage**.
- **Net Profit** = `totalEarned − totalLost` (career profit/loss; `+` = up overall).
- **Rank:** global leaderboard rank (primary). Server rank may be shown alongside if it differs.
- All fields come from existing user data; cosmetics from `user.cosmetics`.
- **Extensible:** future features (hunting/battle) add their stat rows later — the profile just reads more fields. No pre-built hooks now.

> `wallet` is intentionally bare (balance-only) so this profile becomes the natural place players go for their info.

---

## 9. Currency rebrand (💎 Kryztal)

- Display `💎 <amount>` everywhere Kryztal/amounts appear (game results, wallet, profile, shop, transfer, daily, leaderboard).
- Mechanical find-replace across display strings; no logic change.
- Use **Unicode 💎** (universal, never breaks). Do **not** use a custom emoji for the currency symbol — custom emoji are fragile (hosted in one server; if lost, the symbol breaks everywhere).

---

## 10. Edge cases & safety

- **Atomic purchase:** single-file read-modify-write (balance + item together) — no exploit gap.
- **No balance reset:** existing balances untouched; shop drains voluntarily.
- **Superadmin:** bypasses cost / has all items (consistent with existing unlimited-balance pattern).
- **Live-bot safety:** all schema changes **additive** (new fields only); no migration or wipe.
- **Concurrency:** existing economy code rewrites the whole JSON per op; shop follows the same pattern. Bounded by player count (3 servers) — file stays small.
- **Shield caps tied to max bet (500k):** the safety knob that keeps shields from being +EV. Shield 50% cap 250k (price 175k > ~137k EV); Shield 100% cap 500k (price 325k > ~275k EV) — always a sink.
- **No background timers:** boosts/shields are flag/state, lazily checked — survives host restarts; an expired/consumed one is simply ignored.

---

## 11. Versioning

- Bump `package.json` `version` to **2.0.0** (currently stale at `1.0.0` — reconcile with the working number ~1.2.2 during implementation).
- Audit and update every place that displays a version (help command, etc.).

---

## 12. File impact (summary)

- **New:** `utils/shopItems.js`, `utils/shopManager.js`
- **Modified:** `commands/game.js` (new subcommands: shop/buy/use/inventory/profile; **wallet simplified**; cosmetic display in profile & leaderboard; 💎 rebrand in display strings; choices-enum wiring; English UI), `utils/economyManager.js` (new fields/helpers as needed), `deploy-commands.js` (new subcommands), `package.json` (version).
- **Data:** `data/economy.json` gains additive per-user fields (no migration).

---

## 13. Open / deferred
- XP Booster, Cooldown Cutter — re-evaluate post-launch (see §2).
- Seasonal/limited cosmetics, Shield Trio, bundle discounts, Cashback Ticket — future shop updates.
- Game mechanic tweaks — separate spec.
- Sell-back/refund, rich-profile extras, hunting/battle — future.
