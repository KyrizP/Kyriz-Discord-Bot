'use strict';

// ============================================================
// pokerEngine — pure Texas Hold'em single-hand state machine.
// NO Discord, NO IO, NO timers (the UI layer owns timers and calls
// autoAction/forceEndGame when they fire). All money is in CHIPS
// (in-memory); wallets are only touched via escrow join/settle in
// economyManager. Spec: 2026-08-28-new-casino-games-design.md §2.
// ============================================================

const { bestFiveFromSeven, compareHands } = require('./pokerHand');
const { createDeck } = require('./cardDeck');

function createPokerGame(gameId, hostId, buyIn) {
  return {
    gameId, hostId, buyIn,
    players: [],              // [{ id, chips, holeCards, folded, allIn, contributed, currentBet, hasActedThisRound }]
    deck: [],
    community: [],
    pot: 0,                   // display total = sum(contributed) — kept in sync for UI
    currentBet: 0,
    lastRaiseSize: 0,
    currentTurnIndex: -1,
    phase: 'lobby',           // lobby|preflop|flop|turn|river|showdown|settled
    dealerIndex: -1,
    streetBetsSettled: false, // helper flag for street transitions
    handResults: null,        // filled at showdown for UI rendering
    showdownOrder: [],        // player ids in reveal order
  };
}

function addPlayer(game, userId, chips) {
  game.players.push({
    id: userId, chips, holeCards: [],
    folded: false, allIn: false,
    contributed: 0, currentBet: 0, hasActedThisRound: false,
  });
}

function sbForBuyIn(buyIn) {
  return Math.max(100, Math.round((buyIn * 0.025) / 100) * 100);
}

function _activePlayers(game) {
  return game.players.filter((p) => !p.folded);
}

function _canAct(p) {
  return !p.folded && !p.allIn;
}

function _nextActor(game, fromIndex) {
  const n = game.players.length;
  for (let step = 1; step <= n; step++) {
    const idx = (fromIndex + step) % n;
    if (_canAct(game.players[idx])) return idx;
  }
  return -1;
}

function startGame(game) {
  if (game.phase !== 'lobby') return { ok: false, error: 'Already started.' }; // double-start race guard
  if (game.players.length < 2) return { ok: false, error: 'Need at least 2 players.' };
  game.dealerIndex = Math.floor(Math.random() * game.players.length);
  game.deck = createDeck();
  // Shuffle (createDeck is ordered — Fisher-Yates here)
  for (let i = game.deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [game.deck[i], game.deck[j]] = [game.deck[j], game.deck[i]];
  }
  // Deal 2 hole cards each
  for (const p of game.players) {
    p.holeCards = [game.deck.pop(), game.deck.pop()];
  }
  // Blinds (heads-up: dealer = SB, other = BB — standard rule)
  const headsUp = game.players.length === 2;
  const sbIndex = headsUp ? game.dealerIndex : (game.dealerIndex + 1) % game.players.length;
  const bbIndex = headsUp ? (game.dealerIndex + 1) % game.players.length : (game.dealerIndex + 2) % game.players.length;
  const sb = sbForBuyIn(game.buyIn);
  const bb = sb * 2;
  game.sbIndex = sbIndex;
  game.bbIndex = bbIndex;
  game.bbAmount = bb;

  const postBlind = (idx, amount) => {
    const p = game.players[idx];
    const posted = Math.min(amount, p.chips); // short blind → all-in
    p.chips -= posted;
    p.contributed += posted;
    p.currentBet = posted;
    if (p.chips === 0) p.allIn = true;
  };
  postBlind(sbIndex, sb);
  postBlind(bbIndex, bb);

  game.currentBet = bb;
  game.lastRaiseSize = bb;
  game.pot = game.players.reduce((s, p) => s + p.contributed, 0);
  game.phase = 'preflop';

  // Pre-flop first actor: after BB (heads-up: dealer/SB acts first pre-flop)
  const firstIdx = headsUp ? sbIndex : (bbIndex + 1) % game.players.length;
  game.currentTurnIndex = _nextActor(game, (firstIdx - 1 + game.players.length) % game.players.length);
  if (game.currentTurnIndex === -1) return { ok: true, allInImmediate: true };
  return { ok: true };
}

