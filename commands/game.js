const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder, StringSelectMenuBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const {
  isSuperAdmin,
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
  checkTransferLimits,
  getAllPlayers,
  getDailySendLimit,
  getDailyReceiveLimit,
  getTransferData,
  getGlobalRank,
  isAdmin,
} = require('../utils/economyManager');
const { createDeck, drawCard, calculateHand, formatHand, isBlackjack } = require('../utils/cardDeck');
const { listBuyable, getItem } = require('../utils/shopItems');
const shopManager = require('../utils/shopManager');
const battleCmd = require('../utils/battleCommands');

// ============================================================
// Active games tracker (in-memory, per user)
// ============================================================

const activeGames = new Map(); // userId -> game state
const pendingTransfers = new Map(); // uniqueId -> { fromId, toId, amount }
const activeMinesGames = new Map(); // userId -> mines game state
const activeHiloGames = new Map(); // userId -> hilo game state
const activeTowerGames = new Map(); // userId -> tower game state

// ============================================================
// Maintenance mode (in-memory, superadmin toggle)
// ============================================================

let maintenanceMode = { active: false, message: 'Bot is currently under maintenance. Please try again later.' };
let pendingBansos = { active: false, amount: 0, message: '', claimedUsers: new Set() };

// ============================================================
// XP rewards constants
// ============================================================

const XP_WIN = 50;
const XP_LOSE = 10;
const XP_BLACKJACK = 100;
const XP_DAILY = 25;
const MAX_BET = 500000;

// Level-up notification helper
async function sendLevelUpNotification(channel, userId, xpResult) {
  if (!xpResult || !xpResult.leveledUp) return;
  const embed = new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle('🎉 Level Up!')
    .setDescription(
      `<@${userId}> is now **Level ${xpResult.newLevel}**!\n\n` +
      `Reward: 💎 **+${xpResult.rewardTotal.toLocaleString()}** Kryztal`
    )
    .setTimestamp();
  try { await channel.send({ embeds: [embed] }); } catch {}
}

/**
 * Calculate XP with bet-based tier multiplier
 * Higher bets = more XP to prevent low-bet farming
 */
function calculateXP(baseXP, bet) {
  let multiplier;
  if (bet >= 500000) multiplier = 1.0;
  else if (bet >= 100000) multiplier = 0.75;
  else if (bet >= 10000) multiplier = 0.50;
  else if (bet >= 1000) multiplier = 0.25;
  else multiplier = 0.05;
  return Math.max(1, Math.ceil(baseXP * multiplier));
}

// ============================================================
// Cooldown system (per user, per command)
// ============================================================

const cooldowns = new Map(); // `${userId}_${command}` -> timestamp
const COOLDOWN_BJ = 5000;    // 5 seconds for blackjack
const COOLDOWN_CMD = 4000;   // 4 seconds for other commands
const COOLDOWN_HELP = 1000;  // 1 second for help

/**
 * Normalize command name for cooldown key consistency
 */
function normalizeCmdName(command) {
  if (command === 'bj') return 'blackjack';
  if (command === 'lb') return 'leaderboard';
  if (command === 'cf') return 'coinflip';
  if (command === 'rl') return 'roulette';
  if (command === 'hl') return 'hilo';
  if (command === 'tw') return 'tower';
  if (command === 'tf') return 'transfer';
  return command;
}

/**
 * Check if user is on cooldown. Returns remaining seconds or 0.
 */
function checkCooldown(userId, command) {
  const key = `${userId}_${normalizeCmdName(command)}`;
  const now = Date.now();
  const expiry = cooldowns.get(key);

  if (expiry && now < expiry) {
    return Math.ceil((expiry - now) / 1000); // remaining seconds
  }
  return 0;
}

/**
 * Set cooldown for a user + command
 */
function setCooldown(userId, command) {
  const normalized = normalizeCmdName(command);
  const key = `${userId}_${normalized}`;
  let duration = COOLDOWN_CMD;
  if (['blackjack', 'crash', 'slots', 'roulette', 'mines', 'hilo', 'tower'].includes(normalized)) duration = COOLDOWN_BJ;
  else if (normalized === 'help') duration = COOLDOWN_HELP;
  cooldowns.set(key, Date.now() + duration);

  // Auto-cleanup
  setTimeout(() => cooldowns.delete(key), duration);
}

// ============================================================
// Subcommand definitions
// ============================================================

/**
 * Attach game subcommands to an existing command builder
 */
function attachGameSubcommands(commandBuilder) {
  // /kyriz blackjack [bet]
  commandBuilder.addSubcommand((sub) =>
    sub
      .setName('blackjack')
      .setDescription('Play a game of Blackjack')
      .addStringOption((opt) =>
        opt
          .setName('bet')
          .setDescription('Amount to bet (number or "all", default: 1, max: 500,000)')
          .setRequired(false)
      )
  );
  // /kyriz wallet [user] [userid]
  commandBuilder.addSubcommand((sub) =>
    sub
      .setName('wallet')
      .setDescription('Check your Kryztal balance')
      .addUserOption((opt) =>
        opt
          .setName('user')
          .setDescription('Check another user\'s balance (Superadmin only)')
          .setRequired(false)
      )
      .addStringOption((opt) =>
        opt
          .setName('userid')
          .setDescription('Check by user ID — works cross-server (Superadmin only)')
          .setRequired(false)
      )
  );

  // /kyriz daily
  commandBuilder.addSubcommand((sub) =>
    sub.setName('daily').setDescription('Claim your daily Kryztal reward')
  );

  // /kyriz transfer
  commandBuilder.addSubcommand((sub) =>
    sub
      .setName('transfer')
      .setDescription('Transfer Kryztal to another user')
      .addUserOption((opt) =>
        opt.setName('user').setDescription('The user to send Kryztal to').setRequired(true)
      )
      .addIntegerOption((opt) =>
        opt
          .setName('amount')
          .setDescription('Amount of Kryztal to send')
          .setRequired(true)
          .setMinValue(1)
      )
  );

  // /kyriz leaderboard
  commandBuilder.addSubcommand((sub) =>
    sub
      .setName('leaderboard')
      .setDescription('View the top 10 richest players')
      .addStringOption((opt) =>
        opt
          .setName('scope')
          .setDescription('Server leaderboard or global (default: server)')
          .setRequired(false)
          .addChoices(
            { name: 'This Server', value: 'server' },
            { name: 'Global (All Servers)', value: 'all' }
          )
      )
  );

  // /kyriz coinflip
  commandBuilder.addSubcommand((sub) =>
    sub
      .setName('coinflip')
      .setDescription('Flip a coin — heads or tails!')
      .addStringOption((opt) =>
        opt.setName('bet').setDescription('Amount to bet (number or "all")').setRequired(false)
      )
      .addStringOption((opt) =>
        opt
          .setName('side')
          .setDescription('Pick heads or tails (default: heads)')
          .setRequired(false)
          .addChoices(
            { name: 'Heads', value: 'heads' },
            { name: 'Tails', value: 'tails' }
          )
      )
  );

  // /kyriz slots
  commandBuilder.addSubcommand((sub) =>
    sub
      .setName('slots')
      .setDescription('Spin the slot machine!')
      .addStringOption((opt) =>
        opt.setName('bet').setDescription('Amount to bet (number or "all")').setRequired(false)
      )
  );

  // /kyriz dice
  commandBuilder.addSubcommand((sub) =>
    sub
      .setName('dice')
      .setDescription('Roll a dice and bet on the result!')
      .addStringOption((opt) =>
        opt
          .setName('guess')
          .setDescription('Guess: a number (1-6), "even", or "odd"')
          .setRequired(true)
      )
      .addStringOption((opt) =>
        opt.setName('bet').setDescription('Amount to bet (number or "all")').setRequired(false)
      )
  );

  // /kyriz crash
  commandBuilder.addSubcommand((sub) =>
    sub
      .setName('crash')
      .setDescription('Bet and cash out before the multiplier crashes!')
      .addStringOption((opt) =>
        opt.setName('bet').setDescription('Amount to bet (number or "all")').setRequired(false)
      )
  );

  // /kyriz roulette
  commandBuilder.addSubcommand((sub) =>
    sub
      .setName('roulette')
      .setDescription('Spin the roulette wheel!')
      .addStringOption((opt) =>
        opt
          .setName('choice')
          .setDescription('Bet on: red, black, even, odd, 1-18, 19-36, or exact number 0-36')
          .setRequired(true)
      )
      .addStringOption((opt) =>
        opt.setName('bet').setDescription('Amount to bet (number or "all")').setRequired(false)
      )
  );

  // /kyriz mines
  commandBuilder.addSubcommand((sub) =>
    sub
      .setName('mines')
      .setDescription('Minesweeper — reveal tiles, avoid mines, cash out anytime!')
      .addStringOption((opt) =>
        opt.setName('bet').setDescription('Amount to bet (number or "all")').setRequired(false)
      )
      .addIntegerOption((opt) =>
        opt
          .setName('mines')
          .setDescription('Number of mines (1-12, default: 3)')
          .setRequired(false)
          .setMinValue(1)
          .setMaxValue(12)
      )
  );

  // /kyriz hilo
  commandBuilder.addSubcommand((sub) =>
    sub
      .setName('hilo')
      .setDescription('Higher or Lower — guess the next card!')
      .addStringOption((opt) =>
        opt.setName('bet').setDescription('Amount to bet (number or "all")').setRequired(false)
      )
  );

  // /kyriz tower
  commandBuilder.addSubcommand((sub) =>
    sub
      .setName('tower')
      .setDescription('Tower — climb floors by picking safe doors!')
      .addStringOption((opt) =>
        opt.setName('bet').setDescription('Amount to bet (number or "all")').setRequired(false)
      )
      .addStringOption((opt) =>
        opt
          .setName('difficulty')
          .setDescription('Difficulty level (default: easy)')
          .setRequired(false)
          .addChoices(
            { name: 'Easy (3 doors, 1 trap)', value: 'easy' },
            { name: 'Medium (3 doors, 2 traps)', value: 'medium' },
            { name: 'Hard (4 doors, 3 traps)', value: 'hard' }
          )
      )
  );

  // /kyriz help
  commandBuilder.addSubcommand((sub) =>
    sub.setName('help').setDescription('View available commands')
  );

  // /kyriz odds
  commandBuilder.addSubcommand((sub) =>
    sub.setName('odds').setDescription('View win rates & odds for all games')
  );

  // /kyriz players (admin only)
  commandBuilder.addSubcommand((sub) =>
    sub.setName('players').setDescription('View all registered players (Admin only)')
  );

  // /kyriz shop
  commandBuilder.addSubcommand((sub) =>
    sub.setName('shop').setDescription('Browse the shop')
  );

  // /kyriz inventory
  commandBuilder.addSubcommand((sub) =>
    sub.setName('inventory').setDescription('View your items & cosmetics')
  );

  // /kyriz buy
  commandBuilder.addSubcommand((sub) =>
    sub.setName('buy').setDescription('Buy an item from the shop')
      .addStringOption((opt) =>
        opt.setName('item').setDescription('Item to buy').setRequired(true)
          .addChoices(...listBuyable().map((i) => ({ name: `${i.emoji} ${i.name} — 💎${i.price.toLocaleString()} Kryztal`, value: i.id })))
      )
  );

  // /kyriz use
  commandBuilder.addSubcommand((sub) =>
    sub.setName('use').setDescription('Use a consumable or equip a cosmetic')
      .addStringOption((opt) =>
        opt.setName('item').setDescription('Item to use/equip').setRequired(true)
          .addChoices(...listBuyable().map((i) => ({ name: `${i.emoji} ${i.name}`, value: i.id })))
      )
  );

  // /kyriz profile [user]
  commandBuilder.addSubcommand((sub) =>
    sub.setName('profile').setDescription('View your (or someone\'s) profile card')
      .addUserOption((opt) =>
        opt.setName('user').setDescription('Whose profile to view').setRequired(false)
      )
  );

  // Battle mode subcommands (delve / character / bag / sell / equip)
  battleCmd.attachSubcommands(commandBuilder);
}

// ============================================================
// T&C Registration
// ============================================================

function createTCEmbed() {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('Kyriz | Terms & Conditions')
    .setDescription(
      'Before playing, you must agree to the following terms:\n\n' +
        '**1.** Kryztal is a virtual currency that only works within the Kyriz bot ecosystem. ' +
        'It has no real-world monetary value and cannot be exchanged, sold, or transferred outside the bot system.\n\n' +
        '**2.** Exploiting bugs, using bots/macros, or manipulating the system for unfair advantage is prohibited. ' +
        'Violations may result in account reset or permanent ban.\n\n' +
        '**3.** Kryztal lost due to bugs or technical issues will not be compensated unless at the developer\'s discretion.\n\n' +
        '**4.** The developer reserves the right to modify values, rules, or the economy system at any time without prior notice.\n\n' +
        '**5.** By accepting, you confirm that you are at least 13 years old and take responsibility for your use of this bot.\n\n' +
        '**6.** Your username will be publicly displayed on the leaderboard across all servers. By accepting, you consent to this visibility.\n\n' +
        '**Starting balance: 💎 100,000 Kryztal**'
    )
    .setTimestamp();
}

function createTCButtons(userId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`tc_accept_${userId}`)
      .setLabel('Accept & Start')
      .setStyle(ButtonStyle.Success)
  );
}

// ============================================================
// Command handler (slash commands)
// ============================================================

async function execute(interaction) {
  const subcommand = interaction.options.getSubcommand();
  const userId = interaction.user.id;
  const username = interaction.user.username;

  // Maintenance check (superadmin bypasses)
  if (maintenanceMode.active && !isSuperAdmin(userId) && !isAdmin(userId)) {
    return interaction.reply({ content: maintenanceMode.message, ephemeral: true });
  }

  // Bansos check — one-time reward claim
  if (pendingBansos.active && isRegistered(userId) && !isSuperAdmin(userId) && !pendingBansos.claimedUsers.has(userId)) {
    pendingBansos.claimedUsers.add(userId);
    addBalance(userId, pendingBansos.amount);
    const bansosEmbed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('🎁 Compensation Reward!')
      .setDescription(
        `${pendingBansos.message}\n\n` +
        `You received 💎 **+${pendingBansos.amount.toLocaleString()}** Kryztal!\n` +
        `New balance: 💎 **${getBalance(userId).toLocaleString()}** Kryztal`
      )
      .setTimestamp();
    // Send bansos notification, then continue with normal command
    try { await interaction.channel.send({ content: `<@${userId}>`, embeds: [bansosEmbed] }); } catch {}
  }

  // Update username on every interaction
  if (isRegistered(userId)) {
    updateUsername(userId, username);
  }

  // T&C check (skip for superadmin)
  const requiresRegistration = ['blackjack', 'wallet', 'daily', 'transfer', 'coinflip', 'slots', 'dice', 'crash', 'roulette', 'mines', 'hilo', 'tower', 'help', 'odds', 'leaderboard', 'shop', 'inventory', 'buy', 'use', 'profile', 'battle', 'character', 'bag', 'sell', 'equip', 'buygear', 'gear', 'end'];
  if (requiresRegistration.includes(subcommand) && !isRegistered(userId)) {
    const embed = createTCEmbed();
    const buttons = createTCButtons(userId);
    return interaction.reply({ embeds: [embed], components: [buttons] });
  }

  // Cooldown check (skip for superadmin)
  if (!isSuperAdmin(userId)) {
    const remaining = checkCooldown(userId, subcommand);
    if (remaining > 0) {
      return interaction.reply({
        content: `Please wait **${remaining}s** before using this command again.`,
        ephemeral: true,
      });
    }
    setCooldown(userId, subcommand);
  }

  switch (subcommand) {
    case 'blackjack':
      return handleBlackjack(interaction, userId);
    case 'wallet':
      return handleWallet(interaction, userId);
    case 'daily':
      return handleDaily(interaction, userId);
    case 'transfer':
      return handleTransfer(interaction, userId);
    case 'leaderboard':
      return handleLeaderboard(interaction);
    case 'coinflip':
      return handleCoinflip(interaction, userId);
    case 'slots':
      return handleSlots(interaction, userId);
    case 'dice':
      return handleDice(interaction, userId);
    case 'crash':
      return handleCrash(interaction, userId);
    case 'roulette':
      return handleRoulette(interaction, userId);
    case 'mines':
      return handleMines(interaction, userId);
    case 'hilo':
      return handleHilo(interaction, userId);
    case 'tower':
      return handleTower(interaction, userId);
    case 'help':
      return handleHelp(interaction);
    case 'odds':
      return handleOdds(interaction);
    case 'players':
      return handlePlayersSlash(interaction, userId);
    case 'shop':
      return handleShop(interaction, userId);
    case 'inventory':
      return handleInventory(interaction, userId);
    case 'buy':
      return handleBuySlash(interaction, userId);
    case 'use':
      return handleUse(interaction, userId);
    case 'profile': {
      const t = interaction.options.getUser('user');
      return handleProfile(interaction, t ? t.id : userId, t ? t.username : interaction.user.username, t ? t.displayAvatarURL() : interaction.user.displayAvatarURL());
    }
    // Battle mode is prefix-only (ky battle, ky char, ...) — see handlePrefixCommand.
  }
}

// ============================================================
// Prefix command handler
// ============================================================

async function handlePrefixCommand(message, command, args) {
  const userId = message.author.id;
  const username = message.author.username;

  // Superadmin commands (before maintenance block)
  if (command === 'maintenance') {
    return handleMaintenance(message, userId, args);
  }
  if (command === 'bansos') {
    return handleBansos(message, userId, args);
  }
  if (command === 'backup') {
    return handleBackup(message, userId);
  }

  // Maintenance check (superadmin bypasses)
  if (maintenanceMode.active && !isSuperAdmin(userId) && !isAdmin(userId)) {
    // Rate limit maintenance replies (reuse cooldown system)
    const remaining = checkCooldown(userId, 'maintenance_reply');
    if (remaining > 0) return; // Silently ignore if already replied recently
    setCooldown(userId, 'maintenance_reply');
    const embed = new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle('🔧 Maintenance Mode')
      .setDescription(maintenanceMode.message)
      .setTimestamp();
    return message.reply({ embeds: [embed] });
  }

  // Bansos check — one-time reward claim
  if (pendingBansos.active && isRegistered(userId) && !isSuperAdmin(userId) && !pendingBansos.claimedUsers.has(userId)) {
    pendingBansos.claimedUsers.add(userId);
    addBalance(userId, pendingBansos.amount);
    const bansosEmbed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('🎁 Compensation Reward!')
      .setDescription(
        `${pendingBansos.message}\n\n` +
        `You received 💎 **+${pendingBansos.amount.toLocaleString()}** Kryztal!\n` +
        `New balance: 💎 **${getBalance(userId).toLocaleString()}** Kryztal`
      )
      .setTimestamp();
    try { await message.channel.send({ content: `<@${userId}>`, embeds: [bansosEmbed] }); } catch {}
  }

  // Update username
  if (isRegistered(userId)) {
    updateUsername(userId, username);
  }

  // T&C check for commands that require registration
  const requiresRegistration = ['bj', 'blackjack', 'wallet', 'daily', 'transfer', 'tf', 'cf', 'coinflip', 'slots', 'dice', 'crash', 'rl', 'roulette', 'mines', 'hl', 'hilo', 'tw', 'tower', 'help', 'odds', 'lb', 'leaderboard', 'shop', 'inventory', 'inv', 'buy', 'use', 'profile', 'battle', 'char', 'character', 'bag', 'sell', 'sellgear', 'equip', 'unequip', 'buygear', 'gear', 'end'];
  if (requiresRegistration.includes(command) && !isRegistered(userId)) {
    const embed = createTCEmbed();
    const buttons = createTCButtons(userId);
    return message.reply({ embeds: [embed], components: [buttons] });
  }

  // Cooldown check (skip for superadmin)
  if (!isSuperAdmin(userId)) {
    const remaining = checkCooldown(userId, command);
    if (remaining > 0) {
      return message.reply({ content: `Please wait **${remaining}s** before using this command again.` }).then(msg => {
        setTimeout(() => { msg.delete().catch(() => {}); }, remaining * 1000);
      }).catch(() => {});
    }
    setCooldown(userId, command);
  }

  switch (command) {
    case 'bj':
    case 'blackjack':
      return handleBlackjackPrefix(message, userId, args);
    case 'wallet':
      return handleWalletPrefix(message, userId);
    case 'daily':
      return handleDailyPrefix(message, userId);
    case 'transfer':
    case 'tf':
      return handleTransferPrefix(message, userId, args);
    case 'lb':
    case 'leaderboard':
      return handleLeaderboardPrefix(message, args);
    case 'cf':
    case 'coinflip':
      return handleCoinflipPrefix(message, userId, args);
    case 'slots':
      return handleSlotsPrefix(message, userId, args);
    case 'dice':
      return handleDicePrefix(message, userId, args);
    case 'crash':
      return handleCrashPrefix(message, userId, args);
    case 'rl':
    case 'roulette':
      return handleRoulettePrefix(message, userId, args);
    case 'mines':
      return handleMinesPrefix(message, userId, args);
    case 'hl':
    case 'hilo':
      return handleHiloPrefix(message, userId, args);
    case 'tw':
    case 'tower':
      return handleTowerPrefix(message, userId, args);
    case 'help':
      if (args.length > 0) return;
      return handleHelpPrefix(message);
    case 'odds':
      return handleOddsPrefix(message);
    case 'players':
      return handlePlayersPrefix(message, userId);
    case 'shop':
      if (args[0] && args[0].toLowerCase() === 'gear') return battleCmd.handleShopEquipment(message, userId);
      return handleShop(message, userId);
    case 'inventory':
    case 'inv':
      return handleInventory(message, userId, true);
    case 'buy':
      return handleBuyPrefix(message, userId, args);
    case 'use':
      return handleUse(message, userId, args, true);
    case 'profile': {
      const m = message.mentions.users.first();
      return handleProfile(message, m ? m.id : userId, m ? m.username : message.author.username, m ? m.displayAvatarURL() : message.author.displayAvatarURL(), true);
    }
    case 'battle':
      if (args[0] && args[0].toLowerCase() === 'help') return battleCmd.handleBattleHelp(message);
      return battleCmd.handleBattle(message, userId);
    case 'char':
    case 'character':
      if (args[0] && args[0].toLowerCase() === 'name') return battleCmd.handleName(message, userId, args.slice(1).join(' '));
      return battleCmd.handleCharacter(message, userId);
    case 'bag': return battleCmd.handleBag(message, userId, 1);
    case 'gear': return battleCmd.handleGear(message, userId);
    case 'sell': return battleCmd.handleSell(message, userId, args.join(' ') || 'all');
    case 'sellgear': return battleCmd.handleSellGear(message, userId, args[0], args[1]);
    case 'equip': return battleCmd.handleEquip(message, userId, args[0]);
    case 'unequip': return battleCmd.handleUnequip(message, userId, args[0]);
    case 'buygear': return battleCmd.handleBuyGear(message, userId, args[0]);
    case 'end': return battleCmd.handleEnd(message, userId);
    default:
      return;
  }
}

