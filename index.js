/**
 * ╔══════════════════════════════════════════╗
 * ║   Kyriz — Personal Assistant Bot         ║
 * ║   Made with discord.js v14               ║
 * ╚══════════════════════════════════════════╝
 */

require('dotenv').config();
const { Client, GatewayIntentBits, Collection } = require('discord.js');
const { handleAutoReply } = require('./handlers/autoReply');

// ============================================================
// Load Commands
// ============================================================
const autoreplyCommand = require('./commands/autoreply');
const userCommand = require('./commands/user');
const { attachUserSubcommands } = require('./commands/user');

// Attach user subcommands ke command builder
attachUserSubcommands(autoreplyCommand.data);

// ============================================================
// Initialize Client
// ============================================================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
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
  console.log(`║   Online sebagai: ${client.user.tag.padEnd(21)} ║`);
  console.log(`║   Server: ${String(client.guilds.cache.size).padEnd(29)} ║`);
  console.log('╚══════════════════════════════════════════╝');
});

// ============================================================
// Event: MessageCreate — Auto-Reply
// ============================================================
client.on('messageCreate', (message) => {
  handleAutoReply(message);
});

// ============================================================
// Event: InteractionCreate — Slash Commands
// ============================================================
client.on('interactionCreate', async (interaction) => {
  // Hanya proses slash commands
  if (!interaction.isChatInputCommand()) return;

  // Hanya proses command /kyriz
  if (interaction.commandName !== 'kyriz') return;

  // Hanya bisa dipakai di server (bukan DM)
  if (!interaction.guild) {
    return interaction.reply({
      content: 'This command can only be used in a server, not in DMs.',
      ephemeral: true,
    });
  }

  try {
    // Route ke handler yang sesuai berdasarkan subcommand group
    const subcommandGroup = interaction.options.getSubcommandGroup();

    if (subcommandGroup === 'autoreply') {
      await autoreplyCommand.execute(interaction);
    } else if (subcommandGroup === 'user') {
      await userCommand.execute(interaction);
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
// Login
// ============================================================
client.login(process.env.DISCORD_TOKEN).catch((error) => {
  console.error('Failed to login! Make sure DISCORD_TOKEN in .env is correct.');
  console.error(error.message);
  process.exit(1);
});