// Round ends when every player who CAN act has acted since the last raise
// AND matched the current bet (BB option: chip-matched is not enough — the
// BB must still act pre-flop if everyone limped). Spec §2.3.
function _roundComplete(game) {
  const actors = game.players.filter(_canAct);
  if (actors.length === 0) return true;                       // everyone all-in
  if (actors.length === 1) {
    const last = actors[0];
    // One active player left AND they owe nothing → they win by others folding/all-in below them
    if (_activePlayers(game).length === 1) return true;
    return last.hasActedThisRound && last.currentBet >= game.currentBet;
  }
  return actors.every((p) => p.hasActedThisRound && p.currentBet >= game.currentBet);
}

function _advanceStreet(game) {
  for (const p of game.players) {
    p.currentBet = 0;
    p.hasActedThisRound = false;
  }
  game.currentBet = 0;
  game.lastRaiseSize = 0;
  const acts = game.players.filter(_canAct);
  if (acts.length <= 1) {
    // runout — all-in showdown
    game.phase = 'runout';
    return;
  }
  // Post-flop first actor: first active player after dealer
  game.currentTurnIndex = _nextActor(game, game.dealerIndex);
  game.phase = game.phase === 'preflop' ? 'flop' : game.phase === 'flop' ? 'turn' : game.phase === 'turn' ? 'river' : 'showdown';
}

function _draw(game) {
  return game.deck.pop();
}

// Deal community cards for the current phase (UI animates between calls)
function dealStreet(game) {
  if (game.phase === 'flop') {
    game.community.push(_draw(game), _draw(game), _draw(game));
  } else if (game.phase === 'turn' || game.phase === 'river') {
    game.community.push(_draw(game));
  }
}

function _checkFoldWin(game) {
  const alive = _activePlayers(game);
  if (alive.length === 1) {
    // Last standing takes the whole pot
    game.phase = 'settled';
    game.handResults = { type: 'fold-win', winnerId: alive[0].id, amount: game.pot };
    return true;
  }
  return false;
}