// ============================================================
// MAINTENANCE MODE
// ============================================================

async function handleBansos(message, userId, args) {
  if (!isSuperAdmin(userId)) return;

  const action = args[0]?.toLowerCase();

  if (action === 'off' || action === 'stop') {
    const claimed = pendingBansos.claimedUsers.size;
    pendingBansos = { active: false, amount: 0, message: '', claimedUsers: new Set() };
    return message.reply(`Bansos **stopped**. Total claimed: **${claimed}** users.`);
  }

  if (action === 'status') {
    if (!pendingBansos.active) return message.reply('No active bansos.');
    return message.reply(
      `Bansos **active**: 💎 **${pendingBansos.amount.toLocaleString()}** Kryztal per user.\n` +
      `Claimed: **${pendingBansos.claimedUsers.size}** users so far.\n` +
      `Message: ${pendingBansos.message}`
    );
  }

  // ky bansos [amount] [optional message]
  const amount = parseInt(action);
  if (isNaN(amount) || amount < 1) {
    return message.reply(
      'Usage:\n' +
      '`ky bansos [amount] [message]` — Set reward for all users\n' +
      '`ky bansos status` — Check active bansos\n' +
      '`ky bansos off` — Stop bansos'
    );
  }

  if (amount > 2000000) {
    return message.reply('Maximum bansos amount is 💎 **2,000,000** Kryztal.');
  }

  const customMessage = args.slice(1).join(' ') || 'Thank you for your patience!';
  pendingBansos = {
    active: true,
    amount: amount,
    message: customMessage,
    claimedUsers: new Set(),
  };

  return message.reply(
    `🎁 Bansos **activated**!\n` +
    `Amount: 💎 **${amount.toLocaleString()}** Kryztal per user\n` +
    `Message: ${customMessage}\n\n` +
    `Users will receive it on their next command.`
  );
}

async function handleMaintenance(message, userId, args) {
  if (!isSuperAdmin(userId)) return; // Only superadmin

  const action = args[0]?.toLowerCase();

  if (action === 'on') {
    const customMsg = args.slice(1).join(' ');
    maintenanceMode.active = true;
    if (customMsg) maintenanceMode.message = customMsg;
    else maintenanceMode.message = 'Bot is currently under maintenance. Please try again later.';

    // Update bot status
    try {
      message.client.user.setPresence({
        activities: [{ name: 'Under Maintenance', type: 4, state: 'Under Maintenance' }],
        status: 'dnd',
      });
    } catch (e) { /* ignore */ }

    return message.reply('Maintenance mode **ON**. All commands are now blocked for regular users.');
  }

  if (action === 'off') {
    maintenanceMode.active = false;

    // Reset bot status
    try {
      message.client.user.setPresence({
        activities: [],
        status: 'online',
      });
    } catch (e) { /* ignore */ }

    return message.reply('Maintenance mode **OFF**. Bot is back to normal.');
  }

  // Status check
  const status = maintenanceMode.active ? 'ON' : 'OFF';
  return message.reply(`Maintenance is currently **${status}**.\nUsage: \`ky maintenance on [message]\` or \`ky maintenance off\``);
}

async function handleBackup(message, userId) {
  if (!isSuperAdmin(userId)) return; // Only superadmin

  const DATA_DIR = path.join(__dirname, '..', 'data');
  const targets = ['economy.json', 'replies.json', 'users.json'];
  const attachments = [];
  const summary = [];
  for (const name of targets) {
    const fp = path.join(DATA_DIR, name);
    if (fs.existsSync(fp)) {
      attachments.push(new AttachmentBuilder(fp, { name }));
      const kb = (fs.statSync(fp).size / 1024).toFixed(1);
      summary.push(`• \`${name}\` — ${kb} KB`);
    }
  }

  if (attachments.length === 0) {
    return message.reply('⚠️ Tidak ada file data di folder `data/` untuk di-backup.');
  }

  // Hitung jumlah pemain dari economy.json (buat konfirmasi)
  let playerCount = null;
  try {
    const d = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'economy.json'), 'utf-8'));
    playerCount = Object.keys(d).length;
  } catch { /* economy.json belum ada — abaikan */ }

  const ts = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'short', timeStyle: 'short' });

  // Kirim file ke DM superadmin — tersimpan di Discord (off-server), bukan di Wispbyte.
  let owner;
  try {
    owner = await message.client.users.fetch(process.env.SUPERADMIN_ID);
  } catch {
    return message.reply('❌ Gagal mengambil user superadmin. Cek `SUPERADMIN_ID` di .env.');
  }

  try {
    await owner.send({
      content: `📦 **Kyriz Backup**\nDibuat: ${ts} WIB\n\nFile:\n${summary.join('\n')}${playerCount != null ? `\n\nPemain terdaftar: **${playerCount}**` : ''}\n\n_Untuk restore: taruh file-file ini di folder \`data/\` lalu restart bot._`,
      files: attachments,
    });
  } catch {
    return message.reply('❌ Gagal kirim DM (kemungkinan DM dari bot dimatikan). Aktifkan pengaturan DM dari bot ini, lalu coba `ky backup` lagi. Data sengaja TIDAK dikirim ke channel demi keamanan.');
  }

  return message.reply(`✅ Backup terkirim ke DM kamu (**${attachments.length} file**):\n${summary.join('\n')}${playerCount != null ? `\n\nPemain: **${playerCount}**` : ''}`);
}

// ============================================================
// BLACKJACK
// ============================================================

function parseBet(betStr, userId) {
  if (!betStr || betStr === '') return 1;

  if (betStr.toLowerCase() === 'all') {
    const balance = getBalance(userId);
    const actualBalance = isSuperAdmin(userId) ? MAX_BET : balance;
    const bet = Math.min(actualBalance, MAX_BET);
    return bet <= 0 ? 1 : bet; // If 0 balance, return 1 so removeBalance handles "Insufficient balance"
  }

  const bet = parseInt(betStr);
  if (isNaN(bet) || bet < 1) return null;
  return Math.min(bet, MAX_BET);
}

async function handleBlackjack(interaction, userId) {
  const username = interaction.user.username;
  const betStr = interaction.options.getString('bet') || '1';
  const bet = parseBet(betStr, userId);

  if (bet === null) {
    return interaction.reply({ content: 'Invalid bet amount.', ephemeral: true });
  }

  // Check active game
  if (activeGames.has(userId)) {
    return interaction.reply({
      content: 'You already have an active game. Finish it first.',
      ephemeral: true,
    });
  }

  // Check balance
  if (!isSuperAdmin(userId)) {
    const balance = getBalance(userId);
    if (balance < bet) {
      return interaction.reply({
        content: `Insufficient balance. You have 💎 **${balance.toLocaleString()}** Kryztal but tried to bet 💎 **${bet.toLocaleString()}** Kryztal.`,
        ephemeral: true,
      });
    }
  }

  // Deduct bet
  if (!isSuperAdmin(userId)) {
    removeBalance(userId, bet);
  }

  // Start game
  const game = startBlackjackGame(userId, bet, username);

  // Check for instant blackjack
  if (game.playerBlackjack) {
    return finishBlackjack(interaction, game, 'reply');
  }

  // Show game state with buttons
  const embed = createGameEmbed(game, false);
  const buttons = createGameButtons(userId, game);

  const reply = await interaction.reply({ embeds: [embed], components: [buttons], fetchReply: true });
  game.messageId = reply.id;

  // Set timeout (60 seconds)
  game.timeout = setTimeout(() => {
    autoStand(interaction, game);
  }, 60000);
}

async function handleBlackjackPrefix(message, userId, args) {
  const username = message.author.username;
  const betStr = args[0] || '1';
  const bet = parseBet(betStr, userId);

  if (bet === null) return; // Silently ignore invalid bet for prefix

  if (activeGames.has(userId)) {
    return message.reply('You already have an active game. Finish it first.');
  }

  if (!isSuperAdmin(userId)) {
    const balance = getBalance(userId);
    if (balance < bet) {
      return message.reply(
        `Insufficient balance. You have 💎 **${balance.toLocaleString()}** Kryztal but tried to bet 💎 **${bet.toLocaleString()}** Kryztal.`
      );
    }
  }

  if (!isSuperAdmin(userId)) {
    removeBalance(userId, bet);
  }

  const game = startBlackjackGame(userId, bet, username);

  if (game.playerBlackjack) {
    return finishBlackjack(message, game, 'reply');
  }

  const embed = createGameEmbed(game, false);
  const buttons = createGameButtons(userId, game);

  const reply = await message.reply({ embeds: [embed], components: [buttons], fetchReply: true });
  game.messageId = reply.id;

  game.timeout = setTimeout(() => {
    autoStandMessage(reply, game);
  }, 60000);
}

function startBlackjackGame(userId, bet, username) {
  let deck = createDeck();

  const playerHand = [];
  const dealerHand = [];

  // Deal 2 cards each
  let result;
  result = drawCard(deck); playerHand.push(result.card); deck = result.deck;
  result = drawCard(deck); dealerHand.push(result.card); deck = result.deck;
  result = drawCard(deck); playerHand.push(result.card); deck = result.deck;
  result = drawCard(deck); dealerHand.push(result.card); deck = result.deck;

  const playerBlackjack = isBlackjack(playerHand);
  const dealerBlackjack = isBlackjack(dealerHand);

  const game = {
    userId,
    username,
    bet,
    deck,
    playerHand,
    dealerHand,
    playerBlackjack,
    dealerBlackjack,
    doubledDown: false,
    finished: false,
    messageId: null,
    timeout: null,
    processing: false, // Lock to prevent spam
  };

  activeGames.set(userId, game);
  return game;
}

function createGameEmbed(game, revealDealer) {
  const playerValue = calculateHand(game.playerHand);
  const dealerValue = revealDealer
    ? calculateHand(game.dealerHand)
    : calculateHand([game.dealerHand[1]]); // Only visible card

  const embed = new EmbedBuilder()
    .setAuthor({ name: `${game.username}'s game` })
    .setTitle(`Blackjack | Bet: 💎 ${game.bet.toLocaleString()} Kryztal`)
    .setTimestamp();

  // Dealer hand
  const dealerDisplay = revealDealer
    ? formatHand(game.dealerHand, false)
    : formatHand(game.dealerHand, true);

  const dealerValueDisplay = revealDealer ? `Value: ${dealerValue}` : `Value: ${dealerValue}+?`;

  embed.addFields(
    { name: 'Dealer', value: `${dealerDisplay}\n${dealerValueDisplay}`, inline: false },
    { name: '\u200b', value: '\u200b', inline: false },
    { name: 'You', value: `${formatHand(game.playerHand)}\nValue: ${playerValue}`, inline: false }
  );

  // Set color based on state
  if (!game.finished) {
    embed.setColor(0x5865f2); // Blue - in progress
  }

  return embed;
}

function createGameButtons(userId, game) {
  const playerValue = calculateHand(game.playerHand);
  const canDoubleDown = game.playerHand.length === 2 && !game.doubledDown;

  // Check if user can afford double down
  let canAffordDouble = true;
  if (!isSuperAdmin(userId)) {
    const balance = getBalance(userId);
    canAffordDouble = balance >= game.bet;
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`bj_hit_${userId}`)
      .setLabel('Hit')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`bj_stand_${userId}`)
      .setLabel('Stand')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`bj_double_${userId}`)
      .setLabel('Double Down')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!canDoubleDown || !canAffordDouble || playerValue >= 21)
  );

  return row;
}

function disabledButtons(userId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`bj_hit_${userId}`)
      .setLabel('Hit')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`bj_stand_${userId}`)
      .setLabel('Stand')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`bj_double_${userId}`)
      .setLabel('Double Down')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(true)
  );
}

async function finishBlackjack(context, game, method) {
  game.finished = true;
  if (game.timeout) {
    clearTimeout(game.timeout);
    game.timeout = null;
  }

  const playerValue = calculateHand(game.playerHand);
  const dealerValue = calculateHand(game.dealerHand);

  let resultText = '';
  let winnings = 0;
  let color = 0x5865f2;
  let xpGained = 0;

  if (game.playerBlackjack && game.dealerBlackjack) {
    // Both blackjack = push
    resultText = 'Push! Both got Blackjack. Bet returned.';
    winnings = game.bet;
    color = 0xfee75c; // Yellow
    xpGained = XP_LOSE; // Tie gives lose XP
  } else if (game.playerBlackjack) {
    // Player blackjack
    winnings = Math.floor(game.bet * 2.5);
    resultText = `BLACKJACK! You win 💎 ${winnings.toLocaleString()} Kryztal!`;
    color = 0xf1c40f; // Gold
    xpGained = XP_BLACKJACK;
    recordWin(game.userId);
  } else if (game.dealerBlackjack) {
    // Dealer blackjack
    resultText = `Dealer has Blackjack! You lose 💎 ${game.bet.toLocaleString()} Kryztal.`;
    color = 0xed4245; // Red
    xpGained = XP_LOSE;
    recordLoss(game.userId);
  } else if (playerValue > 21) {
    // Player bust
    resultText = `Bust! You lose 💎 ${game.bet.toLocaleString()} Kryztal.`;
    color = 0xed4245;
    xpGained = XP_LOSE;
    recordLoss(game.userId);
  } else if (dealerValue > 21) {
    // Dealer bust
    winnings = game.bet * 2;
    resultText = `Dealer busts! You win 💎 ${winnings.toLocaleString()} Kryztal!`;
    color = 0x57f287; // Green
    xpGained = XP_WIN;
    recordWin(game.userId);
  } else if (playerValue > dealerValue) {
    // Player wins
    winnings = game.bet * 2;
    resultText = `You win 💎 ${winnings.toLocaleString()} Kryztal!`;
    color = 0x57f287;
    xpGained = XP_WIN;
    recordWin(game.userId);
  } else if (playerValue < dealerValue) {
    // Dealer wins
    resultText = `Dealer wins. You lose 💎 ${game.bet.toLocaleString()} Kryztal.`;
    color = 0xed4245;
    xpGained = XP_LOSE;
    recordLoss(game.userId);
  } else {
    // Push
    winnings = game.bet;
    resultText = `Push! Bet returned.`;
    color = 0xfee75c;
    xpGained = XP_LOSE;
  }

  // Add winnings back to balance
  if (winnings > 0) {
    addBalance(game.userId, winnings);
  }

  const actualXP = calculateXP(xpGained, game.bet);
  const xpResult = addXP(game.userId, actualXP);

  // Build result text with XP info
  let xpText = `+${actualXP} XP`;
  if (!isSuperAdmin(game.userId)) {
    const user = getUser(game.userId);
    if (user) {
      xpText += ` | Level ${user.level} (${user.xp}/${user.xpNeeded} XP)`;
    }
  }

  // Build embed
  const embed = createGameEmbed(game, true);
  embed.setColor(color);
  embed.addFields(
    { name: '\u200b', value: '\u200b', inline: false },
    { name: 'Result', value: resultText, inline: false },
    { name: '\u200b', value: xpText, inline: false }
  );

  // Show new balance
  if (!isSuperAdmin(game.userId)) {
    const newBalance = getBalance(game.userId);
    embed.setFooter({ text: `Balance: 💎 ${newBalance.toLocaleString()} Kryztal` });
  } else {
    embed.setFooter({ text: 'Balance: 💎 \u221e Kryztal' });
  }

  // Clean up game
  activeGames.delete(game.userId);

  // Store xpResult for level-up notification
  game.xpResult = xpResult;

  const payload = { embeds: [embed], components: [disabledButtons(game.userId)] };

  if (method === 'reply') {
    await context.reply(payload);
  } else if (method === 'update') {
    await context.update(payload);
  } else if (method === 'edit') {
    await context.edit(payload);
  }

  // Send separate level-up notification
  const ch = context.channel || context.message?.channel;
  if (ch) sendLevelUpNotification(ch, game.userId, game.xpResult);
}

async function autoStand(interaction, game) {
  if (game.finished) return;

  // Dealer draws
  dealerPlay(game);

  // Try to edit the original message
  try {
    const channel = interaction.channel;
    if (channel && game.messageId) {
      const msg = await channel.messages.fetch(game.messageId);
      await finishBlackjack(msg, game, 'edit');
    }
  } catch (error) {
    // If we can't edit, just clean up
    game.finished = true;
    activeGames.delete(game.userId);
  }
}

async function autoStandMessage(message, game) {
  if (game.finished) return;
  dealerPlay(game);
  try {
    await finishBlackjack(message, game, 'edit');
  } catch (error) {
    game.finished = true;
    activeGames.delete(game.userId);
  }
}

function dealerPlay(game) {
  // Dealer draws until 17 or more
  while (calculateHand(game.dealerHand) < 17) {
    const result = drawCard(game.deck);
    game.dealerHand.push(result.card);
    game.deck = result.deck;
  }
}

// ============================================================
// WALLET
// ============================================================

async function handleWallet(interaction, userId) {
  const targetUser = interaction.options.getUser('user');
  const targetUserId = interaction.options.getString('userid');

  // Check by @mention
  if (targetUser && targetUser.id !== userId) {
    if (!isSuperAdmin(userId)) {
      return interaction.reply({
        content: 'Only the Superadmin can check other users\' wallets.',
        ephemeral: true,
      });
    }
    return showWallet(interaction, targetUser.id, targetUser.username);
  }

  // Check by user ID string (cross-server, superadmin only)
  if (targetUserId && targetUserId !== userId) {
    if (!isSuperAdmin(userId)) {
      return interaction.reply({
        content: 'Only the Superadmin can check other users\' wallets.',
        ephemeral: true,
      });
    }

    if (!isRegistered(targetUserId)) {
      return interaction.reply({ content: `User ID \`${targetUserId}\` is not registered.`, ephemeral: true });
    }

    const targetData = getUser(targetUserId);
    const displayName = targetData?.username || `User ${targetUserId}`;
    return showWallet(interaction, targetUserId, displayName);
  }

  return showWallet(interaction, userId, interaction.user.username);
}

