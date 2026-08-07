// utils/shopManager.js
// Shop logic on economy.json. Atomic read-modify-write per operation.
// References economy I/O through the module object so the self-check can
// swap I/O without touching production behavior.
// Self-check: `node utils/shopManager.js`.
const economyManager = require('./economyManager');
const { getItem } = require('./shopItems');

// ---- Defensive accessors: existing users may lack shop fields ----
function inv(user) { return user.inventory || (user.inventory = {}); }
function cosmetics(user) {
  if (!user.cosmetics) user.cosmetics = { title: null, badge: null, color: null, owned: [] };
  if (!Array.isArray(user.cosmetics.owned)) user.cosmetics.owned = [];
  return user.cosmetics;
}
function boosts(user) { return user.activeBoosts || (user.activeBoosts = {}); }

/**
 * Snapshot of a user's shop state for display (does not mutate).
 */
function getInventoryState(userId) {
  const data = economyManager.readEconomy();
  const u = data[userId];
  if (!u) return null;
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

  const data = economyManager.readEconomy();
  const u = data[userId];
  if (!u) return { success: false, message: 'User not found.', newBalance: 0 };

  // Re-validate balance NOW (balance may have changed since a confirm screen was shown).
  if ((u.balance || 0) < item.price) {
    return { success: false, message: 'Insufficient balance.', newBalance: u.balance || 0 };
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

module.exports = { getInventoryState, equipCosmetic, purchase, inv, cosmetics, boosts };

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

    // 6. purchase: consumable. balance 1M -> lucky_token (250k) -> success, 750k, inv+1, totalLost+250k, ONE write.
    store = { '300': { username: 'buyer1', balance: 1000000, totalLost: 0 } };
    writes = 0; lastWrite = null;
    const r6 = purchase('300', 'lucky_token');
    ok(r6.success === true, 'purchase consumable succeeds');
    ok(r6.newBalance === 750000, `purchase consumable newBalance 750000 (got ${r6.newBalance})`);
    ok(store['300'].inventory && store['300'].inventory.lucky_token === 1, 'lucky_token granted (qty 1)');
    ok(store['300'].totalLost === 250000, `totalLost increased by 250k (got ${store['300'].totalLost})`);
    ok(writes === 1, `purchase consumable writes exactly once (got ${writes})`);

    // Atomicity proof: the single payload handed to writeEconomy carried BOTH the deduction AND the grant.
    ok(lastWrite && lastWrite['300'].balance === 750000 && lastWrite['300'].inventory.lucky_token === 1,
       'atomic write payload contains reduced balance AND granted item (no gap)');

    // 7. purchase: permanent. badge_crown (500k) -> success, 500k, owned includes it.
    //    Re-buy: charges again, does NOT duplicate the owned entry.
    store = { '301': { username: 'buyer2', balance: 1000000, totalLost: 0 } };
    writes = 0;
    const r7a = purchase('301', 'badge_crown');
    ok(r7a.success === true, 'purchase permanent succeeds');
    ok(r7a.newBalance === 500000, `purchase permanent newBalance 500000 (got ${r7a.newBalance})`);
    ok(store['301'].cosmetics && store['301'].cosmetics.owned.includes('badge_crown'), 'badge_crown in owned');
    writes = 0;
    const r7b = purchase('301', 'badge_crown');
    ok(r7b.success === true, 're-buy permanent succeeds (charges again)');
    ok(store['301'].balance === 0, `re-buy deducts price again (balance ${store['301'].balance})`);
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
    const r9a = purchase('303', 'lucky_token'); // success -> 750k
    ok(r9a.success === true, 'first purchase succeeds before balance drops');
    store['303'].balance = 0; // simulate balance dropping between confirm screen and click
    const r9b = purchase('303', 'shield_50'); // re-check catches the new low balance
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
  } finally {
    // Restore originals so we never leak the stub into other requires.
    economyManager.readEconomy = origRead;
    economyManager.writeEconomy = origWrite;
    economyManager.isSuperAdmin = origIsAdmin;
  }

  console.log(fail === 0 ? 'OK shopManager self-check' : `${fail} CHECK(S) FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}
