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
    title: 'v3.0.0',
    lines: [
      '⚔️ **Battle Mode is LIVE** — `ky battle` takes you into the dungeon. Clear floors, push your luck, and whatever you do: don\'t die holding the loot.',
      '🧪 Loot → power: `ky sell all` turns drops into Kryptonite, `ky buygear` + `ky equip` turn it into stats.',
      '🥊 Grudges welcome: `ky battle @user`. Every hit rolls ±15% damage — no duel is decided on turn one.',
      '🎒 Full guide at `ky battle help` · name your hero with `ky char name` · window-shop at `ky shop gear`.',
      '📋 `ky help` rebuilt — the whole bot in one clean list.',
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
  } catch (err) {
    if (err.code !== 'ENOENT') { // genuinely missing = first deploy — fine. CORRUPT = preserve bytes.
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      try { fs.renameSync(STATE_FILE, STATE_FILE + '.corrupt-' + stamp); } catch { /* best effort */ }
      console.error(`[DATA SAFETY] botState.json corrupt — preserved as .corrupt-${stamp}, booting with defaults`);
    }
    return defaults(); // deleted / corrupt file — live-safe
  }
}

const state = load();

function save() {
  // Atomic tmp+rename — a failed write (e.g. ENOSPC) leaves the old file
  // intact instead of truncating it to 0 bytes. Same pattern as economyManager.
  const tmp = STATE_FILE + '.tmp-' + process.pid;
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
    fs.renameSync(tmp, STATE_FILE);
  } catch (err) {
    console.error('[botState] Failed to save state:', err.message);
  }
}

module.exports = { state, save, STATE_FILE };