async function handleWalletPrefix(message, userId) {
  // Check if superadmin is trying to look up another user
  const mention = message.mentions.users.first();
  if (mention && isSuperAdmin(userId)) {
    return showWallet(message, mention.id, mention.username, true);
  }

  return showWallet(message, userId, message.author.username, true);
}

async function showWallet(context, userId, username, isPrefix = false) {
  if (!isRegistered(userId) && !isSuperAdmin(userId)) {
    const content = 'This user is not registered yet.';
    if (isPrefix) return context.reply(content);
    return context.reply({ content, ephemeral: true });
  }

  const user = getUser(userId);
  const balanceDisplay = isSuperAdmin(userId) ? '\u221e' : user.balance.toLocaleString();

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`${username}'s Wallet`)
    .addFields({ name: 'Balance', value: `💎 **${balanceDisplay}** Kryztal`, inline: false })
    .addFields({ name: 'Kryptonite', value: `🧪 **${battleCmd.getKryptonite(userId).toLocaleString()}**`, inline: false })
    .setFooter({ text: 'Full stats & flex: /kyriz profile' })
    .setTimestamp();
  return context.reply({ embeds: [embed] });
}

// ============================================================
// SHOP & INVENTORY
// ============================================================

// Page → category filter. Index = page number.
const SHOP_PAGES = [
  { name: 'Consumables', filter: (i) => i.category === 'consumable' },
  { name: 'Titles', filter: (i) => i.category === 'cosmetic' && i.effect.kind === 'title' },
  { name: 'Badges', filter: (i) => i.category === 'cosmetic' && i.effect.kind === 'badge' },
  { name: 'Colors', filter: (i) => i.category === 'cosmetic' && i.effect.kind === 'color' },
];

function buildShopPage(pageNum, userId) {
  pageNum = Math.max(0, Math.min(SHOP_PAGES.length - 1, pageNum));
  const page = SHOP_PAGES[pageNum];
  const items = listBuyable().filter(page.filter);

  const lines = items
    .map((i) => `${i.emoji} **${i.name}** \`${i.id}\` — 💎 **${i.price.toLocaleString()}** Kryztal\n${i.description}`)
    .join('\n\n');

  const embed = new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle(`🛒 Kyriz Shop — ${page.name} (Page ${pageNum + 1}/${SHOP_PAGES.length})`)
    .setDescription(lines || '—')
    .setFooter({ text: 'Select an item below to buy  •  Or use /kyriz buy' })
    .setTimestamp();

  const selectRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`shop:select:${userId}`)
      .setPlaceholder('Select an item to buy...')
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(
        ...items.map((i) => ({
          label: `${i.emoji} ${i.name}`.slice(0, 100),
          description: `💎 ${i.price.toLocaleString()} Kryztal`.slice(0, 100),
          value: i.id,
        }))
      )
  );

  const navRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`shop:page:${userId}:${pageNum - 1}`)
      .setLabel('◀️ Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(pageNum === 0),
    new ButtonBuilder()
      .setCustomId(`shop:page:${userId}:${pageNum + 1}`)
      .setLabel('Next ▶️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(pageNum === SHOP_PAGES.length - 1)
  );

  return { embeds: [embed], components: [selectRow, navRow] };
}

async function handleShop(context, userId) {
  let sent;
  try {
    sent = await context.reply({ ...buildShopPage(0, userId), fetchReply: true });
  } catch {
    // Reply may have succeeded but the message fetch failed (transient). The shop embed is
    // still sent; pagination/buy still work centrally — we just lose the auto-expire timer.
    return;
  }
  try {
    // Auto-delete the WHOLE shop message after 60s of inactivity (resets on any click by the owner).
    const collector = sent.createMessageComponentCollector({ idle: 60000 });
    collector.on('end', async () => { try { await sent.delete(); } catch {} });
  } catch { /* collector is best-effort; shop still works without it */ }
}

async function handleInventory(context, userId, isPrefix = false) {
  const state = shopManager.getInventoryState(userId);
  if (!state) {
    const content = 'You are not registered yet.';
    return isPrefix ? context.reply(content) : context.reply({ content, ephemeral: true });
  }

  // ponytail: local label fn dedups null-guard for catalog ids (catalog may drift from inventory)
  const label = (id) => { const it = getItem(id); return it ? `${it.emoji} ${it.name}` : `❓ ${id}`; };

  const invLines = Object.entries(state.inventory)
    .map(([id, n]) => `• ${label(id)} ×${n}  — \`${id}\``)
    .join('\n') || '_Empty — visit /kyriz shop._';

  const ownedLines = state.cosmetics.owned
    .map((id) => `• ${label(id)}  — \`${id}\``)
    .join('\n') || '_None yet._';

  const equipped = [
    state.cosmetics.title && `Title: ${getItem(state.cosmetics.title)?.effect.value ?? state.cosmetics.title}`,
    state.cosmetics.badge && `Badge: ${getItem(state.cosmetics.badge)?.effect.value ?? state.cosmetics.badge}`,
    state.cosmetics.color && `Color: ${getItem(state.cosmetics.color)?.name ?? state.cosmetics.color}`,
  ].filter(Boolean).join(' · ') || '_None_';

  const boostLines = [
    state.activeBoosts.daily_mult && `📅 Daily ×${state.activeBoosts.daily_mult} queued`,
  ].filter(Boolean).join(' · ') || '_None active._';

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('🎒 Your Inventory')
    .addFields(
      { name: 'Consumables', value: invLines, inline: false },
      { name: 'Active Boosts', value: boostLines, inline: false },
      { name: 'Cosmetics Owned', value: ownedLines, inline: false },
      { name: 'Equipped', value: equipped, inline: false }
    )
    .setFooter({ text: '💡 Use: /kyriz use <item> (pick from list)  •  prefix: ky use <id>' })
    .setTimestamp();
  return context.reply({ embeds: [embed] });
}

// ============================================================
// BUY (slash = confirm buttons; prefix = instant)
// ============================================================

// Shared buy-confirm builder: used by both /kyriz buy (slash) and the shop select menu.
// The [Buy]/[Cancel] buttons it produces are handled by the existing shop:buy/shop:cancel branches
// in handleButton (which call purchase() → re-validates balance, buyer-only check).
function buildBuyConfirmComponents(userId, itemId) {
  const item = getItem(itemId);
  const balance = getBalance(userId);
  const balStr = balance === Infinity ? '∞' : balance.toLocaleString();
  const afterStr = balance === Infinity ? '∞' : (balance - item.price).toLocaleString();

  const embed = new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle('🛒 Confirm Purchase')
    .setDescription(`${item.emoji} **${item.name}**\nPrice: 💎 ${item.price.toLocaleString()} Kryztal\nBalance: 💎 ${balStr} Kryztal → 💎 ${afterStr} Kryztal`)
    .setTimestamp();

  // ponytail: colon-delimited customId — item ids contain underscores (daily_boost_15),
  // so underscore-split would corrupt itemId. Colon never appears in discord user/snowflake ids.
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`shop:buy:${userId}:${itemId}`).setLabel('Buy').setStyle(ButtonStyle.Success).setEmoji('✅'),
    new ButtonBuilder().setCustomId(`shop:cancel:${userId}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary).setEmoji('❌')
  );
  return { embeds: [embed], components: [row] };
}

async function handleBuySlash(interaction, userId) {
  const itemId = interaction.options.getString('item', true);
  const item = getItem(itemId);
  if (!item) return interaction.reply({ content: 'Item not found.', ephemeral: true });

  const balance = getBalance(userId);
  if (balance !== Infinity && balance < item.price) {
    return interaction.reply({ content: `Insufficient balance. You need 💎 ${item.price.toLocaleString()} Kryztal.`, ephemeral: true });
  }

  return interaction.reply(buildBuyConfirmComponents(userId, itemId));
}

async function handleBuyPrefix(message, userId, args) {
  const itemId = (args[0] || '').toLowerCase();
  const item = getItem(itemId);
  if (!item) return message.reply(`Unknown item. Browse with \`ky shop\`, then \`ky buy <id>\` (e.g. \`ky buy lucky_token\`).`);
  const res = shopManager.purchase(userId, itemId); // atomic + re-validates balance
  if (!res.success) return message.reply(res.message);
  return message.reply(`✅ ${res.message} Balance: 💎 ${res.newBalance.toLocaleString()} Kryztal`);
}

// USE: consumable -> shopManager.useItem; permanent cosmetic -> shopManager.equipCosmetic.
async function handleUse(context, userId, args, isPrefix = false) {
  const itemId = isPrefix ? (args[0] || '').toLowerCase() : context.options.getString('item', true);
  const item = getItem(itemId);
  if (!item) {
    const m = 'Unknown item. Browse with `ky shop`, then `ky use <id>` (e.g. `ky use lucky_token`).';
    return isPrefix ? context.reply(m) : context.reply({ content: m, ephemeral: true });
  }
  const res = item.type === 'permanent'
    ? shopManager.equipCosmetic(userId, itemId)
    : shopManager.useItem(userId, itemId);
  return context.reply(res.message);
}

// PROFILE: rich card viewable for self OR another user.
async function handleProfile(context, targetId, username, avatarURL, isPrefix = false) {
  if (!isRegistered(targetId) && !isSuperAdmin(targetId)) {
    const m = 'That user is not registered yet.';
    return isPrefix ? context.reply(m) : context.reply({ content: m, ephemeral: true });
  }
  const user = getUser(targetId) || {};
  const state = shopManager.getInventoryState(targetId) || { cosmetics: { title: null, badge: null, color: null } };

  const titleItem = state.cosmetics.title ? getItem(state.cosmetics.title) : null;
  const badgeItem = state.cosmetics.badge ? getItem(state.cosmetics.badge) : null;
  const colorItem = state.cosmetics.color ? getItem(state.cosmetics.color) : null;

  const display = username + (badgeItem ? ` ${badgeItem.effect.value}` : '');
  const embedColor = colorItem ? colorItem.effect.hex : 0x5865f2;

  const bal = isSuperAdmin(targetId) ? '∞' : (user.balance || 0).toLocaleString();
  const earned = user.totalEarned || 0;
  const lost = user.totalLost || 0;
  const net = earned - lost;
  const netStr = (net >= 0 ? '+' : '') + net.toLocaleString();
  const wins = user.totalWins || 0;
  const losses = user.totalLosses || 0;
  const winRate = (wins + losses) > 0 ? Math.round((wins / (wins + losses)) * 100) : 0;
  const rank = isSuperAdmin(targetId) ? null : getGlobalRank(targetId);

  // XP progress bar (10 segments). Number() coerces superadmin's '?' to NaN→0 so no NaN% renders.
  const level = Number(user.level) || 1;
  const xp = Number(user.xp) || 0;
  const xpNeeded = Number(user.xpNeeded) || 400;
  const pct = Math.min(1, xp / xpNeeded);
  const filled = Math.round(pct * 10);
  const bar = '▰'.repeat(filled) + '▱'.repeat(10 - filled);

  const equipped = [
    titleItem ? `Title [${titleItem.effect.value}]` : null,
    badgeItem ? `Badge ${badgeItem.effect.value}` : null,
    colorItem ? `Color ${colorItem.name.replace('Color: ', '')}` : null,
  ].filter(Boolean).join(' · ') || '_None_';

  const rankLine = isSuperAdmin(targetId) ? '🌟 Superadmin' : (rank ? `🏆 Rank #${rank} Global` : 'Unranked');
  const banner = titleItem ? `━━━━ ✦ ${(titleItem.emoji && titleItem.emoji !== '🏷️') ? titleItem.emoji + ' ' : ''}${titleItem.effect.value} ✦ ━━━━\n` : '';

  const embed = new EmbedBuilder()
    .setColor(embedColor)
    .setAuthor({ name: display, iconURL: avatarURL })
    .setDescription(banner + rankLine)
    .addFields(
      { name: `⭐ Level ${level}`, value: `${bar}  ${xp}/${xpNeeded} XP (${Math.round(pct * 100)}%)` },
      { name: 'Balance', value: `💎 **${bal}** Kryztal` },
      { name: '📊 Net Profit', value: `${netStr}  *(Earned ${earned.toLocaleString()} · Lost ${lost.toLocaleString()})*` },
      { name: '🎰 Record', value: `W/L ${wins}/${losses}  ·  Win Rate ${winRate}%` },
      { name: '🎨 Equipped', value: equipped }
    )
    .setFooter({ text: `Member since ${new Date(user.registeredAt || Date.now()).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' })}` })
    .setTimestamp();
  return context.reply({ embeds: [embed] });
}



async function handleDaily(interaction, userId) {
  return processDaily(interaction, userId);
}

async function handleDailyPrefix(message, userId) {
  return processDaily(message, userId);
}

async function processDaily(context, userId) {
  if (isSuperAdmin(userId)) {
    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('Daily Reward')
      .setDescription('You have unlimited Kryztal. Daily is not needed.')
      .setTimestamp();
    return context.reply({ embeds: [embed] });
  }

  const result = claimDaily(userId);

  if (!result.success) {
    return context.reply({ content: result.message });
  }

  // Add XP for daily
  const xpResult = addXP(userId, XP_DAILY);
  const user = getUser(userId);

  let description = `You received 💎 **${result.amount.toLocaleString()}** Kryztal!\n+${XP_DAILY} XP`;
  if (xpResult.leveledUp) {
    description += `\n\n🎉 LEVEL UP! You are now **Level ${xpResult.newLevel}**! 💎 +${xpResult.rewardTotal.toLocaleString()} Kryztal`;
  }

  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('Daily Reward')
    .setDescription(description)
    .setFooter({ text: `Balance: 💎 ${user.balance.toLocaleString()} Kryztal | Level ${user.level} (${user.xp}/${user.xpNeeded} XP)` })
    .setTimestamp();

  return context.reply({ embeds: [embed] });
}

// ============================================================
// TRANSFER
// ============================================================

async function handleTransfer(interaction, userId) {
  const targetUser = interaction.options.getUser('user');
  const amount = interaction.options.getInteger('amount');

  if (targetUser.id === userId) {
    return interaction.reply({ content: 'You cannot transfer to yourself.', ephemeral: true });
  }

  if (targetUser.bot) {
    return interaction.reply({ content: 'You cannot transfer to a bot.', ephemeral: true });
  }

  if (!isRegistered(targetUser.id)) {
    return interaction.reply({
      content: 'The recipient is not registered yet. They need to accept the Terms & Conditions first.',
      ephemeral: true,
    });
  }

  // Check balance
  if (!isSuperAdmin(userId)) {
    const balance = getBalance(userId);
    if (balance < amount) {
      return interaction.reply({
        content: `Insufficient balance. You have 💎 **${balance.toLocaleString()}** Kryztal.`,
        ephemeral: true,
      });
    }
  }

  const transferId = `${userId}_${Date.now()}`;
  pendingTransfers.set(transferId, { fromId: userId, toId: targetUser.id, amount, targetUsername: targetUser.username });
  scheduleTransferExpiry(transferId);

  const embed = new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle('Confirm Transfer')
    .setDescription(
      `Are you sure you want to send 💎 **${amount.toLocaleString()}** Kryztal to **${targetUser.username}**?`
    )
    .setTimestamp();

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`tf_confirm_${transferId}`)
      .setLabel('Confirm')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`tf_cancel_${transferId}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Danger)
  );

  // Ephemeral confirmation
  return interaction.reply({ embeds: [embed], components: [buttons], ephemeral: true });
}

async function handleTransferPrefix(message, userId, args) {
  // Parse: ky transfer @user 1000
  if (args.length < 2) {
    return message.reply('Usage: `ky transfer @user amount`');
  }

  // Extract mentioned user
  const mentionMatch = args[0].match(/^<@!?(\d+)>$/);
  if (!mentionMatch) {
    return message.reply('Please mention a valid user. Usage: `ky transfer @user amount`');
  }

  const targetId = mentionMatch[1];
  const amount = parseInt(args[1]);

  if (isNaN(amount) || amount < 1) {
    return message.reply('Please enter a valid amount.');
  }

  if (targetId === userId) {
    return message.reply('You cannot transfer to yourself.');
  }

  if (!isRegistered(targetId)) {
    return message.reply('The recipient is not registered yet.');
  }

  if (!isSuperAdmin(userId)) {
    const balance = getBalance(userId);
    if (balance < amount) {
      return message.reply(`Insufficient balance. You have 💎 **${balance.toLocaleString()}** Kryztal.`);
    }
  }

  // For prefix commands, do the transfer directly (no ephemeral buttons available)
  // But we can use a reply with buttons
  const transferId = `${userId}_${Date.now()}`;
  const targetUser = await message.client.users.fetch(targetId);
  pendingTransfers.set(transferId, { fromId: userId, toId: targetId, amount, targetUsername: targetUser.username, channelId: message.channel.id });
  scheduleTransferExpiry(transferId);

  const embed = new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle('Confirm Transfer')
    .setDescription(
      `Are you sure you want to send 💎 **${amount.toLocaleString()}** Kryztal to **${targetUser.username}**?`
    )
    .setTimestamp();

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`tf_confirm_${transferId}`)
      .setLabel('Confirm')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`tf_cancel_${transferId}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Danger)
  );

  return message.reply({ embeds: [embed], components: [buttons] });
}

/**
 * Clean up expired pending transfers (auto-expire after 120 seconds)
 */
function scheduleTransferExpiry(transferId) {
  setTimeout(() => {
    pendingTransfers.delete(transferId);
  }, 120000);
}

// ============================================================
// COINFLIP
// ============================================================

function parseSide(input) {
  if (!input) return 'heads';
  const s = input.toLowerCase();
  if (s === 'heads' || s === 'head' || s === 'h') return 'heads';
  if (s === 'tails' || s === 'tail' || s === 't') return 'tails';
  return null; // invalid
}

async function handleCoinflip(interaction, userId) {
  const betStr = interaction.options.getString('bet');
  const sideStr = interaction.options.getString('side') || 'heads';
  return playCoinflip(interaction, userId, betStr, sideStr, 'reply');
}

async function handleCoinflipPrefix(message, userId, args) {
  const betStr = args[0];
  const sideStr = args[1];
  return playCoinflip(message, userId, betStr, sideStr, 'reply');
}

async function playCoinflip(context, userId, betStr, sideStr, method) {
  const username = context.user?.username || context.author?.username || 'Player';
  const side = parseSide(sideStr);
  if (side === null) {
    return context.reply({ content: 'Invalid side. Please choose `heads` or `tails`.\n\nUsage: `ky cf [bet] [heads/tails]`' });
  }

  const bet = parseBet(betStr, userId);
  if (bet === null) {
    return context.reply({ content: 'Invalid bet. Use a positive number or `all`. Max: 500,000.\n\nUsage: `ky cf [bet] [heads/tails]`' });
  }

  if (!isSuperAdmin(userId)) {
    const result = removeBalance(userId, bet);
    if (!result.success) {
      return context.reply({ content: 'Insufficient balance.' });
    }
  }

  const result = Math.random() < 0.5 ? 'heads' : 'tails';
  const won = result === side;

  // Animation: flipping coin
  const flipEmbed = new EmbedBuilder()
    .setAuthor({ name: `${username}'s game` })
    .setColor(0xfee75c)
    .setTitle('Coinflip | Flipping...')
    .setDescription(`🪙 *The coin is in the air...*\n\nYour pick: **${side}**`)
    .setTimestamp();
  const msg = await context.reply({ embeds: [flipEmbed], fetchReply: true });
  await new Promise((r) => setTimeout(r, 1500));

  if (won) {
    const payout = bet * 2;
    if (!isSuperAdmin(userId)) {
      addBalance(userId, payout);
      const xpResult = addXP(userId, calculateXP(20, bet));
      sendLevelUpNotification(msg.channel, userId, xpResult);
      recordWin(userId);
    }
    const embed = new EmbedBuilder()
      .setAuthor({ name: `${username}'s game` })
      .setColor(0x57f287)
      .setTitle('Coinflip | You Win! 🎉')
      .setDescription(
        `🪙 The coin landed on **${result}**! You chose **${side}**.\n\n` +
        `Bet: 💎 **${bet.toLocaleString()}** Kryztal\n` +
        `Payout: 💎 **+${payout.toLocaleString()}** Kryztal`
      )
      .setTimestamp();
    try { return await msg.edit({ embeds: [embed] }); } catch { return; }
  } else {
    if (!isSuperAdmin(userId)) {
      const xpResult = addXP(userId, calculateXP(5, bet));
      sendLevelUpNotification(msg.channel, userId, xpResult);
      recordLoss(userId);
    }
    const embed = new EmbedBuilder()
      .setAuthor({ name: `${username}'s game` })
      .setColor(0xed4245)
      .setTitle('Coinflip | You Lose')
      .setDescription(
        `🪙 The coin landed on **${result}**. You chose **${side}**.\n\n` +
        `Lost: 💎 **-${bet.toLocaleString()}** Kryztal`
      )
      .setTimestamp();
    try { return await msg.edit({ embeds: [embed] }); } catch { return; }
  }
}

