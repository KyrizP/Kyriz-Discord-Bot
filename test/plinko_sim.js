// Plinko RTP Simulation — verify all risks ≤ 99.5%
// Run: node test/plinko_sim.js

const PLINKO_MULTIPLIERS = {
  low:    [1.5, 1.3, 1.1, 1.0, 0.8, 1.0, 1.1, 1.3, 1.5],
  medium: [5,   2,   1.4, 0.9, 0.4, 0.9, 1.4, 2,   5],
  high:   [26,  5,   1.5, 0.3, 0,   0.3, 1.5, 5,   26],
};
const ROWS = 8;
const SPINS = 2_000_000;

let allPass = true;
for (const risk of ['low', 'medium', 'high']) {
  let totalReturn = 0;
  for (let i = 0; i < SPINS; i++) {
    let rights = 0;
    for (let r = 0; r < ROWS; r++) {
      if (Math.random() < 0.5) rights++;
    }
    totalReturn += PLINKO_MULTIPLIERS[risk][rights];
  }
  const rtp = (totalReturn / SPINS) * 100;
  const pass = rtp <= 99.5;
  if (!pass) allPass = false;
  console.log(`${risk.padEnd(8)} RTP: ${rtp.toFixed(3)}% ${pass ? '✅' : '❌ FAIL'}`);
}
console.log(allPass ? '\nAll risks pass ≤ 99.5% RTP ✅' : '\n❌ RTP GATE FAILED');
process.exit(allPass ? 0 : 1);
