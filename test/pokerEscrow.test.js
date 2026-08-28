// Poker Escrow Tests — Run: node test/pokerEscrow.test.js
// ⚠️ BOTH env vars required (half-config guard throws at require).
process.env.KYRIZ_ECONOMY_DB = ':memory:';
process.env.KYRIZ_ECONOMY_JSON = '/tmp/poker-escrow-nonexist.json';
const eco = require('../utils/economyManager');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.error('FAIL:', msg); } }

// registerUser FIRST — addBalance on unregistered id silently {success:false}
eco.registerUser('p1', 'pokerOne');
eco.registerUser('p2', 'pokerTwo');
eco.registerUser('p3', 'pokerThree');
eco.addBalance('p1', 500000);
eco.addBalance('p2', 500000);
eco.addBalance('p3', 1000);

// 1: join deducts + creates escrow
eco.pokerJoinTransaction('g1', 'p1', 100000);
ok(eco.getBalance('p1') === 500000, 'Balance deducted after join (600k start − 100k)');
ok(eco.getActivePokerEscrows().length === 1, 'Escrow created');

// 2: second player joins
eco.pokerJoinTransaction('g1', 'p2', 100000);
ok(eco.getActivePokerEscrows().length === 2, '2 escrow records');

// 3: settlement (atomic delete + credits)
eco.pokerSettleTransaction('g1', [['p1', 150000], ['p2', 50000]]);
ok(eco.getBalance('p1') === 650000, 'Winner credited');
ok(eco.getBalance('p2') === 550000, 'Loser credited');
ok(eco.getActivePokerEscrows().length === 0, 'Escrow cleared');

// 4: insufficient → rollback, NO escrow, balance unchanged
// (p3 = 101,000 after starting balance + 1k — buy-in 500,000 is beyond it)
try {
  eco.pokerJoinTransaction('g2', 'p3', 500000);
  ok(false, 'Should have thrown');
} catch (e) {
  ok(/balance/i.test(e.message), 'Throws on insufficient: ' + e.message);
}
ok(eco.getActivePokerEscrows().filter((r) => r.game_id === 'g2').length === 0, 'No escrow on rollback');
ok(eco.getBalance('p3') === 101000, 'Balance unchanged after rollback');

// 5: double-join same game+user → PK conflict → rollback (anti double-escrow)
try {
  eco.pokerJoinTransaction('g5', 'p1', 50000);
  eco.pokerJoinTransaction('g5', 'p1', 50000); // PK (g5,p1) conflict
  ok(false, 'Double join should throw');
} catch (e) {
  ok(true, 'Double join rejected');
}
ok(eco.getActivePokerEscrows().filter((r) => r.game_id === 'g5').length === 1, 'Exactly 1 escrow row (not 2)');
ok(eco.getBalance('p1') === 600000, 'Only one deduction');

// 6: settle verify-or-throw — credit to unregistered id rolls back
try {
  eco.pokerJoinTransaction('g6', 'p1', 20000);
  eco.pokerSettleTransaction('g6', [['p1', 15000], ['ghost-user', 5000]]);
  ok(false, 'Settle to ghost should throw');
} catch (e) {
  ok(/credit failed/.test(e.message), 'Verify-or-throw fired');
}
ok(eco.getActivePokerEscrows().filter((r) => r.game_id === 'g6').length === 1, 'Escrow SURVIVES failed settle (recoverable)');
ok(eco.getBalance('p1') === 580000, 'No partial credit (rolled back)');
// recovery path: refund-all works
eco.pokerSettleTransaction('g6', [['p1', 20000]]);
ok(eco.getBalance('p1') === 600000, 'Recovery refund after failed settle');

// 7: idempotent recovery — settled game has no escrow rows
ok(eco.getActivePokerEscrows().filter((r) => r.game_id === 'g1').length === 0, 'Settled = not recoverable');

console.log(`\nPoker Escrow: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