// ============================================================
// SLOTS
// ============================================================

const SLOT_SYMBOLS = ['🍒', '🍋', '🍊', '🍇', '💎', '7️⃣'];

function spinSlots() {
  return [
    SLOT_SYMBOLS[Math.floor(Math.random() * SLOT_SYMBOLS.length)],
    SLOT_SYMBOLS[Math.floor(Math.random() * SLOT_SYMBOLS.length)],
    SLOT_SYMBOLS[Math.floor(Math.random() * SLOT_SYMBOLS.length)],
  ];
}

async function handleSlots(interaction, userId) {
  const betStr = interaction.options.getString('bet');
  return playSlots(interaction, userId, betStr);
}

async function handleSlotsPrefix(message, userId, args) {
  return playSlots(message, userId, args[0]);
}

async function playSlots(context, userId, betStr) {
  const username = context.user?.username || context.author?.username || 'Player';
  const bet = parseBet(betStr, userId);
  if (bet === null) {
    return context.reply({ content: 'Invalid bet. Use a positive number or `all`. Max: 500,000.\n\nUsage: `ky slots [bet]`' });
  }

  if (!isSuperAdmin(userId)) {
    const result = removeBalance(userId, bet);
    if (!result.success) {
      return context.reply({ content: 'Insufficient balance.' });
    }
  }

  const reels = spinSlots();
  const randSym = () => SLOT_SYMBOLS[Math.floor(Math.random() * SLOT_SYMBOLS.length)];

  // Animation step 1: all spinning
  const spin1 = new EmbedBuilder()
    .setAuthor({ name: `${username}'s game` })
    .setColor(0xfee75c)
    .setTitle('Slots | Spinning... 🎰')
    .setDescription(`**[ ${randSym()} | ${randSym()} | ${randSym()} ]**\n\nBet: 💎 **${bet.toLocaleString()}** Kryztal`)
    .setTimestamp();
  const msg = await context.reply({ embeds: [spin1], fetchReply: true });

  // Animation step 2: first reel locked
  await new Promise((r) => setTimeout(r, 1000));
  const spin2 = new EmbedBuilder()
    .setAuthor({ name: `${username}'s game` })
    .setColor(0xfee75c)
    .setTitle('Slots | Spinning... 🎰')
    .setDescription(`**[ ${reels[0]} | ${randSym()} | ${randSym()} ]**\n\nBet: 💎 **${bet.toLocaleString()}** Kryztal`)
    .setTimestamp();
  try { await msg.edit({ embeds: [spin2] }); } catch {}

  // Animation step 3: second reel locked
  await new Promise((r) => setTimeout(r, 1000));
  const spin3 = new EmbedBuilder()
    .setAuthor({ name: `${username}'s game` })
    .setColor(0xfee75c)
    .setTitle('Slots | Spinning... 🎰')
    .setDescription(`**[ ${reels[0]} | ${reels[1]} | ${randSym()} ]**\n\nBet: 💎 **${bet.toLocaleString()}** Kryztal`)
    .setTimestamp();
  try { await msg.edit({ embeds: [spin3] }); } catch {}

  // Final result
  await new Promise((r) => setTimeout(r, 1000));
  const display = `**[ ${reels[0]} | ${reels[1]} | ${reels[2]} ]**`;

  let multiplier = 0;
  let title = 'Slots | No Match';
  let color = 0xed4245;
  let xp = 5;

  if (reels[0] === reels[1] && reels[1] === reels[2]) {
    if (reels[0] === '7️⃣') {
      multiplier = 40;
      title = 'Slots | 🎰 MEGA JACKPOT!!! 🎰';
    } else if (reels[0] === '💎') {
      multiplier = 20;
      title = 'Slots | 💎 JACKPOT! 💎';
    } else {
      multiplier = 9;
      title = 'Slots | Jackpot!';
    }
    color = 0xfee75c;
    xp = 75;
  } else if (reels[0] === reels[1]) {
    multiplier = 1.5;
    title = 'Slots | Partial Match!';
    color = 0x57f287;
    xp = 25;
  } else if (reels[1] === reels[2] || reels[0] === reels[2]) {
    multiplier = 1.0;
    title = 'Slots | Small Match!';
    color = 0x57f287;
    xp = 15;
  }

  if (multiplier > 0) {
    const payout = Math.floor(bet * multiplier);
    if (!isSuperAdmin(userId)) {
      addBalance(userId, payout);
      const xpResultW = addXP(userId, calculateXP(xp, bet));
      sendLevelUpNotification(msg.channel, userId, xpResultW);
      recordWin(userId);
    }
    const embed = new EmbedBuilder()
      .setAuthor({ name: `${username}'s game` })
      .setColor(color)
      .setTitle(title)
      .setDescription(
        `${display}\n\n` +
        `Bet: 💎 **${bet.toLocaleString()}** Kryztal\n` +
        `Multiplier: **${multiplier}x**\n` +
        `Payout: 💎 **+${payout.toLocaleString()}** Kryztal`
      )
      .setTimestamp();
    try { return await msg.edit({ embeds: [embed] }); } catch { return; }
  } else {
    if (!isSuperAdmin(userId)) {
      const xpResultL = addXP(userId, calculateXP(xp, bet));
      sendLevelUpNotification(msg.channel, userId, xpResultL);
      recordLoss(userId);
    }
    const embed = new EmbedBuilder()
      .setAuthor({ name: `${username}'s game` })
      .setColor(color)
      .setTitle(title)
      .setDescription(
        `${display}\n\n` +
        `Lost: 💎 **-${bet.toLocaleString()}** Kryztal`
      )
      .setTimestamp();
    try { return await msg.edit({ embeds: [embed] }); } catch { return; }
  }
}

// ============================================================
// DICE ROLL
// ============================================================

function parseDiceGuess(input) {
  if (!input) return null;
  const s = input.toLowerCase();
  if (s === 'even') return { type: 'parity', value: 'even' };
  if (s === 'odd') return { type: 'parity', value: 'odd' };
  const num = parseInt(s);
  if (!isNaN(num) && num >= 1 && num <= 6) return { type: 'number', value: num };
  return null;
}

async function handleDice(interaction, userId) {
  const betStr = interaction.options.getString('bet');
  const guessStr = interaction.options.getString('guess');
  return playDice(interaction, userId, betStr, guessStr);
}

async function handleDicePrefix(message, userId, args) {
  return playDice(message, userId, args[0], args[1]);
}

async function playDice(context, userId, betStr, guessStr) {
  const username = context.user?.username || context.author?.username || 'Player';
  const guess = parseDiceGuess(guessStr);
  if (!guess) {
    return context.reply({ content: 'Invalid guess. Use a number `1-6`, `even`, or `odd`.\n\nUsage: `ky dice [bet] [1-6/even/odd]`' });
  }

  const bet = parseBet(betStr, userId);
  if (bet === null) {
    return context.reply({ content: 'Invalid bet. Use a positive number or `all`. Max: 500,000.\n\nUsage: `ky dice [bet] [1-6/even/odd]`' });
  }

  if (!isSuperAdmin(userId)) {
    const result = removeBalance(userId, bet);
    if (!result.success) {
      return context.reply({ content: 'Insufficient balance.' });
    }
  }

  const roll = Math.floor(Math.random() * 6) + 1;
  const diceEmojis = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
  const guessDisplay = guess.type === 'number' ? `**${guess.value}**` : `**${guess.value}**`;

  // Animation: rolling dice
  const randFace = () => diceEmojis[Math.floor(Math.random() * 6) + 1];
  const rollEmbed = new EmbedBuilder()
    .setAuthor({ name: `${username}'s game` })
    .setColor(0xfee75c)
    .setTitle('Dice Roll | Rolling... 🎲')
    .setDescription(`${randFace()} ${randFace()} ${randFace()}\n\nYour guess: ${guessDisplay}`)
    .setTimestamp();
  const msg = await context.reply({ embeds: [rollEmbed], fetchReply: true });
  await new Promise((r) => setTimeout(r, 1500));

  let won = false;
  let multiplier = 0;

  if (guess.type === 'number' && roll === guess.value) {
    won = true;
    multiplier = 6;
  } else if (guess.type === 'parity') {
    const isEven = roll % 2 === 0;
    if ((guess.value === 'even' && isEven) || (guess.value === 'odd' && !isEven)) {
      won = true;
      multiplier = 2;
    }
  }

  if (won) {
    const payout = bet * multiplier;
    if (!isSuperAdmin(userId)) {
      addBalance(userId, payout);
      const xpResult = addXP(userId, calculateXP(guess.type === 'number' ? 50 : 25, bet));
      sendLevelUpNotification(msg.channel, userId, xpResult);
      recordWin(userId);
    }
    const embed = new EmbedBuilder()
      .setAuthor({ name: `${username}'s game` })
      .setColor(0x57f287)
      .setTitle('Dice Roll | You Win! 🎲')
      .setDescription(
        `${diceEmojis[roll]} Rolled: **${roll}** | Your guess: ${guessDisplay}\n\n` +
        `Bet: 💎 **${bet.toLocaleString()}** Kryztal\n` +
        `Multiplier: **${multiplier}x**\n` +
        `Payout: 💎 **+${payout.toLocaleString()}** Kryztal`
      )
      .setTimestamp();
    try { return await msg.edit({ embeds: [embed] }); } catch { return; }
  } else {
    if (!isSuperAdmin(userId)) {
      const xpResult = addXP(userId, calculateXP(5, bet));
      sendLevelUpNotification(msg.channel, userId, xpResult);
      recordLoss(userId);
    }
    const embed = new EmbedBuilder()
      .setAuthor({ name: `${username}'s game` })
      .setColor(0xed4245)
      .setTitle('Dice Roll | You Lose 🎲')
      .setDescription(
        `${diceEmojis[roll]} Rolled: **${roll}** | Your guess: ${guessDisplay}\n\n` +
        `Lost: 💎 **-${bet.toLocaleString()}** Kryztal`
      )
      .setTimestamp();
    try { return await msg.edit({ embeds: [embed] }); } catch { return; }
  }
}

// ============================================================
// CRASH
// ============================================================

const activeCrashGames = new Map(); // userId -> crash game state

function generateCrashPoint() {
  // Rumus crash: P(crash >= x) = (1 - edge) / x  →  RTP seragam (1 - edge) di SEMUA titik.
  // Konsekuensi: tidak ada titik cash-out yang +EV (anti-farming). Lihat diskusi/GAME_ODDS.
  // edge = house edge; cap = auto-cashout maksimum (loop berhenti di 10x).
  const edge = 0.02; // 2% house edge
  const cap = 10;    // auto-cashout di 10x
  const r = Math.random();           // r di [0,1) → (1 - r) selalu > 0, tidak ada bagi nol
  const raw = (1 - edge) / (1 - r);
  return Math.min(cap, Math.max(1.0, parseFloat(raw.toFixed(2))));
}

async function handleCrash(interaction, userId) {
  const betStr = interaction.options.getString('bet');
  return playCrash(interaction, userId, betStr, 'slash');
}

async function handleCrashPrefix(message, userId, args) {
  return playCrash(message, userId, args[0], 'prefix');
}

async function playCrash(context, userId, betStr, source) {
  const username = context.user?.username || context.author?.username || 'Player';
  if (activeCrashGames.has(userId)) {
    return context.reply({ content: 'You already have an active crash game. Cash out or wait for it to end.' });
  }

  const bet = parseBet(betStr, userId);
  if (bet === null) {
    return context.reply({ content: 'Invalid bet. Use a positive number or `all`. Max: 500,000.\n\nUsage: `ky crash [bet]`' });
  }

  if (!isSuperAdmin(userId)) {
    const result = removeBalance(userId, bet);
    if (!result.success) {
      return context.reply({ content: 'Insufficient balance.' });
    }
  }

  const crashPoint = generateCrashPoint();

  const game = {
    userId,
    username,
    bet,
    crashPoint,
    currentMultiplier: 1.0,
    cashedOut: false,
    cashoutMultiplier: null,
    payout: null,
    xpResult: null,
    finished: false,
  };

  activeCrashGames.set(userId, game);

  // If instant crash (1.0x), show crash result immediately without cashout button
  if (crashPoint <= 1.0) {
    game.finished = true;
    activeCrashGames.delete(userId);

    if (!isSuperAdmin(userId)) {
      const xpResult = addXP(userId, calculateXP(10, bet));
      sendLevelUpNotification(context.channel, userId, xpResult);
      recordLoss(userId);
    }

    const crashEmbed = new EmbedBuilder()
      .setAuthor({ name: `${username}'s game` })
      .setColor(0xed4245)
      .setTitle('Crash | 💥 Instant CRASH!')
      .setDescription(
        `Crashed at **1.00x** instantly!\n\n` +
        `Lost: 💎 **-${bet.toLocaleString()}** Kryztal`
      )
      .setTimestamp();

    return context.reply({ embeds: [crashEmbed] });
  }

  // Create initial embed
  const embed = new EmbedBuilder()
    .setAuthor({ name: `${username}'s game` })
    .setColor(0x5865f2)
    .setTitle('Crash | 🚀 Game Started')
    .setDescription(
      `Bet: 💎 **${bet.toLocaleString()}** Kryztal\n\n` +
      `Current Multiplier: **1.00x**\n` +
      `Potential Payout: 💎 **${bet.toLocaleString()}** Kryztal\n\n` +
      `Click **Cash Out** before it crashes!`
    )
    .setTimestamp();

  const button = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`crash_cashout_${userId}`)
      .setLabel('Cash Out — 1.00x')
      .setStyle(ButtonStyle.Success)
  );

  const msg = await context.reply({ embeds: [embed], components: [button], fetchReply: true });
  game.messageRef = msg;

  // Run crash game loop
  runCrashLoop(game, msg);
}

function crashTierVisual(mult) {
  if (mult >= 7) return { emoji: '🌙', color: 0xf1c40f, label: 'To the moon!' };
  if (mult >= 4) return { emoji: '💎', color: 0x57f287, label: 'Diamond hands!' };
  if (mult >= 2) return { emoji: '🔥', color: 0xe67e22, label: 'Catching fire!' };
  return { emoji: '🚀', color: 0x5865f2, label: 'Lifting off…' };
}

async function runCrashLoop(game, msg) {
  const steps = [1.10, 1.25, 1.50, 1.75, 2.00, 2.50, 3.00, 4.00, 5.00, 7.00, 10.00];
  
  for (const step of steps) {
    if (game.finished) return;
    
    await new Promise((resolve) => setTimeout(resolve, 1500));
    
    if (game.finished) return;

    if (step > game.crashPoint) {
      // CRASHED
      game.finished = true;
      activeCrashGames.delete(game.userId);

      // Hanya yang TIDAK cash-out yang kena loss. Yang cash-out sudah recordWin di handleCrashCashout.
      if (!game.cashedOut && !isSuperAdmin(game.userId)) {
        const xpResult = addXP(game.userId, calculateXP(10, game.bet));
        sendLevelUpNotification(msg.channel, game.userId, xpResult);
        recordLoss(game.userId);
      }

      const embed = new EmbedBuilder()
        .setAuthor({ name: `${game.username}'s game` })
        .setColor(game.cashedOut ? 0x57f287 : 0xed4245)
        .setTitle(game.cashedOut ? 'Crash | 💥 Crashed — but you cashed out!' : 'Crash | 💥 CRASHED!')
        .setDescription(
          game.cashedOut
            ? `Crashed at **${game.crashPoint.toFixed(2)}x**!\n\n` +
              `You cashed out at **${game.cashoutMultiplier.toFixed(2)}x** ✅\n` +
              `Payout: 💎 **+${game.payout.toLocaleString()}** Kryztal`
            : `Crashed at **${game.crashPoint.toFixed(2)}x**!\n\n` +
              `Lost: 💎 **-${game.bet.toLocaleString()}** Kryztal`
        )
        .setTimestamp();

      const disabledBtn = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`crash_cashout_${game.userId}`)
          .setLabel(
            game.cashedOut
              ? `✅ ${game.cashoutMultiplier.toFixed(2)}x → crashed ${game.crashPoint.toFixed(2)}x`
              : `Crashed at ${game.crashPoint.toFixed(2)}x`
          )
          .setStyle(game.cashedOut ? ButtonStyle.Success : ButtonStyle.Danger)
          .setDisabled(true)
      );

      try { await msg.edit({ embeds: [embed], components: [disabledBtn] }); } catch {}
      return;
    }

    // Step aman tercapai — update multiplier & tampilan
    game.currentMultiplier = step;
    const potential = Math.floor(game.bet * step);
    const tier = crashTierVisual(step);

    const embed = new EmbedBuilder()
      .setAuthor({ name: `${game.username}'s game` })
      .setColor(game.cashedOut ? 0x57f287 : tier.color)
      .setTitle(
        game.cashedOut
          ? `Crash | ✅ Cashed @ ${game.cashoutMultiplier.toFixed(2)}x — ${tier.emoji} ${tier.label}`
          : `Crash | ${tier.emoji} ${tier.label}`
      )
      .setDescription(
        game.cashedOut
          ? `You cashed out at **${game.cashoutMultiplier.toFixed(2)}x** ✅ — locked in 💎 **+${game.payout.toLocaleString()}** Kryztal\n\n` +
            `Still climbing: **${step.toFixed(2)}x** ${tier.emoji}\n` +
            `If you had held: 💎 **${potential.toLocaleString()}** Kryztal\n\n` +
            `Will it crash or moon? 🫣`
          : `Bet: 💎 **${game.bet.toLocaleString()}** Kryztal\n\n` +
            `Current Multiplier: **${step.toFixed(2)}x** ${tier.emoji}\n` +
            `Potential Payout: 💎 **${potential.toLocaleString()}** Kryztal\n\n` +
            `Click **Cash Out** before it crashes!`
      )
      .setTimestamp();

    const button = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`crash_cashout_${game.userId}`)
        .setLabel(
          game.cashedOut
            ? `✅ Cashed @ ${game.cashoutMultiplier.toFixed(2)}x`
            : `Cash Out — ${step.toFixed(2)}x`
        )
        .setStyle(ButtonStyle.Success)
        .setDisabled(game.cashedOut)
    );

    try { await msg.edit({ embeds: [embed], components: [button] }); } catch {}
  }

  // Loop selesai tanpa crash = cap 10x tercapai (crashPoint >= 10)
  if (!game.finished) {
    const autoCashed = !game.cashedOut; // pemain hold sampai moon tanpa cash-out?
    if (autoCashed) {
      game.currentMultiplier = 10.0;
      handleCrashCashout(game); // bayar 10x dulu (finished masih false), set payout/cashoutMultiplier
    }
    game.finished = true;
    activeCrashGames.delete(game.userId);

    const embed = new EmbedBuilder()
      .setAuthor({ name: `${game.username}'s game` })
      .setColor(0x57f287)
      .setTitle(autoCashed ? 'Crash | 🌙 Auto Cash Out — 10.00x!' : 'Crash | 🌙 Reached 10.00x!')
      .setDescription(
        autoCashed
          ? `Reached maximum multiplier!\n\n` +
            `Bet: 💎 **${game.bet.toLocaleString()}** Kryztal\n` +
            `Payout: 💎 **+${game.payout.toLocaleString()}** Kryztal`
          : `It climbed all the way to **10.00x**!\n\n` +
            `You cashed out at **${game.cashoutMultiplier.toFixed(2)}x** ✅\n` +
            `Payout: 💎 **+${game.payout.toLocaleString()}** Kryztal`
      )
      .setTimestamp();

    const disabledBtn = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`crash_cashout_${game.userId}`)
        .setLabel(autoCashed ? 'Auto Cashed Out at 10.00x' : `✅ ${game.cashoutMultiplier.toFixed(2)}x → hit 10.00x`)
        .setStyle(ButtonStyle.Success)
        .setDisabled(true)
    );

    try { await msg.edit({ embeds: [embed], components: [disabledBtn] }); } catch {}
    if (autoCashed) sendLevelUpNotification(msg.channel, game.userId, game.xpResult);
  }
}

