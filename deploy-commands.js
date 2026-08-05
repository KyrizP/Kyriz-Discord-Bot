/**
 * deploy-commands.js
 * 
 * Script untuk register slash commands ke Discord API.
 * Jalankan sekali saat setup: node deploy-commands.js
 * Jalankan ulang setiap kali ada perubahan pada command structure.
 */

require('dotenv').config();
const { REST, Routes } = require('discord.js');
const autoreplyCommand = require('./commands/autoreply');
const { attachUserSubcommands } = require('./commands/user');
const { attachGameSubcommands } = require('./commands/game');

// Attach subcommand groups and subcommands to the command builder
attachUserSubcommands(autoreplyCommand.data);
attachGameSubcommands(autoreplyCommand.data);

const commands = [autoreplyCommand.data.toJSON()];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('Registering slash commands to Discord...');
    console.log(`Commands: ${commands.map((c) => `/${c.name}`).join(', ')}`);

    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), {
      body: commands,
    });

    console.log('Slash commands registered successfully!');
    console.log('');
    console.log('Registered commands:');
    console.log('  /kyriz autoreply add     — Add an auto-reply');
    console.log('  /kyriz autoreply remove  — Remove an auto-reply');
    console.log('  /kyriz autoreply edit    — Edit an auto-reply');
    console.log('  /kyriz autoreply list    — View all auto-replies');
    console.log('  /kyriz user add          — Add an authorized user');
    console.log('  /kyriz user remove       — Remove an authorized user');
    console.log('  /kyriz user list         — View user list');
    console.log('  /kyriz blackjack [bet]   — Play Blackjack');
    console.log('  /kyriz coinflip [bet]    — Flip a coin');
    console.log('  /kyriz slots [bet]       — Spin the slot machine');
    console.log('  /kyriz dice [bet] [guess] — Roll a dice');
    console.log('  /kyriz crash [bet]       — Crash game');
    console.log('  /kyriz roulette [bet]    — Spin the roulette');
    console.log('  /kyriz mines [bet] [mines] — Minesweeper game');
    console.log('  /kyriz hilo [bet]        — Higher or Lower card game');
    console.log('  /kyriz tower [bet] [diff] — Tower climbing game');
    console.log('  /kyriz wallet [user]     — Check Kryztal balance');
    console.log('  /kyriz daily             — Claim daily reward');
    console.log('  /kyriz transfer          — Transfer Kryztal');
    console.log('  /kyriz leaderboard       — Top 10 players (server/global)');
    console.log('  /kyriz help              — View available commands');
  } catch (error) {
    console.error('Failed to register commands:', error);
  }
})();
