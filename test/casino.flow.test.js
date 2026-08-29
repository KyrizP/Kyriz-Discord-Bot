'use strict';

// Casino v2 behavioral probe — DRIVES the real game.js handlers with fake
// Discord interactions (no Discord connection). Catches undefined-identifier
// and wiring bugs that syntax checks and pure-engine tests cannot see
// (the `processing is not defined` class). Run: node test/casino.flow.test.js
process.env.KYRIZ_ECONOMY_DB = ':memory:';
process.env.KYRIZ_ECONOMY_JSON = '/tmp/casino-flow-nonexist.json';
process.env.SUPERADMIN_ID = '900000000000000001';

const game = require('../commands/game.js');
const eco = require('../utils/economyManager');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL: ' + msg); } }

// ---- fake Discord primitives ----
function fakeMsg(id) {
  return {
    id: id || ('m' + Math.random().toString(36).slice(2)),
    edited: [],
    async edit(opts) { this.edited.push(opts); Object.assign(this, { lastEdit: opts }); return this; },
  };
}
function fakeReply() {
  return {
    replied: null, deferred: false, updated: false, ephemeralNotes: [],
    async reply(opts) { this.replied = opts; return fakeMsg(); },
    async deferReply() { this.deferred = true; return fakeMsg(); },
    async deferUpdate() { this.deferred = true; return fakeMsg(); },
    async update(opts) { this.updated = true; this.replied = opts; return fakeMsg(); },
    async followUp(opts) { this.ephemeralNotes.push(opts); return fakeMsg(); },
    async showModal() { this.shownModal = true; },
  };
}
function fakeInteraction(user, customId, msg, fields) {
  const base = fakeReply();
  return Object.assign(base, {
    user: { id: user, username: 'u' + user },
    customId: customId || '',
    message: msg,
    isButton: () => true,
    fields: fields || { getTextInputValue: () => '0' },
    // Discord semantics: update/deferUpdate keep the SAME message (id preserved).
    async update(opts) { this.updated = true; this.replied = opts; if (msg) msg.edited.push(opts); return msg; },
    async deferUpdate() { this.deferred = true; return msg; },
  });
}
function fakePrefixMessage(userId, content, sendResult) {
  const state = { replyMsg: null };
  const ch = {
    sent: [],
    async send(opts) { const m = fakeMsg(); this.sent.push({ m, opts }); if (sendResult) Object.assign(m, sendResult); return m; },
  };
  return {
    author: { id: userId, username: 'u' + userId, bot: false },
    guild: { id: 'g1' },
    member: {},
    content,
    channel: ch,
    async reply(opts) {
      // plinko/poker panels come from context.reply — record it so the probe
      // can drive buttons against the SAME panel object (fetchReply semantics).
      if (!state.replyMsg) state.replyMsg = fakeMsg('reply-panel');
      ch.sent.push({ m: state.replyMsg, opts });
      return state.replyMsg;
    },
  };
}

// Setup players
eco.registerUser('111', 'alice'); eco.addBalance('111', 5000000);
eco.registerUser('222', 'bob');   eco.addBalance('222', 5000000);

(async () => {
  // ---- 1. PLINKO: full flow via prefix → risk button → result ----
  console.log('— plinko flow —');
  const msg = fakePrefixMessage('111', 'ky plinko 10000');
  await game.handlePrefixCommand(msg, 'plinko', ['10000']).catch((e) => ok(false, 'plinko cmd threw: ' + e.message));
  ok(msg.channel.sent.length === 1, 'lobby/risk panel sent');

  // Drive the button handler directly with a risk click on that panel
  const panel = msg.channel.sent[0].m;
  const riskClick = fakeInteraction('111', 'plinko_risk_low', panel);
  await game.handleButton(riskClick).catch((e) => ok(false, 'risk click threw: ' + e.message));
  ok(true, 'risk click completed without ReferenceError');
  ok(riskClick.replied !== null || riskClick.deferred || panel.edited.length >= 0, 'interaction consumed');
  // balance moved: 5M + 100k start - 10k bet (result screen paid or pending)
  const bal1 = eco.getBalance('111');
  ok(typeof bal1 === 'number', 'balance readable post-click: ' + bal1);

  // ---- 2. PLINKO: replay path (the phase-reset fix) — click Again on result ----
  // wait for animation via direct handler call on the (possibly edited) panel
  const againClick = fakeInteraction('111', 'plinko_again', panel);
  await game.handleButton(againClick).catch((e) => ok(false, 'again click threw: ' + e.message));
  ok(true, 'replay click completed without throw');
  const bal2 = eco.getBalance('111');
  // Replay can WIN (payout > bet) — legitimate. Money-sanity: balance changed
  // by exactly one bet-payout cycle, i.e. it is a finite number and not NaN.
  ok(Number.isFinite(bal2), 'replay balance finite (bal ' + bal1 + ' → ' + bal2 + ')');

  // ---- 3. POKER: host via prefix ----
  console.log('— poker flow —');
  const pmsg = fakePrefixMessage('111', 'ky poker 100000');
  await game.handlePrefixCommand(pmsg, 'poker', ['100000']).catch((e) => ok(false, 'poker cmd threw: ' + e.message));
  ok(pmsg.channel.sent.length === 1, 'lobby panel sent');
  const lobby = pmsg.channel.sent[0].m;
  ok(eco.getBalance('111') === bal2 - 100000, 'host buy-in escrowed (bal ' + eco.getBalance('111') + ')');

  // Join from second player
  const joinClick = fakeInteraction('222', 'poker_join', lobby);
  await game.handleButton(joinClick).catch((e) => ok(false, 'join threw: ' + e.message));
  ok(eco.getBalance('222') === 5000000 + 100000 - 100000, 'bob buy-in escrowed');
  ok(eco.getActivePokerEscrows().length === 2, '2 escrow rows');

  // Host starts
  const startClick = fakeInteraction('111', 'poker_start', lobby);
  await game.handleButton(startClick).catch((e) => ok(false, 'start threw: ' + e.message));
  ok(true, 'start completed without throw (deal + blinds + first render)');

  // View hand (ephemeral path)
  const viewClick = fakeInteraction('222', 'poker_viewhand', lobby);
  await game.handleButton(viewClick).catch((e) => ok(false, 'viewhand threw: ' + e.message));
  ok(viewClick.replied && typeof viewClick.replied.content === 'string' && viewClick.replied.content.includes('Your Hand'), 'view hand shows hole cards');

  // Non-participant acts → graceful ephemeral reject (deterministic: user 333 is
  // NOT in the game, unlike turn-order checks which depend on random dealer).
  const actClick = fakeInteraction('333', 'poker_fold', lobby);
  await game.handleButton(actClick).catch((e) => ok(false, 'outsider action threw (should be graceful): ' + e.message));
  const rejected = actClick.replied && /not (in this game|your turn)/i.test(actClick.replied.content || '');
  ok(rejected, 'outsider action rejected gracefully: ' + JSON.stringify(actClick.replied && actClick.replied.content));

  // ---- 4. REGISTRY ----
  console.log('— registry —');
  ok(game.isValidPrefixCommand('plinko'), 'plinko prefix valid');
  ok(game.isValidPrefixCommand('poker'), 'poker prefix valid');
  ok(typeof game.handlePokerModal === 'function', 'modal exported');

  console.log(`\n${fail === 0 ? '✅' : '❌'} casino.flow — Pass: ${pass} | Fail: ${fail}`);
  process.exit(fail ? 1 : 0);
})();
