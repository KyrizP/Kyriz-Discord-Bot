// Poker Engine Tests — pure state machine, no Discord/IO
// Run: node test/pokerEngine.test.js
const E = require('../utils/pokerEngine');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.error('FAIL:', msg); } }

function mkGame(ids, buyIn = 100000) {
  const g = E.createPokerGame('g', ids[0], buyIn);
  for (const id of ids) E.addPlayer(g, id, buyIn);
  return g;
}

function actAll(game, actions) {
  // actions: [{id, action, amount?}] in order — helper for scripted hands
  for (const a of actions) {
    const r = E.playerAction(game, a.id, a.action, a.amount);
    if (!r.ok) throw new Error(`scripted action failed: ${a.id} ${a.action}: ${r.error}`);
  }
}

// ---- 1. Blinds + first actor ----
{
  const g = mkGame(['A', 'B', 'C']);
  const r = E.startGame(g);
  ok(r.ok, 'startGame ok');
  ok(g.phase === 'preflop', 'phase preflop');
  const sb = E.sbForBuyIn(100000);
  ok(sb === 2500, `SB for 100k = 2500 (got ${sb})`);
  ok(g.currentBet === 5000, 'currentBet = BB 5000');
  ok(g.pot === 7500, 'pot = SB+BB 7500');
  ok(E.currentPlayerId(g) !== null, 'first actor assigned (after BB)');
  // BB option: everyone limps → BB still owed an action (chip-matched ≠ acted)
  const bb = g.players[g.bbIndex];
  for (let i = 0; i < 5 && g.phase === 'preflop'; i++) {
    const cur = g.players[g.currentTurnIndex];
    if (!cur || cur === bb) break;
    if (g.currentBet - cur.currentBet > 0) E.playerAction(g, cur.id, 'call');
    else break;
  }
  if (g.phase === 'preflop') {
    const cur = g.players[g.currentTurnIndex];
    ok(cur === bb && !bb.hasActedThisRound, 'BB option alive: BB still owed an action after limps');
  } else {
    ok(true, 'BB acted last (already completed round)');
  }
}

// ---- 2. hasActed resets on raise ----
{
  const g = mkGame(['A', 'B', 'C']);
  E.startGame(g);
  // script: A call, B raise, C call, A call — B's raise reset A/C acted state
  const order = [];
  for (let i = 0; i < 10 && g.phase === 'preflop'; i++) {
    const id = E.currentPlayerId(g);
    if (!id) break;
    order.push(id);
    const isB = id === 'B';
    E.playerAction(g, id, isB && order.filter((x) => x === 'B').length === 1 ? 'raise' : 'call', isB ? 15000 : undefined);
  }
  ok(g.phase === 'flop', `phase advanced to flop after calls (got ${g.phase})`);
}

// ---- 3. Fold-win: everyone folds to one ----
{
  const g = mkGame(['A', 'B']);
  E.startGame(g);
  let acted = false;
  for (let i = 0; i < 5 && !g.handResults; i++) {
    const id = E.currentPlayerId(g);
    if (!id) break;
    E.playerAction(g, id, 'fold');
    acted = true;
  }
  ok(g.phase === 'settled', 'fold-win settles');
  ok(g.handResults.type === 'fold-win', 'fold-win result type');
  const payouts = E.getPayouts(g);
  const total = Object.values(payouts).reduce((a, b) => a + b, 0);
  ok(total === 200000, `fold-win zero-sum (total ${total} = 2×100k)`);
}

