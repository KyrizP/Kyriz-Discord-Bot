const fs = require('fs');
const path = require('path');

const REPLIES_PATH = path.join(__dirname, '..', 'data', 'replies.json');
const USERS_PATH = path.join(__dirname, '..', 'data', 'users.json');

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
// Auto-Reply: CRUD operations
// ============================================================

/**
 * Get all auto-replies for a server (guild)
 */
function getReplies(guildId) {
  const data = readJSON(REPLIES_PATH);
  return data[guildId] || {};
}

/**
 * Add a new auto-reply
 * @returns {{ success: boolean, message: string }}
 */
function addReply(guildId, trigger, reply, caseSensitive = false, matchMode = 'contains') {
  const data = readJSON(REPLIES_PATH);
  if (!data[guildId]) data[guildId] = {};

  const key = trigger.toLowerCase();

  if (data[guildId][key]) {
    return { success: false, message: `Trigger "${trigger}" already exists. Use \`/kyriz autoreply edit\` to modify it.` };
  }

  data[guildId][key] = {
    trigger: trigger, // Store original trigger (before lowercase)
    reply,
    caseSensitive,
    matchMode,
  };

  writeJSON(REPLIES_PATH, data);
  return { success: true, message: `Auto-reply added successfully.` };
}

/**
 * Remove an auto-reply
 * @returns {{ success: boolean, message: string }}
 */
function removeReply(guildId, trigger) {
  const data = readJSON(REPLIES_PATH);
  const key = trigger.toLowerCase();

  if (!data[guildId] || !data[guildId][key]) {
    return { success: false, message: `Trigger "${trigger}" not found.` };
  }

  delete data[guildId][key];
  writeJSON(REPLIES_PATH, data);
  return { success: true, message: `Auto-reply "${trigger}" has been removed.` };
}

/**
 * Edit an existing auto-reply
 * Only updates fields that are provided (not null/undefined)
 * @returns {{ success: boolean, message: string }}
 */
function editReply(guildId, trigger, newReply, caseSensitive, matchMode) {
  const data = readJSON(REPLIES_PATH);
  const key = trigger.toLowerCase();

  if (!data[guildId] || !data[guildId][key]) {
    return { success: false, message: `Trigger "${trigger}" not found.` };
  }

  const entry = data[guildId][key];
  if (newReply !== null && newReply !== undefined) entry.reply = newReply;
  if (caseSensitive !== null && caseSensitive !== undefined) entry.caseSensitive = caseSensitive;
  if (matchMode !== null && matchMode !== undefined) entry.matchMode = matchMode;

  writeJSON(REPLIES_PATH, data);
  return { success: true, message: `Auto-reply "${trigger}" has been updated.` };
}

// ============================================================
// Authorized Users: CRUD operations
// ============================================================

/**
 * Get authorized user IDs for a server
 */
function getAuthorizedUsers(guildId) {
  const data = readJSON(USERS_PATH);
  return data[guildId] || [];
}

/**
 * Get ALL authorized user IDs across all servers (deduplicated)
 */
function getAllAuthorizedUsers() {
  const data = readJSON(USERS_PATH);
  const allIds = new Set();
  for (const guildId of Object.keys(data)) {
    if (Array.isArray(data[guildId])) {
      data[guildId].forEach(id => allIds.add(id));
    }
  }
  return [...allIds];
}

/**
 * Add an authorized user
 * @returns {{ success: boolean, message: string }}
 */
function addAuthorizedUser(guildId, userId) {
  const data = readJSON(USERS_PATH);
  if (!data[guildId]) data[guildId] = [];

  if (data[guildId].includes(userId)) {
    return { success: false, message: `User is already in the authorized list.` };
  }

  data[guildId].push(userId);
  writeJSON(USERS_PATH, data);
  return { success: true, message: `User has been added to the authorized list.` };
}

/**
 * Remove an authorized user
 * @returns {{ success: boolean, message: string }}
 */
function removeAuthorizedUser(guildId, userId) {
  const data = readJSON(USERS_PATH);
  if (!data[guildId]) {
    return { success: false, message: `User not found in the authorized list.` };
  }

  const index = data[guildId].indexOf(userId);
  if (index === -1) {
    return { success: false, message: `User not found in the authorized list.` };
  }

  data[guildId].splice(index, 1);
  writeJSON(USERS_PATH, data);
  return { success: true, message: `User has been removed from the authorized list.` };
}

module.exports = {
  getReplies,
  addReply,
  removeReply,
  editReply,
  getAuthorizedUsers,
  getAllAuthorizedUsers,
  addAuthorizedUser,
  removeAuthorizedUser,
};
