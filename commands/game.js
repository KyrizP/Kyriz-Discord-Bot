const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
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
} = require('../utils/economyManager');
const { createDeck, drawCard, calculateHand, formatHand, isBlackjack } = require('../utils/cardDeck');

// ============================================================
// Active games tracker (in-memory, per user)
// ============================================================

const activeGames = new Map(); // userId -> game state
const pendingTransfers = new Map(); // uniqueId -> { fromId, toId, amount }

// ============================================================
// Maintenance mode (in-memory, superadmin toggle)
// ============================================================

let maintenanceMode = { active: false, message: 'Bot is currently under maintenance. Please try again later.' };

// ============================================================
// XP rewards constants
// ============================================================

const XP_WIN = 50;
const XP_LOSE = 10;
const XP_BLACKJACK = 100;
const XP_DAILY = 25;
const MAX_BET = 500000;

// ============================================================
// Cooldown system (per user, per command)
// ============================================================

const cooldowns = new Map(); // `${userId}_${command}` -> timestamp
const COOLDOWN_BJ = 5000;    // 5 seconds for blackjack
const COOLDOWN_CMD = 3000;   // 3 seconds for other commands
const COOLDOWN_HELP = 1000;  // 1 second for help

/**
 * Normalize command name for cooldown key consistency
 */
function normalizeCmdName(command) {
  if (command === 'bj') return 'blackjack';
  if (command === 'lb') return 'leaderboard';
  if (command === 'cf') return 'coinflip';
  if (command === 'rl') return 'roulette';
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
  if (normalized === 'blackjack' || normalized === 'crash') duration = COOLDOWN_BJ;
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

  // /kyriz wallet [user]
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

  // /kyriz help
  commandBuilder.addSubcommand((sub) =>
    sub.setName('help').setDescription('View available commands')
  );
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
        '**Starting balance: 100,000 Kryztal**'
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
  if (maintenanceMode.active && !isSuperAdmin(userId)) {
    return interaction.reply({ content: maintenanceMode.message, ephemeral: true });
  }

  // Update username on every interaction
  if (isRegistered(userId)) {
    updateUsername(userId, username);
  }

  // T&C check (skip for superadmin)
  const requiresRegistration = ['blackjack', 'wallet', 'daily', 'transfer', 'coinflip', 'slots', 'dice', 'crash', 'roulette'];
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
    case 'help':
      return handleHelp(interaction);
  }
}

// ============================================================
// Prefix command handler
// ============================================================

async function handlePrefixCommand(message, command, args) {
  const userId = message.author.id;
  const username = message.author.username;

  // Maintenance command (superadmin only)
  if (command === 'maintenance') {
    return handleMaintenance(message, userId, args);
  }

  // Maintenance check (superadmin bypasses)
  if (maintenanceMode.active && !isSuperAdmin(userId)) {
    return; // Silently ignore during maintenance for prefix
  }

  // Update username
  if (isRegistered(userId)) {
    updateUsername(userId, username);
  }

  // T&C check for commands that require registration
  const requiresRegistration = ['bj', 'blackjack', 'wallet', 'daily', 'transfer', 'cf', 'coinflip', 'slots', 'dice', 'crash', 'rl', 'roulette'];
  if (requiresRegistration.includes(command) && !isRegistered(userId)) {
    const embed = createTCEmbed();
    const buttons = createTCButtons(userId);
    return message.reply({ embeds: [embed], components: [buttons] });
  }

  // Cooldown check (skip for superadmin)
  if (!isSuperAdmin(userId)) {
    const remaining = checkCooldown(userId, command);
    if (remaining > 0) {
      // Silently ignore for prefix commands (no spam reply)
      return;
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
    case 'help':
      if (args.length > 0) return; // Only exact "ky help", ignore "ky help aku dong"
      return handleHelpPrefix(message);
    default:
      // Invalid command, silently ignore
      return;
  }
}

// ============================================================
// MAINTENANCE MODE
// ============================================================

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

// ============================================================
// BLACKJACK
// ============================================================

function parseBet(betStr, userId) {
  if (!betStr || betStr === '') return 1;

  if (betStr.toLowerCase() === 'all') {
    const balance = getBalance(userId);
    const actualBalance = isSuperAdmin(userId) ? MAX_BET : balance;
    const bet = Math.min(actualBalance, MAX_BET);
    return bet <= 0 ? null : bet; // Return null if no balance
  }

  const bet = parseInt(betStr);
  if (isNaN(bet) || bet < 1) return null;
  return Math.min(bet, MAX_BET);
}

async function handleBlackjack(interaction, userId) {
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
        content: `Insufficient balance. You have **${balance.toLocaleString()} Kryztal** but tried to bet **${bet.toLocaleString()} Kryztal**.`,
        ephemeral: true,
      });
    }
  }

  // Deduct bet
  if (!isSuperAdmin(userId)) {
    removeBalance(userId, bet);
  }

  // Start game
  const game = startBlackjackGame(userId, bet);

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
        `Insufficient balance. You have **${balance.toLocaleString()} Kryztal** but tried to bet **${bet.toLocaleString()} Kryztal**.`
      );
    }
  }

  if (!isSuperAdmin(userId)) {
    removeBalance(userId, bet);
  }

  const game = startBlackjackGame(userId, bet);

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

