// utils/shopManager.js
// Shop logic on economy.json. Atomic read-modify-write per operation.
// References economy I/O through the module object so the self-check can
// swap I/O without touching production behavior.
// Self-check: `node utils/shopManager.js`.
const economyManager = require('./economyManager');
const { getItem, spinWheel, LUCKY_WHEEL, MILESTONE_TITLE_LABELS } = require('./shopItems');

// ---- Defensive accessors: existing users may lack shop fields ----
function inv(user) { return user.inventory || (user.inventory = {}); }
// Pre-catalog era: Abyss milestones pushed the emoji'd DISPLAY STRING into cosmetics.
// Those can never equip (getItem looks up catalog ids). Normalize label -> id, in place,
// idempotent — runs on every cosmetics access, so old data self-heals on first touch.
function normalizeCosmetics(user) {
  const c = user.cosmetics;
  if (!c) return;
  if (c.title && MILESTONE_TITLE_LABELS[c.title]) c.title = MILESTONE_TITLE_LABELS[c.title];
  if (Array.isArray(c.owned)) c.owned = c.owned.map((x) => MILESTONE_TITLE_LABELS[x] || x);
}
function cosmetics(user) {
  if (!user.cosmetics) user.cosmetics = { title: null, badge: null, color: null, owned: [] };
  if (!Array.isArray(user.cosmetics.owned)) user.cosmetics.owned = [];
  normalizeCosmetics(user);
  return user.cosmetics;
}
function boosts(user) { return user.activeBoosts || (user.activeBoosts = {}); }

/**
 * Snapshot of a user's shop state for display (does not mutate).
 */
function getInventoryState(userId) {
  if (economyManager.isSuperAdmin(userId)) {
    // Superadmin isn't in economy.json (unlimited mode) — return a synthetic empty
    // state so /inventory shows an empty bag instead of "not registered yet".
    return { inventory: {}, cosmetics: { title: null, badge: null, color: null, owned: [] }, activeBoosts: {} };
  }
  const data = economyManager.readEconomy();
  const u = data[userId];
  if (!u) return null;
  if (u.cosmetics) normalizeCosmetics(u); // inv/profile view also self-heals legacy labels
  return {
    inventory: { ...(u.inventory || {}) },
    cosmetics: {
      title: (u.cosmetics && u.cosmetics.title) || null,
      badge: (u.cosmetics && u.cosmetics.badge) || null,
      color: (u.cosmetics && u.cosmetics.color) || null,
      owned: (u.cosmetics && Array.isArray(u.cosmetics.owned)) ? [...u.cosmetics.owned] : [],
    },
    activeBoosts: { ...(u.activeBoosts || {}) },
  };
}

/**
 * Equip an owned cosmetic. Permanent ownership, free switching (Model A).
 * @returns {{ success: boolean, message: string }}
 */
function equipCosmetic(userId, itemId) {
  if (economyManager.isSuperAdmin(userId)) return { success: true, message: 'Equipped (superadmin).' };
  const item = getItem(itemId);
  if (!item || item.type !== 'permanent') return { success: false, message: 'That item cannot be equipped.' };

  const data = economyManager.readEconomy();
  const u = data[userId];
  if (!u) return { success: false, message: 'User not found.' };
  const c = cosmetics(u);

  if (!c.owned.includes(itemId)) return { success: false, message: 'You do not own this cosmetic.' };

  // Map cosmetic kind -> equipped slot, storing the item id.
  if (item.effect.kind === 'title') c.title = itemId;
  else if (item.effect.kind === 'badge') c.badge = itemId;
  else if (item.effect.kind === 'color') c.color = itemId;
  else return { success: false, message: 'Unknown cosmetic kind.' };

  economyManager.writeEconomy(data);
  return { success: true, message: `Equipped **${item.name}**.` };
}

/**
 * Atomically purchase an item: deduct price + grant item in ONE read-modify-write.
 * Idempotent-safe: re-checks balance at call time (use again on confirm-click).
 * @returns {{ success: boolean, message: string, newBalance: number }}
 */
