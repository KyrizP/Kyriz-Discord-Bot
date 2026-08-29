# Plinko & Multiplayer Poker — Implementation Plan [EXECUTED 2026-08-28]

> **Status: COMPLETE.** Gates at HEAD `02969b0`: old battery full-green (630+53+43+44+45+60+11+5300+82+parity19+migration10+e2e23+crash200038+exploit38/38) · new suites: plinko RTP 2M-spin PASS, pokerHand 22/22, pokerEscrow 17/17, pokerEngine 31/31 (incl. zero-sum ×100 random games). Owner Discord-manual checklist remains (lobby flow, buttons, modal, multi-player hand).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Plinko (single-player casino) and Multiplayer Poker (2-5 player Texas Hold'em) to Kyriz Discord bot.

**Architecture:** Plinko is a self-contained single-player game with animation, bolted into the existing `game.js` monolith. Poker is a multiplayer session-based game with an escrow system for money safety, a hand evaluator utility, and modal routing for raise input. Both games are prefix-only for poker, prefix+slash for plinko. All state is in-memory Maps; escrow is persisted in SQLite for restart recovery.

**Tech Stack:** discord.js v14, better-sqlite3 (WAL), Node.js

**Spec:** `docs/superpowers/specs/2026-08-28-new-casino-games-design.md`

## Global Constraints

- All game code goes into `commands/game.js` (the monolith — no refactor in this scope)
- Embed text, error messages, button labels = **FULL ENGLISH** (existing convention)
- `parseBet` only supports integers + `all` — no `k`/`m`/`half` (verified `game.js:1037`)
- Max bet: 500,000 (silent cap for plinko via `parseBet`, explicit reject pre-check for poker)
- Superadmin: `removeBalance` = no-op (returns `{ success: true, newBalance: Infinity }`), `addBalance` = no-op. **ZERO `isSuperAdmin` branches in new game code** — the global contract handles it
- `removeBalance` does NOT throw on insufficient balance — it returns `{ success: false }`. All poker transactions MUST check this and throw manually for rollback
- `cardDeck.js` `.value` field = Blackjack-specific (A=11, J/Q/K=10). Poker hand evaluator MUST NOT use it
- Processing flag pattern: `processing.set(key, true)` / `processing.delete(key)` — standard anti-spam
- Maintenance gate is inherited from dispatchers (`game.js:497` slash, `game.js:604` prefix) — no per-game gate needed
- Bot has **ZERO** `isModalSubmit()` handlers today — must add routing in `index.js`
- `poker_escrow` DDL lives in `economyManager.js`, same DB connection — never open second `new Database()`

---

## Phase 1: Plinko (Tasks 1-4)

### Task 1: Board Renderer & RTP Simulation

**Files:**
- Create: `test/plinko_sim.js`
- Create: `test/plinko_render.test.js`

**Produces:**
- `simulatePlinkoDrop(risk)` → `{ slot, multiplier, path }` — used by Task 2
- `renderPlinkoBoard(ballPositions, risk)` → string — used by Task 2. **`ballPositions` = ARRAY of `{row, col}`** (multi-ball renders all balls on one board, spec §1.4 — a single-position signature forces a Task-2 rewrite)
- `PLINKO_MULTIPLIERS` constant object — used by Tasks 2, 3
- RTP proof: all 3 risks ≤ 99.5%

- [x] **Step 1: Define plinko constants at top of `commands/game.js`**

Add after the existing constants block (around line 30):

```js
// ============================================================
// PLINKO
// ============================================================

const PLINKO_ROWS = 8;
const PLINKO_MULTIPLIERS = {
  low:    [1.5, 1.3, 1.1, 1.0, 0.8, 1.0, 1.1, 1.3, 1.5],
  medium: [5,   2,   1.4, 0.9, 0.4, 0.9, 1.4, 2,   5],
  high:   [26,  5,   1.5, 0.3, 0,   0.3, 1.5, 5,   26],
};

function simulatePlinkoPath() {
  const path = [];
  for (let row = 0; row < PLINKO_ROWS; row++) {
    path.push(Math.random() < 0.5 ? -1 : 1);
  }
  const slot = path.filter(d => d === 1).length;
  return { path, slot };
}

function simulatePlinkoDrop(risk) {
  const { path, slot } = simulatePlinkoPath();
  const multiplier = PLINKO_MULTIPLIERS[risk][slot];
  return { path, slot, multiplier };
}

function renderPlinkoBoard(ballRow, ballCol, risk) {
  const mults = PLINKO_MULTIPLIERS[risk];
  const lines = [];
  const width = 9;

  for (let row = 0; row < PLINKO_ROWS; row++) {
    let line = '';
    for (let col = 0; col < width; col++) {
      const isBall = (row === ballRow && col === ballCol);
      line += isBall ? ' 🔵' : ' ◆ ';
    }
    lines.push(line);
  }

  const multLine = mults.map(m => {
    const s = m === 0 ? '0x' : `${m}x`;
    return s.padStart(4);
  }).join('');
  lines.push(multLine);

  return '```\n' + lines.join('\n') + '\n```';
}
```

- [x] **Step 2: Write RTP simulation test**

Create `test/plinko_sim.js`:

```js
// Plinko RTP Simulation — verify all risks ≤ 99.5%
// Run: node test/plinko_sim.js

const PLINKO_MULTIPLIERS = {
  low:    [1.5, 1.3, 1.1, 1.0, 0.8, 1.0, 1.1, 1.3, 1.5],
  medium: [5,   2,   1.4, 0.9, 0.4, 0.9, 1.4, 2,   5],
  high:   [26,  5,   1.5, 0.3, 0,   0.3, 1.5, 5,   26],
};
const ROWS = 8;
const SPINS = 2_000_000;

for (const risk of ['low', 'medium', 'high']) {
  let totalReturn = 0;
  for (let i = 0; i < SPINS; i++) {
    let rights = 0;
    for (let r = 0; r < ROWS; r++) {
      if (Math.random() < 0.5) rights++;
    }
    totalReturn += PLINKO_MULTIPLIERS[risk][rights];
  }
  const rtp = (totalReturn / SPINS) * 100;
  const pass = rtp <= 99.5;
  console.log(`${risk.padEnd(8)} RTP: ${rtp.toFixed(3)}% ${pass ? '✅' : '❌ FAIL'}`);
  if (!pass) process.exit(1);
}
console.log('\nAll risks pass ≤ 99.5% RTP ✅');
```

- [x] **Step 3: Run RTP sim**

Run: `node test/plinko_sim.js`
Expected: All 3 risks ≤ 99.5%

- [x] **Step 4: Write board render test**

Create `test/plinko_render.test.js`:

```js
// Plinko render test — verify board produces valid strings
// Run: node test/plinko_render.test.js

const PLINKO_MULTIPLIERS = {
  low:    [1.5, 1.3, 1.1, 1.0, 0.8, 1.0, 1.1, 1.3, 1.5],
  medium: [5,   2,   1.4, 0.9, 0.4, 0.9, 1.4, 2,   5],
  high:   [26,  5,   1.5, 0.3, 0,   0.3, 1.5, 5,   26],
};

function renderPlinkoBoard(ballRow, ballCol, risk) {
  const mults = PLINKO_MULTIPLIERS[risk];
  const lines = [];
  const width = 9;
  for (let row = 0; row < 8; row++) {
    let line = '';
    for (let col = 0; col < width; col++) {
      const isBall = (row === ballRow && col === ballCol);
      line += isBall ? ' 🔵' : ' ◆ ';
    }
    lines.push(line);
  }
  const multLine = mults.map(m => {
    const s = m === 0 ? '0x' : `${m}x`;
    return s.padStart(4);
  }).join('');
  lines.push(multLine);
  return '```\n' + lines.join('\n') + '\n```';
}

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('FAIL:', msg); } }

// Test 1: renders without crash (no ball visible — row=-1)
const board1 = renderPlinkoBoard(-1, -1, 'high');
assert(typeof board1 === 'string', 'renders string');
assert(board1.includes('26x'), 'includes multiplier');

// Test 2: ball visible at specific position
const board2 = renderPlinkoBoard(3, 2, 'low');
assert(board2.includes('🔵'), 'ball visible');

// Test 3: all risk levels render
for (const risk of ['low', 'medium', 'high']) {
  const b = renderPlinkoBoard(0, 4, risk);
  assert(typeof b === 'string', `${risk} renders`);
}

console.log(`\nPlinko render: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
```

- [x] **Step 5: Run render test**

Run: `node test/plinko_render.test.js`
Expected: All pass

- [x] **Step 6: Commit**

Suggested: `feat(plinko): board renderer + RTP sim — all risks verified ≤ 99.5%`

---

### Task 2: Plinko Game Handler (prefix + slash)

**Files:**
- Modify: `commands/game.js` — add plinko handler + slash subcommand registration + button routing

**Consumes:** `simulatePlinkoDrop(risk)`, `renderPlinkoBoard(...)`, `PLINKO_MULTIPLIERS` from Task 1

**Produces:**
- `case 'plinko':` in prefix handler
- `case 'plinko':` in slash handler
- `handlePlinkoButton(interaction)` for risk selection + Drop Again buttons

- [x] **Step 1: Add plinko slash subcommand registration**

In `commands/game.js`, inside `attachGameSubcommands(commandBuilder)`, add:

```js
commandBuilder.addSubcommand((sub) =>
  sub
    .setName('plinko')
    .setDescription('Drop a ball through the Plinko board')
    .addIntegerOption((opt) =>
      opt.setName('bet').setDescription('Total bet amount').setRequired(true)
    )
    .addIntegerOption((opt) =>
      opt.setName('balls').setDescription('Number of balls (1-5)').setRequired(false)
    )
);
```

- [x] **Step 2: Add plinko to registries**

In `commands/game.js`:
- Add `'plinko'` to `VALID_PREFIX_COMMANDS` array (line ~4547)
- Add `'plinko'` to `requiresRegistration` array (line ~627)
- Add `'plinko'` to 5s cooldown list in `setCooldown` (line ~193)

- [x] **Step 3: Implement full plinko game flow**

Full implementation in `game.js`:
- **Prefix handler** (`case 'plinko':` in `handlePrefixCommand`):
  - Parse `bet` and optional `balls` (1-5, default 1)
  - Validate: `perBall = Math.floor(bet / balls)`, reject if `perBall < 100`
  - Deduct `perBall * balls` via `removeBalance`
  - Show risk selection embed with 3 buttons
  - 30s timeout → refund + disable buttons

- **Slash handler** (`case 'plinko':` in `execute`):
  - Same logic, reading `interaction.options.getInteger('bet')` and `interaction.options.getInteger('balls')`

- **Button handler** (in `handleButton`):
  - `plinko_risk_{low|medium|high}_{userId}_{betInfo}`: start the drop animation
  - Animation: 8 frames × 600ms, ball position traces the path (per ball for multi-ball)
  - Result embed: slot hit, multiplier, payout per ball, total profit/loss
  - XP: 20 base (win) / 5 base (loss) × tier multiplier, per ball
  - Result buttons: `[Again] [×1] [×3] [×5] [Stop]`
  - 60s idle timeout → disable buttons
  - `plinko_again_{userId}_{risk}_{bet}_{balls}`: re-drop same settings
  - `plinko_balls_{userId}_{risk}_{bet}_{newBalls}`: change ball count
  - `plinko_stop_{userId}`: end session

- [x] **Step 4: Add help + odds entries**

In `ky help` text: `ky plinko <bet> [balls] — Drop balls through a Plinko board (1-5 balls)`
In `ky odds` text: `Plinko: Low ~99% | Medium ~97.3% | High ~97.5% RTP`

- [x] **Step 5: Test manually — all risk levels + multi-ball + edge cases**

- `ky plinko 1000` → each risk → verify animation + payout
- `ky plinko 10000 5` → multi-ball split
- `ky plinko 100 5` → reject (perBall < 100)
- `ky plinko all` → 500k cap
- AFK 60s → session ends
- Drop Again → same flow repeats

- [x] **Step 6: Run existing test suite**

Run: `node test/abyss.test.js && node test/pvp.test.js && node test/crash.test.js`
Expected: All pass (zero regressions)

- [x] **Step 7: Deploy slash commands**

Run: `node deploy-commands.js`
Verify: 24/25 subcommands

- [x] **Step 8: Commit**

Suggested: `feat(plinko): full game — risk selection, animation, multi-ball, drop-again, XP`

---

## Phase 2: Multiplayer Poker (Tasks 3-8)

### Task 3: Poker Hand Evaluator

**Files:**
- Create: `utils/pokerHand.js`
- Create: `test/pokerHand.test.js`

**Produces:**
- `evaluateHand(cards)` → `{ rank, name, kickers, display }` — used by Tasks 5, 6
- `compareHands(handA, handB)` → `-1 | 0 | 1` — used by Task 5
- `bestFiveFromSeven(holeCards, communityCards)` → result of `evaluateHand` — used by Task 5
- `getHandDisplay(holeCards, communityCards)` → readable string like "Two Pair — Kings & Tens" — used by Task 6

Hand rankings (high to low): Royal Flush (9), Straight Flush (8), Four of a Kind (7), Full House (6), Flush (5), Straight (4), Three of a Kind (3), Two Pair (2), One Pair (1), High Card (0).

- [x] **Step 1: Write failing hand evaluator tests**

Create `test/pokerHand.test.js`:

```js
// Poker Hand Evaluator Tests
// Run: node test/pokerHand.test.js

const { evaluateHand, compareHands, bestFiveFromSeven } = require('../utils/pokerHand');

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('FAIL:', msg); } }
function card(rank, suit) { return { rank, suit }; }