function startBlackjackGame(userId, bet) {
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
    .setTitle(`Blackjack | Bet: ${game.bet.toLocaleString()} Kryztal`)
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
    resultText = `BLACKJACK! You win ${winnings.toLocaleString()} Kryztal!`;
    color = 0xf1c40f; // Gold
    xpGained = XP_BLACKJACK;
    recordWin(game.userId);
  } else if (game.dealerBlackjack) {
    // Dealer blackjack
    resultText = `Dealer has Blackjack! You lose ${game.bet.toLocaleString()} Kryztal.`;
    color = 0xed4245; // Red
    xpGained = XP_LOSE;
    recordLoss(game.userId);
  } else if (playerValue > 21) {
    // Player bust
    resultText = `Bust! You lose ${game.bet.toLocaleString()} Kryztal.`;
    color = 0xed4245;
    xpGained = XP_LOSE;
    recordLoss(game.userId);
  } else if (dealerValue > 21) {
    // Dealer bust
    winnings = game.bet * 2;
    resultText = `Dealer busts! You win ${winnings.toLocaleString()} Kryztal!`;
    color = 0x57f287; // Green
    xpGained = XP_WIN;
    recordWin(game.userId);
  } else if (playerValue > dealerValue) {
    // Player wins
    winnings = game.bet * 2;
    resultText = `You win ${winnings.toLocaleString()} Kryztal!`;
    color = 0x57f287;
    xpGained = XP_WIN;
    recordWin(game.userId);
  } else if (playerValue < dealerValue) {
    // Dealer wins
    resultText = `Dealer wins. You lose ${game.bet.toLocaleString()} Kryztal.`;
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

  // Add XP
  const xpResult = addXP(game.userId, xpGained);

  // Build result text with XP info
  let xpText = `+${xpGained} XP`;
  if (!isSuperAdmin(game.userId)) {
    const user = getUser(game.userId);
    if (user) {
      xpText += ` | Level ${user.level} (${user.xp}/${user.xpNeeded} XP)`;
    }
  }

  if (xpResult.leveledUp) {
    xpText += `\nLEVEL UP! You are now Level ${xpResult.newLevel}! +${xpResult.rewardTotal.toLocaleString()} Kryztal`;
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
    embed.setFooter({ text: `Balance: ${newBalance.toLocaleString()} Kryztal` });
  } else {
    embed.setFooter({ text: 'Balance: \u221e Kryztal' });
  }

  // Clean up game
  activeGames.delete(game.userId);

  const payload = { embeds: [embed], components: [disabledButtons(game.userId)] };

  if (method === 'reply') {
    return context.reply(payload);
  } else if (method === 'update') {
    return context.update(payload);
  } else if (method === 'edit') {
    return context.edit(payload);
  }
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

  if (targetUser && targetUser.id !== userId) {
    // Only superadmin can check others
    if (!isSuperAdmin(userId)) {
      return interaction.reply({
        content: 'Only the Superadmin can check other users\' wallets.',
        ephemeral: true,
      });
    }

    return showWallet(interaction, targetUser.id, targetUser.username);
  }

  return showWallet(interaction, userId, interaction.user.username);
}

async function handleWalletPrefix(message, userId) {
  return showWallet(message, userId, message.author.username, true);
}

