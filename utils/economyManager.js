const fs = require('fs');
const path = require('path');

const ECONOMY_PATH = path.join(__dirname, '..', 'data', 'economy.json');

// ============================================================
// Helper: Read & write JSON
// ============================================================

function readJSON(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeJSON(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

// ============================================================
// Superadmin check
// ============================================================

function isSuperAdmin(userId) {
  return userId === process.env.SUPERADMIN_ID;
}

/**
 * Check if a user is an admin (set via /kyriz user add)
 */
function isAdmin(userId) {
  if (isSuperAdmin(userId)) return true;
  const data = readJSON(ECONOMY_PATH);
  return !!(data[userId] && data[userId].isAdmin);
}

/**
 * Set a user as admin, register if needed, and add balance
 */
function setAdmin(userId, username, bonusAmount = 10000000) {
  const data = readJSON(ECONOMY_PATH);

  if (!data[userId]) {
    // Register the user first
    data[userId] = {
      username: username,
      balance: bonusAmount,
      level: 1,
      xp: 0,
      xpNeeded: 400,
      totalWins: 0,
      totalLosses: 0,
      totalEarned: bonusAmount,
      totalLost: 0,
      lastDaily: null,
      registeredAt: new Date().toISOString(),
      isAdmin: true,
    };
  } else {
    data[userId].isAdmin = true;
    data[userId].balance += bonusAmount;
    data[userId].totalEarned += bonusAmount;
  }

  writeJSON(ECONOMY_PATH, data);
  return { success: true, newBalance: data[userId].balance };
}

/**
 * Remove admin flag from a user
 */
function removeAdmin(userId) {
  const data = readJSON(ECONOMY_PATH);
  if (data[userId]) {
    data[userId].isAdmin = false;
    writeJSON(ECONOMY_PATH, data);
  }
}

// ============================================================
// User management
// ============================================================

/**
 * Check if a user is registered in the economy system
 */
function isRegistered(userId) {
  if (isSuperAdmin(userId)) return true;
  const data = readJSON(ECONOMY_PATH);
  return !!data[userId];
}

/**
 * Register a new user with starting balance
 * @returns {{ success: boolean, message: string }}
 */
function registerUser(userId, username) {
  const data = readJSON(ECONOMY_PATH);

  if (data[userId]) {
    return { success: false, message: 'User is already registered.' };
  }

  data[userId] = {
    username: username,
    balance: 100000,
    level: 1,
    xp: 0,
    xpNeeded: 400, // Level 1->2 needs 400 XP (level * 200, next level is 2)
    totalWins: 0,
    totalLosses: 0,
    totalEarned: 0,
    totalLost: 0,
    lastDaily: null,
    registeredAt: new Date().toISOString(),
  };

  writeJSON(ECONOMY_PATH, data);
  return { success: true, message: 'User registered successfully.' };
}

/**
 * Get user profile. Returns null if not registered.
 * For superadmin, returns a special unlimited profile.
 */
function getUser(userId) {
  if (isSuperAdmin(userId)) {
    return {
      username: 'Superadmin',
      balance: Infinity,
      level: '?',
      xp: '?',
      xpNeeded: '?',
      totalWins: 0,
      totalLosses: 0,
      totalEarned: 0,
      totalLost: 0,
      lastDaily: null,
      isSuperAdmin: true,
    };
  }

  const data = readJSON(ECONOMY_PATH);
  return data[userId] || null;
}

/**
 * Update username (in case they changed it)
 */
function updateUsername(userId, username) {
  if (isSuperAdmin(userId)) return;
  const data = readJSON(ECONOMY_PATH);
  if (data[userId]) {
    data[userId].username = username;
    writeJSON(ECONOMY_PATH, data);
  }
}

// ============================================================
// Balance operations
// ============================================================

/**
 * Add balance to a user
 * @returns {{ success: boolean, newBalance: number }}
 */
function addBalance(userId, amount) {
  if (isSuperAdmin(userId)) return { success: true, newBalance: Infinity };

  const data = readJSON(ECONOMY_PATH);
  if (!data[userId]) return { success: false, newBalance: 0 };

  data[userId].balance += amount;
  data[userId].totalEarned += amount;
  writeJSON(ECONOMY_PATH, data);
  return { success: true, newBalance: data[userId].balance };
}

/**
 * Remove balance from a user
 * @returns {{ success: boolean, message: string, newBalance: number }}
 */
function removeBalance(userId, amount) {
  if (isSuperAdmin(userId)) return { success: true, message: 'OK', newBalance: Infinity };

  const data = readJSON(ECONOMY_PATH);
  if (!data[userId]) return { success: false, message: 'User not found.', newBalance: 0 };

  if (data[userId].balance < amount) {
    return { success: false, message: 'Insufficient balance.', newBalance: data[userId].balance };
  }

  data[userId].balance -= amount;
  data[userId].totalLost += amount;
  writeJSON(ECONOMY_PATH, data);
  return { success: true, message: 'OK', newBalance: data[userId].balance };
}

/**
 * Get user balance
 */
function getBalance(userId) {
  if (isSuperAdmin(userId)) return Infinity;
  const data = readJSON(ECONOMY_PATH);
  if (!data[userId]) return 0;
  return data[userId].balance;
}

// ============================================================
// Transfer
// ============================================================

/**
 * Transfer balance between users
 * @returns {{ success: boolean, message: string }}
 */
const MAX_TRANSFER = 2_000_000;

function transfer(fromId, toId, amount) {
  if (amount <= 0) return { success: false, message: 'Amount must be greater than 0.' };
  if (amount > MAX_TRANSFER) return { success: false, message: `Maximum transfer is ${MAX_TRANSFER.toLocaleString()} Kryztal.` };

  const data = readJSON(ECONOMY_PATH);

  // Check sender (superadmin has unlimited)
  if (!isSuperAdmin(fromId)) {
    if (!data[fromId]) return { success: false, message: 'Sender not found.' };
    if (data[fromId].balance < amount) return { success: false, message: 'Insufficient balance.' };
  }

  // Check receiver
  if (!data[toId]) return { success: false, message: 'Recipient is not registered yet.' };

  // Deduct from sender (skip for superadmin)
  if (!isSuperAdmin(fromId)) {
    data[fromId].balance -= amount;
    data[fromId].totalLost += amount;
  }

  // Add to receiver
  data[toId].balance += amount;
  data[toId].totalEarned += amount;

  writeJSON(ECONOMY_PATH, data);
  return { success: true, message: 'Transfer successful.' };
}

// ============================================================
// XP & Leveling
// ============================================================

/**
 * Add XP to a user. Handles level up automatically.
 * @returns {{ leveledUp: boolean, newLevel: number, xp: number, xpNeeded: number }}
 */
function addXP(userId, amount) {
  if (isSuperAdmin(userId)) return { leveledUp: false, newLevel: 0, xp: 0, xpNeeded: 0 };

  const data = readJSON(ECONOMY_PATH);
  if (!data[userId]) return { leveledUp: false, newLevel: 0, xp: 0, xpNeeded: 0 };

  const user = data[userId];
  user.xp += amount;

  let leveledUp = false;
  let levelsGained = 0;
  let totalReward = 0;

  // Check for level up (could be multiple levels in theory)
  while (user.xp >= user.xpNeeded) {
    user.xp -= user.xpNeeded; // Reset XP (keep overflow)

    // Actually, user wants XP to reset to 0 on level up
    user.xp = 0;

    user.level += 1;
    user.xpNeeded = (user.level + 1) * 200; // Next level requirement

    // Random reward: 150k-500k, weighted towards lower (Math.random()^2)
    const reward = 150000 + Math.floor(Math.pow(Math.random(), 2) * 350000);
    user.balance += reward;
    user.totalEarned += reward;
    totalReward += reward;

    leveledUp = true;
    levelsGained += 1;
  }

  writeJSON(ECONOMY_PATH, data);

  return {
    leveledUp,
    levelsGained,
    newLevel: user.level,
    xp: user.xp,
    xpNeeded: user.xpNeeded,
    rewardTotal: totalReward,
  };
}

/**
 * Record a win
 */
function recordWin(userId) {
  if (isSuperAdmin(userId)) return;
  const data = readJSON(ECONOMY_PATH);
  if (data[userId]) {
    data[userId].totalWins += 1;
    writeJSON(ECONOMY_PATH, data);
  }
}

/**
 * Record a loss
 */
function recordLoss(userId) {
  if (isSuperAdmin(userId)) return;
  const data = readJSON(ECONOMY_PATH);
  if (data[userId]) {
    data[userId].totalLosses += 1;
    writeJSON(ECONOMY_PATH, data);
  }
}

// ============================================================
// Daily reward
// ============================================================

/**
 * Claim daily reward
 * @returns {{ success: boolean, message: string, amount: number }}
 */
function claimDaily(userId) {
  if (isSuperAdmin(userId)) {
    return { success: true, message: 'Daily claimed.', amount: 0, isSuperAdmin: true };
  }

  const data = readJSON(ECONOMY_PATH);
  if (!data[userId]) return { success: false, message: 'User not found.', amount: 0 };

  const user = data[userId];
  const now = new Date();

  // Use WIB (UTC+7) for daily reset at 00:00 WIB
  const wibOffset = 7 * 60 * 60 * 1000; // 7 hours in ms
  const wibNow = new Date(now.getTime() + wibOffset);
  const today = wibNow.toISOString().split('T')[0]; // YYYY-MM-DD in WIB

  if (user.lastDaily === today) {
    // Calculate time until next daily (00:00 WIB = 17:00 UTC)
    const wibMidnight = new Date(Date.UTC(
      wibNow.getUTCFullYear(), wibNow.getUTCMonth(), wibNow.getUTCDate() + 1, 0, 0, 0, 0
    ));
    const nextResetUTC = new Date(wibMidnight.getTime() - wibOffset);
    const diff = nextResetUTC - now;
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

    const timeStr = (hours === 0 && minutes === 0)
      ? 'less than a minute'
      : `**${hours}h ${minutes}m**`;

    return {
      success: false,
      message: `You already claimed your daily reward today. Come back in ${timeStr}.`,
      amount: 0,
    };
  }

  // Daily reward: random between 5,000 - 15,000
  const dailyAmount = Math.floor(Math.random() * 10001) + 5000;

  user.balance += dailyAmount;
  user.totalEarned += dailyAmount;
  user.lastDaily = today;

  writeJSON(ECONOMY_PATH, data);

  return { success: true, message: 'Daily claimed.', amount: dailyAmount };
}

// ============================================================
// Leaderboard
// ============================================================

/**
 * Get top users by balance (excludes superadmin)
 * @returns {Array<{ userId: string, username: string, balance: number, level: number }>}
 */
function getLeaderboard(limit = 10) {
  const data = readJSON(ECONOMY_PATH);
  const superAdminId = process.env.SUPERADMIN_ID;

  const users = Object.entries(data)
    .filter(([id]) => id !== superAdminId) // Exclude superadmin
    .filter(([id, user]) => !user.isAdmin) // Exclude admins
    .map(([id, user]) => ({
      userId: id,
      username: user.username,
      balance: user.balance,
      level: user.level,
    }))
    .sort((a, b) => b.balance - a.balance)
    .slice(0, limit);

  return users;
}

module.exports = {
  isSuperAdmin,
  isAdmin,
  setAdmin,
  removeAdmin,
  isRegistered,
  registerUser,
  getUser,
  updateUsername,
  addBalance,
  removeBalance,
  getBalance,
  transfer,
  addXP,
  recordWin,
  recordLoss,
  claimDaily,
  getLeaderboard,
};