function handleCrashCashout(game) {
  // Kunci payout di currentMultiplier. TIDAK mengakhiri game — loop tetap mereveal sampai crash (Opsi B).
  // Guard di bawah mencegah double-pay (dipanggil sekali per game).
  if (game.finished || game.cashedOut) return undefined;
  game.cashedOut = true;
  game.cashoutMultiplier = game.currentMultiplier;

  const payout = Math.floor(game.bet * game.currentMultiplier);
  game.payout = payout;

  if (!isSuperAdmin(game.userId)) {
    addBalance(game.userId, payout);
    const xp = game.currentMultiplier >= 5 ? 100 : 30;
    game.xpResult = addXP(game.userId, calculateXP(xp, game.bet));
    recordWin(game.userId);
  }

  return payout;
}

// ============================================================
// ROULETTE
// ============================================================

const RED_NUMBERS = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];
const BLACK_NUMBERS = [2, 4, 6, 8, 10, 11, 13, 15, 17, 20, 22, 24, 26, 28, 29, 31, 33, 35];

function parseRouletteChoice(input) {
  if (!input) return null;
  const s = input.toLowerCase().trim();
  if (s === 'red') return { type: 'color', value: 'red' };
  if (s === 'black') return { type: 'color', value: 'black' };
  if (s === 'even') return { type: 'parity', value: 'even' };
  if (s === 'odd') return { type: 'parity', value: 'odd' };
  if (s === '1-18' || s === 'low') return { type: 'range', value: 'low' };
  if (s === '19-36' || s === 'high') return { type: 'range', value: 'high' };
  const num = parseInt(s);
  if (!isNaN(num) && num >= 0 && num <= 36 && s === String(num)) return { type: 'number', value: num };
  return null;
}

function getRouletteColor(num) {
  if (num === 0) return '🟢';
  return RED_NUMBERS.includes(num) ? '🔴' : '⚫';
}

async function handleRoulette(interaction, userId) {
  const betStr = interaction.options.getString('bet');
  const choiceStr = interaction.options.getString('choice');
  return playRoulette(interaction, userId, betStr, choiceStr);
}

async function handleRoulettePrefix(message, userId, args) {
  return playRoulette(message, userId, args[0], args[1]);
}

async function playRoulette(context, userId, betStr, choiceStr) {
  const username = context.user?.username || context.author?.username || 'Player';
  const choice = parseRouletteChoice(choiceStr);
  if (!choice) {
    return context.reply({
      content: 'Invalid choice. Options: `red`, `black`, `even`, `odd`, `1-18`, `19-36`, or a number `0-36`.\n\nUsage: `ky rl [bet] [red/black/even/odd/1-18/19-36/0-36]`',
    });
  }

  const bet = parseBet(betStr, userId);
  if (bet === null) {
    return context.reply({ content: 'Invalid bet. Use a positive number or `all`. Max: 500,000.\n\nUsage: `ky rl [bet] [red/black/even/odd/1-18/19-36/0-36]`' });
  }

  if (!isSuperAdmin(userId)) {
    const result = removeBalance(userId, bet);
    if (!result.success) {
      return context.reply({ content: 'Insufficient balance.' });
    }
  }

  const result = Math.floor(Math.random() * 37); // 0-36
  const resultColor = getRouletteColor(result);
  const choiceDisplay = choice.type === 'number' ? `Number **${choice.value}**` : `**${choice.value.charAt(0).toUpperCase() + choice.value.slice(1)}**`;

  // Animation: spinning wheel
  const randNum = () => Math.floor(Math.random() * 37);
  const rn1 = randNum(); const rn2 = randNum(); const rn3 = randNum();

  const spinEmbed1 = new EmbedBuilder()
    .setAuthor({ name: `${username}'s game` })
    .setColor(0xfee75c)
    .setTitle('Roulette | 🎡 Spinning...')
    .setDescription(`${getRouletteColor(rn1)} **${rn1}** ← ball bouncing...\n\nYour bet: ${choiceDisplay}`)
    .setTimestamp();
  const msg = await context.reply({ embeds: [spinEmbed1], fetchReply: true });

  await new Promise((r) => setTimeout(r, 1000));
  const spinEmbed2 = new EmbedBuilder()
    .setAuthor({ name: `${username}'s game` })
    .setColor(0xfee75c)
    .setTitle('Roulette | 🎡 Spinning...')
    .setDescription(`${getRouletteColor(rn2)} **${rn2}** ← ball bouncing...\n\nYour bet: ${choiceDisplay}`)
    .setTimestamp();
  try { await msg.edit({ embeds: [spinEmbed2] }); } catch {}

  await new Promise((r) => setTimeout(r, 1000));
  const spinEmbed3 = new EmbedBuilder()
    .setAuthor({ name: `${username}'s game` })
    .setColor(0xfee75c)
    .setTitle('Roulette | 🎡 Slowing down...')
    .setDescription(`${getRouletteColor(rn3)} **${rn3}** ← almost there...\n\nYour bet: ${choiceDisplay}`)
    .setTimestamp();
  try { await msg.edit({ embeds: [spinEmbed3] }); } catch {}

  await new Promise((r) => setTimeout(r, 1000));

  // Determine outcome
  const isRed = RED_NUMBERS.includes(result);
  const isBlack = BLACK_NUMBERS.includes(result);

  let won = false;
  let multiplier = 0;

  switch (choice.type) {
    case 'color':
      if (choice.value === 'red' && isRed) { won = true; multiplier = 2; }
      else if (choice.value === 'black' && isBlack) { won = true; multiplier = 2; }
      break;
    case 'parity':
      if (result !== 0) {
        if (choice.value === 'even' && result % 2 === 0) { won = true; multiplier = 2; }
        else if (choice.value === 'odd' && result % 2 !== 0) { won = true; multiplier = 2; }
      }
      break;
    case 'range':
      if (choice.value === 'low' && result >= 1 && result <= 18) { won = true; multiplier = 2; }
      else if (choice.value === 'high' && result >= 19 && result <= 36) { won = true; multiplier = 2; }
      break;
    case 'number':
      if (result === choice.value) { won = true; multiplier = 36; }
      break;
  }

  if (won) {
    const payout = bet * multiplier;
    if (!isSuperAdmin(userId)) {
      addBalance(userId, payout);
      const xpResult = addXP(userId, calculateXP(choice.type === 'number' ? 75 : 25, bet));
      sendLevelUpNotification(msg.channel, userId, xpResult);
      recordWin(userId);
    }
    const embed = new EmbedBuilder()
      .setAuthor({ name: `${username}'s game` })
      .setColor(0x57f287)
      .setTitle('Roulette | You Win! 🎡')
      .setDescription(
        `${resultColor} Ball landed on **${result}**\n` +
        `Your bet: ${choiceDisplay}\n\n` +
        `Bet: 💎 **${bet.toLocaleString()}** Kryztal\n` +
        `Multiplier: **${multiplier}x**\n` +
        `Payout: 💎 **+${payout.toLocaleString()}** Kryztal`
      )
      .setTimestamp();
    try { return await msg.edit({ embeds: [embed] }); } catch { return; }
  } else {
    if (!isSuperAdmin(userId)) {
      const xpResult = addXP(userId, calculateXP(5, bet));
      sendLevelUpNotification(msg.channel, userId, xpResult);
      recordLoss(userId);
    }
    const embed = new EmbedBuilder()
      .setAuthor({ name: `${username}'s game` })
      .setColor(0xed4245)
      .setTitle('Roulette | You Lose 🎡')
      .setDescription(
        `${resultColor} Ball landed on **${result}**\n` +
        `Your bet: ${choiceDisplay}\n\n` +
        `Lost: 💎 **-${bet.toLocaleString()}** Kryztal`
      )
      .setTimestamp();
    try { return await msg.edit({ embeds: [embed] }); } catch { return; }
  }
}

// ============================================================
// MINES (Minesweeper)
// ============================================================

/**
 * Calculate mines multiplier based on total tiles, mines count, and tiles revealed.
 * Formula: cumulative probability-based, with ~3% house edge.
 * multiplier = (1 - houseEdge) * product of (remaining / safe) for each reveal step
 */
function calculateMinesMultiplier(totalTiles, minesCount, revealed) {
  if (revealed === 0) return 1.0;
  const houseEdge = 0; // No house edge — fair multiplier
  let multiplier = 1.0;
  for (let i = 0; i < revealed; i++) {
    const remaining = totalTiles - i;
    const safe = remaining - minesCount;
    if (safe <= 0) return multiplier;
    multiplier *= remaining / safe;
  }
  return parseFloat((multiplier * (1 - houseEdge)).toFixed(2));
}

async function handleMines(interaction, userId) {
  const betStr = interaction.options.getString('bet');
  const minesCount = interaction.options.getInteger('mines') || 3;
  return playMines(interaction, userId, betStr, minesCount, 'slash');
}

async function handleMinesPrefix(message, userId, args) {
  const betStr = args[0];
  const minesCount = parseInt(args[1]) || 3;
  if (args[1] && (isNaN(parseInt(args[1])) || parseInt(args[1]) < 1 || parseInt(args[1]) > 12)) {
    return message.reply({ content: 'Invalid mines count. Must be 1-12.\n\nUsage: `ky mines [bet] [mines: 1-12]`' });
  }
  return playMines(message, userId, betStr, minesCount, 'prefix');
}

async function playMines(context, userId, betStr, minesCount, source) {
  const username = context.user?.username || context.author?.username || 'Player';
  // Validate mines count
  if (minesCount < 1 || minesCount > 12) {
    return context.reply({ content: 'Invalid mines count. Must be between 1 and 12.\n\nUsage: `ky mines [bet] [mines: 1-12]`' });
  }

  // Check active game
  if (activeMinesGames.has(userId)) {
    return context.reply({ content: 'You already have an active Mines game. Finish it first.' });
  }

  const bet = parseBet(betStr, userId);
  if (bet === null) {
    return context.reply({ content: 'Invalid bet. Use a positive number or `all`. Max: 500,000.\n\nUsage: `ky mines [bet] [mines: 1-12]`' });
  }

  // Deduct balance
  if (!isSuperAdmin(userId)) {
    const result = removeBalance(userId, bet);
    if (!result.success) {
      return context.reply({ content: `Insufficient balance. You have 💎 **${getBalance(userId).toLocaleString()}** Kryztal.` });
    }
  }

  // Generate mine positions
  const totalTiles = 16; // 4x4 grid
  const minePositions = new Set();
  while (minePositions.size < minesCount) {
    minePositions.add(Math.floor(Math.random() * totalTiles));
  }

  const game = {
    userId,
    username,
    bet,
    minesCount,
    totalTiles,
    minePositions,
    revealedTiles: new Set(),
    finished: false,
    cashedOut: false,
    processing: false,
    messageRef: null,
    timeout: null,
  };

  activeMinesGames.set(userId, game);

  const currentMultiplier = 1.0;
  const embed = createMinesEmbed(game, currentMultiplier, false);
  const components = createMinesButtons(game, userId);

  const msg = await context.reply({ embeds: [embed], components, fetchReply: true });
  game.messageRef = msg;

  // Auto cash-out after 120s
  game.timeout = setTimeout(() => {
    autoMinesCashout(game);
  }, 120000);
}

function createMinesEmbed(game, multiplier, gameOver, hitMine = false) {
  const safeTiles = game.totalTiles - game.minesCount;
  const revealed = game.revealedTiles.size;
  const potential = Math.floor(game.bet * multiplier);

  let gridDisplay = '';
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      const idx = row * 4 + col;
      if (game.revealedTiles.has(idx) && game.minePositions.has(idx)) {
        gridDisplay += '💣 '; // The mine they clicked
      } else if (game.revealedTiles.has(idx)) {
        gridDisplay += '💎 ';
      } else if (gameOver && game.minePositions.has(idx)) {
        gridDisplay += '💣 ';
      } else if (gameOver) {
        gridDisplay += '⬜ ';
      } else {
        gridDisplay += '⬜ ';
      }
    }
    gridDisplay += '\n';
  }

  const embed = new EmbedBuilder().setAuthor({ name: `${game.username}'s game` }).setTimestamp();

  if (hitMine) {
    embed
      .setColor(0xed4245)
      .setTitle('Mines | 💣 BOOM!')
      .setDescription(
        `${gridDisplay}\n` +
        `Mines: **${game.minesCount}** | Revealed: **${revealed}**\n\n` +
        `Lost: 💎 **-${game.bet.toLocaleString()}** Kryztal`
      );
  } else if (game.cashedOut) {
    embed
      .setColor(0x57f287)
      .setTitle('Mines | 💰 Cashed Out!')
      .setDescription(
        `${gridDisplay}\n` +
        `Mines: **${game.minesCount}** | Revealed: **${revealed}/${safeTiles}**\n\n` +
        `Multiplier: **${multiplier}x**\n` +
        `Bet: 💎 **${game.bet.toLocaleString()}** Kryztal\n` +
        `Payout: 💎 **+${potential.toLocaleString()}** Kryztal`
      );
  } else if (revealed >= safeTiles) {
    embed
      .setColor(0xf1c40f)
      .setTitle('Mines | 🏆 ALL CLEAR!')
      .setDescription(
        `${gridDisplay}\n` +
        `You found every safe tile!\n\n` +
        `Multiplier: **${multiplier}x**\n` +
        `Bet: 💎 **${game.bet.toLocaleString()}** Kryztal\n` +
        `Payout: 💎 **+${potential.toLocaleString()}** Kryztal`
      );
  } else {
    embed
      .setColor(0x5865f2)
      .setTitle('Mines | 💎 Playing...')
      .setDescription(
        `${gridDisplay}\n` +
        `Mines: **${game.minesCount}** | Revealed: **${revealed}/${safeTiles}**\n\n` +
        `Current Multiplier: **${multiplier}x**\n` +
        `Potential Payout: 💎 **${potential.toLocaleString()}** Kryztal\n\n` +
        `Click tiles to reveal, or **Cash Out** to collect!`
      );
  }

  return embed;
}

function createMinesButtons(game, userId) {
  const rows = [];
  for (let row = 0; row < 4; row++) {
    const actionRow = new ActionRowBuilder();
    for (let col = 0; col < 4; col++) {
      const idx = row * 4 + col;
      const btn = new ButtonBuilder()
        .setCustomId(`mines_tile_${userId}_${idx}`);

      if (game.revealedTiles.has(idx)) {
        btn.setLabel('💎').setStyle(ButtonStyle.Success).setDisabled(true);
      } else {
        btn.setLabel('⬜').setStyle(ButtonStyle.Secondary);
      }

      actionRow.addComponents(btn);
    }
    rows.push(actionRow);
  }

  // Cash out button row
  const multiplier = calculateMinesMultiplier(game.totalTiles, game.minesCount, game.revealedTiles.size);
  const cashoutRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`mines_cashout_${userId}`)
      .setLabel(`💰 Cash Out — ${multiplier}x`)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(game.revealedTiles.size === 0) // Can't cash out without revealing at least 1
  );
  rows.push(cashoutRow);

  return rows;
}

function createMinesDisabledButtons(game, userId) {
  const rows = [];
  for (let row = 0; row < 4; row++) {
    const actionRow = new ActionRowBuilder();
    for (let col = 0; col < 4; col++) {
      const idx = row * 4 + col;
      const btn = new ButtonBuilder()
        .setCustomId(`mines_tile_${userId}_${idx}`)
        .setDisabled(true);

      if (game.revealedTiles.has(idx) && game.minePositions.has(idx)) {
        btn.setLabel('💣').setStyle(ButtonStyle.Danger);
      } else if (game.revealedTiles.has(idx)) {
        btn.setLabel('💎').setStyle(ButtonStyle.Success);
      } else if (game.minePositions.has(idx)) {
        btn.setLabel('💣').setStyle(ButtonStyle.Danger);
      } else {
        btn.setLabel('⬜').setStyle(ButtonStyle.Secondary);
      }

      actionRow.addComponents(btn);
    }
    rows.push(actionRow);
  }

  const cashoutRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`mines_cashout_${userId}`)
      .setLabel('Game Over')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true)
  );
  rows.push(cashoutRow);

  return rows;
}

function finishMinesGame(game, won, multiplier) {
  game.finished = true;
  if (game.timeout) {
    clearTimeout(game.timeout);
    game.timeout = null;
  }
  activeMinesGames.delete(game.userId);

  if (won) {
    const payout = Math.floor(game.bet * multiplier);
    if (!isSuperAdmin(game.userId)) {
      addBalance(game.userId, payout);
      const xp = Math.min(30 + game.revealedTiles.size * 7, 100);
      game.xpResult = addXP(game.userId, calculateXP(xp, game.bet));
      recordWin(game.userId);
    }
    return payout;
  } else {
    if (!isSuperAdmin(game.userId)) {
      game.xpResult = addXP(game.userId, calculateXP(XP_LOSE, game.bet));
      recordLoss(game.userId);
    }
    return 0;
  }
}

async function autoMinesCashout(game) {
  if (game.finished) return;
  if (game.revealedTiles.size === 0) {
    // Nothing revealed, just refund
    game.finished = true;
    activeMinesGames.delete(game.userId);
    if (!isSuperAdmin(game.userId)) {
      addBalance(game.userId, game.bet);
    }
    if (game.timeout) { clearTimeout(game.timeout); game.timeout = null; }
    try {
      const embed = new EmbedBuilder()
        .setAuthor({ name: `${game.username}'s game` })
        .setColor(0xfee75c)
        .setTitle('Mines | ⏰ Time Expired')
        .setDescription('No tiles revealed. Your bet has been returned.')
        .setTimestamp();
      await game.messageRef.edit({ embeds: [embed], components: createMinesDisabledButtons(game, game.userId) });
    } catch {}
    return;
  }

  game.cashedOut = true;
  const multiplier = calculateMinesMultiplier(game.totalTiles, game.minesCount, game.revealedTiles.size);
  const payout = finishMinesGame(game, true, multiplier);

  const embed = createMinesEmbed(game, multiplier, true);
  embed.setFooter({ text: '⏰ Auto Cash Out — Time expired' });
  const components = createMinesDisabledButtons(game, game.userId);

  try { await game.messageRef.edit({ embeds: [embed], components }); } catch {}
  if (game.messageRef?.channel) sendLevelUpNotification(game.messageRef.channel, game.userId, game.xpResult);
}

// ============================================================
// HI-LO (Higher/Lower)
// ============================================================

const HILO_CARD_NAMES = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const HILO_SUITS = ['♠️', '♥️', '♦️', '♣️'];

function hiloDrawCard() {
  const value = Math.floor(Math.random() * 13) + 1; // 1-13
  const suit = HILO_SUITS[Math.floor(Math.random() * 4)];
  return { value, suit, display: `${HILO_CARD_NAMES[value]}${suit}` };
}

/**
 * Calculate hilo multiplier based on the current card and guess type.
 * Higher: (13 / cards_higher) — fair, no house edge
 * Lower: (13 / cards_lower) — fair, no house edge
 * Same: (13 / cards_same) — fair, no house edge
 */
function hiloGuessMultiplier(currentValue, guess) {
  const houseEdge = 1.0; // No house edge — fair multiplier
  let validCount;

  if (guess === 'higher') {
    validCount = 13 - currentValue; // cards strictly higher
  } else if (guess === 'lower') {
    validCount = currentValue - 1; // cards strictly lower
  } else { // same
    validCount = 1; // only same value
  }

  if (validCount <= 0) return 0; // impossible guess
  return parseFloat(((13 / validCount) * houseEdge).toFixed(2));
}

async function handleHilo(interaction, userId) {
  const betStr = interaction.options.getString('bet');
  return playHilo(interaction, userId, betStr, 'slash');
}

async function handleHiloPrefix(message, userId, args) {
  return playHilo(message, userId, args[0], 'prefix');
}

async function playHilo(context, userId, betStr, source) {
  const username = context.user?.username || context.author?.username || 'Player';
  if (activeHiloGames.has(userId)) {
    return context.reply({ content: 'You already have an active Hi-Lo game. Finish it first.' });
  }

  const bet = parseBet(betStr, userId);
  if (bet === null) {
    return context.reply({ content: 'Invalid bet. Use a positive number or `all`. Max: 500,000.\n\nUsage: `ky hl [bet]`' });
  }

  if (!isSuperAdmin(userId)) {
    const result = removeBalance(userId, bet);
    if (!result.success) {
      return context.reply({ content: `Insufficient balance. You have 💎 **${getBalance(userId).toLocaleString()}** Kryztal.` });
    }
  }

  const firstCard = hiloDrawCard();

  const game = {
    userId,
    username,
    bet,
    currentCard: firstCard,
    streak: 0,
    multiplier: 1.0,
    history: [firstCard.display],
    finished: false,
    cashedOut: false,
    processing: false,
    messageRef: null,
    timeout: null,
  };

  activeHiloGames.set(userId, game);

  // Animation: card reveal
  const animEmbed = new EmbedBuilder()
    .setAuthor({ name: `${username}'s game` })
    .setColor(0xfee75c)
    .setTitle('Hi-Lo | 🃏 Drawing card...')
    .setDescription('🎴 *Shuffling the deck...*')
    .setTimestamp();

  const msg = await context.reply({ embeds: [animEmbed], fetchReply: true });
  await new Promise((r) => setTimeout(r, 1500));

  game.messageRef = msg;

  const embed = createHiloEmbed(game);
  const components = createHiloButtons(game, userId);

  try { await msg.edit({ embeds: [embed], components }); } catch {}

  // Timeout: 60s
  game.timeout = setTimeout(() => {
    autoHiloCashout(game);
  }, 60000);
}