async function showWallet(context, userId, username, isPrefix = false) {
  if (!isRegistered(userId) && !isSuperAdmin(userId)) {
    const content = 'This user is not registered yet.';
    if (isPrefix) return context.reply(content);
    return context.reply({ content });
  }

  const user = getUser(userId);
  const balanceDisplay = isSuperAdmin(userId) ? '\u221e' : user.balance.toLocaleString();

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`${username}'s Wallet`)
    .addFields(
      { name: 'Balance', value: `**${balanceDisplay}** Kryztal`, inline: true },
      { name: 'Level', value: isSuperAdmin(userId) ? '\u221e' : `${user.level}`, inline: true }
    )
    .setTimestamp();

  if (!isSuperAdmin(userId) && user) {
    embed.addFields(
      { name: 'XP', value: `${user.xp}/${user.xpNeeded}`, inline: true },
      { name: 'W/L', value: `${user.totalWins}/${user.totalLosses}`, inline: true }
    );
  }

  if (isPrefix) return context.reply({ embeds: [embed] });
  return context.reply({ embeds: [embed] });
}

// ============================================================
// DAILY
// ============================================================

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

  let description = `You received **${result.amount.toLocaleString()} Kryztal**!\n+${XP_DAILY} XP`;
  if (xpResult.leveledUp) {
    description += `\n\nLEVEL UP! You are now Level ${xpResult.newLevel}! +${xpResult.rewardTotal.toLocaleString()} Kryztal`;
  }

  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('Daily Reward')
    .setDescription(description)
    .setFooter({ text: `Balance: ${user.balance.toLocaleString()} Kryztal | Level ${user.level} (${user.xp}/${user.xpNeeded} XP)` })
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
        content: `Insufficient balance. You have **${balance.toLocaleString()} Kryztal**.`,
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
      `Are you sure you want to send **${amount.toLocaleString()} Kryztal** to **${targetUser.username}**?`
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
      return message.reply(`Insufficient balance. You have **${balance.toLocaleString()} Kryztal**.`);
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
      `Are you sure you want to send **${amount.toLocaleString()} Kryztal** to **${targetUser.username}**?`
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
  const side = parseSide(sideStr);
  if (side === null) {
    return context.reply({ content: 'Invalid side. Please choose `heads` or `tails`.' });
  }

  const bet = parseBet(betStr, userId);
  if (bet === null) {
    return context.reply({ content: 'Invalid bet. Use a positive number or `all`.' });
  }

  // Deduct bet
  if (!isSuperAdmin(userId)) {
    const result = removeBalance(userId, bet);
    if (!result.success) {
      return context.reply({ content: 'Insufficient balance.' });
    }
  }

  const result = Math.random() < 0.5 ? 'heads' : 'tails';
  const won = result === side;

  if (won) {
    const payout = bet * 2;
    if (!isSuperAdmin(userId)) {
      addBalance(userId, payout);
      addXP(userId, 20);
      recordWin(userId);
    }

    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('Coinflip | You Win!')
      .setDescription(
        `The coin landed on **${result}**! You chose **${side}**.\n\n` +
        `Bet: **${bet.toLocaleString()}** Kryztal\n` +
        `Payout: **+${payout.toLocaleString()}** Kryztal`
      )
      .setTimestamp();
    return context.reply({ embeds: [embed] });
  } else {
    if (!isSuperAdmin(userId)) {
      addXP(userId, 5);
      recordLoss(userId);
    }

    const embed = new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle('Coinflip | You Lose')
      .setDescription(
        `The coin landed on **${result}**. You chose **${side}**.\n\n` +
        `Lost: **-${bet.toLocaleString()}** Kryztal`
      )
      .setTimestamp();
    return context.reply({ embeds: [embed] });
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
  const bet = parseBet(betStr, userId);
  if (bet === null) {
    return context.reply({ content: 'Invalid bet. Use a positive number or `all`.' });
  }

  if (!isSuperAdmin(userId)) {
    const result = removeBalance(userId, bet);
    if (!result.success) {
      return context.reply({ content: 'Insufficient balance.' });
    }
  }

  const reels = spinSlots();
  const display = `**[ ${reels[0]} | ${reels[1]} | ${reels[2]} ]**`;

  let multiplier = 0;
  let title = 'Slots | No Match';
  let color = 0xed4245;
  let xp = 5;

  if (reels[0] === reels[1] && reels[1] === reels[2]) {
    // 3 of a kind
    if (reels[0] === '7️⃣') {
      multiplier = 50;
      title = 'Slots | 🎰 MEGA JACKPOT!!! 🎰';
    } else if (reels[0] === '💎') {
      multiplier = 25;
      title = 'Slots | 💎 JACKPOT! 💎';
    } else {
      multiplier = 10;
      title = 'Slots | Jackpot!';
    }
    color = 0xfee75c;
    xp = 75;
  } else if (reels[0] === reels[1]) {
    multiplier = 2;
    title = 'Slots | Partial Match!';
    color = 0x57f287;
    xp = 25;
  }

  if (multiplier > 0) {
    const payout = bet * multiplier;
    if (!isSuperAdmin(userId)) {
      addBalance(userId, payout);
      addXP(userId, xp);
      recordWin(userId);
    }

    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(title)
      .setDescription(
        `${display}\n\n` +
        `Bet: **${bet.toLocaleString()}** Kryztal\n` +
        `Multiplier: **${multiplier}x**\n` +
        `Payout: **+${payout.toLocaleString()}** Kryztal`
      )
      .setTimestamp();
    return context.reply({ embeds: [embed] });
  } else {
    if (!isSuperAdmin(userId)) {
      addXP(userId, xp);
      recordLoss(userId);
    }

    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(title)
      .setDescription(
        `${display}\n\n` +
        `Lost: **-${bet.toLocaleString()}** Kryztal`
      )
      .setTimestamp();
    return context.reply({ embeds: [embed] });
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
  const guess = parseDiceGuess(guessStr);
  if (!guess) {
    return context.reply({ content: 'Invalid guess. Use a number `1-6`, `even`, or `odd`.' });
  }

  const bet = parseBet(betStr, userId);
  if (bet === null) {
    return context.reply({ content: 'Invalid bet. Use a positive number or `all`.' });
  }

  if (!isSuperAdmin(userId)) {
    const result = removeBalance(userId, bet);
    if (!result.success) {
      return context.reply({ content: 'Insufficient balance.' });
    }
  }

  const roll = Math.floor(Math.random() * 6) + 1;
  const diceEmojis = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
  let won = false;
  let multiplier = 0;

  if (guess.type === 'number' && roll === guess.value) {
    won = true;
    multiplier = 5;
  } else if (guess.type === 'parity') {
    const isEven = roll % 2 === 0;
    if ((guess.value === 'even' && isEven) || (guess.value === 'odd' && !isEven)) {
      won = true;
      multiplier = 2;
    }
  }

  const guessDisplay = guess.type === 'number' ? `**${guess.value}**` : `**${guess.value}**`;

  if (won) {
    const payout = bet * multiplier;
    if (!isSuperAdmin(userId)) {
      addBalance(userId, payout);
      addXP(userId, guess.type === 'number' ? 50 : 25);
      recordWin(userId);
    }

    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('Dice Roll | You Win!')
      .setDescription(
        `${diceEmojis[roll]} Rolled: **${roll}** | Your guess: ${guessDisplay}\n\n` +
        `Bet: **${bet.toLocaleString()}** Kryztal\n` +
        `Multiplier: **${multiplier}x**\n` +
        `Payout: **+${payout.toLocaleString()}** Kryztal`
      )
      .setTimestamp();
    return context.reply({ embeds: [embed] });
  } else {
    if (!isSuperAdmin(userId)) {
      addXP(userId, 5);
      recordLoss(userId);
    }

    const embed = new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle('Dice Roll | You Lose')
      .setDescription(
        `${diceEmojis[roll]} Rolled: **${roll}** | Your guess: ${guessDisplay}\n\n` +
        `Lost: **-${bet.toLocaleString()}** Kryztal`
      )
      .setTimestamp();
    return context.reply({ embeds: [embed] });
  }
}

// ============================================================
// CRASH
// ============================================================

const activeCrashGames = new Map(); // userId -> crash game state

function generateCrashPoint() {
  // House edge ~4%: crash point follows inverse distribution
  const r = Math.random();
  if (r < 0.04) return 1.0; // Instant crash 4% of the time
  return Math.min(parseFloat((1 / (1 - r)).toFixed(2)), 10.0);
}

async function handleCrash(interaction, userId) {
  const betStr = interaction.options.getString('bet');
  return playCrash(interaction, userId, betStr, 'slash');
}

async function handleCrashPrefix(message, userId, args) {
  return playCrash(message, userId, args[0], 'prefix');
}

async function playCrash(context, userId, betStr, source) {
  if (activeCrashGames.has(userId)) {
    return context.reply({ content: 'You already have an active crash game. Cash out or wait for it to end.' });
  }

  const bet = parseBet(betStr, userId);
  if (bet === null) {
    return context.reply({ content: 'Invalid bet. Use a positive number or `all`.' });
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
    bet,
    crashPoint,
    currentMultiplier: 1.0,
    cashedOut: false,
    finished: false,
  };

  activeCrashGames.set(userId, game);

  // If instant crash (1.0x), show crash result immediately without cashout button
  if (crashPoint <= 1.0) {
    game.finished = true;
    activeCrashGames.delete(userId);

    if (!isSuperAdmin(userId)) {
      addXP(userId, 10);
      recordLoss(userId);
    }

    const crashEmbed = new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle('Crash | Instant CRASH!')
      .setDescription(
        `Crashed at **1.00x** instantly!\n\n` +
        `Lost: **-${bet.toLocaleString()}** Kryztal`
      )
      .setTimestamp();

    return context.reply({ embeds: [crashEmbed] });
  }

  // Create initial embed
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('Crash | Game Started')
    .setDescription(
      `Bet: **${bet.toLocaleString()}** Kryztal\n\n` +
      `Current Multiplier: **1.00x**\n` +
      `Potential Payout: **${bet.toLocaleString()}** Kryztal\n\n` +
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

async function runCrashLoop(game, msg) {
  const steps = [1.2, 1.5, 1.8, 2.0, 2.5, 3.0, 3.5, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0];
  
  for (const step of steps) {
    if (game.finished || game.cashedOut) return;
    
    await new Promise((resolve) => setTimeout(resolve, 1500));
    
    if (game.finished || game.cashedOut) return;

    if (step > game.crashPoint) {
      // CRASHED
      game.finished = true;
      activeCrashGames.delete(game.userId);

      if (!isSuperAdmin(game.userId)) {
        addXP(game.userId, 10);
        recordLoss(game.userId);
      }

      const embed = new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle('Crash | CRASHED!')
        .setDescription(
          `Crashed at **${game.crashPoint.toFixed(2)}x**!\n\n` +
          `Lost: **-${game.bet.toLocaleString()}** Kryztal`
        )
        .setTimestamp();

      const disabledBtn = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`crash_cashout_${game.userId}`)
          .setLabel(`Crashed at ${game.crashPoint.toFixed(2)}x`)
          .setStyle(ButtonStyle.Danger)
          .setDisabled(true)
      );

      try { await msg.edit({ embeds: [embed], components: [disabledBtn] }); } catch {}
      return;
    }

    // Update multiplier
    game.currentMultiplier = step;
    const potential = Math.floor(game.bet * step);

    const embed = new EmbedBuilder()
      .setColor(0xfee75c)
      .setTitle('Crash | Running...')
      .setDescription(
        `Bet: **${game.bet.toLocaleString()}** Kryztal\n\n` +
        `Current Multiplier: **${step.toFixed(2)}x**\n` +
        `Potential Payout: **${potential.toLocaleString()}** Kryztal\n\n` +
        `Click **Cash Out** before it crashes!`
      )
      .setTimestamp();

    const button = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`crash_cashout_${game.userId}`)
        .setLabel(`Cash Out — ${step.toFixed(2)}x`)
        .setStyle(ButtonStyle.Success)
    );

    try { await msg.edit({ embeds: [embed], components: [button] }); } catch {}
  }

  // Reached max 10x without crash (shouldn't happen often since crashPoint ≤ 10)
  if (!game.finished && !game.cashedOut) {
    game.currentMultiplier = 10.0;
    // Auto cash out at 10x
    const payout = handleCrashCashout(game);

    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('Crash | Auto Cash Out — 10.00x!')
      .setDescription(
        `Reached maximum multiplier!\n\n` +
        `Bet: **${game.bet.toLocaleString()}** Kryztal\n` +
        `Payout: **+${payout.toLocaleString()}** Kryztal`
      )
      .setTimestamp();

    const disabledBtn = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`crash_cashout_${game.userId}`)
        .setLabel('Auto Cashed Out at 10.00x')
        .setStyle(ButtonStyle.Success)
        .setDisabled(true)
    );

    try { await msg.edit({ embeds: [embed], components: [disabledBtn] }); } catch {}
  }
}

