/**
 * Test logika Crash (Opsi B) untuk bot Kyriz.
 * Run: node test/crash.test.js   (atau: npm test)
 *
 * Apa yang di-test:
 *  - generateCrashPoint & crashTierVisual → di-IMPORT LANGSUNG dari commands/game.js (rumus asli, bukan salinan).
 *  - State machine Opsi B (runCrashLoop + handleCrashCashout) → di-mirror di sini karena
 *    terikat Discord (msg.edit / interaction.update) dan butuh mock berat. Mirror ini merujuk
 *    baris di game.js; kalau game.js diubah, update mirror ini juga.
 *
 * Bug & celah exploit crash itu ada di LOGIKA (siapa dibayar kapan, berapa, apakah game selesai) —
 * itu yang dicek via assertion di bawah.
 */
'use strict';

const { generateCrashPoint, crashTierVisual } = require('../commands/game.js');

const STEPS = [1.10, 1.25, 1.50, 1.75, 2.00, 2.50, 3.00, 4.00, 5.00, 7.00, 10.00];

// ---- harness ----
let pass = 0, fail = 0;
function check(cond, msg) {
  if (cond) { pass++; } else { fail++; console.log('  ❌ FAIL: ' + msg); }
}

// ---- Mirror state machine Opsi B ----
// Sumber: commands/game.js runCrashLoop (1805-1934) + handleCrashCashout (1936-1954).
// Pemain cash di `target` (step pertama yang >= target DAN tercapai). Bet dinormalisasi = 1.
function play(crashPoint, target) {
  let mult = 1.0, cashed = false, cashMult = null, payout = 0;
  let payouts = 0, win = 0, loss = 0, terminated = false, cap = false;

  // instant path (playCrash:1745) — crashPoint <= 1.0
  if (crashPoint <= 1.0) { loss = 1; terminated = true; return { terminated, payouts, win, loss, cashed, cap, net: -1 }; }

  for (const step of STEPS) {
    if (step > crashPoint) {                 // runCrashLoop:1815 crash branch
      if (!cashed) loss = 1;                  // hanya !cashed yang loss (1821)
      terminated = true;
      return { terminated, payouts, win, loss, cashed, cap, net: cashed ? payout - 1 : -1 };
    }
    mult = step;
    if (!cashed && target != null && step >= target) {
      // handleCrashCashout: bayar SEKALI, TIDAK finish (cashedOut true, finished tetap false)
      cashed = true; cashMult = step; payout = step; payouts++; win = 1;
    }
  }
  // cap block (runCrashLoop:1899) — loop selesai tanpa crash = cap 10x tercapai
  cap = true; terminated = true;
  if (!cashed) { mult = 10.0; cashed = true; cashMult = 10; payout = 10; payouts++; win = 1; }
  return { terminated, payouts, win, loss, cashed, cap, net: payout - 1 };
}

// ===================== TESTS =====================

// [1] generateCrashPoint: range valid, no NaN/Inf, no bagi-nol crash
console.log('\n[1] generateCrashPoint output range (200rb sample)');
for (let i = 0; i < 200000; i++) {
  const cp = generateCrashPoint();
  check(Number.isFinite(cp) && cp >= 1.0 && cp <= 10, `crashPoint finite & in [1,10] (got ${cp})`);
}

// [2] RTP per step: ~98%, SEMUA <100% (no +EV point)
console.log('[2] RTP per step (1jt sample, semua harus <100%)');
const N = 1000000;
const pts = new Array(N);
for (let i = 0; i < N; i++) pts[i] = generateCrashPoint();
let maxRTP = 0;
for (const t of STEPS) {
  let reach = 0;
  for (let i = 0; i < N; i++) if (pts[i] >= t - 1e-9) reach++;
  const rtp = (reach / N) * t;
  if (rtp > maxRTP) maxRTP = rtp;
  check(rtp < 1.0, `RTP cash@${t.toFixed(2)}x < 100% (got ${(rtp * 100).toFixed(2)}%)`);
  check(rtp > 0.95 && rtp < 0.995, `RTP cash@${t.toFixed(2)}x ~98% (got ${(rtp * 100).toFixed(2)}%)`);
}
check(maxRTP < 1.0, `tidak ada titik +EV (max RTP ${(maxRTP * 100).toFixed(2)}% < 100%)`);

// [3] State machine invariants (500rb game acak, target acak)
console.log('[3] Invariant state machine (500rb game acak)');
let stuck = 0, doublePay = 0, bothWL = 0, cashedNotOne = 0;
for (let i = 0; i < 500000; i++) {
  const cp = generateCrashPoint();
  const target = STEPS[Math.floor(Math.random() * STEPS.length)];
  const r = play(cp, target);
  if (!r.terminated) stuck++;
  if (r.payouts > 1) doublePay++;
  if (r.win && r.loss) bothWL++;
  if (r.cashed && r.payouts !== 1) cashedNotOne++;
}
check(stuck === 0, `no stuck game (stuck=${stuck})`);
check(doublePay === 0, `no double-pay (doublePay=${doublePay})`);
check(bothWL === 0, `tidak pernah win+loss bersamaan (both=${bothWL})`);
check(cashedNotOne === 0, `cashed selalu payouts=1 (cashedNotOne=${cashedNotOne})`);

// [4] Edge cases deterministik
console.log('[4] Edge cases (deterministik)');
let r;
r = play(1.0, 2.0);
check(r.terminated && r.payouts === 0 && r.loss === 1 && !r.cashed, 'instant crash: loss, no payout, terminated');

r = play(7.0, 3.0);
check(r.terminated && r.payouts === 1 && r.win === 1 && r.loss === 0 && Math.abs(r.net - 2) < 1e-9, 'cash@3 crash@7: payout 1, win, net +2');

r = play(10.0, 5.0);
check(r.terminated && r.cap && r.payouts === 1 && r.loss === 0 && Math.abs(r.net - 4) < 1e-9, 'cash@5 cap10: payout 1 (NO extra), cap, net +4');

r = play(2.3, 3.0);
check(r.terminated && r.payouts === 0 && r.loss === 1 && !r.cashed, 'hold for 3, crash@2.3: loss, no payout');

r = play(3.0, 3.0);
check(r.terminated && r.payouts === 1 && r.win === 1 && Math.abs(r.net - 2) < 1e-9, 'cp=3.0 cash@3: bisa cash di step boundary');

r = play(5.0, 1.10);
check(r.cashed && r.payouts === 1 && Math.abs(r.net - 0.10) < 1e-9, 'cash@1.10 (step pertama): payout 1.10');

r = play(10.0, null); // hold sampai cap tanpa cash
check(r.terminated && r.cap && r.payouts === 1 && r.win === 1 && Math.abs(r.net - 9) < 1e-9, 'hold to cap 10x: auto-cashout, net +9');

// [5] crashTierVisual (dari game.js asli)
console.log('[5] crashTierVisual (import asli)');
check(crashTierVisual(1.5).emoji === '🚀', 'tier 1.5 = 🚀');
check(crashTierVisual(2.0).emoji === '🔥', 'tier 2.0 = 🔥');
check(crashTierVisual(4.0).emoji === '💎', 'tier 4.0 = 💎');
check(crashTierVisual(7.0).emoji === '🌙', 'tier 7.0 = 🌙');

// ---- summary ----
console.log('\n' + (fail === 0 ? '✅ SEMUA TEST LULUS' : '❌ ADA TEST GAGAL'));
console.log(`Pass: ${pass} | Fail: ${fail}`);
process.exit(fail === 0 ? 0 : 1);