// Royal Flush
const rf = evaluateHand([card('A','♠'), card('K','♠'), card('Q','♠'), card('J','♠'), card('10','♠')]);
assert(rf.rank === 9, 'Royal flush = rank 9');

// Straight Flush
const sf = evaluateHand([card('9','♥'), card('8','♥'), card('7','♥'), card('6','♥'), card('5','♥')]);
assert(sf.rank === 8, 'Straight flush = rank 8');

// Four of a Kind
const foak = evaluateHand([card('K','♠'), card('K','♥'), card('K','♦'), card('K','♣'), card('3','♠')]);
assert(foak.rank === 7, 'Four of a kind = rank 7');

// Full House
const fh = evaluateHand([card('K','♠'), card('K','♥'), card('K','♦'), card('7','♣'), card('7','♠')]);
assert(fh.rank === 6, 'Full house = rank 6');

// Flush
const fl = evaluateHand([card('A','♣'), card('J','♣'), card('8','♣'), card('4','♣'), card('2','♣')]);
assert(fl.rank === 5, 'Flush = rank 5');

// Straight
const st = evaluateHand([card('10','♠'), card('9','♥'), card('8','♦'), card('7','♣'), card('6','♠')]);
assert(st.rank === 4, 'Straight = rank 4');

// Wheel (A-2-3-4-5) — LOWEST straight
const wheel = evaluateHand([card('A','♠'), card('2','♥'), card('3','♦'), card('4','♣'), card('5','♠')]);
assert(wheel.rank === 4, 'Wheel is a straight');
const sixHigh = evaluateHand([card('6','♠'), card('5','♥'), card('4','♦'), card('3','♣'), card('2','♠')]);
assert(compareHands(wheel, sixHigh) < 0, 'Wheel ranks below 6-high straight');

