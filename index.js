/**
 * ╔══════════════════════════════════════════╗
 * ║   Kyriz — Personal Assistant Bot         ║
 * ║   Made with discord.js v14               ║
 * ╚══════════════════════════════════════════╝
 */

require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { handleAutoReply } = require('./handlers/autoReply');

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
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   Kyriz — Personal Assistant Bot         ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║   Online as: ${client.user.tag.padEnd(26)} ║`);
  console.log(`║   Servers: ${String(client.guilds.cache.size).padEnd(28)} ║`);
  console.log('╚══════════════════════════════════════════╝');
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
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});

client.on('error', (error) => {
  console.error('Client error:', error);
});

// ============================================================
// Login
// ============================================================
client.login(process.env.DISCORD_TOKEN).catch((error) => {
  console.error('Failed to login! Make sure DISCORD_TOKEN in .env is correct.');
  console.error(error.message);
  process.exit(1);
});
