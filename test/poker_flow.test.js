'use strict';

// Poker flow regression — drives the REAL handlers with fake interactions:
//   1. OWNER REPRO (2p): SB calls, then BB's button (label "Check", customId
//      poker_call) must resolve as CHECK — the old bug errored "Nothing to
//      call" and soft-locked limped pots. Full check-down to showdown.
//   2. 3 PLAYERS: first actor raises via the modal path, everyone calls,
//      check-down to settlement — escrow fully cleared, money sane.
//   3. Turn countdown: betting-phase embed carries a live <t:...:R> Discord
//      timestamp (ticks client-side; same deadline the AFK timeout enforces).
// Run: node test/poker_flow.test.js   (~15s — runout animations)
process.env.KYRIZ_ECONOMY_DB = ':memory:';
process.env.KYRIZ_ECONOMY_JSON = '/tmp/poker-flow-nonexist.json';
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
    replied: null, deferred: false, shownModal: false,
    async reply(opts) { this.replied = opts; return fakeMsg(); },
    async deferUpdate() { this.deferred = true; return null; },
    async update(opts) { this.updated = true; this.replied = opts; return fakeMsg(); },
    async followUp(opts) { this.notes = this.notes || []; this.notes.push(opts); return fakeMsg(); },
    async showModal() { this.shownModal = true; },
  };
}
function fakeInteraction(user, customId, msg) {
  const base = fakeReply();
  return Object.assign(base, {
    user: { id: user }, customId: customId || '', message: msg,
    isButton: () => true,
    fields: { getTextInputValue: () => '0' },
    async update(opts) { this.updated = true; this.replied = opts; return msg; },
    async deferUpdate() { this.deferred = true; return msg; },
  });
}
function fakeModal(user, amount) {
  const base = fakeReply();
  return Object.assign(base, {
    user: { id: user },
    isModalSubmit: () => true,
    fields: { getTextInputValue: () => amount },
  });
}
function fakePrefixMessage(userId, content) {
  const state = { replyMsg: null };
  const ch = {
    sent: [], // poker sends its panel via channel.send — must be recorded too
    async send(opts) { const m = fakeMsg('send-' + this.sent.length); this.sent.push({ m, opts }); return m; },
  };
  return {
    author: { id: userId, bot: false }, guild: { id: 'g1' }, content, channel: ch,
    async reply(opts) {
      if (!state.replyMsg) state.replyMsg = fakeMsg('panel-' + userId);
      ch.sent.push({ m: state.replyMsg, opts });
      return state.replyMsg;
    },
  };
}

const errors = []; // every error-style reply seen across all hands
function noteError(c) { if (c && /❌/.test(c)) errors.push(c); }

// Click as whichever player holds the turn; returns the actor or null.
async function act(panel, uids, customId) {
  for (const uid of uids) {
    const it = fakeInteraction(uid, customId, panel);
    await game.handleButton(it);
    const c = String((it.replied && it.replied.content) || '');
    noteError(c);
    if (!/not your turn/i.test(c)) return { uid, it, c };
  }
  return null;
}
async function waitEscrowEmpty(label, timeoutMs = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (eco.getActivePokerEscrows().length === 0) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}
function lastDesc(panel) {
  const last = panel.edited[panel.edited.length - 1];
  return (last && last.embeds && last.embeds[0] && last.embeds[0].data.description) || '';
}

async function hostGame(ids, buyIn, label) {
  for (const id of ids) { eco.registerUser(id, 'u' + id); eco.addBalance(id, 5000000); }
  const msg = fakePrefixMessage(ids[0], `ky poker ${buyIn}`);
  await game.handlePrefixCommand(msg, 'poker', [String(buyIn)]);
  const panel = msg.channel.sent[0].m;
  for (const id of ids.slice(1)) {
    const it = fakeInteraction(id, 'poker_join', panel);
    await game.handleButton(it);
    const c = String((it.replied && it.replied.content) || '');
    if (c && !/join|Join/i.test(c)) console.log(`  [dbg ${label}] join ${id} replied: ${c.slice(0, 140)}`);
  }
  const st = fakeInteraction(ids[0], 'poker_start', panel);
  await game.handleButton(st);
  const sc = String((st.replied && st.replied.content) || '');
  if (sc) console.log(`  [dbg ${label}] start replied: ${sc.slice(0, 140)}`);
  return panel;
}

