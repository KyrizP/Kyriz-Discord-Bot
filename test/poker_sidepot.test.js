'use strict';

// Side-pot verification the owner cannot test live with 2 accounts.
//
// Part A (engine, deterministic): 3-way all-in proves THE STRUCTURAL THEOREM —
//   equal buy-ins (mandatory) ⇒ every all-in total = exactly buyIn ⇒ classic
//   side pots are IMPOSSIBLE in live play; every showdown is ONE contested
//   layer (+ dead money). Multi-layer engine math stays verified in
//   pokerEngine.test.js #4-6 as future-proofing.
// Part B (engine, exhaustive): 300 random 3-5 player games, all-in-biased
//   actions, full runout — Σ payouts === Σ buy-ins EVERY game.
// Part C (handlers, real buttons): the same 3-way all-in through the actual
//   game.js handlers + escrow settlement — zero-sum EXACTLY 0 (poker gives
//   no XP per spec), escrow cleared, stats recorded once per player.
// Run: node test/poker_sidepot.test.js   (~20s)
process.env.KYRIZ_ECONOMY_DB = ':memory:';
process.env.KYRIZ_ECONOMY_JSON = '/tmp/poker-sidepot-nonexist.json';
process.env.SUPERADMIN_ID = '900000000000000001';

const E = require('../utils/pokerEngine');
const gameCmd = require('../commands/game.js');
const eco = require('../utils/economyManager');
const { fakeInteraction, fakeModal, fakePrefixMessage } = require('./helpers/fakeDiscord');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.error('  FAIL: ' + msg); } }

// Seeded RNG (deterministic runs)
Math.random = (() => { let s = 20260829 >>> 0; return () => { s = ((Math.imul(s, 1103515245) + 12345) >>> 0) % 2147483648; return s / 2147483648; }; })();

// ---- Part A: deterministic 3-way all-in + THE STRUCTURAL THEOREM ----
// Equal buy-ins (mandatory) + single-hand ⇒ every all-in TOTAL = exactly
// buyIn (blinds are carved FROM the stack: SB all-in = 2.5k + 97.5k = 100k).
// Nobody can be all-in below another's total ⇒ classic side pots are
// IMPOSSIBLE in live play — every showdown is ONE contested layer (plus
// dead money from folds). Engine multi-layer math stays verified in
// pokerEngine.test.js #4-6 as future-proofing for unequal-buyIn designs.
{
  const g = E.createPokerGame('sp1', 'D0', 100000);
  for (const id of ['D0', 'S0', 'B0']) E.addPlayer(g, id, 100000);
  const r = E.startGame(g);
  ok(r.ok, 'A: startGame ok');
  const dealer = g.players[g.dealerIndex], sb = g.players[g.sbIndex], bb = g.players[g.bbIndex];
  ok(dealer.chips === 100000 && sb.chips === 97500 && bb.chips === 95000,
    `A: blind drain D 100000/SB 97500/BB 95000 (got ${dealer.chips}/${sb.chips}/${bb.chips})`);
  // 3-handed preflop: button acts first → all-in raise-TO full stack
  ok(E.currentPlayerId(g) === dealer.id, 'A: button acts first preflop (3-handed)');
  let rr = E.playerAction(g, dealer.id, 'raise', 100000); // = chips + currentBet → all-in
  ok(rr.ok, 'A: button all-in raise-TO 100000 ok');
  rr = E.playerAction(g, E.currentPlayerId(g), 'call'); ok(rr.ok, 'A: SB short all-in call');
  rr = E.playerAction(g, E.currentPlayerId(g), 'call'); ok(rr.ok, 'A: BB short all-in call');
  ok(g.players.every((p) => p.allIn), 'A: all three all-in');
  ok(g.players.every((p) => p.contributed === 100000),
    `A: all-in totals all = buyIn 100k — nobody can be all-in BELOW anyone (got ${g.players.map((p) => p.contributed).join('/')})`);
  const { layers, uncalled } = E.computeLayers(g);
  ok(layers.length === 1, `A: exactly ONE contested layer — side pots structurally impossible (got ${layers.length})`);
  ok(layers[0].amount === 300000 && layers[0].eligible.length === 3,
    `A: single layer = whole 300k, 3 eligible (got ${layers[0].amount}/${layers[0].eligible.length})`);
  ok(uncalled.length === 0, `A: no uncalled excess (got ${JSON.stringify(uncalled)})`);
  while (g.community.length < 5) { // dealStreet switches on phase — set it correctly
    if (g.community.length === 0) g.phase = 'flop';
    else if (g.community.length === 3) g.phase = 'turn';
    else if (g.community.length === 4) g.phase = 'river';
    else break;
    E.dealStreet(g);
  }
  g.phase = 'showdown';
  const payouts = E.getPayouts(g);
  const sum = Object.values(payouts).reduce((a, b) => a + b, 0);
  ok(sum === 300000, `A: Σ payouts 300,000 (got ${sum})`);
}

