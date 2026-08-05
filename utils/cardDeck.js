// ============================================================
// Card Deck Utilities for Blackjack
// ============================================================

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

/**
 * Create a full 52-card deck
 * @returns {Array<{ rank: string, suit: string, value: number }>}
 */
function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      let value;
      if (rank === 'A') {
        value = 11; // Will be adjusted in calculateHand
      } else if (['J', 'Q', 'K'].includes(rank)) {
        value = 10;
      } else {
        value = parseInt(rank);
      }
      deck.push({ rank, suit, value });
    }
  }
  return shuffleDeck(deck);
}

/**
 * Shuffle deck using Fisher-Yates algorithm
 */
function shuffleDeck(deck) {
  const shuffled = [...deck];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

/**
 * Draw a card from the deck
 * @returns {{ card: object, deck: Array }}
 */
function drawCard(deck) {
  const card = deck.pop();
  return { card, deck };
}

/**
 * Calculate the best value of a hand (handles Ace as 1 or 11)
 * @returns {number}
 */
function calculateHand(hand) {
  let total = 0;
  let aces = 0;

  for (const card of hand) {
    total += card.value;
    if (card.rank === 'A') aces += 1;
  }

  // Convert Aces from 11 to 1 if busting
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }

  return total;
}

/**
 * Format a single card for display
 * @param {object} card - { rank, suit }
 * @param {boolean} hidden - Show as [??]
 * @returns {string}
 */
function formatCard(card, hidden = false) {
  if (hidden) return '[??]';
  return `[${card.rank}${card.suit}]`;
}

/**
 * Format an entire hand for display
 * @param {Array} hand - Array of card objects
 * @param {boolean} hideFirst - Hide the first card (for dealer)
 * @returns {string}
 */
function formatHand(hand, hideFirst = false) {
  return hand
    .map((card, index) => {
      if (hideFirst && index === 0) return formatCard(card, true);
      return formatCard(card, false);
    })
    .join(' ');
}

/**
 * Check if a hand is a natural blackjack (21 with exactly 2 cards)
 */
function isBlackjack(hand) {
  return hand.length === 2 && calculateHand(hand) === 21;
}

module.exports = {
  createDeck,
  drawCard,
  calculateHand,
  formatCard,
  formatHand,
  isBlackjack,
};