function createHiloEmbed(game) {
  const card = game.currentCard;
  const potential = Math.floor(game.bet * game.multiplier);
  const historyStr = game.history.join(' → ');

  // Calculate multipliers for display
  const higherMult = hiloGuessMultiplier(card.value, 'higher');
  const lowerMult = hiloGuessMultiplier(card.value, 'lower');
  const sameMult = hiloGuessMultiplier(card.value, 'same');

  const oddsDisplay = [
    higherMult > 0 ? `⬆️ Higher: **${higherMult}x**` : '⬆️ Higher: ~~impossible~~',
    lowerMult > 0 ? `⬇️ Lower: **${lowerMult}x**` : '⬇️ Lower: ~~impossible~~',
    `↔️ Same: **${sameMult}x**`,
  ].join('\n');

  return new EmbedBuilder()
    .setAuthor({ name: `${game.username}'s game` })
    .setColor(0x5865f2)
    .setTitle(`Hi-Lo | 🃏 Streak: ${game.streak}`)
    .setDescription(
      `Current card: **${card.display}** (Value: ${card.value})\n\n` +
      `${oddsDisplay}\n\n` +
      `Cards: ${historyStr}\n\n` +
      `Current Multiplier: **${game.multiplier}x**\n` +
      `Potential Payout: 💎 **${potential.toLocaleString()}** Kryztal\n\n` +
      `Guess the next card, or **Cash Out**!`
    )
    .setTimestamp();
}

function createHiloButtons(game, userId) {
  const card = game.currentCard;
  const higherMult = hiloGuessMultiplier(card.value, 'higher');
  const lowerMult = hiloGuessMultiplier(card.value, 'lower');
  const sameMult = hiloGuessMultiplier(card.value, 'same');

  const guessRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`hilo_higher_${userId}`)
      .setLabel(`Higher ⬆️ (${higherMult}x)`)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(higherMult === 0), // King can't go higher
    new ButtonBuilder()
      .setCustomId(`hilo_lower_${userId}`)
      .setLabel(`Lower ⬇️ (${lowerMult}x)`)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(lowerMult === 0), // Ace can't go lower
    new ButtonBuilder()
      .setCustomId(`hilo_same_${userId}`)
      .setLabel(`Same ↔️ (${sameMult}x)`)
      .setStyle(ButtonStyle.Secondary)
  );

  const cashoutRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`hilo_cashout_${userId}`)
      .setLabel(`💰 Cash Out — ${game.multiplier}x`)
      .setStyle(ButtonStyle.Success)
      .setDisabled(game.streak === 0) // Can't cash out without at least 1 correct guess
  );

  return [guessRow, cashoutRow];
}

function createHiloDisabledButtons(userId) {
  const guessRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`hilo_higher_${userId}`).setLabel('Higher ⬆️').setStyle(ButtonStyle.Primary).setDisabled(true),
    new ButtonBuilder().setCustomId(`hilo_lower_${userId}`).setLabel('Lower ⬇️').setStyle(ButtonStyle.Primary).setDisabled(true),
    new ButtonBuilder().setCustomId(`hilo_same_${userId}`).setLabel('Same ↔️').setStyle(ButtonStyle.Secondary).setDisabled(true)
  );
  const cashoutRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`hilo_cashout_${userId}`).setLabel('Game Over').setStyle(ButtonStyle.Secondary).setDisabled(true)
  );
  return [guessRow, cashoutRow];
}

function finishHiloGame(game, won) {
  game.finished = true;
  if (game.timeout) {
    clearTimeout(game.timeout);
    game.timeout = null;
  }
  activeHiloGames.delete(game.userId);

  if (won) {
    const payout = Math.floor(game.bet * game.multiplier);
    if (!isSuperAdmin(game.userId)) {
      addBalance(game.userId, payout);
      const xp = Math.min(30 + game.streak * 10, 100);
      game.xpResult = addXP(game.userId, calculateXP(xp, game.bet));
      recordWin(game.userId);
    }
    return payout;
  } else {
    if (!isSuperAdmin(game.userId)) {
      game.xpResult = addXP(game.userId, calculateXP(XP_LOSE, game.bet));
      recordLoss(game.userId);
    }
    return 0;
  }
}

async function autoHiloCashout(game) {
  if (game.finished) return;

  if (game.streak === 0) {
    // No correct guesses, forfeit
    game.finished = true;
    activeHiloGames.delete(game.userId);
    if (!isSuperAdmin(game.userId)) {
      game.xpResult = addXP(game.userId, calculateXP(XP_LOSE, game.bet));
      recordLoss(game.userId);
    }
    if (game.timeout) { clearTimeout(game.timeout); game.timeout = null; }
    try {
      const embed = new EmbedBuilder()
        .setAuthor({ name: `${game.username}'s game` })
        .setColor(0xed4245)
        .setTitle('Hi-Lo | ⏰ Time Expired')
        .setDescription(`No guesses made. You lose 💎 **${game.bet.toLocaleString()}** Kryztal.`)
        .setTimestamp();
      await game.messageRef.edit({ embeds: [embed], components: createHiloDisabledButtons(game.userId) });
    } catch {}
    return;
  }

  game.cashedOut = true;
  const payout = finishHiloGame(game, true);

  const embed = new EmbedBuilder()
    .setAuthor({ name: `${game.username}'s game` })
    .setColor(0x57f287)
    .setTitle('Hi-Lo | 💰 Auto Cash Out!')
    .setDescription(
      `Cards: ${game.history.join(' → ')}\n\n` +
      `Streak: **${game.streak}** | Multiplier: **${game.multiplier}x**\n\n` +
      `Bet: 💎 **${game.bet.toLocaleString()}** Kryztal\n` +
      `Payout: 💎 **+${payout.toLocaleString()}** Kryztal`
    )
    .setFooter({ text: '⏰ Auto Cash Out — Time expired' })
    .setTimestamp();

  try { await game.messageRef.edit({ embeds: [embed], components: createHiloDisabledButtons(game.userId) }); } catch {}
  if (game.messageRef?.channel) sendLevelUpNotification(game.messageRef.channel, game.userId, game.xpResult);
}

// ============================================================
// TOWER
// ============================================================

const TOWER_CONFIGS = {
  easy:   { doors: 3, traps: 1, label: 'Easy' },
  medium: { doors: 3, traps: 2, label: 'Medium' },
  hard:   { doors: 4, traps: 3, label: 'Hard' },
};

/**
 * Calculate tower multiplier based on difficulty and floors cleared.
 * multiplier = (doors / safeDoors)^floors * (1 - houseEdge)
 */
function calculateTowerMultiplier(difficulty, floorsCleared) {
  if (floorsCleared === 0) return 1.0;
  const config = TOWER_CONFIGS[difficulty];
  const houseEdge = 0; // No house edge — fair multiplier
  const oddsPerFloor = config.doors / (config.doors - config.traps);
  const raw = Math.pow(oddsPerFloor, floorsCleared) * (1 - houseEdge);
  return parseFloat(raw.toFixed(2));
}

async function handleTower(interaction, userId) {
  const betStr = interaction.options.getString('bet');
  const difficulty = interaction.options.getString('difficulty') || 'easy';
  return playTower(interaction, userId, betStr, difficulty, 'slash');
}

async function handleTowerPrefix(message, userId, args) {
  const betStr = args[0];
  let difficulty = (args[1] || 'easy').toLowerCase();
  if (!['easy', 'medium', 'hard'].includes(difficulty)) {
    return message.reply({ content: 'Invalid difficulty. Options: `easy`, `medium`, `hard`.\n\nUsage: `ky tw [bet] [easy/medium/hard]`' });
  }
  return playTower(message, userId, betStr, difficulty, 'prefix');
}

async function playTower(context, userId, betStr, difficulty, source) {
  const username = context.user?.username || context.author?.username || 'Player';
  if (activeTowerGames.has(userId)) {
    return context.reply({ content: 'You already have an active Tower game. Finish it first.' });
  }

  if (!TOWER_CONFIGS[difficulty]) {
    return context.reply({ content: 'Invalid difficulty. Options: `easy`, `medium`, `hard`.\n\nUsage: `ky tw [bet] [easy/medium/hard]`' });
  }

  const bet = parseBet(betStr, userId);
  if (bet === null) {
    return context.reply({ content: 'Invalid bet. Use a positive number or `all`. Max: 500,000.\n\nUsage: `ky tw [bet] [easy/medium/hard]`' });
  }

  if (!isSuperAdmin(userId)) {
    const result = removeBalance(userId, bet);
    if (!result.success) {
      return context.reply({ content: `Insufficient balance. You have 💎 **${getBalance(userId).toLocaleString()}** Kryztal.` });
    }
  }

  const config = TOWER_CONFIGS[difficulty];
  const maxFloors = 10;

  // Pre-generate trap positions for all floors
  const floors = [];
  for (let f = 0; f < maxFloors; f++) {
    const trapPositions = new Set();
    while (trapPositions.size < config.traps) {
      trapPositions.add(Math.floor(Math.random() * config.doors));
    }
    floors.push({ trapPositions, revealed: false, chosenDoor: null });
  }

  const game = {
    userId,
    username,
    bet,
    difficulty,
    config,
    maxFloors,
    floors,
    currentFloor: 0, // 0-indexed, next floor to play
    finished: false,
    cashedOut: false,
    processing: false,
    messageRef: null,
    timeout: null,
  };

  activeTowerGames.set(userId, game);

  const embed = createTowerEmbed(game);
  const components = createTowerButtons(game, userId);

  const msg = await context.reply({ embeds: [embed], components, fetchReply: true });
  game.messageRef = msg;

  // Timeout: 120s
  game.timeout = setTimeout(() => {
    autoTowerCashout(game);
  }, 120000);
}

function createTowerEmbed(game, hitTrap = false) {
  const config = game.config;
  const multiplier = calculateTowerMultiplier(game.difficulty, game.currentFloor);
  const potential = Math.floor(game.bet * multiplier);
  const floorNum = game.currentFloor + 1; // Display 1-indexed

  // Build tower visual (show from current floor down to floor 1)
  let towerDisplay = '';
  const showFloors = Math.min(game.currentFloor + 1, 8); // Show at most 8 floors

  for (let f = Math.min(game.currentFloor, game.maxFloors - 1); f >= Math.max(0, game.currentFloor - showFloors + 1); f--) {
    const floor = game.floors[f];
    const label = `Floor ${f + 1}: `;

    if (floor.revealed) {
      // Show revealed floor
      let doorDisplay = '';
      for (let d = 0; d < config.doors; d++) {
        if (d === floor.chosenDoor && floor.trapPositions.has(d)) {
          doorDisplay += '💀 ';
        } else if (d === floor.chosenDoor) {
          doorDisplay += '✅ ';
        } else if (floor.trapPositions.has(d)) {
          doorDisplay += '💀 ';
        } else {
          doorDisplay += '✅ ';
        }
      }
      towerDisplay += `${label}${doorDisplay}\n`;
    } else if (f === game.currentFloor) {
      // Current floor (unplayed)
      let doorDisplay = '';
      for (let d = 0; d < config.doors; d++) {
        doorDisplay += '🚪 ';
      }
      towerDisplay += `${label}${doorDisplay}  ← Pick a door!\n`;
    }
  }

  if (!towerDisplay) {
    let doorDisplay = '';
    for (let d = 0; d < config.doors; d++) {
      doorDisplay += '🚪 ';
    }
    towerDisplay = `Floor 1: ${doorDisplay}  ← Pick a door!\n`;
  }

  const embed = new EmbedBuilder().setAuthor({ name: `${game.username}'s game` }).setTimestamp();

  if (hitTrap) {
    embed
      .setColor(0xed4245)
      .setTitle(`Tower | 💀 GAME OVER — Floor ${floorNum}`)
      .setDescription(
        `**${config.label}** difficulty\n\n` +
        `${towerDisplay}\n` +
        `You hit a trap on Floor ${floorNum}!\n\n` +
        `Lost: 💎 **-${game.bet.toLocaleString()}** Kryztal`
      );
  } else if (game.cashedOut || game.currentFloor >= game.maxFloors) {
    embed
      .setColor(0x57f287)
      .setTitle(game.currentFloor >= game.maxFloors
        ? `Tower | 🏆 MAX FLOOR REACHED!`
        : `Tower | 💰 Cashed Out — Floor ${game.currentFloor}`)
      .setDescription(
        `**${config.label}** difficulty\n\n` +
        `${towerDisplay}\n` +
        `Floors cleared: **${game.currentFloor}/${game.maxFloors}**\n\n` +
        `Multiplier: **${multiplier}x**\n` +
        `Bet: 💎 **${game.bet.toLocaleString()}** Kryztal\n` +
        `Payout: 💎 **+${potential.toLocaleString()}** Kryztal`
      );
  } else {
    embed
      .setColor(0x5865f2)
      .setTitle(`Tower | 🏗️ Floor ${floorNum}`)
      .setDescription(
        `**${config.label}** difficulty (${config.doors} doors, ${config.traps} trap${config.traps > 1 ? 's' : ''})\n\n` +
        `${towerDisplay}\n` +
        `Floors cleared: **${game.currentFloor}/${game.maxFloors}**\n` +
        `Current Multiplier: **${multiplier}x**\n` +
        `Potential Payout: 💎 **${potential.toLocaleString()}** Kryztal\n\n` +
        `Pick a safe door to climb higher!`
      );
  }

  return embed;
}

function createTowerButtons(game, userId) {
  const config = game.config;
  const rows = [];

  // Door buttons
  const doorRow = new ActionRowBuilder();
  for (let d = 0; d < config.doors; d++) {
    doorRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`tower_door_${userId}_${d}`)
        .setLabel(`🚪 ${d + 1}`)
        .setStyle(ButtonStyle.Secondary)
    );
  }
  rows.push(doorRow);

  // Cash out button
  const multiplier = calculateTowerMultiplier(game.difficulty, game.currentFloor);
  const cashoutRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`tower_cashout_${userId}`)
      .setLabel(`💰 Cash Out — ${multiplier}x`)
      .setStyle(ButtonStyle.Success)
      .setDisabled(game.currentFloor === 0) // Can't cash out on floor 0
  );
  rows.push(cashoutRow);

  return rows;
}

function createTowerDisabledButtons(game, userId) {
  const config = game.config;
  const rows = [];

  const doorRow = new ActionRowBuilder();
  for (let d = 0; d < config.doors; d++) {
    doorRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`tower_door_${userId}_${d}`)
        .setLabel(`🚪 ${d + 1}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true)
    );
  }
  rows.push(doorRow);

  const cashoutRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`tower_cashout_${userId}`)
      .setLabel('Game Over')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true)
  );
  rows.push(cashoutRow);

  return rows;
}

function finishTowerGame(game, won) {
  game.finished = true;
  if (game.timeout) {
    clearTimeout(game.timeout);
    game.timeout = null;
  }
  activeTowerGames.delete(game.userId);

  if (won) {
    const multiplier = calculateTowerMultiplier(game.difficulty, game.currentFloor);
    const payout = Math.floor(game.bet * multiplier);
    if (!isSuperAdmin(game.userId)) {
      addBalance(game.userId, payout);
      const xp = Math.min(30 + game.currentFloor * 8, 100);
      game.xpResult = addXP(game.userId, calculateXP(xp, game.bet));
      recordWin(game.userId);
    }
    return payout;
  } else {
    if (!isSuperAdmin(game.userId)) {
      game.xpResult = addXP(game.userId, calculateXP(XP_LOSE, game.bet));
      recordLoss(game.userId);
    }
    return 0;
  }
}

async function autoTowerCashout(game) {
  if (game.finished) return;

  if (game.currentFloor === 0) {
    // No floors cleared, forfeit
    game.finished = true;
    activeTowerGames.delete(game.userId);
    if (!isSuperAdmin(game.userId)) {
      game.xpResult = addXP(game.userId, calculateXP(XP_LOSE, game.bet));
      recordLoss(game.userId);
    }
    if (game.timeout) { clearTimeout(game.timeout); game.timeout = null; }
    try {
      const embed = new EmbedBuilder()
        .setAuthor({ name: `${game.username}'s game` })
        .setColor(0xed4245)
        .setTitle('Tower | ⏰ Time Expired')
        .setDescription(`No floors cleared. You lose 💎 **${game.bet.toLocaleString()}** Kryztal.`)
        .setTimestamp();
      await game.messageRef.edit({ embeds: [embed], components: createTowerDisabledButtons(game, game.userId) });
    } catch {}
    return;
  }

  game.cashedOut = true;
  const payout = finishTowerGame(game, true);
  const multiplier = calculateTowerMultiplier(game.difficulty, game.currentFloor);

  const embed = createTowerEmbed(game);
  embed.setFooter({ text: '⏰ Auto Cash Out — Time expired' });
  const components = createTowerDisabledButtons(game, game.userId);

  try { await game.messageRef.edit({ embeds: [embed], components }); } catch {}
  if (game.messageRef?.channel) sendLevelUpNotification(game.messageRef.channel, game.userId, game.xpResult);
}



// ============================================================
// LEADERBOARD
// ============================================================

async function handleLeaderboard(interaction) {
  const scope = interaction.options.getString('scope') || 'server';
  return showLeaderboard(interaction, scope);
}

async function handleLeaderboardPrefix(message, args) {
  const scope = (args && args[0]?.toLowerCase() === 'all') ? 'all' : 'server';
  return showLeaderboard(message, scope);
}

async function showLeaderboard(context, scope = 'server') {
  const guild = context.guild;
  let users;

  if (scope === 'all' || !guild) {
    // Global leaderboard
    users = getLeaderboard(10);
  } else {
    // Server leaderboard — bulk fetch guild members, then filter
    const allUsers = getLeaderboard(1000);
    try {
      await guild.members.fetch(); // Bulk fetch all members into cache
    } catch {
      // If bulk fetch fails, fall back to global
      users = getLeaderboard(10);
      scope = 'all';
    }

    if (!users) {
      const serverUsers = [];
      for (const user of allUsers) {
        if (guild.members.cache.has(user.userId)) {
          serverUsers.push(user);
          if (serverUsers.length >= 10) break;
        }
      }
      users = serverUsers;
    }
  }

  if (users.length === 0) {
    const msg = scope === 'all'
      ? 'No registered players yet.'
      : 'No registered players in this server yet. Try `ky lb all` for global.';
    return context.reply({ content: msg });
  }

  const ranks = ['**1.**', '**2.**', '**3.**'];
  let description = '';

  for (let i = 0; i < users.length; i++) {
    const user = users[i];
    const rank = i < 3 ? ranks[i] : `**${i + 1}.**`;
    const displayName = (user.username || 'Unknown').length > 16
      ? [...(user.username || 'Unknown')].slice(0, 15).join('') + '\u2026'
      : (user.username || 'Unknown');
    const c = user.cosmetics || {};
    const titleItem = c.title ? getItem(c.title) : null;
    const badgeItem = c.badge ? getItem(c.badge) : null;
    const prefix = titleItem ? `[${(titleItem.emoji && titleItem.emoji !== '🏷️') ? titleItem.emoji + ' ' : ''}${titleItem.effect.value}] ` : '';
    const suffix = badgeItem ? ` ${badgeItem.effect.value}` : '';
    description += `${rank} ${prefix}**${displayName}**${suffix} \u2014 💎 ${user.balance.toLocaleString()} Kryztal (Lv.${user.level})\n`;
  }

  const title = scope === 'all' ? 'Leaderboard | Global Top 10' : 'Leaderboard | Server Top 10';

  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle(title)
    .setDescription(description)
    .setTimestamp();

  return context.reply({ embeds: [embed] });
}

// ============================================================
// Button interaction handler
// ============================================================