// ---- Part B: exhaustive random all-in-heavy games ----
{
  let games = 0, zeroSumFails = 0, withAllIns = 0, multiLayer = 0;
  for (let iter = 0; iter < 300; iter++) {
    const n = 3 + (iter % 3); // 3-5 players
    const ids = Array.from({ length: n }, (_, i) => 'P' + i);
    const g = E.createPokerGame('sp2', ids[0], 100000);
    for (const id of ids) E.addPlayer(g, id, 100000);
    E.startGame(g);
    let guard = 0;
    while (!['settled', 'showdown', 'runout'].includes(g.phase) && guard++ < 300) {
      const id = E.currentPlayerId(g);
      if (!id) break;
      const p = g.players[g.currentTurnIndex];
      const toCall = g.currentBet - p.currentBet;
      const roll = Math.random();
      let r;
      if (roll < 0.55) r = E.playerAction(g, id, 'allin');            // all-in bias → layers
      else if (toCall > 0) r = E.playerAction(g, id, roll < 0.8 ? 'call' : 'fold');
      else r = E.playerAction(g, id, roll < 0.85 ? 'check' : 'raise', E.minRaiseTo(g) + 5000);
      if (r && !r.ok && /turn/.test(r.error || '')) break;
      if (g.phase === 'flop' && g.community.length === 0) E.dealStreet(g);
      if (g.phase === 'turn' && g.community.length === 3) E.dealStreet(g);
      if (g.phase === 'river' && g.community.length === 4) E.dealStreet(g);
    }
    while (g.community.length < 5 && g.phase !== 'settled') {
      if (g.community.length === 0) g.phase = 'flop';
      else if (g.community.length === 3) g.phase = 'turn';
      else if (g.community.length === 4) g.phase = 'river';
      else break;
      E.dealStreet(g);
    }
    if (g.phase !== 'settled') g.phase = 'showdown';
    const payouts = E.getPayouts(g);
    const sum = Object.values(payouts).reduce((a, b) => a + b, 0);
    if (sum !== n * 100000) { zeroSumFails++; console.error(`  iter ${iter}: Σ ${sum} ≠ ${n * 100000} (phase ${g.phase})`); if (zeroSumFails > 3) break; }
    if (Object.values(payouts).some((v) => v < 0)) { zeroSumFails++; console.error(`  iter ${iter}: negative payout`); }
    if (g.players.filter((p) => p.allIn).length >= 2) withAllIns++;
    // Theorem, empirically: any showdown with all-ins still has ONE contested layer.
    if (g.handResults && g.handResults.type === 'showdown' && g.players.some((p) => p.allIn)) {
      const L = E.computeLayers(g);
      if (L.layers.length > 1 || L.uncalled.length > 0) {
        multiLayer++;
        console.error(`  iter ${iter}: side-pot shape appeared live (layers ${L.layers.length}, uncalled ${L.uncalled.length})`);
      }
    }
    games++;
  }
  ok(games === 300, `B: ran ${games}/300 games`);
  ok(zeroSumFails === 0, `B: zero-sum held in ALL games (${zeroSumFails} violations)`);
  ok(withAllIns >= 200, `B: layer math actually exercised — ${withAllIns}/300 games had 2+ all-ins`);
  ok(multiLayer === 0, `B: THEOREM held — zero live side-pot shapes in ${games} games (saw ${multiLayer})`);
}