function handleCrashCashout(game) {
  if (game.finished || game.cashedOut) return;
  game.cashedOut = true;
  game.finished = true;
  activeCrashGames.delete(game.userId);

  const payout = Math.floor(game.bet * game.currentMultiplier);

  if (!isSuperAdmin(game.userId)) {
    addBalance(game.userId, payout);
    const xp = game.currentMultiplier >= 5 ? 100 : 30;
    addXP(game.userId, xp);
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
  const choice = parseRouletteChoice(choiceStr);
  if (!choice) {
    return context.reply({
      content: 'Invalid choice. Options: `red`, `black`, `even`, `odd`, `1-18`, `19-36`, or a number `0-36`.',
    });
  }

  const bet = parseBet(betStr, userId);
  if (bet === null) {
    return context.reply({ content: 'Invalid bet. Use a positive number or `all`.' });
  }

  if (!isSuperAdmin(userId)) {
    const result = removeBalance(userId, bet);
    if (!result.success) {
      return context.reply({ content: 'Insufficient balance.' });
    }
  }

  const result = Math.floor(Math.random() * 37); // 0-36
  const resultColor = getRouletteColor(result);
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
      if (result === choice.value) { won = true; multiplier = 35; }
      break;
  }

  const choiceDisplay = choice.type === 'number' ? `Number **${choice.value}**` : `**${choice.value.charAt(0).toUpperCase() + choice.value.slice(1)}**`;

  if (won) {
    const payout = bet * multiplier;
    if (!isSuperAdmin(userId)) {
      addBalance(userId, payout);
      addXP(userId, choice.type === 'number' ? 75 : 25);
      recordWin(userId);
    }

    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('Roulette | You Win!')
      .setDescription(
        `${resultColor} Ball landed on **${result}**\n` +
        `Your bet: ${choiceDisplay}\n\n` +
        `Bet: **${bet.toLocaleString()}** Kryztal\n` +
        `Multiplier: **${multiplier}x**\n` +
        `Payout: **+${payout.toLocaleString()}** Kryztal`
      )
      .setTimestamp();
    return context.reply({ embeds: [embed] });
  } else {
    if (!isSuperAdmin(userId)) {
      addXP(userId, 5);
      recordLoss(userId);
    }

    const embed = new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle('Roulette | You Lose')
      .setDescription(
        `${resultColor} Ball landed on **${result}**\n` +
        `Your bet: ${choiceDisplay}\n\n` +
        `Lost: **-${bet.toLocaleString()}** Kryztal`
      )
      .setTimestamp();
    return context.reply({ embeds: [embed] });
  }
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
    description += `${rank} **${displayName}** \u2014 ${user.balance.toLocaleString()} Kryztal (Lv.${user.level})\n`;
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

async function handleButton(interaction) {
  const customId = interaction.customId;

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
          `**Starting balance:** 100,000 Kryztal\n` +
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

    const payout = handleCrashCashout(game);

    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('Crash | Cashed Out!')
      .setDescription(
        `You cashed out at **${game.currentMultiplier.toFixed(2)}x**!\n\n` +
        `Bet: **${game.bet.toLocaleString()}** Kryztal\n` +
        `Payout: **+${payout.toLocaleString()}** Kryztal`
      )
      .setTimestamp();

    const disabledBtn = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`crash_cashout_${targetUserId}`)
        .setLabel(`Cashed Out at ${game.currentMultiplier.toFixed(2)}x`)
        .setStyle(ButtonStyle.Success)
        .setDisabled(true)
    );

    return interaction.update({ embeds: [embed], components: [disabledBtn] });
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
        `<@${pending.fromId}> sent **${pending.amount.toLocaleString()} Kryztal** to <@${pending.toId}>.`
      )
      .setTimestamp();

    return interaction.channel.send({ embeds: [visibleEmbed] });
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
      resultText = `Bust! You lose ${game.bet.toLocaleString()} Kryztal.`;
      color = 0xed4245;
      recordLoss(game.userId);
    } else if (dealerValue > 21) {
      winnings = game.bet * 2;
      resultText = `Dealer busts! You win ${winnings.toLocaleString()} Kryztal!`;
      color = 0x57f287;
      xpGained = XP_WIN;
      recordWin(game.userId);
    } else if (playerValue > dealerValue) {
      winnings = game.bet * 2;
      resultText = `You win ${winnings.toLocaleString()} Kryztal! (Auto-stand: time expired)`;
      color = 0x57f287;
      xpGained = XP_WIN;
      recordWin(game.userId);
    } else if (playerValue < dealerValue) {
      resultText = `Dealer wins. You lose ${game.bet.toLocaleString()} Kryztal. (Auto-stand: time expired)`;
      color = 0xed4245;
      recordLoss(game.userId);
    } else {
      winnings = game.bet;
      resultText = `Push! Bet returned. (Auto-stand: time expired)`;
      color = 0xfee75c;
    }

    if (winnings > 0) addBalance(game.userId, winnings);
    const xpResult = addXP(game.userId, xpGained);

    let xpText = `+${xpGained} XP`;
    if (!isSuperAdmin(game.userId)) {
      const user = getUser(game.userId);
      if (user) xpText += ` | Level ${user.level} (${user.xp}/${user.xpNeeded} XP)`;
    }
    if (xpResult.leveledUp) {
      xpText += `\nLEVEL UP! You are now Level ${xpResult.newLevel}! +${xpResult.rewardTotal.toLocaleString()} Kryztal`;
    }

    embed.setColor(color);
    embed.addFields(
      { name: '\u200b', value: '\u200b', inline: false },
      { name: 'Result', value: resultText, inline: false },
      { name: '\u200b', value: xpText, inline: false }
    );

    if (!isSuperAdmin(game.userId)) {
      const newBalance = getBalance(game.userId);
      embed.setFooter({ text: `Balance: ${newBalance.toLocaleString()} Kryztal` });
    } else {
      embed.setFooter({ text: 'Balance: \u221e Kryztal' });
    }

    game.finished = true;
    activeGames.delete(game.userId);

    await interaction.message.edit({
      embeds: [embed],
      components: [disabledButtons(game.userId)],
    });
  } catch (error) {
    game.finished = true;
    activeGames.delete(game.userId);
  }
}

