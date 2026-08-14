'use strict';

// ============================================================
// botState — persistent cross-restart state (data/botState.json):
// maintenance flag, bansos round (+ per-round claimers), and patch
// notes (incl. the announcement message that gets EDITED on every
// new patch instead of re-posted). Same sync read/write pattern as
// economyManager. Missing/corrupt file → fresh defaults (live-safe:
// maintenance OFF, no bansos — identical to a restart today).
// ============================================================

const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '..', 'data', 'botState.json');

// Seed = the current live version. Only used when the file is missing
// entirely; `ky patch clear` persists an empty list that stays empty.
const SEED_VERSIONS = [
  {
    version: 1,
    date: '2026-08-14',
    title: 'v2.1',
    lines: [
      '⚔️ **Battle Mode v1.1** — Legend/Mythic/Divine mystery-box gear with gacha passives, deeper dungeons, and admin inspect tools',
      '🥊 **PvP Duels v1.5** — hits now roll ±15% damage (comebacks are real!), mage burn scales with level, War Cry damage reduction capped, parried hits now show their damage',
      '🛒 **Shop v2.0** — new catalog: daily boosts, lucky tokens, mystery boxes, titles, badges & profile colors',
      '💎 QoL — username sync, `ky backup`, PvP challenge auto-expire',
    ],
  },
];

function defaults() {
  return {
    maintenance: { active: false, message: 'Bot is currently under maintenance. Please try again later.' },
    bansos: { active: false, amount: 0, message: '', claimedUsers: [] },
    patch: { versions: SEED_VERSIONS.slice(), channelId: null, messageId: null },
  };
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const d = defaults();
    const bansos = raw.bansos || {};
    const patch = raw.patch || {};
    return {
      maintenance: { ...d.maintenance, ...(raw.maintenance || {}) },
      bansos: {
        ...d.bansos, ...bansos,
        claimedUsers: Array.isArray(bansos.claimedUsers) ? bansos.claimedUsers : [],
      },
      patch: {
        ...d.patch, ...patch,
        versions: Array.isArray(patch.versions) ? patch.versions : d.patch.versions,
      },
    };
  } catch {
    return defaults(); // first deploy / deleted / corrupt file
  }
}

const state = load();

function save() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('[botState] Failed to save state:', err.message);
  }
}

module.exports = { state, save, STATE_FILE };
