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

module.exports = { getInventoryState, equipCosmetic, inv, cosmetics, boosts };

// ---- Self-check (run: node utils/shopManager.js) ----
// Monkeypatches economyManager.readEconomy/writeEconomy to an in-memory store
// so equipCosmetic's real I/O path is exercised without touching data/economy.json.
if (require.main === module) {
  let fail = 0;
  const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fail++; } };

  // In-memory store + write counter.
  let store = {};
  let writes = 0;
  const origRead = economyManager.readEconomy;
  const origWrite = economyManager.writeEconomy;
  const origIsAdmin = economyManager.isSuperAdmin;
  economyManager.readEconomy = () => store;
  economyManager.writeEconomy = (data) => { store = data; writes++; };
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
  } finally {
    // Restore originals so we never leak the stub into other requires.
    economyManager.readEconomy = origRead;
    economyManager.writeEconomy = origWrite;
    economyManager.isSuperAdmin = origIsAdmin;
  }

  console.log(fail === 0 ? 'OK shopManager self-check' : `${fail} CHECK(S) FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}