// Raise-TO semantics: `amount` = player's total bet for this street.
function playerAction(game, userId, action, amount) {
  if (['settled', 'showdown', 'runout'].includes(game.phase)) {
    return { ok: false, error: 'The hand is over.' };
  }
  const player = game.players[game.currentTurnIndex];
  if (!player || player.id !== userId) return { ok: false, error: "It's not your turn." };
  if (player.folded || player.allIn) return { ok: false, error: 'You cannot act.' };

  const toCall = game.currentBet - player.currentBet;

  if (action === 'fold') {
    player.folded = true;
    player.hasActedThisRound = true;
    if (_checkFoldWin(game)) return { ok: true, gameOver: true, events: [{ type: 'fold-win' }] };
    if (_roundComplete(game)) { _advanceStreet(game); return { ok: true, phaseChanged: true }; }
    game.currentTurnIndex = _nextActor(game, game.currentTurnIndex);
    return { ok: true, events: [{ type: 'fold', userId }] };
  }

  if (action === 'check') {
    if (toCall > 0) return { ok: false, error: 'There is a bet to call — check is not allowed.' };
    player.hasActedThisRound = true;
    if (_roundComplete(game)) { _advanceStreet(game); return { ok: true, phaseChanged: true }; }
    game.currentTurnIndex = _nextActor(game, game.currentTurnIndex);
    return { ok: true, events: [{ type: 'check', userId }] };
  }

  if (action === 'call') {
    if (toCall <= 0) return { ok: false, error: 'Nothing to call — check instead.' };
    const pay = Math.min(toCall, player.chips);
    player.chips -= pay;
    player.contributed += pay;
    player.currentBet += pay;
    if (player.chips === 0) player.allIn = true;
    player.hasActedThisRound = true;
    game.pot = game.players.reduce((s, p) => s + p.contributed, 0);
    if (_roundComplete(game)) { _advanceStreet(game); return { ok: true, phaseChanged: true }; }
    game.currentTurnIndex = _nextActor(game, game.currentTurnIndex);
    return { ok: true, events: [{ type: 'call', userId, amount: pay }] };
  }

  if (action === 'raise') {
    // amount = raise-TO total for this street
    if (amount == null || !Number.isFinite(amount) || amount <= 0) {
      return { ok: false, error: 'Please enter a valid number.' };
    }
    const minRaiseTo = game.currentBet + game.lastRaiseSize;
    const isAllIn = amount >= player.chips + player.currentBet;
    if (amount > player.chips + player.currentBet) {
      return { ok: false, error: `You only have 💎 ${player.chips.toLocaleString()} chips.` };
    }
    if (!isAllIn && amount < minRaiseTo) {
      return { ok: false, error: `Minimum raise is to 💎 ${minRaiseTo.toLocaleString()}.` };
    }
    const raiseSize = amount - player.currentBet;
    if (raiseSize <= 0) return { ok: false, error: 'Raise must exceed your current bet.' };
    player.chips -= raiseSize;
    player.contributed += raiseSize;
    if (amount > game.currentBet) {
      game.lastRaiseSize = amount - game.currentBet;
      game.currentBet = amount;
    }
    player.currentBet = amount;
    if (player.chips === 0) player.allIn = true;
    // Raise resets acted-state for everyone else (BB option rule)
    for (const p of game.players) if (p !== player) p.hasActedThisRound = false;
    player.hasActedThisRound = true;
    game.pot = game.players.reduce((s, p) => s + p.contributed, 0);
    // Round completion is _roundComplete's call — NOT "≤1 player can act".
    // The old heuristic advanced the street even when that one remaining
    // player (e.g. the BB facing an all-in) still owed a call, giving them a
    // free showdown for just their blind. _roundComplete already handles the
    // all-actors-gone (0) and single-actor-matched (1) cases correctly.
    if (_roundComplete(game)) { _advanceStreet(game); return { ok: true, phaseChanged: true }; }
    game.currentTurnIndex = _nextActor(game, game.currentTurnIndex);
    return { ok: true, events: [{ type: 'raise', userId, toAmount: amount, allIn: player.allIn }] };
  }

  if (action === 'allin') {
    const target = player.chips + player.currentBet;
    return playerAction(game, userId, 'raise', target);
  }

  return { ok: false, error: 'Unknown action.' };
}

// AFK: auto-check if no bet owed, else auto-fold (spec §2.5)
function autoAction(game) {
  const player = game.players[game.currentTurnIndex];
  if (!player) return { ok: false };
  if (game.currentBet - player.currentBet <= 0) {
    return playerAction(game, player.id, 'check');
  }
  return playerAction(game, player.id, 'fold');
}

// ---- Settlement: contribution-layering side pots (spec §2.8) ----

// Compute side-pot layers from contributed totals.
// Returns [{ amount, eligible: [userId...] }] plus uncalled-bet returns folded in.
function computeLayers(game) {
  const alive = _activePlayers(game);
  // If only one player remains (fold-win), whole pot to them.
  if (alive.length === 1) {
    return { layers: [], uncalled: [], winner: alive[0].id, total: game.pot };
  }
  const levels = [...new Set(alive.map((p) => p.contributed))].sort((a, b) => a - b);
  const layers = [];
  let prev = 0;
  for (const l of levels) {
    let amount = 0;
    for (const p of game.players) {
      amount += Math.max(0, Math.min(p.contributed, l) - Math.min(p.contributed, prev));
    }
    const eligible = alive.filter((p) => p.contributed >= l).map((p) => p.id);
    layers.push({ amount, eligible });
    prev = l;
  }
  // Uncalled top layer: exactly ONE eligible player → returned, not contested
  const uncalled = [];
  if (layers.length > 0 && layers[layers.length - 1].eligible.length === 1) {
    const top = layers.pop();
    uncalled.push({ userId: top.eligible[0], amount: top.amount });
  }
  return { layers, uncalled, winner: null, total: game.pot };
}