// Shop select-menu → routes to the (ephemeral) buy-confirm. The confirm's buttons reuse the
// existing shop:buy/shop:cancel handler, so no purchase logic is duplicated.
async function handleSelectMenu(interaction) {
  if (!interaction.customId.startsWith('shop:select:')) return;
  if (maintenanceMode.active && !isSuperAdmin(interaction.user.id) && !isAdmin(interaction.user.id)) {
    return interaction.reply({ content: `🛠️ ${maintenanceMode.message}`, ephemeral: true });
  }
  const ownerId = interaction.customId.split(':')[2];
  if (interaction.user.id !== ownerId) {
    return interaction.reply({ content: "This isn't your shop session — use `/kyriz shop` to open your own.", ephemeral: true });
  }
  const itemId = interaction.values && interaction.values[0];
  const item = getItem(itemId);
  if (!item) return interaction.reply({ content: 'Item not found.', ephemeral: true });
  const userId = interaction.user.id;
  // Pre-check balance (mirrors /buy) so we don't show a confirm with a negative projected balance.
  const balance = getBalance(userId);
  if (balance !== Infinity && balance < item.price) {
    return interaction.reply({ content: `Insufficient balance. You need 💎 ${item.price.toLocaleString()} Kryztal.`, ephemeral: true });
  }
  return interaction.reply({ ...buildBuyConfirmComponents(userId, itemId), ephemeral: true });
}

async function handleButton(interaction) {
  const customId = interaction.customId;

  // Battle mode buttons (per-user locked inside battleCmd.handleButton)
  if (customId.startsWith('battle_')) return battleCmd.handleButton(interaction);

  // Maintenance: block shop buy/pagination for non-admins on an already-open shop embed
  // (the command-level guard covers /shop & /buy; game buttons are left alone so in-progress
  // rounds can still finish).
  if ((customId.startsWith('shop:page:') || customId.startsWith('shop:buy:')) && maintenanceMode.active && !isSuperAdmin(interaction.user.id) && !isAdmin(interaction.user.id)) {
    return interaction.reply({ content: `🛠️ ${maintenanceMode.message}`, ephemeral: true });
  }

  // --- Shop pagination (invoker-only) ---
  if (customId.startsWith('shop:page:')) {
    const parts = customId.split(':'); // ['shop','page',userId,pageNum]
    const ownerId = parts[2];
    if (interaction.user.id !== ownerId) {
      return interaction.reply({ content: "This isn't your shop session — use `/kyriz shop` to open your own.", ephemeral: true });
    }
    let page = Number(parts[3]);
    if (!Number.isInteger(page)) page = 0;
    return interaction.update(buildShopPage(page, ownerId));
  }

  // --- Shop buy confirm/cancel (colon-delimited; item ids contain underscores) ---
  if (customId.startsWith('shop:buy:') || customId.startsWith('shop:cancel:')) {
    const parts = customId.split(':'); // ['shop', 'buy'|'cancel', userId, itemId?]
    const buyerId = parts[2];
    const itemId = parts[3];
    if (interaction.user.id !== buyerId) {
      return interaction.reply({ content: 'This is not your purchase.', ephemeral: true });
    }
    if (customId.startsWith('shop:cancel:')) {
      return interaction.update({ content: 'Purchase cancelled.', embeds: [], components: [] });
    }
    // Confirm: re-validate at click time. purchase() re-checks balance, so a buyer whose
    // balance dropped between the confirm screen and the click is rejected.
    const res = shopManager.purchase(buyerId, itemId);
    if (!res.success) {
      return interaction.update({ content: `❌ ${res.message}`, embeds: [], components: [] });
    }
    return interaction.update({ content: `✅ ${res.message} Balance: 💎 ${res.newBalance.toLocaleString()} Kryztal`, embeds: [], components: [] });
  }

  // --- T&C Accept ---
  if (customId.startsWith('tc_accept_')) {
    const targetUserId = customId.replace('tc_accept_', '');

    // Only the user who triggered can accept
    if (interaction.user.id !== targetUserId) {
      return interaction.reply({
        content: 'This is not your registration.',
        ephemeral: true,
      });
    }

    registerUser(targetUserId, interaction.user.username);

    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('Welcome to Kyriz Games!')
      .setDescription(
        `You have been registered successfully.\n\n` +
          `**Starting balance:** 💎 100,000 Kryztal\n` +
          `**Level:** 1\n\n` +
          `Use \`ky bj [bet]\` or \`/kyriz blackjack\` to start playing!`
      )
      .setTimestamp();

    // Disable the accept button
    const disabledRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`tc_accept_${targetUserId}`)
        .setLabel('Accepted')
        .setStyle(ButtonStyle.Success)
        .setDisabled(true)
    );

    return interaction.update({ embeds: [embed], components: [disabledRow] });
  }

  // --- Blackjack buttons ---
  if (customId.startsWith('bj_')) {
    const parts = customId.split('_');
    const action = parts[1]; // hit, stand, double
    const targetUserId = parts[2];

    // Only the player can interact
    if (interaction.user.id !== targetUserId) {
      return interaction.reply({
        content: 'This is not your game.',
        ephemeral: true,
      });
    }

    const game = activeGames.get(targetUserId);
    if (!game || game.finished) {
      return interaction.reply({
        content: 'This game has already ended.',
        ephemeral: true,
      });
    }

    // Prevent spam — if currently processing, ignore
    if (game.processing) {
      return interaction.deferUpdate();
    }

    game.processing = true;

    try {
      if (action === 'hit') {
        // Draw a card
        const result = drawCard(game.deck);
        game.playerHand.push(result.card);
        game.deck = result.deck;

        const playerValue = calculateHand(game.playerHand);

        if (playerValue > 21) {
          // Bust
          game.processing = false;
          return await finishBlackjack(interaction, game, 'update');
        }

        if (playerValue === 21) {
          // Auto stand at 21
          dealerPlay(game);
          game.processing = false;
          return await finishBlackjack(interaction, game, 'update');
        }

        // Continue game — update embed with new card
        const embed = createGameEmbed(game, false);
        const buttons = createGameButtons(targetUserId, game);

        // Reset timeout
        if (game.timeout) clearTimeout(game.timeout);
        game.timeout = setTimeout(() => {
          autoStandButton(interaction, game);
        }, 60000);

        game.processing = false;
        return await interaction.update({ embeds: [embed], components: [buttons] });
      }

      if (action === 'stand') {
        dealerPlay(game);
        game.processing = false;
        return await finishBlackjack(interaction, game, 'update');
      }

      if (action === 'double') {
        // Double down: double bet, draw 1 card, auto stand
        if (!isSuperAdmin(targetUserId)) {
          const balanceCheck = removeBalance(targetUserId, game.bet);
          if (!balanceCheck.success) {
            game.processing = false;
            return interaction.reply({
              content: 'Insufficient balance for double down.',
              ephemeral: true,
            });
          }
        }

        game.bet *= 2;
        game.doubledDown = true;

        // Draw exactly 1 card
        const result = drawCard(game.deck);
        game.playerHand.push(result.card);
        game.deck = result.deck;

        const playerValue = calculateHand(game.playerHand);

        if (playerValue > 21) {
          game.processing = false;
          return await finishBlackjack(interaction, game, 'update');
        }

        // Auto stand after double down
        dealerPlay(game);
        game.processing = false;
        return await finishBlackjack(interaction, game, 'update');
      }

      // Unrecognized action — reset lock
      game.processing = false;
      return interaction.deferUpdate();
    } catch (error) {
      // Ensure cleanup on error
      game.processing = false;
      if (!game.finished) {
        game.finished = true;
        activeGames.delete(game.userId);
      }
      throw error;
    }
  }

  // --- Crash cashout button ---
  if (customId.startsWith('crash_cashout_')) {
    const targetUserId = customId.replace('crash_cashout_', '');

    if (interaction.user.id !== targetUserId) {
      return interaction.reply({ content: 'This is not your game.', ephemeral: true });
    }

    const game = activeCrashGames.get(targetUserId);
    if (!game || game.finished || game.cashedOut) {
      return interaction.deferUpdate();
    }

    // Kunci payout di currentMultiplier. Game TIDAK selesai — loop lanjut mereveal crash (Opsi B).
    handleCrashCashout(game);
    const tier = crashTierVisual(game.currentMultiplier);

    const embed = new EmbedBuilder()
      .setAuthor({ name: `${game.username}'s game` })
      .setColor(0x57f287)
      .setTitle(`Crash | ✅ Cashed @ ${game.cashoutMultiplier.toFixed(2)}x — ${tier.emoji} ${tier.label}`)
      .setDescription(
        `You cashed out at **${game.cashoutMultiplier.toFixed(2)}x** ✅ — locked in 💎 **+${game.payout.toLocaleString()}** Kryztal\n\n` +
        `Still climbing: **${game.currentMultiplier.toFixed(2)}x** ${tier.emoji}\n\n` +
        `Watch it ride… will it crash or moon? 🫣`
      )
      .setTimestamp();

    const disabledBtn = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`crash_cashout_${targetUserId}`)
        .setLabel(`✅ Cashed @ ${game.cashoutMultiplier.toFixed(2)}x`)
        .setStyle(ButtonStyle.Success)
        .setDisabled(true)
    );

    await interaction.update({ embeds: [embed], components: [disabledBtn] });
    sendLevelUpNotification(interaction.channel, targetUserId, game.xpResult);
    return;
  }

  // --- Transfer buttons ---
  if (customId.startsWith('tf_confirm_') || customId.startsWith('tf_cancel_')) {
    const isConfirm = customId.startsWith('tf_confirm_');
    const prefix = isConfirm ? 'tf_confirm_' : 'tf_cancel_';
    const transferId = customId.slice(prefix.length);

    const pending = pendingTransfers.get(transferId);
    if (!pending) {
      return interaction.reply({ content: 'This transfer has expired.', ephemeral: true });
    }

    // Verify it's the sender
    if (interaction.user.id !== pending.fromId) {
      return interaction.reply({ content: 'This is not your transfer.', ephemeral: true });
    }

    pendingTransfers.delete(transferId);

    if (!isConfirm) {
      // Cancelled
      const disabledRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('tf_done')
          .setLabel('Cancelled')
          .setStyle(ButtonStyle.Danger)
          .setDisabled(true)
      );
      return interaction.update({
        embeds: [
          new EmbedBuilder().setColor(0xed4245).setTitle('Transfer Cancelled').setTimestamp(),
        ],
        components: [disabledRow],
      });
    }

    // Check transfer limits
    const limitCheck = checkTransferLimits(pending.fromId, pending.toId, pending.amount);
    if (!limitCheck.allowed) {
      // Edit the message to show limit error
      const limitEmbed = new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle('Transfer Failed')
        .setDescription(limitCheck.message)
        .setTimestamp();
      return interaction.update({ embeds: [limitEmbed], components: [] });
    }

    // Execute transfer
    const result = transfer(pending.fromId, pending.toId, pending.amount);

    if (!result.success) {
      return interaction.update({
        content: result.message,
        embeds: [],
        components: [],
      });
    }

    // Update the confirmation message (ephemeral)
    const disabledRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('tf_done')
        .setLabel('Confirmed')
        .setStyle(ButtonStyle.Success)
        .setDisabled(true)
    );

    await interaction.update({
      embeds: [
        new EmbedBuilder().setColor(0x57f287).setTitle('Transfer Complete').setTimestamp(),
      ],
      components: [disabledRow],
    });

    // Send visible message in the channel
    const visibleEmbed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('Transfer')
      .setDescription(
        `<@${pending.fromId}> sent 💎 **${pending.amount.toLocaleString()}** Kryztal to <@${pending.toId}>.`
      )
      .setTimestamp();

    return interaction.channel.send({ embeds: [visibleEmbed] });
  }

  // --- Mines tile click ---
  if (customId.startsWith('mines_tile_')) {
    const parts = customId.split('_');
    const targetUserId = parts[2];
    const tileIdx = parseInt(parts[3]);

    if (interaction.user.id !== targetUserId) {
      return interaction.reply({ content: 'This is not your game.', ephemeral: true });
    }

    const game = activeMinesGames.get(targetUserId);
    if (!game || game.finished) {
      return interaction.deferUpdate();
    }

    if (game.processing) {
      return interaction.deferUpdate();
    }
    game.processing = true;

    try {
      // Already revealed
      if (game.revealedTiles.has(tileIdx)) {
        game.processing = false;
        return interaction.deferUpdate();
      }

      // Hit a mine!
      if (game.minePositions.has(tileIdx)) {
        game.revealedTiles.add(tileIdx);
        const multiplier = calculateMinesMultiplier(game.totalTiles, game.minesCount, game.revealedTiles.size - 1);
        finishMinesGame(game, false, multiplier);

        const embed = createMinesEmbed(game, multiplier, true, true);
        const components = createMinesDisabledButtons(game, targetUserId);
        game.processing = false;
        await interaction.update({ embeds: [embed], components });
        sendLevelUpNotification(interaction.channel, game.userId, game.xpResult);
        return;
      }

      // Safe tile
      game.revealedTiles.add(tileIdx);
      const safeTiles = game.totalTiles - game.minesCount;
      const multiplier = calculateMinesMultiplier(game.totalTiles, game.minesCount, game.revealedTiles.size);

      // Check if all safe tiles revealed
      if (game.revealedTiles.size >= safeTiles) {
        const payout = finishMinesGame(game, true, multiplier);
        const embed = createMinesEmbed(game, multiplier, true);
        const components = createMinesDisabledButtons(game, targetUserId);
        game.processing = false;
        await interaction.update({ embeds: [embed], components });
        sendLevelUpNotification(interaction.channel, game.userId, game.xpResult);
        return;
      }

      // Continue game
      // Reset timeout
      if (game.timeout) clearTimeout(game.timeout);
      game.timeout = setTimeout(() => { autoMinesCashout(game); }, 120000);

      const embed = createMinesEmbed(game, multiplier, false);
      const components = createMinesButtons(game, targetUserId);
      game.processing = false;
      return interaction.update({ embeds: [embed], components });
    } catch (error) {
      game.processing = false;
      throw error;
    }
  }

  // --- Mines cash out ---
  if (customId.startsWith('mines_cashout_')) {
    const targetUserId = customId.replace('mines_cashout_', '');

    if (interaction.user.id !== targetUserId) {
      return interaction.reply({ content: 'This is not your game.', ephemeral: true });
    }

    const game = activeMinesGames.get(targetUserId);
    if (!game || game.finished) {
      return interaction.deferUpdate();
    }

    if (game.revealedTiles.size === 0) {
      return interaction.deferUpdate(); // Can't cash out without revealing
    }

    if (game.processing) {
      return interaction.deferUpdate();
    }
    game.processing = true;

    game.cashedOut = true;
    const multiplier = calculateMinesMultiplier(game.totalTiles, game.minesCount, game.revealedTiles.size);
    const payout = finishMinesGame(game, true, multiplier);

    const embed = createMinesEmbed(game, multiplier, true);
    const components = createMinesDisabledButtons(game, targetUserId);
    await interaction.update({ embeds: [embed], components });
    sendLevelUpNotification(interaction.channel, game.userId, game.xpResult);
    return;
  }

  // --- Hi-Lo guess buttons ---
  if (customId.startsWith('hilo_higher_') || customId.startsWith('hilo_lower_') || customId.startsWith('hilo_same_')) {
    let guess, targetUserId;
    if (customId.startsWith('hilo_higher_')) {
      guess = 'higher';
      targetUserId = customId.replace('hilo_higher_', '');
    } else if (customId.startsWith('hilo_lower_')) {
      guess = 'lower';
      targetUserId = customId.replace('hilo_lower_', '');
    } else {
      guess = 'same';
      targetUserId = customId.replace('hilo_same_', '');
    }

    if (interaction.user.id !== targetUserId) {
      return interaction.reply({ content: 'This is not your game.', ephemeral: true });
    }

    const game = activeHiloGames.get(targetUserId);
    if (!game || game.finished) {
      return interaction.deferUpdate();
    }

    if (game.processing) {
      return interaction.deferUpdate();
    }
    game.processing = true;

    try {
      // Validate guess is possible
      const guessMultiplier = hiloGuessMultiplier(game.currentCard.value, guess);
      if (guessMultiplier === 0) {
        game.processing = false;
        return interaction.reply({ content: 'This guess is impossible with the current card.', ephemeral: true });
      }

      // Draw next card
      const nextCard = hiloDrawCard();
      game.history.push(nextCard.display);

      // Check if guess is correct
      let correct = false;
      if (guess === 'higher' && nextCard.value > game.currentCard.value) correct = true;
      if (guess === 'lower' && nextCard.value < game.currentCard.value) correct = true;
      if (guess === 'same' && nextCard.value === game.currentCard.value) correct = true;

      if (!correct) {
        // Wrong guess — lose
        finishHiloGame(game, false);

        const embed = new EmbedBuilder()
          .setAuthor({ name: `${game.username}'s game` })
          .setColor(0xed4245)
          .setTitle('Hi-Lo | ❌ Wrong Guess!')
          .setDescription(
            `Previous: **${game.currentCard.display}** → Drew: **${nextCard.display}**\n` +
            `You guessed: **${guess}** — Wrong!\n\n` +
            `Cards: ${game.history.join(' → ')}\n` +
            `Streak: **${game.streak}**\n\n` +
            `Lost: 💎 **-${game.bet.toLocaleString()}** Kryztal`
          )
          .setTimestamp();

        game.processing = false;
        await interaction.update({ embeds: [embed], components: createHiloDisabledButtons(targetUserId) });
        sendLevelUpNotification(interaction.channel, game.userId, game.xpResult);
        return;
      }

      // Correct guess!
      game.streak += 1;
      game.multiplier = parseFloat((game.multiplier * guessMultiplier).toFixed(2));
      game.currentCard = nextCard;

      // Max streak check (10 rounds)
      if (game.streak >= 10) {
        game.cashedOut = true;
        const payout = finishHiloGame(game, true);

        const embed = new EmbedBuilder()
          .setAuthor({ name: `${game.username}'s game` })
          .setColor(0xf1c40f)
          .setTitle('Hi-Lo | 🏆 MAX STREAK!')
          .setDescription(
            `Cards: ${game.history.join(' → ')}\n\n` +
            `Streak: **${game.streak}** — Maximum reached!\n` +
            `Multiplier: **${game.multiplier}x**\n\n` +
            `Bet: 💎 **${game.bet.toLocaleString()}** Kryztal\n` +
            `Payout: 💎 **+${payout.toLocaleString()}** Kryztal`
          )
          .setTimestamp();

        game.processing = false;
        await interaction.update({ embeds: [embed], components: createHiloDisabledButtons(targetUserId) });
        sendLevelUpNotification(interaction.channel, game.userId, game.xpResult);
        return;
      }

      // Show animation: card reveal
      const animEmbed = new EmbedBuilder()
        .setAuthor({ name: `${game.username}'s game` })
        .setColor(0xfee75c)
        .setTitle(`Hi-Lo | 🃏 Drawing next card...`)
        .setDescription(
          `Previous: **${game.history[game.history.length - 2]}** — Guessed: **${guess}**\n\n` +
          `🎴 *Revealing...*`
        )
        .setTimestamp();

      await interaction.update({ embeds: [animEmbed], components: createHiloDisabledButtons(targetUserId) });
      await new Promise((r) => setTimeout(r, 1200));

      // Show result
      const embed = new EmbedBuilder()
        .setAuthor({ name: `${game.username}'s game` })
        .setColor(0x57f287)
        .setTitle(`Hi-Lo | ✅ Correct! Streak: ${game.streak}`)
        .setDescription(
          `Drew: **${nextCard.display}** (Value: ${nextCard.value}) — **${guess}** was correct!\n\n`
        )
        .setTimestamp();

      // Reset timeout
      if (game.timeout) clearTimeout(game.timeout);
      game.timeout = setTimeout(() => { autoHiloCashout(game); }, 60000);

      // Then update with proper game embed
      const gameEmbed = createHiloEmbed(game);
      const components = createHiloButtons(game, targetUserId);

      game.processing = false;
      try { await game.messageRef.edit({ embeds: [gameEmbed], components }); } catch {}
      return;
    } catch (error) {
      game.processing = false;
      throw error;
    }
  }

  // --- Hi-Lo cash out ---
  if (customId.startsWith('hilo_cashout_')) {
    const targetUserId = customId.replace('hilo_cashout_', '');

    if (interaction.user.id !== targetUserId) {
      return interaction.reply({ content: 'This is not your game.', ephemeral: true });
    }

    const game = activeHiloGames.get(targetUserId);
    if (!game || game.finished) {
      return interaction.deferUpdate();
    }

    if (game.streak === 0) {
      return interaction.deferUpdate(); // Can't cash out without a streak
    }

    if (game.processing) {
      return interaction.deferUpdate();
    }
    game.processing = true;

    game.cashedOut = true;
    const payout = finishHiloGame(game, true);

    const embed = new EmbedBuilder()
      .setAuthor({ name: `${game.username}'s game` })
      .setColor(0x57f287)
      .setTitle('Hi-Lo | 💰 Cashed Out!')
      .setDescription(
        `Cards: ${game.history.join(' → ')}\n\n` +
        `Streak: **${game.streak}** | Multiplier: **${game.multiplier}x**\n\n` +
        `Bet: 💎 **${game.bet.toLocaleString()}** Kryztal\n` +
        `Payout: 💎 **+${payout.toLocaleString()}** Kryztal`
      )
      .setTimestamp();

    await interaction.update({ embeds: [embed], components: createHiloDisabledButtons(targetUserId) });
    sendLevelUpNotification(interaction.channel, game.userId, game.xpResult);
    return;
  }

  // --- Tower door pick ---
  if (customId.startsWith('tower_door_')) {
    const parts = customId.split('_');
    const targetUserId = parts[2];
    const doorIdx = parseInt(parts[3]);

    if (interaction.user.id !== targetUserId) {
      return interaction.reply({ content: 'This is not your game.', ephemeral: true });
    }

    const game = activeTowerGames.get(targetUserId);
    if (!game || game.finished) {
      return interaction.deferUpdate();
    }

    if (game.processing) {
      return interaction.deferUpdate();
    }
    game.processing = true;

    try {
      const floor = game.floors[game.currentFloor];
      floor.revealed = true;
      floor.chosenDoor = doorIdx;

      // Hit a trap!
      if (floor.trapPositions.has(doorIdx)) {
        finishTowerGame(game, false);

        // Show animation: reveal doors
        const animEmbed = new EmbedBuilder()
          .setAuthor({ name: `${game.username}'s game` })
          .setColor(0xfee75c)
          .setTitle(`Tower | 🚪 Opening door ${doorIdx + 1}...`)
          .setDescription('*The door creaks open...*')
          .setTimestamp();

        await interaction.update({ embeds: [animEmbed], components: createTowerDisabledButtons(game, targetUserId) });
        await new Promise((r) => setTimeout(r, 1000));

        const embed = createTowerEmbed(game, true);
        const components = createTowerDisabledButtons(game, targetUserId);
        game.processing = false;
        try { await game.messageRef.edit({ embeds: [embed], components }); } catch {}
        sendLevelUpNotification(interaction.channel, game.userId, game.xpResult);
        return;
      }

      // Safe door! Advance floor
      game.currentFloor += 1;

      // Animation: door opening
      const nextFloorDisplay = game.currentFloor >= game.maxFloors ? game.maxFloors : game.currentFloor + 1;
      const animEmbed = new EmbedBuilder()
        .setAuthor({ name: `${game.username}'s game` })
        .setColor(0x57f287)
        .setTitle(game.currentFloor >= game.maxFloors
          ? `Tower | 🏆 All floors cleared!`
          : `Tower | ✅ Safe! Climbing to Floor ${nextFloorDisplay}...`)
        .setDescription(`Door ${doorIdx + 1} was safe! 🎉`)
        .setTimestamp();

      await interaction.update({ embeds: [animEmbed], components: createTowerDisabledButtons(game, targetUserId) });
      await new Promise((r) => setTimeout(r, 1000));

      // Max floor check
      if (game.currentFloor >= game.maxFloors) {
        game.cashedOut = true;
        const payout = finishTowerGame(game, true);
        const embed = createTowerEmbed(game);
        const components = createTowerDisabledButtons(game, targetUserId);
        game.processing = false;
        try { await game.messageRef.edit({ embeds: [embed], components }); } catch {}
        sendLevelUpNotification(interaction.channel, game.userId, game.xpResult);
        return;
      }

      // Reset timeout
      if (game.timeout) clearTimeout(game.timeout);
      game.timeout = setTimeout(() => { autoTowerCashout(game); }, 120000);

      const embed = createTowerEmbed(game);
      const components = createTowerButtons(game, targetUserId);
      game.processing = false;
      try { await game.messageRef.edit({ embeds: [embed], components }); } catch {}
      return;
    } catch (error) {
      game.processing = false;
      throw error;
    }
  }

  // --- Tower cash out ---
  if (customId.startsWith('tower_cashout_')) {
    const targetUserId = customId.replace('tower_cashout_', '');

    if (interaction.user.id !== targetUserId) {
      return interaction.reply({ content: 'This is not your game.', ephemeral: true });
    }

    const game = activeTowerGames.get(targetUserId);
    if (!game || game.finished) {
      return interaction.deferUpdate();
    }

    if (game.currentFloor === 0) {
      return interaction.deferUpdate(); // Can't cash out on floor 0
    }

    if (game.processing) {
      return interaction.deferUpdate();
    }
    game.processing = true;

    game.cashedOut = true;
    const payout = finishTowerGame(game, true);
    const multiplier = calculateTowerMultiplier(game.difficulty, game.currentFloor);

    const embed = createTowerEmbed(game);
    const components = createTowerDisabledButtons(game, targetUserId);
    await interaction.update({ embeds: [embed], components });
    sendLevelUpNotification(interaction.channel, game.userId, game.xpResult);
    return;
  }

  // --- Odds pagination ---
  if (customId.startsWith('odds_prev_') || customId.startsWith('odds_next_')) {
    const isNext = customId.startsWith('odds_next_');
    const targetUserId = customId.replace('odds_prev_', '').replace('odds_next_', '');

    if (interaction.user.id !== targetUserId) {
      return interaction.reply({ content: 'Use `ky odds` to view your own odds page.', ephemeral: true });
    }

    const newPage = isNext ? 2 : 1;
    const embed = createOddsPage(newPage);
    const buttons = createOddsButtons(targetUserId, newPage);
    return interaction.update({ embeds: [embed], components: [buttons] });
  }

  // --- Players pagination ---
  if (customId.startsWith('pl_prev_') || customId.startsWith('pl_next_')) {
    const parts = customId.split('_');
    const direction = parts[1]; // 'prev' or 'next'
    const targetUserId = parts[2];
    const currentPage = parseInt(parts[3]);

    if (interaction.user.id !== targetUserId) {
      return interaction.reply({ content: 'Only the command user can navigate pages.', ephemeral: true });
    }

    const newPage = direction === 'next' ? currentPage + 1 : currentPage - 1;
    const { embed, totalPages } = createPlayersPage(newPage);
    const buttons = createPlayersButtons(targetUserId, newPage, totalPages);
    return interaction.update({ embeds: [embed], components: [buttons] });
  }
}

