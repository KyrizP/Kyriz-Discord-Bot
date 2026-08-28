# New Casino Games — Design Spec v0.3 (Draft)

**Date:** 2026-08-28 · **Status:** DRAFT v0.4 — Plinko & Poker finalized, Horse Race TBD
**v0.4 (2026-08-28) review fixes:** force-end = refund-ALL-contributions incl. folded (v0.3's non-folded-only refund had no recipient for folded money — zero-sum assertion would throw or Kryztal is destroyed); §2.6 join-tx corrected — removeBalance RETURNS {success:false}, doesn't throw (free-chips hole if followed literally); 6th-player lobby cap made explicit.
**v0.3 (2026-08-28) poker review fixes:** SA policy re-decided by owner — superadmin PLAYS with escrow-uniform accounting (synthetic-chips money-printer design removed; wallet-write still skipped; inflation vector owner-approved); round-end = ACTED-and-matched with explicit BB option (classic poker-engine bug); game timeout 5→15 min, force-end = refund-by-exact-contribution (kills the clock-burn exploit of proportional split); raise modal = raise-TO semantics, min = currentBet + last-raise-size; modal routing (`isModalSubmit`) added to file impact — bot has NO modal handler today; side pots = contribution-layering incl. uncalled-bet return & dead money; join escrow = single `db.transaction`; escrow DDL pinned to economyManager's connection (env-aware); §4.2 updated (poker prefix-only, 0 slots); host auto-joins at command time; AFK = check-if-possible; poker test section added (no RTP sim — zero-sum); chip-dumping open-decision box.
**v0.2 (2026-08-28) review fixes:** `parseBet` description corrected to match code (numeric + `all` only — suffix/fraction claims removed); payout rounding pinned to `Math.floor` per ball; win/loss stats defined as net-based per drop; unified result-screen buttons; implementation registries listed (prefix list, help, odds, cooldown list); §4.2 subcommand-cap audit filled in (23/25 used today); restart edge case added; coinflip RTP observation. Standard gates verified & written explicitly: silent 500k cap applies to everyone (incl. superadmin), maintenance gate inherited from dispatchers, superadmin no-write contract, XP bases corrected to real code (20/5 pinned — v0.1's "50/10 same as other games" premise was false and would violate §4.4). **RTP tables unchanged** — analytically verified: Low 98.98% / Medium 97.34% / High 97.50%.
**Constraint:** Integrate into existing `commands/game.js` monolith. Same economy (`parseBet`, `addBalance`/`removeBalance`, `addXP`, `recordWin`/`recordLoss`). Same anti-spam (`processing` flag). Same embed animation pattern (multi-step `msg.edit`).

---

## §1 Plinko

### 1.1 Overview

Ball drops through an 8-row peg board, bouncing left/right randomly at each row, landing on one of 9 multiplier slots at the bottom. Three risk levels control the multiplier spread. Single-ball and multi-ball (2-5) modes.

### 1.2 Commands

```
ky plinko <bet> [balls]       — prefix
/kyriz plinko <bet> [balls]   — slash
```

- `bet`: total amount wagered, passed through `parseBet` **exactly as it exists in code today** (`commands/game.js:1037`): a plain integer (`10000`) or the literal `all` (= `min(balance, MAX_BET)`). Nothing else — no `half`, no `1/4`, no `10%`, no `k`/`m` suffixes. Do not document or build on formats the parser does not support.
  - ⚠️ **Known pre-existing issue (all games, out of scope here):** `parseBet` uses `parseInt`, so `10k`/`10%` silently bet **10** and `1/4` silently bets **1** instead of erroring. Upgrading `parseBet` is a separate task with its own spec; Plinko must not assume that upgrade lands.
- `balls`: optional, 1-5 (default 1). Total bet divided evenly: `perBall = Math.floor(bet / balls)`. Remainder stays in wallet. Total deducted = `perBall × balls`.
- Min bet: 100 per ball (reject if `perBall < 100`)
- Max bet: 500,000 total (standard cap)
- Superadmin: parsed amount as-is (standard bypass)

### 1.3 Risk Levels

Selected via **buttons** after command, before drop:

```
[🟢 Low] [🟡 Medium] [🔴 High]
```

30-second timeout — no selection = auto-cancel, refund bet.

#### Multiplier Slots (9 slots, symmetric)

**🟢 Low Risk** — safe, small swings:
```
Slot:    0    1    2    3    4    3    2    1    0
Mult:  1.5x 1.3x 1.1x 1.0x 0.8x 1.0x 1.1x 1.3x 1.5x
```

**🟡 Medium Risk** — balanced:
```
Slot:    0    1    2    3    4    3    2    1    0
Mult:  5x   2x  1.4x 0.9x 0.4x 0.9x 1.4x  2x   5x
```

**🔴 High Risk** — volatile, big swings:
```
Slot:    0    1    2    3    4    3    2    1    0
Mult:  26x   5x  1.5x 0.3x  0x  0.3x 1.5x  5x  26x
```

#### Probability Distribution (Binomial, 8 rows)

Each peg: 50/50 left/right. Slot = number of rightward bounces.

| Slot | Bounces right | Probability | Fraction |
|:---:|:---:|:---:|:---:|
| 0 | 0 | 0.39% | 1/256 |
| 1 | 1 | 3.13% | 8/256 |
| 2 | 2 | 10.94% | 28/256 |
| 3 | 3 | 21.88% | 56/256 |
| 4 | 4 | 27.34% | 70/256 |
| 5 | 5 | 21.88% | 56/256 |
| 6 | 6 | 10.94% | 28/256 |
| 7 | 7 | 3.13% | 8/256 |
| 8 | 8 | 0.39% | 1/256 |

#### Theoretical RTP

| Risk | RTP | Notes |
|:---|:---|:---|
| Low | ~99.0% | Consistent near-1x returns |
| Medium | ~97.3% | Mix of small losses + occasional 5x |
| High | ~97.5% | Mostly lose (27% chance of 0x center), but 0.39% chance of 26x |

> **⚠️ RTP MUST be verified via 1M-spin sim** (same standard as all other games — `test/plinko_sim.js`). Multiplier tables above are draft; tune until all three risks are ≤ 99.5%.

### 1.4 Game Flow

#### Step 1: Command → Risk Selection
```
🔵 PLINKO
─────────────────
Bet: 💎 10,000 Kryztal (1 ball)

Select your risk level:
🟢 Low — Safe, small wins
🟡 Medium — Balanced
🔴 High — Volatile, big wins

[🟢 Low] [🟡 Medium] [🔴 High]
```

Button owner verification (standard). 30s timeout → cancel + refund.

#### Step 2: Animation (8 frames × 600ms)

Ball(s) drop from top, bouncing L/R each row. Multi-ball: all balls animate simultaneously on same board.

**Single ball frame example (row 3 of 8):**
```
🔵 PLINKO — High Risk
─────────────────
  ·  ·  ·  ·  ·  ·  ·  ·  ·
  ·  ◆  ·  ◆  ·  ◆  ·  ◆  ·
  ◆  ·  ◆  ·  ◆  ·  ◆  ·  ◆
  ·  ◆  ·  🔵 ·  ◆  ·  ◆  ·  ← ball here
  ◆  ·  ◆  ·  ◆  ·  ◆  ·  ◆
  ·  ◆  ·  ◆  ·  ◆  ·  ◆  ·
  ◆  ·  ◆  ·  ◆  ·  ◆  ·  ◆
  ·  ◆  ·  ◆  ·  ◆  ·  ◆  ·
 26x  5x 1.5x 0.3x 0x 0.3x 1.5x 5x 26x

💎 10,000 — dropping...
```

**Multi-ball frame example (5 balls, row 5):**
```
  ·  ·  ·  ·  ·  ·  ·  ·  ·
  ·  ◆  ·  ◆  ·  ◆  ·  ◆  ·
  ◆  ·  ◆  ·  ◆  ·  ◆  ·  ◆
  ·  ◆  ·  ◆  ·  ◆  ·  ◆  ·
  ◆  ·  ◆  ·  ◆  ·  ◆  ·  ◆
  ·  🔵 ·  🔵 🔵 ·  ◆  🔵 🔵
  ◆  ·  ◆  ·  ◆  ·  ◆  ·  ◆
  ·  ◆  ·  ◆  ·  ◆  ·  ◆  ·
 26x  5x 1.5x 0.3x 0x 0.3x 1.5x 5x 26x

💎 10,000 × 5 balls — dropping...
```

**Animation timing:**
- 600ms per frame × 8 rows = ~5 seconds
- `processing` flag = true during animation (standard anti-spam)
- try/catch silent fail on stale interactions (standard)

#### Step 3: Result

**Single ball:**
```
🔵 PLINKO — High Risk
─────────────────
  [board with ball at final slot]

 26x  5x 1.5x 0.3x 0x 0.3x 1.5x 5x 26x
                                    🔵

💎 Result: 5x → 50,000
📈 Profit: +40,000 Kryztal

[🔵 Again] [🔵 ×1] [🔵 ×3] [🔵 ×5] [❌ Stop]
```

**Multi-ball:**
```
🔵 PLINKO — High Risk × 5 Balls
─────────────────
  [board with all balls at final slots]

  🔵 → 5x    💎 10,000
  🔵 → 0.3x  💎 600
  🔵 → 26x   💎 52,000 🔥
  🔵 → 1.5x  💎 3,000
  🔵 → 0x    💎 0

  Bet: 💎 10,000   Return: 💎 65,600
  Profit: +55,600 Kryztal 🎉

[🔵 Again] [🔵 ×1] [🔵 ×3] [🔵 ×5] [❌ Stop]
```

**Payout rounding (binding):** per ball, payout = `Math.floor(perBall × multiplier)`. Total return = sum of the per-ball payouts. Integer Kryztal only; floor favors the house — same convention as crash/hilo/mines/tower. Floored RTP is always ≤ theoretical RTP, so rounding can only keep the ≤ 99.5% invariant safe, never violate it.

#### Step 4: Drop Again Buttons

| Button | Action |
|:---|:---|
| 🔵 Again | Repeat last drop: same bet, same risk, same ball count. Deduct → animate → result |
| 🔵 ×1 / ×3 / ×5 | Switch ball count, then immediately drop (recalculate perBall from same total bet) |
| ❌ Stop | Disable all buttons, end session |

- **Same button set on every result screen** (single-ball and multi-ball): `[Again] [×1] [×3] [×5] [Stop]` — no asymmetric variants

- Button owner verification (standard)
- **Idle expiry — binding (60s per result screen, timer RESETS on every drop):** on expiry, re-edit the SAME embed with all five buttons `.setDisabled(true)` + append a `Session ended — idle 60s` note (embed description footer). This reads as "finished playing": last result stays visible as history, buttons dead — exactly the mines/crash/hilo end-state convention (`msg.edit` with disabled buttons, silent-fail `try {} catch {}`). No money moves at expiry — the drop was already resolved and paid at the result screen. At expiry ALSO clear the session state (`activeGames` entry + `plinko_<userId>` processing lock) so the player can immediately run a fresh `ky plinko`. Do NOT delete the message.
- Balance insufficient → disable button + reply ephemeral "Insufficient balance"
- `perBall < 100` after ball count change → disable that button

### 1.5 XP

Verified against code first: there is **no single "standard" XP base** across games — coinflip uses 20/5, dice 50 (exact) / 25 (parity) + 5 loss, roulette 75 (exact) / 25 (color) + 5 loss — all × bet-tier multiplier. Plinko is a fast animated game in the coinflip family, so pin:
- Win (net profit > 0): **base 20 XP** × tier multiplier
- Lose (net profit ≤ 0): **base 5 XP** × tier multiplier
- Tier by total bet amount (standard tiers)

> Why not v0.1's 50/10: that "same as other games" premise is false in code, and at ~28.9% profit-rate per drop (all risks, symmetric) 50/10 yields ~21.5 base XP/drop vs coinflip's 12.5 — a faster XP farm, violating §4.4. 20/5 yields ~9.3 < 12.5 ✓ for every risk level.

Multi-ball: ONE XP award per drop based on net profit/loss (not per ball).

Stats (`recordWin`/`recordLoss`): also ONE record per drop, net-based — net profit > 0 = 1 win, ≤ 0 = 1 loss. A 5-ball drop never writes 5 records (mirrors the XP rule, prevents stat inflation).

### 1.6 Implementation Notes

- Add to `commands/game.js` — new `case 'plinko':` in both slash and prefix handlers
- Registries to update (easy to forget; misses break discoverability, not function): `VALID_PREFIX_COMMANDS` (`commands/game.js:4547` — add `'plinko'`), `ky help` text, `ky odds` list, 5s fast-game cooldown list (`commands/game.js:193` — add `'plinko'`; default otherwise is 4s, `game.js:154-156`)
- Add `handlePlinkoButton` for risk select + Drop Again
- Board rendering: helper function `renderBoard(rows, ballPositions, multipliers)` → returns string for embed description. Use **code block** for monospace alignment
- Ball path: pre-calculate full path at start (`Array(8).fill().map(() => Math.random() < 0.5 ? -1 : 1)`), animate frame by frame
- Multi-ball: pre-calculate ALL paths, render all balls on same board per frame
- `processing` Map entry: `plinko_<userId>`
- Auto-timeout: 60s idle per result screen, timer resets each drop (buttons — see Step 4), 30s (risk selection)
- `activeGames` Map or similar for session state (risk, bet, balls, current embed)

### 1.7 Edge Cases

- User clicks risk button after timeout → interaction already expired (Discord handles)
- User leaves server mid-game → bet already deducted, result auto-resolves (no human action needed after risk is picked — animation is autonomous)
- Balance drops below bet between games (someone transfers away) → Drop Again disabled
- **Max bet is a SILENT CAP, not a rejection** (verified `game.js:119` + `parseBet`): `ky plinko 600000` bets 💎 500,000 — `Math.min(bet, MAX_BET)` applies to everyone. Same behavior as all existing games; do not add a special error for it.
- **Maintenance gate is inherited automatically** (verified): the gate sits at the top of BOTH dispatchers — slash `execute()` (`game.js:497`) and prefix `handlePrefixCommand()` (`game.js:604`) — blocking non-admin players with a rate-limited ephemeral message while superadmin/admin bypass. `case 'plinko'` routes inside those dispatchers, so no per-game maintenance code is needed — but the implementation must NOT introduce any early-return path that bypasses the gate.
- **Superadmin** (verified contract, coinflip/blackjack as reference): economyManager early-returns `Infinity` balance; bet deduction, payout credit, XP, and win/loss records are ALL skipped (every write call wrapped in `!isSuperAdmin(userId)`). The bet amount itself is NOT exempt from the cap: `parseBet` has no superadmin branch on the numeric path, and `all` resolves to MAX_BET (500k) regardless of balance. (v0.1's "parseBet returns parsed amount as-is" was wrong — corrected.)
- Bot restart mid-session (risk-select window, animation, or result screen) → in-memory session gone; deducted bet is lost with no result. Same accepted risk as every other in-memory game — not a new exception, but must be documented to players

---

## §2 Multiplayer Poker (Texas Hold'em — Single Hand)

### 2.1 Overview

2-5 player Texas Hold'em poker. **Single hand per game** — no multi-hand sessions. Player vs player (zero house edge). Buy-in model with escrow for restart recovery. Prefix-only (`ky poker`), no slash command (preserve 25-cap).

### 2.2 Commands

```
ky poker <buy-in>   — start a table (host)
```

- `buy-in`: `all` goes through `parseBet` (resolves to `min(balance, MAX_BET)` — never exceeds the cap). A numeric buy-in gets a **RAW pre-check BEFORE `parseBet`**: `parseInt(raw)` first; if `> 500,000` → explicit reject *"❌ Maximum buy-in is 💎 500,000."* The pre-check is REQUIRED — `parseBet` silently caps (`Math.min(bet, MAX_BET)`), so the handler can never see the original amount after parsing. (Owner decision 2026-08-28: explicit reject, NOT silent cap — multiplayer money at stake, clarity > consistency.)
- Min buy-in: 1,000 (small blind would be too tiny otherwise)
- All joining players pay the **same buy-in** as host

### 2.3 Game Lifecycle

```
LOBBY → DEAL → PRE-FLOP → FLOP → TURN → RIVER → SHOWDOWN → SETTLEMENT
```

#### Phase 1: Lobby (30 seconds)
```
🃏 POKER TABLE
──────────────────
Buy-in: 💎 100,000 | Blinds: 2,500 / 5,000

Players (2/5):
  1. Kyriz ✅
  2. Alex  ✅

Waiting for players... (in 25 seconds)

[💰 Join] [▶️ Start] [❌ Cancel]
```

- **Host auto-joins at command time**: running `ky poker <buy-in>` immediately deducts the host's buy-in + creates their escrow record (same §2.6 join transaction). Host with insufficient balance gets the same rejection — no free lobby spam. Host still uses **[❌ Cancel]** for a full refund.
- **[💰 Join]**: Anyone not in game. Deducts buy-in immediately → escrow record created. Balance insufficient → ephemeral: *"Insufficient balance. Buy-in is 💎 100,000."*
- **[▶️ Start]**: Host only. Requires ≥2 players. Starts immediately.
- **[❌ Cancel]**: Host only. Full refund all players.
- Auto-start: 30 seconds if ≥2 players, otherwise auto-cancel + refund.
- Player already in another poker game → reject: *"You're already in a poker game."*
- Player in active PvP/battle → reject: *"You're in an active game. Finish it first."*

#### Phase 2: Deal
- Assign positions: Dealer (D), Small Blind (SB), Big Blind (BB), others
- Auto-deduct blinds from chips:
  - SB = `Math.round(buyIn * 0.025 / 100) * 100` (2.5%, rounded to nearest 100)
  - BB = SB × 2
- Deal 2 hole cards per player (from shuffled 52-card deck)
- Transition to Pre-Flop betting round

#### Phase 3-6: Betting Rounds (Pre-Flop → Flop → Turn → River)

Each round:
1. Determine first actor (pre-flop: player after BB; post-flop: first active player after dealer)
2. Each player acts in order: Check / Call / Raise / All-in / Fold
3. **Round ends when every non-folded, non-all-in player has ACTED since the last raise AND matched the current bet.** "Acted" ≠ "matched": a player who is merely chip-level matched still owes an action — this is the **big blind option** (pre-flop, if everyone just calls/limps, the BB may still check or raise). Implement with a per-round `hasActed` set that RESETS on every raise — never with bet-amount comparison alone. (Classic poker-engine bug: BB option silently skipped.)
4. If only 1 player remains (everyone else folded) → skip to Settlement (no showdown)
5. If all remaining players are all-in → auto-runout remaining community cards
6. Dealer button is drawn RANDOMLY per game (single-hand games — no rotation carries over)

**Community card reveals (with animation):**
- Flop: 3 cards, flipped one-by-one (600ms each)
- Turn: 1 card (800ms)
- River: 1 card (800ms)

#### Phase 7: Showdown
- Reveal all remaining players' hole cards
- Evaluate best 5-card hand from 7 cards (2 hole + 5 community)
- Rank: Royal Flush > Straight Flush > Four of a Kind > Full House > Flush > Straight > Three of a Kind > Two Pair > One Pair > High Card
- Ties: split pot equally (remainder to first position in rotation — `Math.floor`)

#### Phase 8: Settlement
See §2.6 Money Flow.

### 2.4 Betting Actions & Buttons

```
[👁️ View Hand] [✅ Check/Call] [💰 Raise] [💎 All-in] [🏳️ Fold]
```

| Button | Who can click | Behavior |
|:---|:---|:---|
| 👁️ View Hand | Any player in game (any time) | Ephemeral: hole cards + current best hand |
| ✅ Check | Current turn player, if no active bet | Pass without betting |
| ✅ Call {amount} | Current turn player, if active bet ≤ chips | Match current bet |
| ✅ All-in {chips} | Current turn player, if active bet > chips | Bet everything (can't afford full call) |
| 💰 Raise | Current turn player | Opens Modal (see below) |
| 💎 All-in | Current turn player | Bet all remaining chips |
| 🏳️ Fold | Current turn player | Surrender hand |

**Non-turn player clicks action button** → ephemeral: *"It's not your turn."*
**Non-player clicks any button** → ephemeral: *"You're not in this game."*

#### Raise Modal
```
┌─────────────────────────────┐
│   Raise Amount              │
│   ┌───────────────────────┐ │
│   │                       │ │
│   └───────────────────────┘ │
│   Min: {minRaiseTo}       │
│   Max: {yourChips}          │
│                             │
│   [Cancel]   [Submit]       │
└─────────────────────────────┘
```

**Input semantics (binding): the number entered is the raise-TO total** (the player's total bet for the street after the raise), NOT the increment over the current bet.

Validation (server-side, at modal submit):
- Non-numeric / empty / ≤ 0 → *"Please enter a valid number."*
- < `minRaiseTo` → *"Minimum raise is to 💎 {minRaiseTo}."*
- > player's chips → *"You only have 💎 {chips} chips."*
- Between current bet and `minRaiseTo` → same minimum-raise rejection (an all-in below the minimum raise is only reachable via the 💎 All-in button, never the modal)

`minRaiseTo = currentBet + lastRaiseSize`, where `lastRaiseSize` = size of the last raise (raise-to minus the previous current bet), floored at BB for the first bet of a street — the standard min-raise rule. Example: current bet 30,000 after a 20,000 raise (from 10,000) → `minRaiseTo` = 50,000; entering 40,000 is rejected; entering 35,000 is rejected too (below min — not a legal modal all-in).

#### View Hand (Ephemeral)

```
(Only you can see this)
Your Hand: [K♠] [K♥]
🔥 Three of a Kind — Kings
```

- Shows current best hand evaluation (updates with community cards — user must re-click)
- Pre-deal: *"Cards haven't been dealt yet."*
- After fold: *"You have folded."*
- No "Board" line — already visible in channel

### 2.5 Turn Management & Anti-Stuck

> **⚠️ CRITICAL LESSON FROM PvP BUG** (verified: `battleCommands.js:1192-1200`)
>
> PvP encodes `actorId` in button `customId` → if embed edit fails, buttons retain OLD actorId → BOTH players get "Not your turn" → stuck. **Poker MUST NOT repeat this.**

#### Rule: Buttons are GENERIC, turn is checked at click time

```js
// WRONG (PvP pattern — causes stuck):
customId: `poker_call_${gameId}_${currentPlayerId}`
// check: interaction.user.id !== actorIdFromButton → "Not your turn"

// CORRECT (Poker pattern):
customId: `poker_call_${gameId}`
// check: game.currentTurn !== interaction.user.id → "Not your turn"
```

Buttons contain **only `gameId`**, NOT player ID. Turn is resolved from **game state in memory** at click time. Even if embed edit fails and old buttons remain visible, the correct player's click still works because the game state (not the button) determines whose turn it is.

#### AFK Timer (30 seconds)

```js
// On each turn start:
clearTimeout(game.afkTimer);
game.afkTimer = setTimeout(() => autoAction(gameId), 30_000); // check if no bet owed, else fold
// On valid action: timer cleared + restarted for next player
```

- AFK → **auto-check if there is no bet to the player, else auto-fold** (standard auto-action; always-folding taxes a player who could have checked for free)
- **Timer cleared SYNCHRONOUSLY before any await** (same fix as PvP `clearAfkTimer` at `:1217`)
- If all remaining players fold via AFK → last standing wins pot

#### Game Timeout (15 minutes total)

```js
game.gameTimer = setTimeout(() => forceEndGame(gameId), 15 * 60_000);
```

- If somehow the game runs 15+ minutes → force-end
- **Force-end = REFUND BY EXACT CONTRIBUTION, ALL players — folded included** (binding, v0.4): every player receives back exactly their own `contributed` total (§2.8), whether they folded or not. Pot goes to zero. NO proportional split, NO showdown.
- **Why refund-ALL (v0.4 review fix):** v0.3 said non-folded-only refunds with "folded losses locked in" — but that money had NO recipient: Σ payouts < Σ buy-ins, so either the §2.6 zero-sum assertion throws (settle never commits → boot recovery refunds everyone anyway — "locked losses" fiction) or the implementer drops the assertion and folded Kryztal is silently DESTROYED (deflation). Refund-all is the only self-consistent option.
- **Why refund at all (vs split):** a proportional split rewards clock-burning — a player with the biggest stake can bet big, then stall ~28s per action (never tripping the 30s AFK fold) to reach force-end and walk away with the largest share of OTHER players' money without ever showing cards. Exact-contribution refund-all makes timeout money-neutral: burning the clock wins nothing, ever — and folding costs nothing ONLY in the abnormal-timeout case (normal settlements still lock folded losses in via the winner).
- Escrow cleared in the same settlement transaction (§2.6). Zero-sum assertion holds trivially (Σ refunds = Σ contributions).
- 15 min (not 5): a healthy 4-player hand × 4 streets × ~20s per decision already exceeds 5 minutes — 5 would cut normal games.

#### Interaction Stability

Every `interaction.update()` / `message.edit()` wrapped in try/catch:
```js
try {
  await interaction.update({ embeds: [...], components: [...] });
} catch (e) {
  // Stale interaction — buttons may be dead
  // Fall through: AFK timer will handle stuck turns
  // Game state is still valid in memory
}
```

If ALL button interactions die (message too old, 15min Discord limit):
- AFK timer auto-folds current player every 30s
- Chain reaction: everyone gets auto-folded → last standing wins
- Worst case: game timeout at 15 min → force-end + exact-contribution refund

**There is NO scenario where the game permanently stucks.**

### 2.6 Money Flow (Escrow Model)

#### Invariant: Total money in = Total money out (zero-sum)

**JOIN (host auto-join at command time, or [💰 Join] click) — ONE SQLite transaction:**

```js
const joinTx = db.transaction((userId, buyIn) => {
  removeBalance(userId, buyIn);              // no-op for superadmin (global contract)
  insertPokerEscrow(gameId, userId, buyIn);
});
joinTx(userId, buyIn);
game.players.push({ id: userId, chips: buyIn });   // in-memory, AFTER the tx commits
```

Both-or-neither: a crash between deduct and escrow INSERT rolls back BOTH — the wallet-shrink-without-escrow hole is structurally impossible (better-sqlite3 `db.transaction()`, the same pattern as the migration in `economyManager.js`). Insufficient balance → `removeBalance` **returns `{ success: false }` (it does NOT throw — verified `economyManager.js:584-588`)** → the join tx MUST check the return and `throw` manually to trigger rollback. An implementer following v0.3's "removeBalance throws" literally creates a join-without-payment hole: escrow row inserted, no deduction, free chips. (Plan v0.2 already caught this; spec corrected to match.)

**DURING GAME:** chip movements are in-memory ONLY — the wallet is NOT touched during gameplay. No `addBalance` / `removeBalance` calls mid-game.

**SETTLEMENT (normal end, lobby [❌ Cancel], and force-end) — ONE SQLite transaction:**

```js
const settleTx = db.transaction((gameId, payouts) => {
  deletePokerEscrow(gameId);                                   // escrow gone…
  for (const [userId, amount] of payouts) addBalance(userId, amount); // …only if credits commit
});
settleTx(gameId, payouts);
```

- Cancel = settlement with payouts = each player's buy-in (full refund). Force-end = payouts = exact contributions (§2.5).
- Crash before commit → full rollback → escrow rows still present → boot recovery refunds. Nothing half-settled.
- Zero-sum asserted in code before commit: Σ payouts = Σ contributions = Σ buy-ins.

**RESTART RECOVERY (bot crash) — boot sequence, transactional:**

- `SELECT * FROM poker_escrow` → group rows by `game_id`.
- Per group, ONE transaction: for each row `addBalance(userId, buy_in)` (no-op for superadmin) → delete that group's rows.
- Log: `[POKER] Recovered N games, refunded M players`.
- **No double-refund — and no lost money.** Because settlement is transactional, an escrow row exists ONLY if no settlement was committed for that game ("escrow deleted but credits not applied" cannot exist — uncommitted = rolled back). The refund is therefore always exact; the v0.2 wording ("crash after delete before credit = player loses buy-in") described a state that a transaction makes impossible and is removed.

#### Escrow Table (SQLite)

```sql
CREATE TABLE IF NOT EXISTS poker_escrow (
  game_id   TEXT NOT NULL,
  user_id   TEXT NOT NULL,
  buy_in    INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (game_id, user_id)
);
```

Lightweight. No complex queries. Only INSERT (join), DELETE (settlement/cancel), SELECT (recovery).

**DB ownership (binding):** the `poker_escrow` DDL lives in `utils/economyManager.js` — appended to the existing boot-time `SCHEMA_SQL`, executed on the SAME better-sqlite3 connection. Never open a second `new Database()` on the same file (SQLite locking + WAL make dual connections a corruption/`SQLITE_BUSY` source). Poker code touches escrow ONLY through transaction-wrapped helpers exported from economyManager. The env overrides `KYRIZ_ECONOMY_DB`/`KYRIZ_ECONOMY_JSON` then apply to tests/gladi automatically — no separate db file, no separate connection.

#### Anti-Exploit: Double Credit Prevention

- During game: **zero wallet operations**. Chips are ephemeral in-memory numbers.
- Settlement: single atomic transaction (DELETE escrow + credit wallets)
- No pathway where chips AND wallet are credited simultaneously
- Folded players: chips returned at settlement (not at fold time — simpler, avoids partial escrow states)

### 2.7 Blinds

| Buy-in | Small Blind | Big Blind |
|:---|:---|:---|
| 1,000 | 100 | 200 |
| 10,000 | 300 | 600 |
| 50,000 | 1,300 | 2,600 |
| 100,000 | 2,500 | 5,000 |
| 500,000 | 12,500 | 25,000 |

Formula: `SB = Math.round(buyIn * 0.025 / 100) * 100`, `BB = SB * 2`

Minimum SB = 100. Blinds auto-deducted from chips at deal.

### 2.8 Side Pots

Triggered when a player goes all-in with fewer chips than the current bet.

#### Algorithm: Contribution Layering (binding)

Track `contributed[userId]` for every player from the first chip that enters the pot — **blinds count** (they are bets), calls, raises, all-ins.

1. Collect sorted unique contribution levels of the all-in players.
2. For each level `l`: layer `l` holds `Σ_p min(contributed[p], l) − min(contributed[p], previousLevel)` over ALL players (folded included — their dead money funds layers), and is contestable only by non-folded players with `contributed[p] ≥ l`.
3. Award each layer to the best hand among its eligible players (ties split per §2.3).
4. **Uncalled-bet auto-return**: if the top layer has exactly ONE eligible player, it is returned to that player immediately — a bet nobody called was never at risk.
5. Folded players are never eligible for any layer, but their money stays in the layers it landed in (dead money).

This subsumes the old "sort all-in amounts" sketch AND handles uncalled bets + dead money, which the old sketch got wrong (it returned uncalled bets only by luck of ordering).

#### Example: 3 Players, Different All-ins

```
Alex:  all-in 20,000  (only 20k chips)
Mika:  all-in 60,000
Kyriz: call   60,000

Main Pot:  💎 60,000  (20k × 3) — Alex, Mika, Kyriz eligible
Side Pot:  💎 80,000  (40k × 2) — Mika, Kyriz only

Display:
  Pot: 💎 60,000 (main) + 💎 80,000 (side)
```

#### Showdown with Side Pots

```
Alex has best hand:
  🥇 Alex  wins Main Pot 💎 60,000
  → Side Pot: compare Mika vs Kyriz only
  🥇 Kyriz wins Side Pot 💎 80,000

Alex does NOT have best hand:
  🥇 Kyriz wins Main Pot + Side Pot = 💎 140,000
```

Multiple side pots possible (3+ different all-in amounts) — layers stack naturally.

#### Example: Uncalled Bet (the case the old sketch missed)

```
Kyriz bets 80,000. Mika all-in 30,000. Everyone else folds.

Layer 30,000:  30,000 × 2 = 60,000  — eligible {Kyriz, Mika}
Top layer:     50,000 contributed by Kyriz alone → ONE eligible → auto-RETURN to Kyriz

Showdown: better hand wins the 60,000 layer (or splits it).
Kyriz's real risk was only 30,000 — the extra 50,000 comes home regardless of the river.
```

### 2.9 Edge Cases (Comprehensive)

#### Game Flow
| Case | Behavior |
|:---|:---|
| Only 1 player joins (30s timeout) | Auto-cancel, refund |
| Everyone folds except 1 | Winner takes pot, **no card reveal** |
| All remaining players all-in | Auto-runout: deal remaining community cards with animation, then showdown |
| 2 players, 1 folds pre-flop | Winner takes blinds (SB+BB). Game over. No deal. |
| Everyone checks every round | Showdown with just blind money in pot |
| Tie at showdown | Split pot evenly. Odd remainder to first in rotation |
| All-in pre-flop (before any community cards) | Full 5-card runout animation |

#### Money Safety
| Case | Behavior |
|:---|:---|
| Player tries to bet > chips | Button disabled / modal rejects |
| Player can't afford call | Button shows "All-in {chips}" instead of "Call" |
| Buy-in > 500,000 | Explicit reject (not silent cap) |
| Buy-in > balance | *"Insufficient balance."* |
| Bot restart mid-game | Escrow refund all players (see §2.6) |
| Settlement crash (between delete escrow + credit) | Transaction = atomic, both or neither |
| Player joins poker + plays slots simultaneously | Allowed — different money (buy-in already deducted) |
| Player joins 2 poker games | Blocked: *"You're already in a poker game."* |
| 6th player clicks Join (table full) | Blocked: *"Table is full (5 players)."* |
| Two accounts collude (chip-dumping) | See §4.4 OPEN DECISION — no gate by owner default; audit/revisit if abused |

#### Interaction Stability (PvP Bug Prevention)
| Case | Behavior |
|:---|:---|
| Embed edit fails (stale/lag) | Buttons still work: turn checked from game state, not button ID |
| Both players click simultaneously | `processing` lock per game: first click processed, second queued |
| Buttons expire (15 min Discord limit) | AFK timer chain-folds → game resolves naturally |
| Player leaves server mid-game | 30s AFK → auto-fold. Chips return at settlement |
| `ky poker end` during game | **NOT AVAILABLE** after deal. Only in lobby (Cancel). |

#### Superadmin

**Policy (owner decision, 2026-08-28): superadmin PLAYS poker for real — no special-case game code.**

| Case | Behavior |
|:---|:---|
| Superadmin joins poker | Like any player: buy-in ≤ 500k (cap not exempt), `removeBalance` is a no-op (global `Infinity` early-return contract — `Infinity` stays `Infinity`), **normal escrow record created**, normal chip stack at the table. |
| Superadmin loses chips | Winner's `addBalance` credits REAL Kryztal that never left a wallet → **new money enters the economy (faucet)**. Owner explicitly accepts this inflation vector: he is the sole superadmin and will not dump chips deliberately. |
| Superadmin wins chips | `addBalance(superadmin, …)` is a no-op (global contract) → those Kryztal leave circulation. Accounting stays zero-sum in CHIP space at all times. |
| Bot restart mid-game | Standard §2.6 recovery: refund row read → `addBalance(SA, buyIn)` = no-op → escrow deleted. No double-credit possible. |
| Implementation rule | Poker code contains **ZERO `isSuperAdmin` branches** — the economyManager early-return makes wallet writes no-ops automatically. Any special-casing here would re-open the removed "synthetic chips" money-printer design (v0.2): a synthetic-lose join that pays winners real Kryztal with zero wallet deduction. |

### 2.10 Embed Templates

**Pre-Flop:**
```
🃏 POKER TABLE
──────────────────
[🂠] [🂠] [🂠] [🂠] [🂠]

  🔹 Kyriz    💎 97,500   SB 2,500
  🔸 Alex     💎 95,000   BB 5,000
  ⬜ Mika     💎 100,000

  Pot: 💎 7,500

👉 Mika's turn
⏰ Auto-fold <t:1693234567:R>

[👁️ View Hand] [✅ Call 5,000] [💰 Raise] [💎 All-in] [🏳️ Fold]
```

**After Raise:**
```
🃏 POKER TABLE
──────────────────
[10♠] [K♦] [3♣] [🂠] [🂠]

  🔹 Kyriz    💎 70,000   raise 30,000 🔥
  🔸 Alex     💎 80,000   waiting...
  🏳️ Mika    💎 90,000   folded (lost 10,000)

  Pot: 💎 67,500

👉 Alex's turn
⏰ Auto-fold <t:1693234597:R>

[👁️ View Hand] [✅ Call 30,000] [💰 Raise] [💎 All-in] [🏳️ Fold]
```

**All-in Runout:**
```
🃏 ALL-IN! Running the board...
──────────────────
[10♠] [K♦] [3♣] [7♥] [🂠]

  💎 Kyriz    all-in 100,000
  💎 Alex     all-in 100,000

  Pot: 💎 200,000

Revealing final card...
```

**Showdown:**
```
🃏 POKER TABLE — Showdown!
──────────────────
[10♠] [K♦] [3♣] [7♥] [Q♠]

  🥇 Kyriz    [A♠] [K♠]  → Two Pair (Kings & Tens)
  🥈 Alex     [Q♥] [Q♦]  → One Pair (Queens)
  🏳️ Mika    folded

  🏆 Kyriz wins 💎 107,500!

  Kyriz: +7,500 profit   (💎 107,500 to wallet)
  Alex:  -20,000 loss     (💎 80,000 to wallet)
  Mika:  -10,000 loss     (💎 90,000 to wallet)
```

### 2.11 XP & Stats

- **No XP from poker.** Reason: player vs player, zero-sum. XP would be net-positive (both players gain XP, money just moves) → XP farm exploit (friends play each other repeatedly). Same reason battle PvP doesn't give Kryztal XP.
- **Win/Loss stats**: 1 record per game per player. Win = positive net. Loss = negative net, **including net-0** (folded/all blind money lost = negative; exact-break-even = recorded as LOSS, consistent with Plinko's `net ≤ 0 = loss` rule). Fold = loss (lost blinds/bets).

### 2.12 Implementation Notes

- **File**: `commands/game.js` — new `case 'poker':` in prefix handler only
- **Button handler**: `handlePokerButton` — generic `customId` format: `poker_{action}_{gameId}` (NO player ID). `gameId` = `poker_<hostId>_<Date.now().toString(36)>` (~30 chars) — every customId stays far under Discord's 100-char customId limit even with the longest action suffix.
- **Modal handler**: `handlePokerModal` — for raise amount input. **`index.js` has NO modal routing today (verified: zero `isModalSubmit` hits in the whole codebase)** — add an `interaction.isModalSubmit()` branch in `index.js`'s `interactionCreate` handler routing to poker; without it the Raise button is dead-on-arrival.
- **State**: `activePokerGames` Map — `gameId → { players, deck, community, pot, currentTurn, phase, hasActed, contributed, afkTimer, gameTimer }`. `hasActed` = per-round acted set (resets on raise — BB option, §2.3). `contributed` = per-player total put in pot (side pots + refunds computed from it at settlement, §2.8/§2.5 — never stored as live side-pot state).
- **Card logic**: reuse `utils/cardDeck.js` (deck, shuffle — already exists for Blackjack)
- **Hand evaluator**: new `utils/pokerHand.js` — evaluate best 5 from 7 cards. This is the most complex piece. Well-known algorithms exist (bit-manipulation lookup tables).
- **Registries**: add `'poker'` to `VALID_PREFIX_COMMANDS`, `ky help`, `ky odds`
- **Escrow table**: `poker_escrow` in SQLite (see §2.6) — DDL + helpers inside economyManager's single connection (§2.6 DB ownership)
- **Recovery**: add to `index.js` boot sequence — check `poker_escrow` → transactional per-group refund (§2.6)
- **Processing lock**: `poker_${gameId}` — one action at a time per game (not per player)

---

## §3 Horse Race

> **Status: TBD** — brainstorm pending

---

## §4 Shared Implementation Concerns

### 4.1 File Impact

All three games go into `commands/game.js` (the monolith — no refactor in this scope). Each game adds:
- Command handler (prefix and/or slash — **poker is prefix-only**, §2.1)
- Button handler
- Board/animation renderer
- Game-specific constants (multipliers, paytables, etc.)
- **Poker only: modal handler** — plus a NEW `interaction.isModalSubmit()` branch in `index.js`'s `interactionCreate` (the bot has no modal path today — verified; without it, Raise is dead-on-arrival)

### 4.2 Slash Command Registration

- `/kyriz plinko <bet> [balls]` — consumes 1 slot
- **Poker — NO slash subcommand**: prefix-only (`ky poker`, §2.1/§2.12), consumes 0 slots
- `/kyriz race <bet> [horse]` (TBD) — would consume 1 slot

⚠️ **Discord hard cap: 25 subcommands + groups per top-level command. AUDITED 2026-08-28 (from code, not estimates):**

| Item | Count |
|:---|:---|
| Standalone subcommands (`game.js` `addSubcommand`) | 21 |
| Subcommand groups (`autoreply` in `commands/autoreply.js`, `user` in `commands/user.js`) | 2 |
| **Used today** | **23 / 25** |

Consequences for this spec:
- Plinko → 24/25 ✅ fits
- Poker → +0 slots (prefix-only)
- Horse Race → 25/25 ⚠️ **exactly at the ceiling — fits, but zero headroom remains for ANY future slash subcommand after it**

**Decision required BEFORE brainstorming poker/race:** how to structure games beyond slot 25. Leading option: consolidate casino games under a wrapper subcommand — `/kyriz play <game>` with a string-choice option (~13 game names, far under the separate 25-choice limit for choices) — but this changes existing UX (`/kyriz blackjack` → `/kyriz play blackjack`) and therefore needs its own brainstorm + migration. Do not spend remaining slots casually; adding plinko consumes one of the last two.

### 4.3 Testing

Each game needs:
- **RTP sim** (`test/<game>_sim.js`) — 1M+ spins, verify ≤ 99.5%
- **Edge case test** — min/max bet, multi-ball rounding, timeout, insufficient balance
- **Animation test** — verify board rendering produces valid strings (no crashes on edge positions)

#### Poker (§2) — different test profile: ZERO-SUM game, NO RTP sim

There is no house edge to simulate — money only moves between players. Poker's test battery instead:
- **Hand evaluator vectors** (deterministic, `test/pokerHand.test.js`): wheel straight A-2-3-4-5 ranks LOWEST straight; straight < flush ordering; kicker wars; board-plays split (both players play the board); best-5-from-7 over all 21 combinations; suit ties
- **Side pots**: uncalled-bet auto-return (§2.8 example), dead money funds layers but folder is ineligible, stacked multi-level all-ins, blinds counted in contributions
- **Round-end / BB option**: everyone limps pre-flop → BB may still act; `hasActed` resets on every raise (regression test for the classic engine bug)
- **Escrow**: join-tx rollback on insufficient balance; settlement atomicity; boot recovery refunds exactly; a settled game can never be re-refunded (idempotent recovery)
- **Zero-sum property test**: scripted randomized games → Σ final chips = Σ buy-ins, every single time
- **Timeout**: force-end refunds EXACT contributions — regression test for the clock-burn exploit (§2.5)
- **AFK**: auto-check when no bet to call; auto-fold when there is
- **Stuck-game theorem**: with ALL button interactions dead (message too old), the AFK chain-fold still resolves the game to a payout

### 4.4 Economy Impact

Three new games = three new ways to earn/lose Kryztal. Monitor:
- Aggregate RTP across all games (should stay ≤ 99.5% individually)
- No game should be "strictly better" for farming than existing ones
- XP gain rate: ensure new games don't create faster XP farming paths
- 🔍 **Side observation (verify separately — out of scope for this spec):** coinflip appears to run at RTP **exactly 100%** — fair `Math.random() < 0.5` coin with payout `bet × 2` and no fee (`commands/game.js:1966`, `:1980`). That contradicts the documented "all games ≤ 99.5%" invariant and makes coinflip the current best farm (break-even money + net-positive XP). Plinko Low (99.0%) is strictly worse for farming than coinflip, so the "no strictly better game" bar is already met — but the coinflip discrepancy deserves its own investigation task.
- ⚠️ **OPEN DECISION — chip-dumping (2 accounts):** two accounts join the same poker table and one deliberately loses to the other → Kryztal moves across accounts, bypassing `ky transfer` level-gates and the 3/day transfer caps. Owner default (2026-08-28): **no gate** — buy-in is capped at 500k/table anyway and the player base is a small trusted circle. Revisit if abused: minimum account level to join, per-day poker net-loss cap, or an audit log for repeated same-pair tables.