// Showdown: evaluate hands, award layers. Returns payout map + result info.
function settleShowdown(game) {
  const { layers, uncalled } = computeLayers(game);
  const payouts = {}; // userId -> total credit (winnings + uncalled + leftover chips)
  const results = [];
  // Everyone keeps their unbet chips (buyIn - contributed) — credit them
  for (const p of game.players) {
    if (p.chips > 0) payouts[p.id] = (payouts[p.id] || 0) + p.chips;
  }
  for (const u of uncalled) {
    payouts[u.userId] = (payouts[u.userId] || 0) + u.amount;
    results.push({ type: 'uncalled', userId: u.userId, amount: u.amount });
  }
  const hands = {};
  for (const p of _activePlayers(game)) {
    hands[p.id] = bestFiveFromSeven(p.holeCards, game.community);
  }
  for (const layer of layers) {
    if (layer.amount <= 0) continue;
    let best = null;
    let winners = [];
    for (const uid of layer.eligible) {
      const h = hands[uid];
      if (!best || compareHands(h, best) > 0) { best = h; winners = [uid]; }
      else if (compareHands(h, best) === 0) winners.push(uid);
    }
    const share = Math.floor(layer.amount / winners.length);
    let remainder = layer.amount - share * winners.length;
    // Odd chips to first winner in rotation order (dealer-relative)
    for (const uid of winners) {
      let amt = share;
      if (remainder > 0) { amt += 1; remainder -= 1; }
      payouts[uid] = (payouts[uid] || 0) + amt;
    }
    results.push({ type: 'layer', amount: layer.amount, winners, hand: best });
  }
  game.phase = 'settled';
  game.handResults = { type: 'showdown', results, hands };
  return payouts;
}

// Fold-win: last standing takes everything
function settleFoldWin(game) {
  const payouts = {};
  for (const p of game.players) {
    if (p.chips > 0) payouts[p.id] = (payouts[p.id] || 0) + p.chips;
  }
  const winner = _activePlayers(game)[0];
  payouts[winner.id] = (payouts[winner.id] || 0) + game.pot;
  game.phase = 'settled';
  game.handResults = { type: 'fold-win', winnerId: winner.id, amount: game.pot };
  return payouts;
}

// Force-end (15-min timeout): refund ALL players their exact contribution,
// folded included (spec §2.5 v0.4 — folded money has no other recipient).
function forceEndGame(game) {
  const payouts = {};
  for (const p of game.players) {
    // contributed goes back AND leftover chips stay — total = buyIn effectively
    payouts[p.id] = p.contributed + p.chips;
  }
  game.phase = 'settled';
  game.handResults = { type: 'force-end' };
  return payouts;
}

function getPayouts(game) {
  if (game.phase === 'settled') {
    // already computed? recompute is idempotent on state — but safer to have been called once.
  }
  if (_activePlayers(game).length === 1) return settleFoldWin(game);
  if (game.community.length === 5) return settleShowdown(game);
  // Runout not finished (force-end mid-street) → refund-all path
  return forceEndGame(game);
}

// UI helpers
function currentPlayerId(game) {
  const p = game.players[game.currentTurnIndex];
  return p ? p.id : null;
}

function minRaiseTo(game) {
  return game.currentBet + game.lastRaiseSize;
}

module.exports = {
  createPokerGame, addPlayer, startGame, playerAction, autoAction,
  computeLayers, settleShowdown, settleFoldWin, forceEndGame, getPayouts,
  dealStreet, currentPlayerId, minRaiseTo, sbForBuyIn,
};