// Three of a Kind
const toak = evaluateHand([card('Q','♠'), card('Q','♥'), card('Q','♦'), card('9','♣'), card('3','♠')]);
assert(toak.rank === 3, 'Three of a kind = rank 3');

// Two Pair
const tp = evaluateHand([card('J','♠'), card('J','♥'), card('5','♦'), card('5','♣'), card('A','♠')]);
assert(tp.rank === 2, 'Two pair = rank 2');

// One Pair
const op = evaluateHand([card('J','♠'), card('J','♥'), card('8','♦'), card('4','♣'), card('2','♠')]);
assert(op.rank === 1, 'One pair = rank 1');

// High Card
const hc = evaluateHand([card('A','♠'), card('K','♥'), card('9','♦'), card('5','♣'), card('2','♠')]);
assert(hc.rank === 0, 'High card = rank 0');

// Kicker Wars — same pair, different kicker
const pairK  = evaluateHand([card('K','♠'), card('K','♥'), card('A','♦'), card('9','♣'), card('3','♠')]);
const pairK2 = evaluateHand([card('K','♦'), card('K','♣'), card('A','♠'), card('8','♣'), card('3','♥')]);
assert(compareHands(pairK, pairK2) > 0, 'Same pair, higher kicker wins (9 > 8)');

