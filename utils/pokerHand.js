'use strict';

// ============================================================
// pokerHand — pure Texas Hold'em hand evaluation. No IO, no Discord.
// Cards: { rank: '2'..'10','J','Q','K','A', suit: '♠','♥','♦','♣' }.
// NOTE: do NOT use cardDeck.js `.value` — that is Blackjack-specific (A=11).
// ============================================================

const RANK_VALUE = { 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, 10: 10, J: 11, Q: 12, K: 13, A: 14 };

// Evaluate exactly 5 cards → { rank: 0-9, name, tiebreak: number[] }
// rank: 9 royal, 8 straight flush, 7 quads, 6 full house, 5 flush, 4 straight,
//       3 trips, 2 two pair, 1 pair, 0 high card. tiebreak compares within rank.
function evaluateHand(cards) {
  const vals = cards.map((c) => RANK_VALUE[c.rank]).sort((a, b) => b - a);
  const suits = cards.map((c) => c.suit);
  const isFlush = suits.every((s) => s === suits[0]);

  // counts: value → occurrences
  const count = {};
  for (const v of vals) count[v] = (count[v] || 0) + 1;
  // groups sorted by (count desc, value desc): quads first, then trips, pairs, kickers
  const groups = Object.entries(count)
    .map(([v, n]) => ({ v: +v, n }))
    .sort((a, b) => (b.n - a.n) || (b.v - a.v));

  // Straight detection (incl. wheel A-2-3-4-5 → high = 5)
  const uniq = [...new Set(vals)].sort((a, b) => b - a);
  let straightHigh = 0;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
    else if (uniq[0] === 14 && uniq[1] === 5 && uniq[4] === 2) straightHigh = 5; // wheel
  }

  if (isFlush && straightHigh && straightHigh === 14) {
    return { rank: 9, name: 'Royal Flush', tiebreak: [14] };
  }
  if (isFlush && straightHigh) {
    return { rank: 8, name: 'Straight Flush', tiebreak: [straightHigh] };
  }
  if (groups[0].n === 4) {
    return { rank: 7, name: 'Four of a Kind', tiebreak: [groups[0].v, groups[1].v] };
  }
  if (groups[0].n === 3 && groups[1].n === 2) {
    return { rank: 6, name: 'Full House', tiebreak: [groups[0].v, groups[1].v] };
  }
  if (isFlush) {
    return { rank: 5, name: 'Flush', tiebreak: vals };
  }
  if (straightHigh) {
    return { rank: 4, name: 'Straight', tiebreak: [straightHigh] };
  }
  if (groups[0].n === 3) {
    return { rank: 3, name: 'Three of a Kind', tiebreak: [groups[0].v, groups[1].v, groups[2].v] };
  }
  if (groups[0].n === 2 && groups[1].n === 2) {
    return { rank: 2, name: 'Two Pair', tiebreak: [groups[0].v, groups[1].v, groups[2].v] };
  }
  if (groups[0].n === 2) {
    return { rank: 1, name: 'One Pair', tiebreak: [groups[0].v, groups[1].v, groups[2].v, groups[3].v] };
  }
  return { rank: 0, name: 'High Card', tiebreak: vals };
}

// -1 a<b, 0 tie, 1 a>b — suits NEVER break ties.
function compareHands(a, b) {
  if (a.rank !== b.rank) return a.rank > b.rank ? 1 : -1;
  const len = Math.max(a.tiebreak.length, b.tiebreak.length);
  for (let i = 0; i < len; i++) {
    const av = a.tiebreak[i] || 0;
    const bv = b.tiebreak[i] || 0;
    if (av !== bv) return av > bv ? 1 : -1;
  }
  return 0;
}

// Best 5 of 7 (2 hole + 5 community) — all C(7,5)=21 combos.
function bestFiveFromSeven(holeCards, communityCards) {
  const all = [...holeCards, ...communityCards];
  let best = null;
  const n = all.length;
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      for (let c = b + 1; c < n; c++) {
        for (let d = c + 1; d < n; d++) {
          for (let e = d + 1; e < n; e++) {
            const hand = evaluateHand([all[a], all[b], all[c], all[d], all[e]]);
            if (!best || compareHands(hand, best) > 0) best = hand;
          }
        }
      }
    }
  }
  return best;
}

const RANK_NAME = { 2: 'Twos', 3: 'Threes', 4: 'Fours', 5: 'Fives', 6: 'Sixes', 7: 'Sevens', 8: 'Eights', 9: 'Nines', 10: 'Tens', 11: 'Jacks', 12: 'Queens', 13: 'Kings', 14: 'Aces' };

// Human-readable: "Two Pair — Kings & Tens"
function getHandDisplay(holeCards, communityCards) {
  const best = bestFiveFromSeven(holeCards, communityCards);
  if (!best) return 'No hand';
  switch (best.rank) {
    case 9: return '👑 Royal Flush';
    case 8: return '🔥 Straight Flush';
    case 7: return `💎 Four of a Kind — ${RANK_NAME[best.tiebreak[0]]}`;
    case 6: return `🏠 Full House — ${RANK_NAME[best.tiebreak[0]]} over ${RANK_NAME[best.tiebreak[1]]}`;
    case 5: return '♣️ Flush';
    case 4: return `➡️ Straight — ${RANK_NAME[best.tiebreak[0]]} high`;
    case 3: return `🔺 Three of a Kind — ${RANK_NAME[best.tiebreak[0]]}`;
    case 2: return `✌️ Two Pair — ${RANK_NAME[best.tiebreak[0]]} & ${RANK_NAME[best.tiebreak[1]]}`;
    case 1: return `🂠 One Pair — ${RANK_NAME[best.tiebreak[0]]}`;
    default: return `🃏 High Card — ${RANK_NAME[best.tiebreak[0]]}`;
  }
}

module.exports = { evaluateHand, compareHands, bestFiveFromSeven, getHandDisplay, RANK_VALUE };