// ============================================================
// Valid prefix commands list
// ============================================================

const VALID_PREFIX_COMMANDS = ['bj', 'blackjack', 'wallet', 'daily', 'transfer', 'lb', 'leaderboard', 'help', 'maintenance', 'cf', 'coinflip', 'slots', 'dice', 'crash', 'rl', 'roulette'];

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
      'All commands can be used with **slash commands** or **prefix commands**.\n' +
      'Prefix commands start with `ky` followed by the command name.\n\n' +
      '```\n' +
      'GAMES\n' +
      '/kyriz blackjack [bet]    ky bj [bet]\n' +
      '  Play Blackjack. Default bet: 1. Max: 500,000.\n\n' +
      '/kyriz coinflip [bet] [side]  ky cf [bet] [h/t]\n' +
      '  Flip a coin. Side: heads/head/h, tails/tail/t.\n\n' +
      '/kyriz slots [bet]        ky slots [bet]\n' +
      '  Spin the slot machine.\n\n' +
      '/kyriz dice [bet] [guess] ky dice [bet] [1-6/even/odd]\n' +
      '  Roll a dice and bet on the result.\n\n' +
      '/kyriz crash [bet]        ky crash [bet]\n' +
      '  Cash out before the multiplier crashes.\n\n' +
      '/kyriz roulette [bet] [choice]  ky rl [bet] [choice]\n' +
      '  Roulette: red/black/even/odd/1-18/19-36/0-36.\n\n' +
      'ECONOMY\n' +
      '/kyriz wallet             ky wallet\n' +
      '  Check your Kryztal balance and stats.\n\n' +
      '/kyriz daily              ky daily\n' +
      '  Claim your daily reward (resets 00:00 WIB).\n\n' +
      '/kyriz transfer           ky transfer @user [amount]\n' +
      '  Send Kryztal to another user.\n\n' +
      '/kyriz leaderboard        ky lb\n' +
      '  Server top 10. Use "ky lb all" for global.\n\n' +
      'INFO\n' +
      '/kyriz help               ky help\n' +
      '  Show this help message.\n' +
      '```'
    )
    .setFooter({ text: 'Currency: Kryztal | Prefix: ky' })
    .setTimestamp();
}

async function handleHelp(interaction) {
  return interaction.reply({ embeds: [createHelpEmbed()] });
}

async function handleHelpPrefix(message) {
  return message.reply({ embeds: [createHelpEmbed()] });
}

module.exports = {
  attachGameSubcommands,
  execute,
  handlePrefixCommand,
  handleButton,
  isValidPrefixCommand,
};