function purchase(userId, itemId) {
  if (economyManager.isSuperAdmin(userId)) return { success: true, message: 'Added (superadmin).', newBalance: Infinity };

  const item = getItem(itemId);
  if (!item) return { success: false, message: 'Item not found.', newBalance: 0 };
  if (item.unlisted) return { success: false, message: 'This item cannot be purchased — it is earned, not bought.', newBalance: 0 }; // milestone grants: price 0, never buyable

  const data = economyManager.readEconomy();
  const u = data[userId];
  if (!u) return { success: false, message: 'User not found.', newBalance: 0 };

  // Re-validate balance NOW (balance may have changed since a confirm screen was shown).
  if ((u.balance || 0) < item.price) {
    return { success: false, message: 'Insufficient balance.', newBalance: u.balance || 0 };
  }

  // Block re-buying an already-owned permanent cosmetic (no wasting Kryztal on a duplicate).
  if (item.type === 'permanent' && cosmetics(u).owned.includes(itemId)) {
    return { success: false, message: 'You already own this cosmetic.', newBalance: u.balance || 0 };
  }

  // ---- single atomic mutation block ----
  u.balance -= item.price;
  u.totalLost = (u.totalLost || 0) + item.price;

  if (item.type === 'permanent') {
    const c = cosmetics(u);
    if (!c.owned.includes(itemId)) c.owned.push(itemId);
  } else {
    inv(u)[itemId] = (inv(u)[itemId] || 0) + 1;
  }
  economyManager.writeEconomy(data);
  // ---- end atomic block ----

  return { success: true, message: `Purchased **${item.name}**.`, newBalance: u.balance };
}

/**
 * Use a consumable from inventory.
 * - daily_boost: arm a flag on activeBoosts (consumed by game hooks).
 * - spin: resolve the wheel immediately and credit the prize.
 * @returns {{ success: boolean, message: string, outcome?: { prize: number } }}
 */
function useItem(userId, itemId) {
  if (economyManager.isSuperAdmin(userId)) return { success: true, message: 'Used (superadmin).' };

  const item = getItem(itemId);
  if (!item || item.type !== 'consumable') {
    return { success: false, message: 'That item cannot be used.' };
  }

  const data = economyManager.readEconomy();
  const u = data[userId];
  if (!u) return { success: false, message: 'User not found.' };

  const inventory = inv(u);
  if (!inventory[itemId] || inventory[itemId] <= 0) {
    return { success: false, message: 'You do not have this item.' };
  }

  const b = boosts(u);
  const eff = item.effect;

  if (eff.kind === 'daily_boost') {
    // Queue the multiplier for the next daily claim (consumed in claimDaily).
    b.daily_mult = eff.mult;
    inventory[itemId] -= 1;
    if (inventory[itemId] <= 0) delete inventory[itemId];
    economyManager.writeEconomy(data);
    return { success: true, message: `📅 Daily boost armed (x${eff.mult}). It applies to your next /kyriz daily.` };
  }

  if (eff.kind === 'spin') {
    const prize = spinWheel(eff.wheel);
    inventory[itemId] -= 1;
    if (inventory[itemId] <= 0) delete inventory[itemId];
    u.balance = (u.balance || 0) + prize;
    u.totalEarned = (u.totalEarned || 0) + prize;
    economyManager.writeEconomy(data);
    return { success: true, message: `You won **💎 ${prize.toLocaleString()}**!`, outcome: { prize } };
  }

  return { success: false, message: 'Unknown consumable effect.' };
}

module.exports = { getInventoryState, equipCosmetic, purchase, useItem, inv, cosmetics, boosts };

