/**
 * ╔══════════════════════════════════════════╗
 * ║   Kyriz — Personal Assistant Bot         ║
 * ║   Made with discord.js v14               ║
 * ╚══════════════════════════════════════════╝
 */

require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { handleAutoReply } = require('./handlers/autoReply');
const economyManager = require('./utils/economyManager');
const { getAllPlayers, backupEconomy } = economyManager;

// ============================================================
// Load Commands
// ============================================================
const autoreplyCommand = require('./commands/autoreply');
const userCommand = require('./commands/user');
const gameCommand = require('./commands/game');
const { attachUserSubcommands } = require('./commands/user');
const { attachGameSubcommands } = require('./commands/game');

// Attach subcommand groups and subcommands to the command builder
attachUserSubcommands(autoreplyCommand.data);
attachGameSubcommands(autoreplyCommand.data);

// ============================================================
// Initialize Client
// ============================================================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ============================================================
// Event: Ready
// ============================================================
client.once('ready', () => {
  // SQLite migration: initDb throws eagerly at require-time on corrupt/refuse states —
  // this handler is only reached with a HEALTHY db (spec §5: refuse-to-start is the
  // deliberate behavior change from the old degraded-banner mode).
  const playerCount = getAllPlayers().length;
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   Kyriz — Personal Assistant Bot         ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║   Online as: ${client.user.tag.padEnd(26)} ║`);
  console.log(`║   Servers: ${String(client.guilds.cache.size).padEnd(28)} ║`);
  console.log(`║   Players: ${String(playerCount).padEnd(28)} ║`);
  console.log('╚══════════════════════════════════════════╝');
  // One-time battle data migration sweep (v1.6 flat -> characters) so the leaderboard
  // shows everyone immediately, not just players who already ran a battle command.
  try {
    const r = require('./utils/battleManager').migrateAllBattleData();
    if (r.migrated > 0) console.log(`║   Battle data migrated: ${String(r.migrated).padEnd(25)} ║`);
  } catch (e) { console.error('[migrate] battle sweep failed:', e.message); }

  // DATA SAFETY: rolling local backup at boot + every 6h (data/backups/, keep 14).
  // The 2026-07-17-style corrupt-file wipe can never happen again: readJSON preserves
  // corrupt bytes instead of silently running empty, and these snapshots cap ANY loss at 6h.
  try {
    const dest = backupEconomy();
    if (dest) console.log(`║   Economy snapshot: ${path.basename(dest).padEnd(30)} ║`);
  } catch { /* boot must never die on backup failure */ }
  setInterval(() => { try { backupEconomy(); } catch { /* non-fatal */ } }, 6 * 60 * 60 * 1000);

  // DAILY OFF-SERVER BACKUP: DM all data files to the superadmin at 00:01 WIB every day
  // (17:01 UTC — WIB is UTC+7, no DST). Copies live in Discord DMs, so even a wiped
  // container loses at most one day. sendBackupDM guards itself against double-sends.
  const dailyBackupDM = async () => {
    try {
      const r = await gameCommand.sendBackupDM(client, true);
      if (r && r.sent) console.log(`║   Daily backup DM sent (${r.count} files) — data safe off-server ✅`);
      else if (r) console.error(`║   ⚠️ Daily backup DM not sent — reason: ${r.reason}`); // ALL reasons logged (spec §6)
    } catch (e) { console.error('[backup-dm] failed:', e.message); }
  };
  const msToNext001WIB = () => { // next 00:01 WIB
    const now = new Date();
    const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 17, 1, 0));
    if (t <= now) t.setUTCDate(t.getUTCDate() + 1);
    return t - now;
  };
  setTimeout(() => { dailyBackupDM(); setInterval(dailyBackupDM, 24 * 60 * 60 * 1000); }, msToNext001WIB());
  // Retry hole: if today's 00:01 DM failed (bot down / DMs closed), a restart mid-day must
  // retry it — sendBackupDM's one-per-day guard makes this a no-op when already sent.
  setTimeout(() => { dailyBackupDM(); }, 60 * 1000);
  // Housekeeping: stale .tmp-* leftovers from crashes mid-atomic-write (pre-rename)
  try {
    const dataDir = path.join(__dirname, 'data');
    for (const f of fs.readdirSync(dataDir)) {
      if (f.includes('.tmp-')) { try { fs.rmSync(path.join(dataDir, f)); } catch { /* locked */ } }
    }
  } catch { /* data dir missing — fine */ }

  // Maintenance persisted ON across a restart → restore the DND presence too
  if (gameCommand.isMaintenanceActive && gameCommand.isMaintenanceActive()) {
    try {
      client.user.setPresence({
        activities: [{ name: 'Under Maintenance', type: 4, state: 'Under Maintenance' }],
        status: 'dnd',
      });
      console.log('║   Maintenance: ON (restored from state)  ║');
    } catch { /* non-fatal */ }
  }
});

// ============================================================
// Event: MessageCreate — Prefix Commands & Auto-Reply
// ============================================================
client.on('messageCreate', async (message) => {
  // Skip bot messages
  if (message.author.bot) return;

  // Skip DMs
  if (!message.guild) return;

  // Check for prefix command "ky" at the start of the message
  const content = message.content.trim();
  const lowerContent = content.toLowerCase();

  if (lowerContent.startsWith('ky ')) {
    const parts = content.slice(3).trim().split(/\s+/);
    const command = parts[0]?.toLowerCase();
    const args = parts.slice(1);

    // Only process valid commands, ignore everything else silently
    if (command && gameCommand.isValidPrefixCommand(command)) {
      try {
        await gameCommand.handlePrefixCommand(message, command, args);
      } catch (error) {
        console.error('Error executing prefix command:', error);
        // Storage hiccups (shared-host disk flaps) used to fail SILENTLY to the
        // player — bot looked dead. Tell them it's temporary and retryable.
        if (error && (error.code === 'ENOSPC' || error.code === 'SQLITE_FULL')) {
          try {
            await message.reply('⚠️ Storage is momentarily unavailable — please try again in a few seconds.');
          } catch { /* already replied / stale */ }
        }
      }
      return; // Don't process auto-reply for prefix commands
    }
    // Invalid prefix command (e.g. "ky haha") — fall through to auto-reply silently
  }

  // Auto-reply handler
  handleAutoReply(message);
});

// ============================================================
// Event: InteractionCreate — Slash Commands & Buttons
// ============================================================
client.on('interactionCreate', async (interaction) => {
  // Handle button interactions
  if (interaction.isButton()) {
    try {
      await gameCommand.handleButton(interaction);
    } catch (error) {
      console.error('Error handling button:', error);
      // Surface storage hiccups explicitly — silent stuck panels read as "bot dead".
      const content = error && (error.code === 'ENOSPC' || error.code === 'SQLITE_FULL')
        ? '⚠️ Storage is momentarily unavailable — please try again in a few seconds.'
        : 'An error occurred. Please try again.';
      try {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content, ephemeral: true });
        } else if (interaction.deferred) {
          await interaction.followUp({ content, ephemeral: true });
        }
      } catch { /* stale interaction */ }
    }
    return;
  }

  // Handle select-menu interactions
  if (interaction.isStringSelectMenu()) {
    try {
      await gameCommand.handleSelectMenu(interaction);
    } catch (error) {
      console.error('Error handling select menu:', error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: 'An error occurred. Please try again.',
          ephemeral: true,
        });
      }
    }
    return;
  }

  // Handle slash commands only
  if (!interaction.isChatInputCommand()) return;

  // Only process command /kyriz
  if (interaction.commandName !== 'kyriz') return;

  // Only usable in servers (not DMs)
  if (!interaction.guild) {
    return interaction.reply({
      content: 'This command can only be used in a server, not in DMs.',
      ephemeral: true,
    });
  }

  try {
    // Route based on subcommand group or subcommand
    const subcommandGroup = interaction.options.getSubcommandGroup(false);
    const subcommand = interaction.options.getSubcommand();

    if (subcommandGroup === 'autoreply') {
      await autoreplyCommand.execute(interaction);
    } else if (subcommandGroup === 'user') {
      await userCommand.execute(interaction);
    } else {
      // Standalone subcommands (game commands: blackjack, wallet, daily, transfer, leaderboard)
      await gameCommand.execute(interaction);
    }
  } catch (error) {
    console.error('Error executing command:', error);

    const errorMessage = 'An error occurred while executing the command. Please try again later.';

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: errorMessage, ephemeral: true });
    } else {
      await interaction.reply({ content: errorMessage, ephemeral: true });
    }
  }
});

// ============================================================
// Global Error Handlers (prevent crash)
// ============================================================
process.on('unhandledRejection', (error) => {
  console.error('Unhandled promise rejection:', error);
  logDiagnostic('unhandledRejection: ' + (error && error.stack || error));
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  logDiagnostic('uncaughtException: ' + (error && error.stack || error));
});

client.on('error', (error) => {
  console.error('Client error:', error);
  logDiagnostic('clientError: ' + (error && error.message || error));
});

// Post-mortem log — the Wispbyte console clears on restart; this file survives,
// so "why did it die" is answerable after the fact. Rare writes, tiny file.
// Size guard: error storms (reconnect bursts) must not grow this unbounded on a
// 1GB-storage free tier — past 1MB, rotate to .old and start fresh.
const fs = require('fs');
const path = require('path');
const DIAG_LOG = path.join(__dirname, 'data', 'diagnostic.log');
const DIAG_MAX_BYTES = 1024 * 1024;
function logDiagnostic(msg) {
  try {
    try {
      const st = fs.statSync(DIAG_LOG);
      if (st.size > DIAG_MAX_BYTES) {
        try { fs.rmSync(DIAG_LOG + '.old', { force: true }); } catch {}
        fs.renameSync(DIAG_LOG, DIAG_LOG + '.old');
      }
    } catch { /* file doesn't exist yet — fine */ }
    fs.appendFileSync(DIAG_LOG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch { /* data dir missing — console only */ }
}
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    logDiagnostic(sig + ' received (panel stop/restart or manual kill)');
    try { economyManager.closeDatabase(); } catch { /* already closed */ } // WAL checkpoint (spec §6)
    process.exit(0);
  });
}

// ============================================================
// Login (with retry — a single network blip at boot must not
// strand the app offline until a manual start)
// ============================================================
const MAX_LOGIN_ATTEMPTS = 5;
if (!process.env.DISCORD_TOKEN) {
  // Fail fast — retrying a missing token for 75s is pointless
  console.error('DISCORD_TOKEN is missing! Make sure .env is uploaded/complete.');
  process.exit(1);
}
async function loginWithRetry(attempt = 1) {
  try {
    await client.login(process.env.DISCORD_TOKEN);
  } catch (error) {
    logDiagnostic(`login attempt ${attempt}/${MAX_LOGIN_ATTEMPTS} failed: ${error.message}`);
    console.error(`Login attempt ${attempt}/${MAX_LOGIN_ATTEMPTS} failed: ${error.message}`);
    if (attempt >= MAX_LOGIN_ATTEMPTS) {
      console.error('Failed to login! Make sure DISCORD_TOKEN in .env is correct.');
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 15000));
    return loginWithRetry(attempt + 1);
  }
}
loginWithRetry();
