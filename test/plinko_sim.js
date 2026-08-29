// Plinko RTP Simulation — verify all risks ≤ 99.5%
// Run: node test/plinko_sim.js

const PLINKO_MULTIPLIERS = {
  low:    [1.4, 1.2, 1.0, 0.8, 1.0, 1.2, 1.4],
  medium: [3,   1.6, 1.0, 0.4, 1.0, 1.6, 3],
  high:   [12,  2,   0.5, 0,   0.5, 2,   12],
};
const ROWS = 6;
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