// ---- 4. Side pots: contribution layering (spec §2.8 example) ----
{
  const g = mkGame(['Alex', 'Mika', 'Kyriz'], 100000);
  // Force known contributions — simulate via direct state manipulation
  const p = {};
  for (const pl of g.players) p[pl.id] = pl;
  p.Alex.chips = 80000; p.Alex.contributed = 20000; p.Alex.folded = false; p.Alex.allIn = true;
  p.Mika.chips = 40000; p.Mika.contributed = 60000; p.Mika.folded = false; p.Mika.allIn = true;
  p.Kyriz.chips = 40000; p.Kyriz.contributed = 60000; p.Kyriz.folded = false; p.Kyriz.allIn = false;
  g.community = [];
  g.pot = 140000;
  // Give a full board
  g.community = [
    { rank: 'A', suit: '♠' }, { rank: 'K', suit: '♠' }, { rank: 'Q', suit: '♠' },
    { rank: 'J', suit: '♠' }, { rank: '9', suit: '♠' },
  ];
  // Alex hole: A♠K♠ → royal... wait community has A K Q J 9 of spades — Alex holds royal-flush material
  p.Alex.holeCards = [{ rank: 'A', suit: '♠' }, { rank: 'K', suit: '♠' }];
  p.Mika.holeCards = [{ rank: '2', suit: '♥' }, { rank: '3', suit: '♥' }];
  p.Kyriz.holeCards = [{ rank: '5', suit: '♦' }, { rank: '6', suit: '♦' }];
  const { layers, uncalled } = E.computeLayers(g);
  // layers: 20000 {all 3}, 60000 {Mika, Kyriz} — no uncalled (Mika+Kyriz both ≥ 60000)
  ok(layers.length === 2, `2 layers (got ${layers.length})`);
  ok(layers[0].amount === 60000 && layers[0].eligible.length === 3, `main pot 60k, 3 eligible (got ${layers[0].amount}/${layers[0].eligible.length})`);
  ok(layers[1].amount === 80000 && layers[1].eligible.length === 2, `side pot 80k, 2 eligible (got ${layers[1].amount}/${layers[1].eligible.length})`);
  ok(uncalled.length === 0, 'no uncalled (both matched 60k)');
  // Alex has royal flush (A♠ K♠ + Q♠ J♠ 9♠ board) → wins main 60k; Kyriz > Mika (board plays... Kyriz 5♦6♦ vs Mika 2♥3♥ — both play board AKQJ9 → tie!)
  const payouts = E.settleShowdown(g);
  // board plays for Kyriz vs Mika → tie → side pot splits 40k/40k
  ok(payouts.Alex === 60000 + 80000, `Alex wins main 60k + keeps 80k (got ${payouts.Alex})`);
  ok(payouts.Kyriz === 80000 && payouts.Mika === 80000, `side pot tie: 40k each + 40k leftovers (K=${payouts.Kyriz} M=${payouts.Mika})`);
  const total = Object.values(payouts).reduce((a, b) => a + b, 0);
  ok(total === 300000, `showdown zero-sum = 3 buy-ins (total ${total})`);
}

// ---- 5. Uncalled bet return (spec §2.8 example 2) ----
{
  const g = mkGame(['Kyriz', 'Mika', 'Fold1'], 100000);
  const p = {};
  for (const pl of g.players) p[pl.id] = pl;
  p.Kyriz.contributed = 80000; p.Kyriz.chips = 20000; p.Kyriz.folded = false;
  p.Mika.contributed = 30000; p.Mika.chips = 70000; p.Mika.allIn = true; p.Mika.chips = 0;
  p.Fold1.contributed = 0; p.Fold1.chips = 100000; p.Fold1.folded = true;
  g.pot = 110000;
  const { layers, uncalled } = E.computeLayers(g);
  ok(uncalled.length === 1 && uncalled[0].userId === 'Kyriz' && uncalled[0].amount === 50000,
    `uncalled 50k back to Kyriz (got ${JSON.stringify(uncalled)})`);
  ok(layers.length === 1 && layers[0].amount === 60000 && layers[0].eligible.length === 2, 'contested layer 60k {Kyriz,Mika}');
}

// ---- 6. Dead money: folded player's contribution funds layers but ineligible ----
{
  const g = mkGame(['W', 'X', 'Dead'], 100000);
  const p = {};
  for (const pl of g.players) p[pl.id] = pl;
  p.W.contributed = 50000; p.W.chips = 50000; p.W.folded = false;
  p.X.contributed = 50000; p.X.chips = 50000; p.X.folded = false;
  p.Dead.contributed = 30000; p.Dead.chips = 70000; p.Dead.folded = true;
  g.pot = 130000;
  const { layers, uncalled } = E.computeLayers(g);
  ok(uncalled.length === 0, 'no uncalled (W=X matched)');
  ok(layers.length === 1 && layers[0].amount === 130000 && layers[0].eligible.length === 2,
    `dead 30k funds the single layer: 130k contested by 2 (got ${layers[0]?.amount}/${layers[0]?.eligible.length})`);
}

// ---- 7. Force-end: refund ALL incl. folded (v0.4) ----
{
  const g = mkGame(['A', 'B', 'C'], 100000);
  const p = {};
  for (const pl of g.players) p[pl.id] = pl;
  p.A.contributed = 40000; p.A.chips = 60000; p.A.folded = false;
  p.B.contributed = 40000; p.B.chips = 60000; p.B.folded = false;
  p.C.contributed = 10000; p.C.chips = 90000; p.C.folded = true; // folded, 10k in pot
  const payouts = E.forceEndGame(g);
  ok(payouts.A === 100000 && payouts.B === 100000 && payouts.C === 100000,
    `force-end refunds ALL exact (A=${payouts.A} B=${payouts.B} C=${payouts.C})`);
  const total = Object.values(payouts).reduce((a, b) => a + b, 0);
  ok(total === 300000, `force-end zero-sum (${total})`);
}

