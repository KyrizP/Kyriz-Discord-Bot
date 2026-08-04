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

// Attach user subcommand group ke command builder yang sama
attachUserSubcommands(autoreplyCommand.data);

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
  } catch (error) {
    console.error('Failed to register commands:', error);
  }
})();