// Suit ties — suits never break ties
const flushH = evaluateHand([card('A','♥'), card('K','♥'), card('Q','♥'), card('J','♥'), card('9','♥')]);
const flushS = evaluateHand([card('A','♠'), card('K','♠'), card('Q','♠'), card('J','♠'), card('9','♠')]);
assert(compareHands(flushH, flushS) === 0, 'Same-rank flushes tie');

// Best 5 from 7 — finds Royal Flush
const best = bestFiveFromSeven(
  [card('A','♠'), card('K','♠')],
  [card('Q','♠'), card('J','♠'), card('10','♠'), card('2','♥'), card('3','♦')]
);
assert(best.rank === 9, 'Best-5-from-7 finds Royal Flush');

// Board-plays split
const board = [card('A','♠'), card('K','♠'), card('Q','♠'), card('J','♠'), card('10','♠')];
const h1 = bestFiveFromSeven([card('2','♥'), card('3','♥')], board);
const h2 = bestFiveFromSeven([card('4','♦'), card('5','♦')], board);
assert(compareHands(h1, h2) === 0, 'Both play board = tie');

// Straight < Flush ordering
assert(compareHands(st, fl) < 0, 'Straight < Flush');

console.log(`\nPoker Hand Evaluator: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
```

- [x] **Step 2: Run test to verify it fails**

Run: `node test/pokerHand.test.js`
Expected: FAIL (module not found)

- [x] **Step 3: Implement `utils/pokerHand.js`**

~150 lines. Core approach:
- Map rank strings to numeric values: `{2:2, 3:3, ..., 10:10, J:11, Q:12, K:13, A:14}`
- `evaluateHand(5 cards)`: check from best to worst (royal flush → high card)
- `bestFiveFromSeven(hole, community)`: iterate all C(7,5)=21 combinations, return best
- `compareHands(a, b)`: compare rank first, then kickers element-by-element
- Wheel straight: A-2-3-4-5 has effective high=5 (lowest straight)
- **DO NOT use `card.value`** — that's Blackjack-specific (A=11)

- [x] **Step 4: Run tests**

Run: `node test/pokerHand.test.js`
Expected: All pass

- [x] **Step 5: Commit**

Suggested: `feat(poker): hand evaluator — rank/compare/best-5-from-7 with test vectors`

---

### Task 4: Escrow Helpers in economyManager

**Files:**
- Modify: `utils/economyManager.js` — add `poker_escrow` DDL + helper functions
- Create: `test/pokerEscrow.test.js`

**Produces:**
- `pokerJoinTransaction(gameId, userId, buyIn)` — atomic: removeBalance + insert escrow. **THROWS on insufficient balance** (wraps removeBalance's `{ success: false }` return with manual throw)
- `pokerSettleTransaction(gameId, payouts)` — atomic: delete escrow + credit all
- `getActivePokerEscrows()` → array of `{ game_id, user_id, buy_in }`

> [!WARNING]
> **Critical gotcha:** `removeBalance` returns `{ success: false }` on insufficient balance — it does NOT throw. The join transaction MUST check the return value and throw manually for the `db.transaction()` rollback to work. Without this: player joins without paying.

- [x] **Step 1: Write failing escrow tests**

Create `test/pokerEscrow.test.js`:

```js
// Poker Escrow Tests
// Run: node test/pokerEscrow.test.js (env set at top — BOTH vars, see warning)

// ⚠️ economyManager REFUSES a lone KYRIZ_ECONOMY_DB (half-configuration guard
// throws at require). BOTH vars must be set BEFORE require.
process.env.KYRIZ_ECONOMY_DB = ':memory:';
process.env.KYRIZ_ECONOMY_JSON = '/tmp/poker-escrow-nonexist.json';
const eco = require('../utils/economyManager');

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('FAIL:', msg); } }

// Setup test players — MUST registerUser first: addBalance on an unregistered
// id returns { success: false } SILENTLY (economyManager:586) and every balance
// assertion below would fail.
eco.registerUser('p1', 'pokerOne');
eco.registerUser('p2', 'pokerTwo');
eco.registerUser('p3', 'pokerThree');
eco.addBalance('p1', 500000);
eco.addBalance('p2', 500000);

// Test 1: Join deducts + creates escrow
eco.pokerJoinTransaction('g1', 'p1', 100000);
assert(eco.getBalance('p1') === 400000, 'Balance deducted after join');
assert(eco.getActivePokerEscrows().length === 1, 'Escrow created');

// Test 2: Second player joins
eco.pokerJoinTransaction('g1', 'p2', 100000);
assert(eco.getActivePokerEscrows().length === 2, '2 escrow records');

// Test 3: Settlement
eco.pokerSettleTransaction('g1', [['p1', 150000], ['p2', 50000]]);
assert(eco.getBalance('p1') === 550000, 'Winner credited');
assert(eco.getBalance('p2') === 450000, 'Loser credited');
assert(eco.getActivePokerEscrows().length === 0, 'Escrow cleared');

// Test 4: Insufficient balance → rollback
eco.addBalance('p3', 1000);
try {
  eco.pokerJoinTransaction('g2', 'p3', 100000);
  assert(false, 'Should have thrown');
} catch (e) {
  assert(e.message.includes('nsufficient') || e.message.includes('balance'), 'Throws on insufficient');
}
assert(eco.getActivePokerEscrows().filter(r => r.game_id === 'g2').length === 0, 'No escrow on rollback');
assert(eco.getBalance('p3') === 1000, 'Balance unchanged');

// Test 5: Idempotent recovery
eco.pokerJoinTransaction('g3', 'p1', 50000);
eco.pokerSettleTransaction('g3', [['p1', 50000]]);
assert(eco.getActivePokerEscrows().filter(r => r.game_id === 'g3').length === 0, 'Settled = not recoverable');

// Test 6: Active escrow visible for recovery
eco.pokerJoinTransaction('g4', 'p1', 100000);
eco.pokerJoinTransaction('g4', 'p2', 100000);
assert(eco.getActivePokerEscrows().filter(r => r.game_id === 'g4').length === 2, 'Active game recoverable');
// Cleanup
eco.pokerSettleTransaction('g4', [['p1', 100000], ['p2', 100000]]);

console.log(`\nPoker Escrow: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
```

- [x] **Step 2: Run test to verify it fails**

Run: `KYRIZ_ECONOMY_DB=:memory: KYRIZ_ECONOMY_JSON=/tmp/poker-t-nonexist.json node test/pokerEscrow.test.js`
Expected: FAIL (functions not found)

- [x] **Step 3: Implement escrow in `economyManager.js`**

1. Append to `SCHEMA_SQL`:
```sql
CREATE TABLE IF NOT EXISTS poker_escrow (
  game_id   TEXT NOT NULL,
  user_id   TEXT NOT NULL,
  buy_in    INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (game_id, user_id)
);
```

2. Add prepared statements after existing `S = { ... }`:
```js
S.insertEscrow = db.prepare('INSERT INTO poker_escrow (game_id, user_id, buy_in) VALUES (?, ?, ?)');
S.deleteEscrow = db.prepare('DELETE FROM poker_escrow WHERE game_id = ?');
S.selectEscrows = db.prepare('SELECT game_id, user_id, buy_in FROM poker_escrow');
```

3. Add functions:
```js
function pokerJoinTransaction(gameId, userId, buyIn) {
  const tx = db.transaction(() => {
    const result = removeBalance(userId, buyIn);
    if (!result.success) throw new Error(result.message || 'Insufficient balance.');
    S.insertEscrow.run(gameId, userId, buyIn);
  });
  tx();
}

function pokerSettleTransaction(gameId, payouts) {
  const tx = db.transaction(() => {
    S.deleteEscrow.run(gameId);
    for (const [userId, amount] of payouts) {
      if (amount > 0) {
        // addBalance returns { success: false } SILENTLY on an unregistered id
        // (economyManager:586). In a money-critical settle, verify-or-throw:
        // rollback keeps escrow alive → boot recovery retries later. Superadmin
        // is unaffected (early-return success). (v0.4 cross-review addition)
        const r = addBalance(userId, amount);
        if (!r.success) throw new Error(`poker settle: credit failed for ${userId}`);
      }
    }
  });
  tx();
}

function getActivePokerEscrows() {
  return S.selectEscrows.all();
}
```

4. Add to `module.exports`.

- [x] **Step 4: Run escrow tests**

Run: `KYRIZ_ECONOMY_DB=:memory: KYRIZ_ECONOMY_JSON=/tmp/poker-t-nonexist.json node test/pokerEscrow.test.js`
Expected: All pass

- [x] **Step 5: Run existing tests for regressions**

Run: `KYRIZ_ECONOMY_DB=:memory: KYRIZ_ECONOMY_JSON=/tmp/poker-t-nonexist.json node test/abyss.test.js`
Expected: All 630 assertions pass

- [x] **Step 6: Commit**

Suggested: `feat(poker): escrow helpers — atomic join/settle/recovery in economyManager`

---

### Task 5: Poker Engine (Game State, Turns, Side Pots)

**Files:**
- Create: `utils/pokerEngine.js`
- Create: `test/pokerEngine.test.js`

**Consumes:**
- `bestFiveFromSeven`, `compareHands` from `utils/pokerHand.js` (Task 3)
- `createDeck` from `utils/cardDeck.js`

**Produces:**
- `createPokerGame(gameId, hostId, buyIn)` → game object
- `addPlayer(game, userId, chips)` — push player
- `startGame(game)` — shuffle, deal, assign blinds, set phase
- `playerAction(game, userId, action, amount?)` → `{ ok, error, events, phaseChanged, gameOver }`
- `autoAction(game)` → check if no bet owed, else fold
- `forceEndGame(game)` → payouts by exact contribution **for ALL players, folded included** (spec §2.5 v0.4: folded money has no other recipient — refund-only-non-folded breaks the zero-sum assertion or destroys Kryztal)
- `getPayouts(game)` → `[[userId, amount], ...]` for settlement

This is the core poker logic — **NO Discord dependencies**. Pure state machine.

- [x] **Step 1: Write engine tests**

Create `test/pokerEngine.test.js` covering:
- Game creation + player add + startGame
- Blind deduction
- BB option: everyone limps → BB can still act
- `hasActed` resets on raise
- All-in + auto-runout flag
- Side pot calculation (contribution layering)
- Uncalled bet auto-return
- Force-end = exact contribution refund **ALL players incl. folded** (v0.4)
- Zero-sum: Σ payouts === Σ buy-ins (100 random games)
- AFK: auto-check when no bet, auto-fold when bet exists

~250 lines.

- [x] **Step 2: Run test to verify it fails**

Run: `node test/pokerEngine.test.js`
Expected: FAIL

- [x] **Step 3: Implement `utils/pokerEngine.js`**

~450 lines. Key structure:

```js
const { bestFiveFromSeven, compareHands } = require('./pokerHand');
const { createDeck, drawCard } = require('./cardDeck');

function createPokerGame(gameId, hostId, buyIn) {
  return {
    gameId, hostId, buyIn,
    players: [],              // [{ id, chips, holeCards, folded, allIn, contributed, currentBet }]
    deck: null,
    community: [],
    pot: 0,
    currentBet: 0,
    lastRaiseSize: 0,
    currentTurnIndex: -1,
    phase: 'lobby',           // lobby|preflop|flop|turn|river|showdown|settled
    dealerIndex: -1,
    hasActed: new Set(),      // resets on each new street + each raise (BB option fix)
    round: 0,                 // street counter
  };
}

function addPlayer(game, userId, chips) {
  game.players.push({
    id: userId, chips, holeCards: [], folded: false, allIn: false,
    contributed: 0, currentBet: 0,
  });
}

function startGame(game) {
  // Random dealer
  game.dealerIndex = Math.floor(Math.random() * game.players.length);
  game.deck = createDeck();
  // Deal 2 hole cards each
  for (const p of game.players) {
    const c1 = drawCard(game.deck);
    game.deck = c1.deck;
    const c2 = drawCard(game.deck);
    game.deck = c2.deck;
    p.holeCards = [c1.card, c2.card];
  }
  // Deduct blinds
  const sbIndex = (game.dealerIndex + 1) % game.players.length;
  const bbIndex = (game.dealerIndex + 2) % game.players.length;
  const sb = Math.max(100, Math.round(game.buyIn * 0.025 / 100) * 100);
  const bb = sb * 2;
  // ... deduct from chips, add to pot, set contributed ...
  game.phase = 'preflop';
  // First actor = after BB
  game.currentTurnIndex = (bbIndex + 1) % game.players.length;
  // Skip folded/all-in
  advanceToActivePlayer(game);
}

function playerAction(game, userId, action, amount) {
  // Validate turn
  const player = game.players[game.currentTurnIndex];
  if (!player || player.id !== userId) return { ok: false, error: "It's not your turn." };
  // ... process action: check, call, raise, allin, fold ...
  // On raise: hasActed.clear() then hasActed.add(userId) — BB option fix
  // Check round end: all non-folded non-allin have acted AND matched
  // Advance phase if needed
}

function autoAction(game) {
  const player = game.players[game.currentTurnIndex];
  if (player.currentBet >= game.currentBet) {
    return playerAction(game, player.id, 'check');
  } else {
    return playerAction(game, player.id, 'fold');
  }
}
// ... etc
```

- [x] **Step 4: Run tests**

Run: `node test/pokerEngine.test.js`
Expected: All pass

- [x] **Step 5: Commit**

Suggested: `feat(poker): engine — turns, BB option, contribution-layering, zero-sum`

---

### Task 6: Poker Command Handler + Buttons + Modal

**Files:**
- Modify: `commands/game.js` — add poker prefix handler + button handler + modal handler

**Consumes:**
- `utils/pokerEngine.js` (Task 5)
- `pokerJoinTransaction`, `pokerSettleTransaction` from `economyManager.js` (Task 4)
- `formatCard` from `utils/cardDeck.js`

**Produces:**
- `case 'poker':` in prefix handler
- `handlePokerButton(interaction)` — all button interactions
- `handlePokerModal(interaction)` — raise modal submit
- `activePokerGames` Map

- [x] **Step 1: Add poker to registries**

- Add `'poker'` to `VALID_PREFIX_COMMANDS`
- Add `'poker'` to `requiresRegistration`
- Add to `ky help` and `ky odds` text

- [x] **Step 2: Implement prefix command handler**

```js
case 'poker': {
  const rawBet = args[0];
  if (!rawBet) return message.reply('Usage: `ky poker <buy-in>` — Start a poker table');
  // Explicit reject >500k BEFORE parseBet
  const rawNum = parseInt(rawBet);
  if (!isNaN(rawNum) && rawNum > MAX_BET) {
    return message.reply('❌ Maximum buy-in is 💎 500,000.');
  }
  const buyIn = parseBet(rawBet, userId);
  if (buyIn === null || buyIn < 1000) return message.reply('❌ Minimum buy-in is 💎 1,000.');
  // Check not already in a game
  // Create game, host auto-joins with escrow
  // Send lobby embed + buttons
  // 30s lobby timer
  break;
}
```

- [x] **Step 3: Implement lobby buttons**

`poker_join_`, `poker_start_`, `poker_cancel_`:
- Join: validate (not already in a game, **table not full — reject 6th+ with "Table is full (5 players)."**), `pokerJoinTransaction`, add to game, update embed
- Start: host-only, ≥2 players, call `startGame`, transition embed
- Cancel: host-only, settle with buy-in refund

- [x] **Step 4: Implement game phase buttons**

`poker_check_`, `poker_call_`, `poker_allin_`, `poker_fold_`, `poker_viewhand_`, `poker_raise_`:
- All buttons: generic `customId` with only `gameId` — turn validated from game state
- ViewHand: ephemeral with `bestFiveFromSeven` evaluation
- Raise: show modal (`ModalBuilder` + `TextInputBuilder`)
- After action: clear AFK timer synchronously, process via `playerAction`, update embed
- Processing lock: `poker_${gameId}`

- [x] **Step 5: Implement modal handler**

```js
async function handlePokerModal(interaction) {
  if (!interaction.customId.startsWith('poker_raise_modal_')) return;
  const gameId = interaction.customId.replace('poker_raise_modal_', '');
  const game = activePokerGames.get(gameId);
  if (!game) return interaction.reply({ content: 'Game not found.', ephemeral: true });
  // Validate turn, parse amount, validate min-raise (raise-TO semantics)
  // Process raise via playerAction
  // Update embed
}
```

- [x] **Step 6: Implement animation for community cards**

Flop: 3 frames × 600ms, Turn: 1 × 800ms, River: 1 × 800ms. All-in runout: deal remaining with animation.

- [x] **Step 7: Implement showdown + settlement**

Render result embed (spec §2.10 templates), call `pokerSettleTransaction`, **clear BOTH timers (`clearTimeout(game.afkTimer); clearTimeout(game.gameTimer)`) BEFORE `activePokerGames.delete`** — a leaked gameTimer firing after settle would force-end a dead game object.

- [x] **Step 8: Implement AFK timer + game timeout**

- 30s per turn → `autoAction` (check or fold)
- 15 min total → `forceEndGame` (exact-contribution refund)
- Timer cleared synchronously before any await
- Discord live countdown: `<t:${Math.floor(Date.now()/1000)+30}:R>`

- [x] **Step 9: Commit**

Suggested: `feat(poker): command handler — lobby, buttons, modal, animation, settlement`

---

### Task 7: Modal Routing in `index.js` + Boot Recovery

**Files:**
- Modify: `index.js` — add `isModalSubmit` branch + poker escrow boot recovery

**Consumes:**
- `handlePokerModal` from `commands/game.js` (Task 6)
- `getActivePokerEscrows`, `pokerSettleTransaction` from `economyManager.js` (Task 4)

- [x] **Step 1: Add modal routing in `index.js`**

After the `isStringSelectMenu` block (line ~191), before `if (!interaction.isChatInputCommand())`:

```js
// Handle modal submissions (poker raise)
if (interaction.isModalSubmit()) {
  try {
    await gameCommand.handlePokerModal(interaction);
  } catch (error) {
    console.error('Error handling modal:', error);
    const content = error && (error.code === 'ENOSPC' || error.code === 'SQLITE_FULL')
      ? '⚠️ Storage is momentarily unavailable — please try again in a few seconds.'
      : 'An error occurred. Please try again.';
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content, ephemeral: true });
      }
    } catch { /* stale */ }
  }
  return;
}
```

- [x] **Step 2: Add boot recovery in `client.once('ready')`**

After the backup section:

```js
// Poker escrow recovery
try {
  const escrows = economyManager.getActivePokerEscrows();
  if (escrows.length > 0) {
    const grouped = {};
    for (const row of escrows) {
      if (!grouped[row.game_id]) grouped[row.game_id] = [];
      grouped[row.game_id].push(row);
    }
    let games = 0, players = 0;
    for (const [gid, rows] of Object.entries(grouped)) {
      economyManager.pokerSettleTransaction(gid, rows.map(r => [r.user_id, r.buy_in]));
      games++; players += rows.length;
    }
    if (games > 0) console.log(`║   [POKER] Recovered ${games} game(s), refunded ${players} player(s) ║`);
  }
} catch (e) { console.error('[POKER] Recovery failed:', e.message); }
```

- [x] **Step 3: Export `handlePokerModal` from game.js**

- [x] **Step 4: Verify modal + recovery manually**

- Raise modal works end-to-end
- Kill bot mid-game → restart → players refunded

- [x] **Step 5: Commit**

Suggested: `feat(poker): modal routing + boot recovery`

---

### Task 8: Integration Tests + Final Verification

**Files:**
- Create: `test/poker.test.js` — comprehensive integration test

- [x] **Step 1: Write integration test**

Covers spec §4.3 battery:
- Hand evaluator re-verification
- Side pots: uncalled-bet, dead money, stacked all-ins
- BB option regression
- Escrow idempotency
- Zero-sum property (100 random games)
- Timeout: exact-contribution refund
- AFK: auto-check vs auto-fold
- Stuck-game theorem

- [x] **Step 2: Run full test suite**

```bash
KYRIZ_ECONOMY_DB=:memory: KYRIZ_ECONOMY_JSON=/tmp/poker-t-nonexist.json node test/pokerHand.test.js && \
KYRIZ_ECONOMY_DB=:memory: KYRIZ_ECONOMY_JSON=/tmp/poker-t-nonexist.json node test/pokerEscrow.test.js && \
KYRIZ_ECONOMY_DB=:memory: KYRIZ_ECONOMY_JSON=/tmp/poker-t-nonexist.json node test/pokerEngine.test.js && \
KYRIZ_ECONOMY_DB=:memory: KYRIZ_ECONOMY_JSON=/tmp/poker-t-nonexist.json node test/poker.test.js && \
KYRIZ_ECONOMY_DB=:memory: KYRIZ_ECONOMY_JSON=/tmp/poker-t-nonexist.json node test/abyss.test.js && \
node test/plinko_sim.js
```

Expected: All pass, zero regressions.

- [x] **Step 3: Manual test checklist**

- [x] 2-player full flow: lobby → deal → bet → showdown → settlement — automated (test/poker_flow.test.js hand 1, 20 asserts)
- [x] 5-player with side pots — automated (test/poker_sidepot.test.js): NOTE side pots are structurally impossible with equal buy-ins (proven, 300 games) — what is verified is the single-layer zero-sum + the engine's multi-layer math (pokerEngine #4-6)
- [x] All-in pre-flop: full runout — automated (poker_sidepot Part C handler-level + Part A/B engine)
- [x] Everyone folds: winner takes pot, no reveal — automated (poker_flow hand 3, 5p fold-win)
- [x] AFK: auto-fold after 30s / auto-check when possible — engine-verified (pokerEngine #9 autoAction); live Discord behavior still worth one manual glance
- [x] View Hand: ephemeral, correct evaluation — automated (casino.flow)
- [x] Raise modal: min-raise validation — automated (pokerEngine #10, poker_flow hand 2, poker_sidepot C); short-stack label clamp fixed after owner report
- [x] Insufficient balance join: rejected — automated (pokerEscrow suite rollback case + plinko_money pattern)
- [x] Already in game: rejected — code-verified (join guard `_userInPokerGame`) + 6th-player cap automated (poker_flow hand 3)
- Manual checklist remaining (owner, live Discord): raise modal on mobile, AFK 30s auto-check visually, 3+ humans in one hand
- [ ] Host cancel: all refunded
- [ ] Non-host Start/Cancel: rejected
- [ ] Non-player buttons: rejected
- [ ] Superadmin plays: no crashes

- [x] **Step 4: Commit**

Suggested: `feat(poker): integration tests — all edge cases verified`

---

## Post-Implementation Checklist

- [ ] `node deploy-commands.js` — verify 24/25 subcommands
- [ ] Run `node -c commands/game.js && node -c utils/pokerHand.js && node -c utils/pokerEngine.js && node -c utils/economyManager.js && node -c index.js` — syntax check all modified files
- [ ] Suggest user commit with: `feat(casino): plinko + multiplayer poker — complete implementation`
- [ ] Suggest user deploy to Raznar and test with real players
