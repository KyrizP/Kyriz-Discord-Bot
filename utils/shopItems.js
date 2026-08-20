// utils/shopItems.js
// Data-driven shop catalog + pure helpers. Self-check: `node utils/shopItems.js`.

// ---- Reward wheels (amount + probability). Probabilities sum to 1. ----
const LUCKY_WHEEL = [
  { amt: 50000,   p: 0.45 },
  { amt: 150000,  p: 0.30 },
  { amt: 300000,  p: 0.18 },
  { amt: 500000,  p: 0.05 },
  { amt: 1000000, p: 0.02 },
]; // EV ≈ 166.5k

const MYSTERY_WHEEL = [
  { amt: 100000,  p: 0.40 },
  { amt: 300000,  p: 0.30 },
  { amt: 600000,  p: 0.20 },
  { amt: 1000000, p: 0.07 },
  { amt: 3000000, p: 0.03 },
]; // EV ≈ 410k

// ---- Catalog ----
// type: 'consumable' (used from inventory) | 'permanent' (cosmetic, owned forever)
// effect.kind: 'daily_boost' | 'spin'
const ITEMS = {
  // Consumables
  daily_boost_15:{ id: 'daily_boost_15',name: 'Daily x1.5',    emoji: '📅', category: 'consumable', type: 'consumable', price: 200000, effect: { kind: 'daily_boost', mult: 1.5 }, description: 'Your next daily reward is multiplied by 1.5.' },
  daily_boost_20:{ id: 'daily_boost_20',name: 'Daily x2',      emoji: '📅', category: 'consumable', type: 'consumable', price: 400000, effect: { kind: 'daily_boost', mult: 2.0 }, description: 'Your next daily reward is multiplied by 2.' },
  lucky_token:   { id: 'lucky_token',   name: 'Lucky Token',   emoji: '🎟️', category: 'consumable', type: 'consumable', price: 200000, effect: { kind: 'spin', wheel: 'LUCKY_WHEEL' }, description: 'Spin the lucky wheel for a random Kryztal prize.' },
  mystery_box:   { id: 'mystery_box',   name: 'Mystery Box',   emoji: '📦', category: 'consumable', type: 'consumable', price: 500000, effect: { kind: 'spin', wheel: 'MYSTERY_WHEEL' }, description: 'Spin the mystery wheel — bigger prizes, bigger thrills.' },

  // Cosmetics (permanent). Prices span the wealth distribution.
  title_rookie:     { id: 'title_rookie',    name: 'Title: Rookie',     emoji: '🏷️', category: 'cosmetic', type: 'permanent', price: 250000,  effect: { kind: 'title', value: 'Rookie' },     description: 'Equip the [Rookie] title.' },
  title_gambler:    { id: 'title_gambler',   name: 'Title: Gambler',    emoji: '🏷️', category: 'cosmetic', type: 'permanent', price: 1000000, effect: { kind: 'title', value: 'Gambler' },  description: 'Equip the [Gambler] title.' },
  title_highroller: { id: 'title_highroller',name: 'Title: High Roller',emoji: '🏷️', category: 'cosmetic', type: 'permanent', price: 5000000, effect: { kind: 'title', value: 'High Roller' }, description: 'Equip the [High Roller] title.' },
  title_whale:      { id: 'title_whale',     name: 'Title: Whale',      emoji: '🏷️', category: 'cosmetic', type: 'permanent', price: 15000000,effect: { kind: 'title', value: 'Whale' },     description: 'Equip the [Whale] title.' },
  title_mythic:     { id: 'title_mythic',    name: 'Title: Mythic',     emoji: '🌟', category: 'cosmetic', type: 'permanent', price: 30000000,effect: { kind: 'title', value: 'Mythic' },    description: 'Equip the [Mythic] title.' },
  title_celestial:  { id: 'title_celestial', name: 'Title: Celestial',  emoji: '✨', category: 'cosmetic', type: 'permanent', price: 50000000,effect: { kind: 'title', value: 'Celestial' }, description: 'Equip the [Celestial] title.' },
  title_divine:     { id: 'title_divine',    name: 'Title: Divine',     emoji: '🔱', category: 'cosmetic', type: 'permanent', price: 100000000,effect:{ kind: 'title', value: 'Divine' },    description: 'Equip the [Divine] title.' },
  badge_crown:      { id: 'badge_crown',     name: 'Badge: Crown',      emoji: '👑', category: 'cosmetic', type: 'permanent', price: 500000,  effect: { kind: 'badge', value: '👑' },       description: 'Equip the Crown badge.' },
  badge_inferno:    { id: 'badge_inferno',   name: 'Badge: Inferno',    emoji: '🔥', category: 'cosmetic', type: 'permanent', price: 1000000, effect: { kind: 'badge', value: '🔥' },       description: 'Equip the Inferno badge.' },
  badge_champion:   { id: 'badge_champion',  name: 'Badge: Champion',   emoji: '🏆', category: 'cosmetic', type: 'permanent', price: 3000000, effect: { kind: 'badge', value: '🏆' },       description: 'Equip the Champion badge.' },
  badge_skull:      { id: 'badge_skull',     name: 'Badge: Skull',      emoji: '💀', category: 'cosmetic', type: 'permanent', price: 5000000, effect: { kind: 'badge', value: '💀' },       description: 'Equip the Skull badge.' },
  color_crimson:    { id: 'color_crimson',   name: 'Color: Crimson',    emoji: '❤️', category: 'cosmetic', type: 'permanent', price: 750000,  effect: { kind: 'color', value: 'crimson', hex: 0xDC143C }, description: 'Crimson embed color.' },
  color_emerald:    { id: 'color_emerald',   name: 'Color: Emerald',    emoji: '💚', category: 'cosmetic', type: 'permanent', price: 750000,  effect: { kind: 'color', value: 'emerald', hex: 0x2ECC71 }, description: 'Emerald embed color.' },
  color_sapphire:   { id: 'color_sapphire',  name: 'Color: Sapphire',   emoji: '💙', category: 'cosmetic', type: 'permanent', price: 750000,  effect: { kind: 'color', value: 'sapphire', hex: 0x3498DB }, description: 'Sapphire embed color.' },
  color_gold:       { id: 'color_gold',      name: 'Color: Gold',       emoji: '💛', category: 'cosmetic', type: 'permanent', price: 2000000, effect: { kind: 'color', value: 'gold', hex: 0xFFD700 }, description: 'Gold embed color (Premium).' },
  color_royal:      { id: 'color_royal',     name: 'Color: Royal',      emoji: '💜', category: 'cosmetic', type: 'permanent', price: 2000000, effect: { kind: 'color', value: 'royal', hex: 0x9B59B6 }, description: 'Royal embed color (Premium).' },
  color_obsidian:   { id: 'color_obsidian',  name: 'Color: Obsidian',   emoji: '⚫', category: 'cosmetic', type: 'permanent', price: 2000000, effect: { kind: 'color', value: 'obsidian', hex: 0x1A1A2E }, description: 'Obsidian embed color (Premium).' },
  // --- Abyss milestone titles: granted by Abyss Tower clears, NEVER purchasable ---
  // unlisted:true keeps them out of listBuyable() (shop pages + buy/use slash choices —
  // also protects Discord's 25-choice cap: 21 buyable + 7 would exceed it).
  // Equip via prefix: ky use title_drake_slayer (the id shows in the ky inv panel).
  title_gatebreaker:      { id: 'title_gatebreaker',      name: 'Title: Gatebreaker',      emoji: '🗝️', category: 'cosmetic', type: 'permanent', price: 0, unlisted: true, effect: { kind: 'title', value: 'Gatebreaker' },    description: 'Abyss milestone — clear Floor 1.' },
  title_drake_slayer:     { id: 'title_drake_slayer',     name: 'Title: Drake Slayer',     emoji: '🐉', category: 'cosmetic', type: 'permanent', price: 0, unlisted: true, effect: { kind: 'title', value: 'Drake Slayer' },   description: 'Abyss milestone — clear Floor 3.' },
  title_stormcaller:      { id: 'title_stormcaller',      name: 'Title: Stormcaller',      emoji: '⚡', category: 'cosmetic', type: 'permanent', price: 0, unlisted: true, effect: { kind: 'title', value: 'Stormcaller' },    description: 'Abyss milestone — clear Floor 5.' },
  title_frozen_heart:     { id: 'title_frozen_heart',     name: 'Title: Frozen Heart',     emoji: '❄️', category: 'cosmetic', type: 'permanent', price: 0, unlisted: true, effect: { kind: 'title', value: 'Frozen Heart' },   description: 'Abyss milestone — clear Floor 7.' },
  title_self_slayer:      { id: 'title_self_slayer',      name: 'Title: Self-Slayer',      emoji: '🪞', category: 'cosmetic', type: 'permanent', price: 0, unlisted: true, effect: { kind: 'title', value: 'Self-Slayer' },    description: 'Abyss milestone — clear Floor 9 (beat your mirror).' },
  title_abyssal_overlord: { id: 'title_abyssal_overlord', name: 'Title: Abyssal Overlord', emoji: '💀', category: 'cosmetic', type: 'permanent', price: 0, unlisted: true, effect: { kind: 'title', value: 'Abyssal Overlord' }, description: 'Abyss milestone — clear Floor 10.' },
  title_abyssal_master:   { id: 'title_abyssal_master',   name: 'Title: Abyssal Master',   emoji: '🌌', category: 'cosmetic', type: 'permanent', price: 0, unlisted: true, effect: { kind: 'title', value: 'Abyssal Master' },  description: 'Abyss 30-star mastery title.' },
};

