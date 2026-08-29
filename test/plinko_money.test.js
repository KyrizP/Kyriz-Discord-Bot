'use strict';

// Plinko money audit — proves balance invariants on the REAL handlers:
//   1. A completed drop moves EXACTLY −bet + Return (Return parsed from the
//      result embed the bot itself rendered — no re-derived math). If the drop
//      leveled the player up, the only extra credit allowed is the documented
//      level-up reward (150k-500k random, XP system — not plinko's money).
//   2. ×3 replay deducts the floor-split total (9999 for 10k) and pays its own Return.
//   3. Insufficient balance at the risk click: NOTHING moves, player sees ❌.
//   4. Concurrent double-click on Again: exactly ONE deduction + ONE payout
//      (phase flips to 'risk' synchronously before the first await).
// Run: node test/plinko_money.test.js   (~10s — real 2.4s animations)
process.env.KYRIZ_ECONOMY_DB = ':memory:';
process.env.KYRIZ_ECONOMY_JSON = '/tmp/plinko-money-nonexist.json';
process.env.SUPERADMIN_ID = '900000000000000001';

const game = require('../commands/game.js');
const eco = require('../utils/economyManager');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL: ' + msg); } }

function fakeMsg(id) {
  return {
    id: id || 'panel-' + Math.random().toString(36).slice(2),
    edited: [],
    async edit(opts) { this.edited.push(opts); return this; },
  };
}
function fakeReply() {
  return {
    replied: null, deferred: false,
    async reply(opts) { this.replied = opts; return fakeMsg(); },
    async deferUpdate() { this.deferred = true; return null; },
    async update(opts) { this.updated = true; this.replied = opts; return fakeMsg(); },
  };
}
function fakeInteraction(user, customId, msg) {
  const base = fakeReply();
  return Object.assign(base, {
    user: { id: user }, customId: customId || '', message: msg,
    isButton: () => true,
    async update(opts) { this.updated = true; this.replied = opts; return msg; },
    async deferUpdate() { this.deferred = true; return msg; },
  });
}
function fakePrefixMessage(userId, content) {
  const state = { replyMsg: null };
  const ch = { async send() { return fakeMsg(); } };
  return {
    author: { id: userId, bot: false }, guild: { id: 'g1' }, content, channel: ch,
    async reply(opts) {
      if (!state.replyMsg) state.replyMsg = fakeMsg('panel-' + userId);
      ch.sent = [{ m: state.replyMsg, opts }];
      return state.replyMsg;
    },
  };
}

// Parse the bot's own result line: "Bet: 💎 9,999   Return: 💎 12,000"
function lastDesc(panel) {
  const last = panel.edited[panel.edited.length - 1];
  return (last && last.embeds && last.embeds[0] && last.embeds[0].data.description) || '';
}
function parseReturn(panel) {
  const m = lastDesc(panel).match(/Return: 💎\s*([\d,]+)/);
  return m ? parseInt(m[1].replace(/,/g, ''), 10) : null;
}

// Balance-delta assertion that allows ONLY the documented level-up reward as
// extra credit (150k-500k random, one per drop — plinko itself never mints).
function assertMoney(label, before, after, bet, ret, desc) {
  const raw = after - before;
  const expected = ret - bet;
  if (/LEVEL UP/.test(desc)) {
    const reward = raw - expected;
    ok(reward >= 150000 && reward <= 500000,
      `${label}: level-up drop — reward ${reward} ∈ [150k,500k] and game math exact (${raw - reward} === ${expected})`);
  } else {
    ok(raw === expected, `${label}: delta ${raw} === Return ${ret} − bet ${bet} (no level-up)`);
  }
}