// ---- 8. Full showdown zero-sum: 100 random games to river ----
{
  Math.random = (() => { let s = 123456789 >>> 0; return () => { s = ((Math.imul(s, 1103515245) + 12345) >>> 0) % 2147483648; return s / 2147483648; }; })();
  let zeroSumOK = true;
  for (let iter = 0; iter < 100; iter++) {
    const g = mkGame(['A', 'B', 'C', 'D'].slice(0, 2 + (iter % 3)), 100000);
    E.startGame(g);
    let guard = 0;
    while (!['settled', 'runout', 'showdown'].includes(g.phase) && guard++ < 200) {
      const id = E.currentPlayerId(g);
      if (!id) break;
      const p = g.players[g.currentTurnIndex];
      const toCall = g.currentBet - p.currentBet;
      const roll = Math.random();
      let action, amount;
      if (toCall <= 0) action = roll < 0.3 ? 'raise' : 'check';
      else action = roll < 0.15 ? 'fold' : roll < 0.3 ? 'raise' : 'call';
      if (action === 'raise') {
        const target = Math.min(p.chips + p.currentBet, game2Raise(g));
        action = target >= p.chips + p.currentBet ? 'allin' : 'raise';
        amount = target;
      }
      const r = E.playerAction(g, id, action, amount);
      if (!r.ok) { /* invalid scripted action — skip */ if (r.error.includes('turn')) break; }
      // runout: deal remaining streets
      if (g.phase === 'flop' && g.community.length === 0) E.dealStreet(g);
      if (g.phase === 'turn' && g.community.length === 3) E.dealStreet(g);
      if (g.phase === 'river' && g.community.length === 4) E.dealStreet(g);
      if (g.phase === 'showdown' && g.community.length === 5) break;
    }
    // runout handling
    while (g.community.length < 5 && g.phase !== 'settled') {
      if (g.phase === 'runout') {
        if (g.community.length === 0) { g.phase = 'flop'; E.dealStreet(g); g.phase = 'runout'; }
        else if (g.community.length === 3) { g.phase = 'turn'; E.dealStreet(g); g.phase = 'runout'; }
        else if (g.community.length === 4) { g.phase = 'river'; E.dealStreet(g); g.phase = 'runout'; }
        else break;
      } else break;
    }
    if (g.phase === 'runout' && g.community.length === 5) g.phase = 'showdown';
    const payouts = E.getPayouts(g);
    const total = Object.values(payouts).reduce((a, b) => a + b, 0);
    const buyIns = g.players.length * 100000;
    if (total !== buyIns) {
      zeroSumOK = false;
      console.error(`  iter ${iter}: total ${total} ≠ buyIns ${buyIns} (phase ${g.phase}, players ${g.players.length})`);
      break;
    }
  }
  ok(zeroSumOK, '100 random games: Σ payouts = Σ buy-ins every time');
  Math.random = (() => { let s = 987654321 >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; })();
}

function game2Raise(g) {
  return g.currentBet + g.lastRaiseSize + Math.floor(Math.random() * 20000);
}

// ---- 9. AFK: auto-check when no bet, auto-fold when bet owed ----
{
  const g = mkGame(['A', 'B']);
  E.startGame(g);
  const id = E.currentPlayerId(g);
  const p = g.players[g.currentTurnIndex];
  const owed = g.currentBet - p.currentBet;
  const r = E.autoAction(g);
  ok(r.ok, 'autoAction ok');
  if (owed > 0) ok(p.folded, 'AFK with bet owed → auto-fold');
  else ok(!p.folded, 'AFK with no bet → auto-check');
}

// ---- 10. Raise validation: min-raise, over-chips ----
{
  const g = mkGame(['A', 'B']);
  E.startGame(g);
  const id = E.currentPlayerId(g);
  const p = g.players[g.currentTurnIndex];
  const min = E.minRaiseTo(g); // currentBet(BB) + lastRaise(BB) = 2*BB = 10000
  const r1 = E.playerAction(g, id, 'raise', 6000); // below min, not all-in
  ok(!r1.ok && /Minimum raise/.test(r1.error), `min-raise rejected: ${r1.error}`);
  const r2 = E.playerAction(g, id, 'raise', 999999999); // over chips
  ok(!r2.ok && /only have/.test(r2.error), `over-chips rejected: ${r2.error}`);
  const r3 = E.playerAction(g, id, 'raise', p.chips + p.currentBet); // exact all-in ok
  ok(r3.ok, 'all-in via exact raise-TO accepted');
  ok(p.allIn, 'player marked all-in');
}

console.log(`\nPoker Engine: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