// ---- Self-check (run: node utils/shopManager.js) ----
// Monkeypatches economyManager.readEconomy/writeEconomy to an in-memory store
// so equipCosmetic's real I/O path is exercised without touching data/economy.json.
if (require.main === module) {
  let fail = 0;
  const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fail++; } };

  // In-memory store + write counter.
  let store = {};
  let writes = 0;
  let lastWrite = null; // captured payload for atomicity proof
  const origRead = economyManager.readEconomy;
  const origWrite = economyManager.writeEconomy;
  const origIsAdmin = economyManager.isSuperAdmin;
  economyManager.readEconomy = () => store;
  economyManager.writeEconomy = (data) => { store = data; lastWrite = data; writes++; };
  // SUPERADMIN_ID is unset in the self-check, so isSuperAdmin always returns false.

  try {
    // 1. getInventoryState on a user with NO shop fields (defensiveness).
    store = { '100': { username: 'bare', balance: 100 } };
    const snap = getInventoryState('100');
    ok(snap !== null, 'snapshot for bare user is non-null');
    ok(snap && snap.cosmetics.title === null, 'bare user title null');
    ok(snap && snap.cosmetics.badge === null, 'bare user badge null');
    ok(snap && snap.cosmetics.color === null, 'bare user color null');
    ok(snap && Array.isArray(snap.cosmetics.owned) && snap.cosmetics.owned.length === 0, 'bare user owned []');
    ok(snap && typeof snap.inventory === 'object' && Object.keys(snap.inventory).length === 0, 'bare user inventory {}');
    ok(snap && typeof snap.activeBoosts === 'object' && Object.keys(snap.activeBoosts).length === 0, 'bare user activeBoosts {}');
    ok(snap && getInventoryState('404') === null, 'non-existent user snapshot null');

    // 1b. superadmin: getInventoryState returns a synthetic EMPTY state and does NOT
    // touch economy.json (superadmin isn't stored there). Fixes the "/inventory says
    // not registered" bug for superadmin.
    process.env.SUPERADMIN_ID = 'SUPER1';
    economyManager.readEconomy = () => { throw new Error('superadmin must not read economy'); };
    const superSnap = getInventoryState('SUPER1');
    ok(superSnap !== null, 'superadmin snapshot non-null (not "not registered")');
    ok(superSnap && Object.keys(superSnap.inventory).length === 0, 'superadmin inventory empty {}');
    ok(superSnap && superSnap.cosmetics && superSnap.cosmetics.owned.length === 0, 'superadmin cosmetics empty');
    ok(superSnap && superSnap.activeBoosts && Object.keys(superSnap.activeBoosts).length === 0, 'superadmin activeBoosts empty');
    economyManager.readEconomy = () => store; // restore
    delete process.env.SUPERADMIN_ID;

    // 2. equipCosmetic on an OWNED badge succeeds, sets cosmetics.badge, writes once.
    store = { '200': { username: 'owner', balance: 100, cosmetics: { title: null, badge: null, color: null, owned: ['badge_crown'] } } };
    writes = 0;
    const r2 = equipCosmetic('200', 'badge_crown');
    ok(r2.success === true, 'equip owned badge succeeds');
    ok(writes === 1, `equip owned badge writes once (got ${writes})`);
    ok(store['200'].cosmetics.badge === 'badge_crown', 'badge slot set to badge_crown');

    // 3. equipCosmetic on a cosmetic NOT owned fails {success:false}, no slot mutation.
    store = { '201': { username: 'notowner', balance: 100, cosmetics: { title: null, badge: null, color: null, owned: [] } } };
    writes = 0;
    const r3 = equipCosmetic('201', 'badge_crown');
    ok(r3.success === false, 'equip unowned cosmetic fails');
    ok(writes === 0, `equip unowned cosmetic does not write (got ${writes})`);
    ok(store['201'].cosmetics.badge === null, 'badge slot unchanged after failed equip');

    // 4. equipCosmetic with a consumable id or unknown id fails {success:false}.
    store = { '202': { username: 'cons', balance: 100, cosmetics: { title: null, badge: null, color: null, owned: ['lucky_token'] } } };
    writes = 0;
    const r4a = equipCosmetic('202', 'lucky_token');
    ok(r4a.success === false, 'equip consumable (lucky_token) fails');
    ok(writes === 0, `equip consumable does not write (got ${writes})`);
    const r4b = equipCosmetic('202', 'totally_fake_id');
    ok(r4b.success === false, 'equip unknown id fails');

    // 5. equipCosmetic on a non-existent user fails {success:false}.
    store = {};
    writes = 0;
    const r5 = equipCosmetic('999', 'badge_crown');
    ok(r5.success === false, 'equip on non-existent user fails');
    ok(writes === 0, `equip on non-existent user does not write (got ${writes})`);

    // 6. purchase: consumable. balance 1M -> lucky_token (200k) -> success, 800k, inv+1, totalLost+200k, ONE write.
    store = { '300': { username: 'buyer1', balance: 1000000, totalLost: 0 } };
    writes = 0; lastWrite = null;
    const r6 = purchase('300', 'lucky_token');
    ok(r6.success === true, 'purchase consumable succeeds');
    ok(r6.newBalance === 800000, `purchase consumable newBalance 800000 (got ${r6.newBalance})`);
    ok(store['300'].inventory && store['300'].inventory.lucky_token === 1, 'lucky_token granted (qty 1)');
    ok(store['300'].totalLost === 200000, `totalLost increased by 200k (got ${store['300'].totalLost})`);
    ok(writes === 1, `purchase consumable writes exactly once (got ${writes})`);

    // Atomicity proof: the single payload handed to writeEconomy carried BOTH the deduction AND the grant.
    ok(lastWrite && lastWrite['300'].balance === 800000 && lastWrite['300'].inventory.lucky_token === 1,
       'atomic write payload contains reduced balance AND granted item (no gap)');

    // 7. purchase: permanent. badge_crown (500k) -> success, 500k, owned includes it.
    //    Re-buy: BLOCKED (already owned) — balance unchanged, no extra write.
    store = { '301': { username: 'buyer2', balance: 1000000, totalLost: 0 } };
    writes = 0;
    const r7a = purchase('301', 'badge_crown');
    ok(r7a.success === true, 'purchase permanent succeeds');
    ok(r7a.newBalance === 500000, `purchase permanent newBalance 500000 (got ${r7a.newBalance})`);
    ok(store['301'].cosmetics && store['301'].cosmetics.owned.includes('badge_crown'), 'badge_crown in owned');
    writes = 0;
    const r7b = purchase('301', 'badge_crown');
    ok(r7b.success === false, 're-buy owned permanent is BLOCKED');
    ok(r7b.newBalance === 500000, `re-buy returns unchanged balance (got ${r7b.newBalance})`);
    ok(store['301'].balance === 500000, `re-buy does not deduct (balance ${store['301'].balance})`);
    ok(writes === 0, `re-buy writes zero (got ${writes})`);
    ok(store['301'].cosmetics.owned.filter((id) => id === 'badge_crown').length === 1, 'owned lists badge_crown exactly once (no dup)');

    // 8. purchase: insufficient balance. balance 100 -> lucky_token -> {success:false}, no mutation, no write.
    store = { '302': { username: 'poor', balance: 100, totalLost: 0 } };
    writes = 0; lastWrite = null;
    const r8 = purchase('302', 'lucky_token');
    ok(r8.success === false, 'insufficient balance fails {success:false}');
    ok(store['302'].balance === 100, 'balance unchanged after insufficient purchase');
    ok(!store['302'].inventory || store['302'].inventory.lucky_token === undefined, 'inventory unchanged after insufficient purchase');
    ok(writes === 0, `insufficient balance writes zero (got ${writes})`);

    // 9. purchase: re-validation at call time. Buy (success); drop balance to 0; buy again -> {success:false}.
    store = { '303': { username: 'race', balance: 1000000, totalLost: 0 } };
    writes = 0;
    const r9a = purchase('303', 'lucky_token'); // success -> 800k
    ok(r9a.success === true, 'first purchase succeeds before balance drops');
    store['303'].balance = 0; // simulate balance dropping between confirm screen and click
    const r9b = purchase('303', 'lucky_token'); // re-check catches the new low balance
    ok(r9b.success === false, 're-validation rejects purchase after balance dropped to 0');

    // 10. purchase: unknown item / missing user -> {success:false}, zero writes.
    store = { '304': { username: 'x', balance: 1000000, totalLost: 0 } };
    writes = 0;
    const r10a = purchase('304', 'totally_fake_id');
    ok(r10a.success === false, 'unknown item fails {success:false}');
    ok(writes === 0, `unknown item writes zero (got ${writes})`);
    writes = 0;
    const r10b = purchase('404', 'lucky_token');
    ok(r10b.success === false, 'missing user fails {success:false}');
    ok(writes === 0, `missing user writes zero (got ${writes})`);

    // 11. useItem: daily_boost_20 (x2.0). inventory.daily_boost_20=1 -> daily_mult=2, deletes item, ONE write.
    store = { '400': { username: 'boosted20', balance: 100000, inventory: { daily_boost_20: 1 } } };
    writes = 0;
    const r11 = useItem('400', 'daily_boost_20');
    ok(r11.success === true, 'useItem daily_boost_20 succeeds');
    ok(writes === 1, `useItem daily_boost_20 writes once (got ${writes})`);
    ok(store['400'].activeBoosts && store['400'].activeBoosts.daily_mult === 2, 'daily_mult armed to 2');
    ok(store['400'].inventory.daily_boost_20 === undefined, 'daily_boost_20 deleted from inventory at qty 0');

    // 12. useItem: daily_boost. daily_boost_15 (qty 2) -> daily_mult=1.5, decremented to 1 (not deleted).
    store = { '401': { username: 'boosted', balance: 100000, inventory: { daily_boost_15: 2 } } };
    writes = 0;
    const r12 = useItem('401', 'daily_boost_15');
    ok(r12.success === true, 'useItem daily_boost succeeds');
    ok(writes === 1, `useItem daily_boost writes once (got ${writes})`);
    ok(store['401'].activeBoosts && store['401'].activeBoosts.daily_mult === 1.5, 'daily_mult armed to 1.5');
    ok(store['401'].inventory.daily_boost_15 === 1, 'daily_boost_15 decremented to 1 (kept at qty>0)');

    // 13. useItem: spin (lucky_token). balance 100k -> balance+prize, prize in LUCKY_WHEEL;
    //     totalEarned += prize; lucky_token deleted; ONE write. Prize is random -> assert membership + accounting.
    store = { '402': { username: 'spinner', balance: 100000, totalEarned: 0, inventory: { lucky_token: 1 } } };
    writes = 0;
    const r13 = useItem('402', 'lucky_token');
    const wheelAmts = LUCKY_WHEEL.map((s) => s.amt);
    ok(r13.success === true, 'useItem spin succeeds');
    ok(r13.outcome && typeof r13.outcome.prize === 'number', 'spin outcome has numeric prize');
    ok(r13.outcome && wheelAmts.includes(r13.outcome.prize), `spin prize is a LUCKY_WHEEL amount (got ${r13.outcome && r13.outcome.prize})`);
    ok(writes === 1, `useItem spin writes once (got ${writes})`);
    ok(store['402'].inventory.lucky_token === undefined, 'lucky_token deleted after spin');
    ok(store['402'].balance === 100000 + r13.outcome.prize, `balance increased by exact prize (got ${store['402'].balance})`);
    ok(store['402'].totalEarned === r13.outcome.prize, `totalEarned increased by exact prize (got ${store['402'].totalEarned})`);

    // 14. useItem: not in inventory -> {success:false}, no mutation, zero writes.
    store = { '403': { username: 'empty', balance: 100000, inventory: {} } };
    writes = 0;
    const r14 = useItem('403', 'daily_boost_15');
    ok(r14.success === false, 'useItem on missing inventory item fails');
    ok(writes === 0, `useItem missing item writes zero (got ${writes})`);
    ok(Object.keys(store['403'].inventory).length === 0, 'inventory unchanged after failed use');

    // 15. useItem: cosmetic id -> {success:false} (cosmetics go through equipCosmetic). Owned, still rejected.
    store = { '410': { username: 'cos', balance: 100000, cosmetics: { title: null, badge: null, color: null, owned: ['badge_crown'] } } };
    writes = 0;
    const r15 = useItem('410', 'badge_crown');
    ok(r15.success === false, 'useItem on cosmetic id fails (use equipCosmetic)');
    ok(writes === 0, `useItem cosmetic writes zero (got ${writes})`);

    // 16. useItem: unknown item / missing user -> {success:false}, zero writes.
    store = { '405': { username: 'x', balance: 100000, inventory: { lucky_token: 1 } } };
    writes = 0;
    const r16a = useItem('405', 'totally_fake_id');
    ok(r16a.success === false, 'useItem unknown item fails');
    ok(writes === 0, `useItem unknown item writes zero (got ${writes})`);
    writes = 0;
    const r16b = useItem('999', 'lucky_token');
    ok(r16b.success === false, 'useItem missing user fails');
    ok(writes === 0, `useItem missing user writes zero (got ${writes})`);

    // 17. milestone titles: legacy display labels self-heal to catalog ids + equip works.
    // (bugfix: pre-catalog era stored '🐉 Drake Slayer' in cosmetics — unequippable forever)
    store = { '411': { username: 'mz', balance: 0, cosmetics: { title: '🐉 Drake Slayer', badge: null, color: null, owned: ['🐉 Drake Slayer', '🪞 Self-Slayer'] } } };
    writes = 0;
    const st17 = getInventoryState('411');
    ok(JSON.stringify(st17.cosmetics.owned) === JSON.stringify(['title_drake_slayer', 'title_self_slayer']), 'legacy owned labels normalize to catalog ids on view');
    ok(st17.cosmetics.title === 'title_drake_slayer', 'legacy equipped label normalizes too');
    const r17 = equipCosmetic('411', 'title_self_slayer');
    ok(r17.success === true, 'milestone title equips after migration (ky use title_self_slayer)');
    ok(writes >= 1, 'equip writes');

    // 18. milestone titles are NEVER purchasable (unlisted, price 0 — earned only).
    store = { '412': { username: 'by', balance: 999999999 } };
    writes = 0;
    const r18 = purchase('412', 'title_abyssal_master');
    ok(r18.success === false, 'purchasing a milestone title is blocked');
    ok(writes === 0, 'blocked milestone purchase writes zero');
  } finally {
    // Restore originals so we never leak the stub into other requires.
    economyManager.readEconomy = origRead;
    economyManager.writeEconomy = origWrite;
    economyManager.isSuperAdmin = origIsAdmin;
  }

  console.log(fail === 0 ? 'OK shopManager self-check' : `${fail} CHECK(S) FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}