(async () => {
  // ---- A. single ball, low risk ----
  eco.registerUser('A1', 'alice'); eco.addBalance('A1', 1000000);
  const baseA = eco.getBalance('A1');
  const msgA = fakePrefixMessage('A1', 'ky plinko 10000');
  await game.handlePrefixCommand(msgA, 'plinko', ['10000']);
  const panelA = msgA.channel.sent[0].m;
  await game.handleButton(fakeInteraction('A1', 'plinko_risk_low', panelA));
  const retA = parseReturn(panelA);
  ok(retA !== null, 'A: result embed has Return line');
  assertMoney('A', baseA, eco.getBalance('A1'), 10000, retA, lastDesc(panelA));

  // ---- B. ×3 replay on the same panel: floor split, its own Return ----
  const baseB = eco.getBalance('A1');
  await game.handleButton(fakeInteraction('A1', 'plinko_b3', panelA));
  const retB = parseReturn(panelA);
  ok(retB !== null, 'B: replay result has Return line');
  assertMoney('B', baseB, eco.getBalance('A1'), 9999, retB, lastDesc(panelA));

  // ---- C. insufficient balance at the risk click ----
  eco.registerUser('C1', 'carol');
  const balC = eco.getBalance('C1'); // whatever registerUser granted
  const betC = Math.min(500000, balC + 100000); // provably more than she has
  const msgC = fakePrefixMessage('C1', `ky plinko ${betC}`);
  await game.handlePrefixCommand(msgC, 'plinko', [String(betC)]);
  const panelC = msgC.channel.sent[0].m;
  const clickC = fakeInteraction('C1', 'plinko_risk_high', panelC);
  await game.handleButton(clickC);
  ok(eco.getBalance('C1') === balC, `C: balance untouched on failed deduct (${balC} → ${eco.getBalance('C1')})`);
  ok(clickC.replied && /❌|Insufficient|insufficient/i.test(String(clickC.replied.content || '')), 'C: player sees the rejection');
  const clickC2 = fakeInteraction('C1', 'plinko_risk_high', panelC);
  await game.handleButton(clickC2);
  ok(clickC2.replied && /expired|ended/i.test(String(clickC2.replied.content || '')), 'C: session cleaned — second click says expired/ended');

  // ---- D. concurrent double-click Again: ONE deduction + ONE payout ----
  eco.registerUser('D1', 'dave'); eco.addBalance('D1', 1000000);
  const baseD = eco.getBalance('D1');
  const msgD = fakePrefixMessage('D1', 'ky plinko 10000');
  await game.handlePrefixCommand(msgD, 'plinko', ['10000']);
  const panelD = msgD.channel.sent[0].m;
  await game.handleButton(fakeInteraction('D1', 'plinko_risk_low', panelD)); // first drop
  const midD = eco.getBalance('D1');
  // fire TWO Again clicks in the same tick — both promises alive concurrently
  const p1 = game.handleButton(fakeInteraction('D1', 'plinko_again', panelD));
  const p2 = game.handleButton(fakeInteraction('D1', 'plinko_again', panelD));
  await Promise.all([p1, p2]);
  const retD = parseReturn(panelD);
  const secondDropLeveled = /LEVEL UP/.test(lastDesc(panelD));
  // midD itself may embed a first-drop level-up — decompose via its own embed is
  // impossible now (panel overwritten), so assert the PAIR's effect directly:
  // exactly one 10000 deduct + one Return credit (± its own level-up reward).
  const pairDelta = eco.getBalance('D1') - midD;
  if (secondDropLeveled) {
    const reward = pairDelta - (retD - 10000);
    ok(reward >= 150000 && reward <= 500000,
      `D: double-click → ONE bet + ONE payout + level-up reward ${reward} ∈ [150k,500k] (pairDelta ${pairDelta})`);
  } else {
    ok(pairDelta === retD - 10000,
      `D: double-click → exactly ONE deduct + ONE payout (pairDelta ${pairDelta} === Return ${retD} − 10000)`);
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} plinko_money — Pass: ${pass} | Fail: ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('AUDIT CRASHED:', e); process.exit(1); });