// Legacy milestone labels (pre-catalog era stored the emoji'd display string in
// cosmetics.owned/equipped). Map display -> catalog id; normalizeCosmetics migrates old data.
const MILESTONE_TITLE_LABELS = {
  '🗝️ Gatebreaker': 'title_gatebreaker',
  '🐉 Drake Slayer': 'title_drake_slayer',
  '⚡ Stormcaller': 'title_stormcaller',
  '❄️ Frozen Heart': 'title_frozen_heart',
  '🪞 Self-Slayer': 'title_self_slayer',
  '💀 Abyssal Overlord': 'title_abyssal_overlord',
  '🌌 Abyssal Master': 'title_abyssal_master',
};

const WHEELS = { LUCKY_WHEEL, MYSTERY_WHEEL };

function getItem(id) { return ITEMS[id] || null; }
function listBuyable() { return Object.values(ITEMS).filter((i) => !i.unlisted); } // unlisted = milestone grants (never shop-listed, never buyable)

// Pick a wheel slice. rng is injectable for testing (defaults to Math.random).
function spinWheel(wheelName, rng = Math.random) {
  const wheel = WHEELS[wheelName];
  if (!wheel) return 0;
  const roll = rng();
  let acc = 0;
  for (const slice of wheel) {
    acc += slice.p;
    if (roll < acc) return slice.amt;
  }
  return wheel[wheel.length - 1].amt;
}