// ---- Part C: same 3-way all-in through the REAL handlers ----
(async () => {
  console.log('— part C: handler-level 3-way all-in —');
  const ids = ['SP1', 'SP2', 'SP3'];
  for (const id of ids) { eco.registerUser(id, 'u' + id); eco.addBalance(id, 5000000); }
  const statsBefore = {};
  for (const id of ids) {
    const p = eco.readPlayer(id) || {};
    statsBefore[id] = (p.totalWins || 0) + (p.totalLosses || 0);
  }
  const before = {};
  for (const id of ids) before[id] = eco.getBalance(id);

  const msg = fakePrefixMessage('SP1', 'ky poker 100000');
  await gameCmd.handlePrefixCommand(msg, 'poker', ['100000']);
  const panel = msg.channel.sent[0].m;
  for (const id of ['SP2', 'SP3']) await gameCmd.handleButton(fakeInteraction(id, 'poker_join', panel));
  await gameCmd.handleButton(fakeInteraction('SP1', 'poker_start', panel));
  ok(eco.getActivePokerEscrows().length === 3, 'C: 3 escrow rows');

  // Parse the live panel: "D **id** — 💎 100,000 · ..." per player.
  // The host is DISPLAYED as "Host" (not their id) — map it back or every
  // interaction issued for them targets a nonexistent user.
  const idOf = (display) => (display === 'Host' ? 'SP1' : display);
  function parsePlayers() {
    const last = panel.edited[panel.edited.length - 1];
    const desc = last && last.embeds && last.embeds[0] && last.embeds[0].data.description || '';
    const field = last && last.embeds && last.embeds[0] && last.embeds[0].data.fields
      && last.embeds[0].data.fields[0] && last.embeds[0].data.fields[0].value || '';
    const out = {};
    for (const line of field.split('\n')) {
      const m = line.match(/^(\s*)(D|SB|BB)?\s*\*\*(.+?)\*\* — 💎\s*([\d,]+)/);
      if (m) out[idOf(m[3])] = { pos: m[2] || '', chips: parseInt(m[4].replace(/,/g, ''), 10), line };
    }
    return { out, field };
  }
  const { out: players0 } = parsePlayers();
  const chipsList = Object.values(players0).map((p) => p.chips).sort((a, b) => a - b);
  ok(JSON.stringify(chipsList) === '[95000,97500,100000]',
    `C: blind spread on panel 95k/97.5k/100k (got ${JSON.stringify(chipsList)})`);

  // Turn holder (3-handed preflop = button, chips 100k) raises ALL-IN via modal
  const { field: f0 } = parsePlayers();
  const turnLine = f0.split('\n').find((l) => l.includes('👉'));
  const turnId = turnLine && idOf((turnLine.match(/\*\*(.+?)\*\*/) || [])[1]);
  ok(turnId && players0[turnId] && players0[turnId].chips === 100000, `C: first actor is the button (got ${turnId})`);
  const raiseClick = fakeInteraction(turnId, 'poker_raise', panel);
  await gameCmd.handleButton(raiseClick);
  ok(raiseClick.shownModal, 'C: raise modal opened');
  const modal = fakeModal(turnId, String(players0[turnId].chips)); // raise-TO full stack
  await gameCmd.handlePokerModal(modal);

  // SB and BB call — both auto-short-all-in
  for (let i = 0; i < 2; i++) {
    const { field } = parsePlayers();
    const tl = field.split('\n').find((l) => l.includes('👉'));
    const nextId = tl && idOf((tl.match(/\*\*(.+?)\*\*/) || [])[1]);
    ok(nextId, `C: turn advanced (actor ${i + 1}: ${nextId})`);
    if (!nextId) break;
    await gameCmd.handleButton(fakeInteraction(nextId, 'poker_call', panel));
  }

  // All-in runout (~2.4s) → showdown → settle. ΣΔ must be EXACTLY 0 (no XP in poker).
  const t0 = Date.now();
  while (eco.getActivePokerEscrows().length > 0 && Date.now() - t0 < 12000) {
    await new Promise((r) => setTimeout(r, 250));
  }
  ok(eco.getActivePokerEscrows().length === 0, 'C: escrow cleared');

  const delta = ids.reduce((s, id) => s + (eco.getBalance(id) - before[id]), 0);
  ok(delta === 0, `C: ΣΔ EXACTLY 0 — side-pot redistribution is perfectly zero-sum (got ${delta})`);
  for (const id of ids) {
    const d = eco.getBalance(id) - before[id];
    ok(d > -100000 && d < 100000, `C: ${id} net within stack bounds (Δ ${d})`);
  }
  // Stats: one record per player per game (spec §2.11)
  for (const id of ids) {
    const p = eco.readPlayer(id) || {};
    const played = (p.totalWins || 0) + (p.totalLosses || 0);
    ok(played === statsBefore[id] + 1, `C: ${id} stats +1 (W/L recorded once)`);
  }
  // Settlement panel: "💎 X returned" per player must sum to 300,000
  const last = panel.edited[panel.edited.length - 1];
  const desc = last && last.embeds && last.embeds[0] && last.embeds[0].data.description || '';
  const field = last && last.embeds && last.embeds[0] && last.embeds[0].data.fields && last.embeds[0].data.fields[0].value || '';
  const returned = [...(field + '\n' + desc).matchAll(/💎\s*([\d,]+) returned/g)].map((m) => parseInt(m[1].replace(/,/g, ''), 10));
  ok(returned.length === 3 && returned.reduce((a, b) => a + b, 0) === 300000,
    `C: settlement shows 3 payouts totalling 300,000 (got ${JSON.stringify(returned)})`);

  console.log(`\n${fail === 0 ? '✅' : '❌'} poker_sidepot — Pass: ${pass} | Fail: ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASHED:', e); process.exit(1); });