async function autoStandButton(interaction, game) {
  if (game.finished) return;
  dealerPlay(game);

  try {
    // Edit the message to show final state
    const embed = createGameEmbed(game, true);
    const playerValue = calculateHand(game.playerHand);
    const dealerValue = calculateHand(game.dealerHand);

    let resultText = '';
    let winnings = 0;
    let color = 0x5865f2;
    let xpGained = XP_LOSE;

    if (playerValue > 21) {
      resultText = `Bust! You lose 💎 ${game.bet.toLocaleString()} Kryztal.`;
      color = 0xed4245;
      recordLoss(game.userId);
    } else if (dealerValue > 21) {
      winnings = game.bet * 2;
      resultText = `Dealer busts! You win 💎 ${winnings.toLocaleString()} Kryztal!`;
      color = 0x57f287;
      xpGained = XP_WIN;
      recordWin(game.userId);
    } else if (playerValue > dealerValue) {
      winnings = game.bet * 2;
      resultText = `You win 💎 ${winnings.toLocaleString()} Kryztal! (Auto-stand: time expired)`;
      color = 0x57f287;
      xpGained = XP_WIN;
      recordWin(game.userId);
    } else if (playerValue < dealerValue) {
      resultText = `Dealer wins. You lose 💎 ${game.bet.toLocaleString()} Kryztal. (Auto-stand: time expired)`;
      color = 0xed4245;
      recordLoss(game.userId);
    } else {
      winnings = game.bet;
      resultText = `Push! Bet returned. (Auto-stand: time expired)`;
      color = 0xfee75c;
    }

    if (winnings > 0) addBalance(game.userId, winnings);
    const actualXP = calculateXP(xpGained, game.bet);
    const xpResult = addXP(game.userId, actualXP);

    let xpText = `+${actualXP} XP`;
    if (!isSuperAdmin(game.userId)) {
      const user = getUser(game.userId);
      if (user) xpText += ` | Level ${user.level} (${user.xp}/${user.xpNeeded} XP)`;
    }

    embed.setColor(color);
    embed.addFields(
      { name: '\u200b', value: '\u200b', inline: false },
      { name: 'Result', value: resultText, inline: false },
      { name: '\u200b', value: xpText, inline: false }
    );

    if (!isSuperAdmin(game.userId)) {
      const newBalance = getBalance(game.userId);
      embed.setFooter({ text: `Balance: 💎 ${newBalance.toLocaleString()} Kryztal` });
    } else {
      embed.setFooter({ text: 'Balance: 💎 \u221e Kryztal' });
    }

    game.finished = true;
    activeGames.delete(game.userId);

    await interaction.message.edit({
      embeds: [embed],
      components: [disabledButtons(game.userId)],
    });

    // Send separate level-up notification
    if (interaction.channel) sendLevelUpNotification(interaction.channel, game.userId, xpResult);
  } catch (error) {
    game.finished = true;
    activeGames.delete(game.userId);
  }
}

// ============================================================
// Valid prefix commands list
// ============================================================

const VALID_PREFIX_COMMANDS = ['bj', 'blackjack', 'wallet', 'daily', 'transfer', 'tf', 'lb', 'leaderboard', 'help', 'odds', 'maintenance', 'bansos', 'backup', 'cf', 'coinflip', 'slots', 'dice', 'crash', 'rl', 'roulette', 'mines', 'hl', 'hilo', 'tw', 'tower', 'players', 'shop', 'inventory', 'inv', 'buy', 'use', 'profile', 'battle', 'char', 'character', 'bag', 'sell', 'sellgear', 'equip', 'unequip', 'buygear', 'gear', 'end'];

function isValidPrefixCommand(command) {
  return VALID_PREFIX_COMMANDS.includes(command.toLowerCase());
}

// ============================================================
// HELP
// ============================================================

function createHelpEmbed() {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('Kyriz | Commands')
    .setDescription(
      'Prefix every command with `ky`.   `[optional]` · `<required>`\n\n' +
      '🃏 **Games**\n' +
      '`bj [bet]` · `cf [bet] [h/t]` · `slots [bet]` · `dice [bet] [1-6/e/o]` · `crash [bet]` · `rl [bet] [red/black/0-36]` · `mines [bet]` · `hl [bet]` · `tw [bet]`\n\n' +
      '⚔️ **Battle** _— Kryptonite RPG_\n' +
      '`battle` · `battle help` · `char [name <nama>]` · `bag` · `gear` · `sell [all|code n]` · `buygear <g-code>` · `equip <g-code>` · `unequip <slot>` · `sellgear <g-code>` · `shop gear`\n\n' +
      '💰 **Economy**\n' +
      '`wallet` · `daily` · `tf @user <amt>` · `lb [all]`\n\n' +
      '🛍️ **Shop**\n' +
      '`shop` · `buy <id>` · `use <id>` · `inv` · `profile [@user]`\n\n' +
      'ℹ️ **Info**\n' +
      '`help` · `odds` · `battle help`'
    )
    .setFooter({ text: '💎 Kryztal (games/economy) · 🧪 Kryptonite (battle) | Prefix: ky' })
    .setTimestamp();
}

async function handleHelp(interaction) {
  return interaction.reply({ embeds: [createHelpEmbed()] });
}

async function handleHelpPrefix(message) {
  return message.reply({ embeds: [createHelpEmbed()] });
}

// ============================================================
// ODDS
// ============================================================

function createOddsPage(page) {
  if (page === 1) {
    return new EmbedBuilder()
      .setColor(0xfee75c)
      .setTitle('📊 Kyriz | Game Odds & Rates')
      .setDescription(
        '**Payouts for all games.**\n\n' +

        '🪙 **Coinflip**\n' +
        '```\n' +
        'Heads / Tails          →   2x\n' +
        '```\n\n' +

        '🎰 **Slots**\n' +
        '```\n' +
        '[ 7 | 7 | 7 ]  MEGA JACKPOT   →  40x\n' +
        '[ 💎 | 💎 | 💎 ]  JACKPOT      →  20x\n' +
        '[ 🍒 | 🍒 | 🍒 ]  3 of a kind  →   9x\n' +
        '[ 🍒 | 🍒 | 🍋 ]  First 2 match →  1.5x\n' +
        '[ 🍊 | 🍋 | 🍊 ]  Any 2 match   →  1.0x\n' +
        '```\n\n' +

        '🎲 **Dice**\n' +
        '```\n' +
        'Exact number (1-6)     →   6x\n' +
        'Even / Odd             →   2x\n' +
        '```\n\n' +

        '🎡 **Roulette**\n' +
        '```\n' +
        '🔴 Red / ⚫ Black      →   2x\n' +
        'Even / Odd             →   2x\n' +
        '1-18 / 19-36           →   2x\n' +
        'Exact number (0-36)    →  36x\n' +
        '```\n\n' +

        '🃏 **Blackjack**\n' +
        '```\n' +
        'Win                    →   2x\n' +
        'Blackjack (21)         → 2.5x\n' +
        'Push (tie)             →   1x refund\n' +
        '```'
      )
      .setFooter({ text: 'Page 1/2 • ky odds' })
      .setTimestamp();
  }

  return new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle('📊 Kyriz | Game Odds & Rates')
    .setDescription(
      '🚀 **Crash** — cash out before it crashes!\n' +
      '```\n' +
      'Cash out at    Chance\n' +
      '─────────────────────────────\n' +
      '  1.1x         ~89%\n' +
      '  1.5x         ~65%\n' +
      '  2.0x         ~49%   (1 in 2)\n' +
      '  3.0x         ~33%   (1 in 3)\n' +
      '  5.0x         ~20%   (1 in 5)\n' +
      ' 10.0x         ~10%   (1 in 10)\n' +
      'Instant crash  ~2%\n' +
      '```\n\n' +

      '💎 **Mines** — 4×4 grid, default 3 bombs\n' +
      '```\n' +
      'Tiles revealed   Multiplier\n' +
      '───────────────────────────\n' +
      '  1 tile            1.23x\n' +
      '  3 tiles           1.96x\n' +
      '  5 tiles           3.39x\n' +
      '  8 tiles          10.00x\n' +
      ' 13 tiles (all!)  560.00x\n' +
      '```\n\n' +

      '🃏 **Hi-Lo** — guess the next card\n' +
      '```\n' +
      'Example from card 7:\n' +
      '  Higher       →   2.17x\n' +
      '  Lower        →   2.17x\n' +
      '  Same         →  13.00x\n' +
      '\n' +
      'Multipliers stack each round!\n' +
      '```\n\n' +

      '🏗️ **Tower** — pick the safe door\n' +
      '```\n' +
      'Difficulty       3 floors    5 floors\n' +
      '──────────────────────────────────────\n' +
      'Easy   (1/3)       3.38x       7.59x\n' +
      'Medium (2/3)      27.00x     243.00x\n' +
      'Hard   (3/4)      64.00x   1,024.00x\n' +
      '```'
    )
    .setFooter({ text: 'Page 2/2 • Fair games • ky odds' })
    .setTimestamp();
}

function createOddsButtons(userId, currentPage) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`odds_prev_${userId}`)
      .setLabel('◀ Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage === 1),
    new ButtonBuilder()
      .setCustomId(`odds_next_${userId}`)
      .setLabel('Next ▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage === 2)
  );
}

async function handleOdds(interaction) {
  const embed = createOddsPage(1);
  const buttons = createOddsButtons(interaction.user.id, 1);
  return interaction.reply({ embeds: [embed], components: [buttons] });
}

async function handleOddsPrefix(message) {
  const embed = createOddsPage(1);
  const buttons = createOddsButtons(message.author.id, 1);
  return message.reply({ embeds: [embed], components: [buttons] });
}

// ============================================================
// PLAYERS LIST (Admin/Superadmin only)
// ============================================================

const PLAYERS_PER_PAGE = 10;

function formatNumber(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return n.toLocaleString();
}

function createPlayersPage(page) {
  const players = getAllPlayers();
  const totalPages = Math.max(1, Math.ceil(players.length / PLAYERS_PER_PAGE));
  const safePage = Math.max(1, Math.min(page, totalPages));
  const start = (safePage - 1) * PLAYERS_PER_PAGE;
  const pagePlayers = players.slice(start, start + PLAYERS_PER_PAGE);

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('📋 Registered Players')
    .setFooter({ text: `Page ${safePage}/${totalPages} • Total: ${players.length} players` })
    .setTimestamp();

  if (pagePlayers.length === 0) {
    embed.setDescription('_No registered players yet._');
    return { embed, totalPages: safePage };
  }

  let desc = '';
  pagePlayers.forEach((p, i) => {
    const rank = start + i + 1;
    const level = p.level ?? 1;
    const xp = p.xp ?? 0;
    const xpNeeded = p.xpNeeded ?? 400;
    const adminTag = p.isAdmin ? ' `[Admin]`' : '';
    const wins = p.totalWins ?? 0;
    const losses = p.totalLosses ?? 0;

    // Transfer remaining today
    const sendLimit = getDailySendLimit(level);
    const recvLimit = getDailyReceiveLimit(level);
    const td = getTransferData(p);
    const sendLeft = Math.max(0, sendLimit - td.sentTotal);
    const recvLeft = Math.max(0, recvLimit - td.receivedTotal);

    // Joined date
    const joined = p.registeredAt ? new Date(p.registeredAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—';

    desc += `**${rank}.** <@${p.userId}> • Lv.**${level}** (${xp}/${xpNeeded} XP)${adminTag}\n`;
    desc += `> 💎 **${p.balance.toLocaleString()}** Kryztal | 🏆 ${wins}W/${losses}L | 📅 ${joined}\n`;
    desc += `> 📈 Earned: **${formatNumber(p.totalEarned ?? 0)}** | 📉 Lost: **${formatNumber(p.totalLost ?? 0)}**\n`;
    // Admin/superadmin bebas limit transfer — tampilan harus jujur (jangan tunjukin limit palsu).
    const bypassLimits = p.isAdmin || isSuperAdmin(p.userId);
    if (bypassLimits) {
      desc += `> 📤 ∞ (Admin) | 📥 ∞ (Admin)\n`;
    } else if (sendLimit > 0) {
      desc += `> 📤 ${formatNumber(sendLeft)}/${formatNumber(sendLimit)} left | 📥 ${formatNumber(recvLeft)}/${formatNumber(recvLimit)} left\n`;
    } else {
      desc += `> 📤 Can\'t send (Lv.${level}) | 📥 ${formatNumber(recvLeft)}/${formatNumber(recvLimit)} left\n`;
    }
    desc += '\n';
  });

  embed.setDescription(desc.trim());
  return { embed, totalPages };
}

function createPlayersButtons(userId, currentPage, totalPages) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`pl_prev_${userId}_${currentPage}`)
      .setLabel('◀ Prev')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage <= 1),
    new ButtonBuilder()
      .setCustomId(`pl_next_${userId}_${currentPage}`)
      .setLabel('Next ▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage >= totalPages),
  );
  return row;
}

async function handlePlayersPrefix(message, userId) {
  if (!isSuperAdmin(userId) && !isAdmin(userId)) {
    return message.reply({ content: 'Only admins can use this command.' });
  }
  const { embed, totalPages } = createPlayersPage(1);
  const buttons = createPlayersButtons(userId, 1, totalPages);
  return message.reply({ embeds: [embed], components: [buttons] });
}

async function handlePlayersSlash(interaction, userId) {
  if (!isSuperAdmin(userId) && !isAdmin(userId)) {
    return interaction.reply({ content: 'Only admins can use this command.', ephemeral: true });
  }
  const { embed, totalPages } = createPlayersPage(1);
  const buttons = createPlayersButtons(userId, 1, totalPages);
  return interaction.reply({ embeds: [embed], components: [buttons], ephemeral: true });
}

module.exports = {
  attachGameSubcommands,
  execute,
  handlePrefixCommand,
  handleButton,
  handleSelectMenu,
  handleShop,
  isValidPrefixCommand,
  generateCrashPoint, // diekspor untuk test (test/crash.test.js)
  crashTierVisual,    // diekspor untuk test
};