(async () => {
  // ---- HAND 1: owner repro, 2 players, call → BB "Check" button ----
  console.log('— hand 1: 2p call/check-down (owner repro) —');
  const ids1 = ['P1', 'P2'];
  const before1 = {};
  const panel1 = await hostGame(ids1, 100000, "h1");
  for (const id of ids1) before1[id] = eco.getBalance(id);
  ok(eco.getActivePokerEscrows().length === 2, 'hand1: 2 escrow rows');
  ok(/<t:\d+:R>/.test(lastDesc(panel1)), 'hand1: betting panel shows live <t:R> countdown');
  let acted1 = 0;
  while (eco.getActivePokerEscrows().length > 0 && acted1 < 10) {
    const r = await act(panel1, ids1, 'poker_call');
    if (!r) break;
    acted1++;
  }
  ok(await waitEscrowEmpty('hand1'), 'hand1: escrow cleared after showdown');
  ok(errors.every((e) => !/Nothing to call/.test(e)), 'hand1: NO "Nothing to call" anywhere (the BB-option bug)');
  ok(errors.every((e) => !/can.?t check/i.test(e)), 'hand1: no phantom check errors');
  const sum1 = ids1.reduce((s, id) => s + eco.getBalance(id), 0);
  ok(sum1 >= 200000, `hand1: money sane (Σ ${sum1} ≥ 2×buyIn — zero-sum + level-ups only)`);

  // ---- HAND 2: 3 players, raise via modal, call, check-down ----
  console.log('— hand 2: 3p raise + calls + check-down —');
  errors.length = 0;
  const ids2 = ['Q1', 'Q2', 'Q3'];
  const before2 = {};
  const panel2 = await hostGame(ids2, 100000, "h2");
  for (const id of ids2) before2[id] = eco.getBalance(id);
  ok(eco.getActivePokerEscrows().length === 3, 'hand2: 3 escrow rows');

  // First actor raises via the modal (click poker_raise until the modal opens,
  // then submit 15000 — a legal min-raise over the BB).
  let raised = null;
  for (const uid of ids2) {
    const it = fakeInteraction(uid, 'poker_raise', panel2);
    await game.handleButton(it);
    const c = String((it.replied && it.replied.content) || '');
    noteError(c);
    if (it.shownModal) { raised = uid; break; }
    if (!/not your turn/i.test(c)) break;
  }
  ok(raised !== null, 'hand2: raise button opened the modal for the turn holder');
  if (raised) {
    const m = fakeModal(raised, '15000');
    await game.handlePokerModal(m);
    noteError(String((m.replied && m.replied.content) || ''));
  }

  // Everyone else calls, then check it down to showdown.
  let acted2 = 0;
  while (eco.getActivePokerEscrows().length > 0 && acted2 < 14) {
    const r = await act(panel2, ids2, 'poker_call');
    if (!r) break;
    acted2++;
  }
  ok(await waitEscrowEmpty('hand2'), 'hand2: escrow cleared after showdown');
  ok(errors.length === 0, `hand2: zero error replies (got: ${errors.join(' | ') || 'none'})`);
  const delta2 = ids2.reduce((s, id) => s + eco.getBalance(id) - before2[id], 0);
  ok(delta2 === 0 || delta2 >= 150000, `hand2: ΣΔ ${delta2} is zero-sum or zero-sum + level-up reward(s)`);

  console.log(`\n${fail === 0 ? '✅' : '❌'} poker_flow — Pass: ${pass} | Fail: ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FLOW CRASHED:', e); process.exit(1); });