// Pure: apply a daily multiplier.
function applyDailyMultiplier(amount, mult) {
  return Math.floor(amount * mult);
}

// Expected value of a wheel (for self-check / tuning).
function wheelEV(wheelName) {
  const wheel = WHEELS[wheelName];
  if (!wheel) return 0;
  return wheel.reduce((s, sl) => s + sl.amt * sl.p, 0);
}

module.exports = {
  ITEMS, LUCKY_WHEEL, MYSTERY_WHEEL, MILESTONE_TITLE_LABELS,
  getItem, listBuyable, spinWheel, applyDailyMultiplier, wheelEV,
};

// ---- Self-check (run: node utils/shopItems.js) ----
if (require.main === module) {
  let fail = 0;
  const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fail++; } };

  ok(getItem('nope') === null, 'unknown item returns null');
  ok(listBuyable().length === 21, `catalog has 21 items, got ${listBuyable().length}`);

  // Wheels: EV below price (sink), probabilities sum to 1
  for (const [name, wheel] of Object.entries(WHEELS)) {
    const sumP = wheel.reduce((s, sl) => s + sl.p, 0);
    ok(Math.abs(sumP - 1) < 1e-9, `${name} probabilities sum to 1 (got ${sumP})`);
  }
  ok(wheelEV('LUCKY_WHEEL') < getItem('lucky_token').price, 'lucky wheel EV < price (sink)');
  ok(wheelEV('MYSTERY_WHEEL') < getItem('mystery_box').price, 'mystery wheel EV < price (sink)');

  // Daily multiplier
  ok(applyDailyMultiplier(300000, 1.5) === 450000, 'daily x1.5');
  ok(applyDailyMultiplier(300000, 2) === 600000, 'daily x2');

  // All prices positive & integers
  for (const it of listBuyable()) {
    ok(Number.isInteger(it.price) && it.price > 0, `${it.id} has positive integer price`);
  }

  console.log(fail === 0 ? 'OK shopItems self-check' : `${fail} CHECK(S) FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}
