// Poker Hand Evaluator Tests — Run: node test/pokerHand.test.js
const { evaluateHand, compareHands, bestFiveFromSeven } = require('../utils/pokerHand');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.error('FAIL:', msg); } }
const card = (rank, suit) => ({ rank, suit });

// Rankings
ok(evaluateHand([card('A','♠'), card('K','♠'), card('Q','♠'), card('J','♠'), card('10','♠')]).rank === 9, 'Royal flush = 9');
ok(evaluateHand([card('9','♥'), card('8','♥'), card('7','♥'), card('6','♥'), card('5','♥')]).rank === 8, 'Straight flush = 8');
ok(evaluateHand([card('K','♠'), card('K','♥'), card('K','♦'), card('K','♣'), card('3','♠')]).rank === 7, 'Quads = 7');
ok(evaluateHand([card('K','♠'), card('K','♥'), card('K','♦'), card('7','♣'), card('7','♠')]).rank === 6, 'Full house = 6');
ok(evaluateHand([card('A','♣'), card('J','♣'), card('8','♣'), card('4','♣'), card('2','♣')]).rank === 5, 'Flush = 5');
const st = evaluateHand([card('10','♠'), card('9','♥'), card('8','♦'), card('7','♣'), card('6','♠')]);
ok(st.rank === 4, 'Straight = 4');
ok(evaluateHand([card('Q','♠'), card('Q','♥'), card('Q','♦'), card('9','♣'), card('3','♠')]).rank === 3, 'Trips = 3');
ok(evaluateHand([card('J','♠'), card('J','♥'), card('5','♦'), card('5','♣'), card('A','♠')]).rank === 2, 'Two pair = 2');
ok(evaluateHand([card('J','♠'), card('J','♥'), card('8','♦'), card('4','♣'), card('2','♠')]).rank === 1, 'Pair = 1');
ok(evaluateHand([card('A','♠'), card('K','♥'), card('9','♦'), card('5','♣'), card('2','♠')]).rank === 0, 'High card = 0');

// Wheel = LOWEST straight
const wheel = evaluateHand([card('A','♠'), card('2','♥'), card('3','♦'), card('4','♣'), card('5','♠')]);
ok(wheel.rank === 4, 'Wheel is a straight');
const sixHigh = evaluateHand([card('6','♠'), card('5','♥'), card('4','♦'), card('3','♣'), card('2','♠')]);
ok(compareHands(wheel, sixHigh) < 0, 'Wheel ranks below 6-high straight');

// Royal vs straight-flush: A-high SF is royal, ranks above K-high SF
const kSF = evaluateHand([card('K','♠'), card('Q','♠'), card('J','♠'), card('10','♠'), card('9','♠')]);
const aSF = evaluateHand([card('A','♠'), card('K','♠'), card('Q','♠'), card('J','♠'), card('10','♠')]);
ok(kSF.rank === 8 && aSF.rank === 9, 'A-high SF = royal(9), K-high SF = 8');
ok(compareHands(aSF, kSF) > 0, 'Royal > K-high SF');

// Kicker wars
const pairK  = evaluateHand([card('K','♠'), card('K','♥'), card('A','♦'), card('9','♣'), card('3','♠')]);
const pairK2 = evaluateHand([card('K','♦'), card('K','♣'), card('A','♠'), card('8','♣'), card('3','♥')]);
ok(compareHands(pairK, pairK2) > 0, 'Same pair, kicker 9 > 8');

// Suit ties never break ties
const flushH = evaluateHand([card('A','♥'), card('K','♥'), card('Q','♥'), card('J','♥'), card('9','♥')]);
const flushS = evaluateHand([card('A','♠'), card('K','♠'), card('Q','♠'), card('J','♠'), card('9','♠')]);
ok(compareHands(flushH, flushS) === 0, 'Same-rank flushes tie');

// Straight < Flush
const fl = evaluateHand([card('A','♣'), card('J','♣'), card('8','♣'), card('4','♣'), card('2','♣')]);
ok(compareHands(st, fl) < 0, 'Straight < Flush');

// Full house vs flush
const fh = evaluateHand([card('K','♠'), card('K','♥'), card('K','♦'), card('7','♣'), card('7','♠')]);
ok(compareHands(fl, fh) < 0, 'Flush < Full House');

// Best 5 from 7
ok(bestFiveFromSeven([card('A','♠'), card('K','♠')], [card('Q','♠'), card('J','♠'), card('10','♠'), card('2','♥'), card('3','♦')]).rank === 9, 'Finds Royal from 7');
const board = [card('A','♠'), card('K','♠'), card('Q','♠'), card('J','♠'), card('10','♠')];
const h1 = bestFiveFromSeven([card('2','♥'), card('3','♥')], board);
const h2 = bestFiveFromSeven([card('4','♦'), card('5','♦')], board);
ok(compareHands(h1, h2) === 0, 'Board plays = tie');

// 6-card straight detection must fail (uniq.length !== 5)
ok(evaluateHand([card('A','♠'), card('K','♥'), card('Q','♦'), card('J','♣'), card('9','♠')]).rank === 0, 'No straight with gap (A-K-Q-J-9)');

// 21-combination exhaustiveness: pair in hole + trips on board = full house
const fh7 = bestFiveFromSeven([card('8','♠'), card('8','♥')], [card('K','♦'), card('K','♣'), card('K','♠'), card('2','♥'), card('3','♦')]);
ok(fh7.rank === 6, 'Best-5 chooses FH (K trips + 8 pair) over trips');

console.log(`\nPoker Hand Evaluator: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
