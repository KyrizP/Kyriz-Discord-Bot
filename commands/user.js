const { EmbedBuilder } = require('discord.js');
const { isSuperAdmin, isAuthorizedUser } = require('../utils/permissionCheck');
const { addAuthorizedUser, removeAuthorizedUser, getAuthorizedUsers } = require('../utils/dataManager');
const { setAdmin, removeAdmin, isAdmin } = require('../utils/economyManager');

// ============================================================
// Subcommand definitions for /kyriz user
// ============================================================

/**
 * Attach subcommand group 'user' to an existing command builder
 */
function attachUserSubcommands(commandBuilder) {
  commandBuilder.addSubcommandGroup((group) =>
    group
      .setName('user')
      .setDescription('Manage users who can configure Kyriz')

      // ---- /kyriz user add ----
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('Add a user as Admin (Superadmin only)')
          .addUserOption((opt) =>
            opt.setName('target').setDescription('The user to add').setRequired(true)
          )
          .addIntegerOption((opt) =>
            opt
              .setName('amount')
              .setDescription('Starting Kryztal bonus (default: 10,000,000, max: 50,000,000)')
              .setRequired(false)
          )
      )

      // ---- /kyriz user remove ----
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('Remove a user\'s Admin access (Superadmin only)')
          .addUserOption((opt) =>
            opt.setName('target').setDescription('The user to remove').setRequired(true)
          )
      )

      // ---- /kyriz user list ----
      .addSubcommand((sub) =>
        sub.setName('list').setDescription('View the list of Admins')
      )
  );
}

// ============================================================
// Command Handler
// ============================================================

async function execute(interaction) {
  const guildId = interaction.guild.id;
  const userId = interaction.user.id;
  const subcommand = interaction.options.getSubcommand();

  switch (subcommand) {
    case 'add':
      return handleUserAdd(interaction, guildId, userId);
    case 'remove':
      return handleUserRemove(interaction, guildId, userId);
    case 'list':
      return handleUserList(interaction, guildId, userId);
  }
}

// ---- USER ADD ----
async function handleUserAdd(interaction, guildId, userId) {
  if (!isSuperAdmin(userId)) {
    return interaction.reply({
      content: 'Only the **Superadmin** can add admins.',
      ephemeral: true,
    });
  }

  const targetUser = interaction.options.getUser('target');
  const amount = interaction.options.getInteger('amount') ?? 10000000; // Default 10M

  if (targetUser.bot) {
    return interaction.reply({
      content: 'Cannot add a bot as an admin.',
      ephemeral: true,
    });
  }

  if (isSuperAdmin(targetUser.id)) {
    return interaction.reply({
      content: 'Superadmin already has full access by default.',
      ephemeral: true,
    });
  }

  if (amount < 0 || amount > 50000000) {
    return interaction.reply({
      content: 'Amount must be between **0** and **50,000,000** Kryztal.',
      ephemeral: true,
    });
  }

  // Add to authorized users for this guild (for auto-reply access)
  addAuthorizedUser(guildId, targetUser.id);

  // Check if already a global admin (skip bonus, just add guild auth)
  if (isAdmin(targetUser.id)) {
    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('✅ Admin Authorized')
      .setDescription(
        `${targetUser} is already an **Admin** globally.\n` +
        `Auto-reply access granted for this server.`
      )
      .setTimestamp();
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  // Set as admin in economy + add balance
  const result = setAdmin(targetUser.id, targetUser.username, amount);

  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('✅ Admin Added')
    .setDescription(
      `${targetUser} is now an **Admin**.\n\n` +
      `💰 Bonus: **+${amount.toLocaleString()} Kryztal**\n` +
      `💳 Balance: **${result.newBalance.toLocaleString()} Kryztal**\n\n` +
      `• Can configure auto-replies\n` +
      `• Excluded from leaderboard`
    )
    .setTimestamp();

  return interaction.reply({ embeds: [embed], ephemeral: true });
}

// ---- USER REMOVE ----
async function handleUserRemove(interaction, guildId, userId) {
  if (!isSuperAdmin(userId)) {
    return interaction.reply({
      content: 'Only the **Superadmin** can remove admins.',
      ephemeral: true,
    });
  }

  const targetUser = interaction.options.getUser('target');

  if (isSuperAdmin(targetUser.id)) {
    return interaction.reply({
      content: 'Superadmin cannot remove their own access.',
      ephemeral: true,
    });
  }

  // Check if target is even an admin
  if (!isAdmin(targetUser.id) && !getAuthorizedUsers(guildId).includes(targetUser.id)) {
    return interaction.reply({
      content: `${targetUser} is not an Admin.`,
      ephemeral: true,
    });
  }

  // Remove from this guild's authorized list (ignore if not in this guild)
  removeAuthorizedUser(guildId, targetUser.id);

  // Remove global admin flag
  removeAdmin(targetUser.id);

  const embed = new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle('❌ Admin Removed')
    .setDescription(
      `${targetUser} is no longer an **Admin**.\n\n` +
      `• Auto-reply access revoked\n` +
      `• Back on leaderboard\n` +
      `• Balance unchanged`
    )
    .setTimestamp();

  return interaction.reply({ embeds: [embed], ephemeral: true });
}

// ---- USER LIST ----
async function handleUserList(interaction, guildId, userId) {
  if (!isAuthorizedUser(guildId, userId)) {
    return interaction.reply({
      content: 'You do not have permission to view this list.',
      ephemeral: true,
    });
  }

  const authorizedUsers = getAuthorizedUsers(guildId);
  const superAdminId = process.env.SUPERADMIN_ID;

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('Users with Config Access')
    .setTimestamp();

  embed.addFields({
    name: 'Superadmin',
    value: `<@${superAdminId}>`,
    inline: false,
  });

  if (authorizedUsers.length > 0) {
    const userList = authorizedUsers.map((id) => `<@${id}>`).join('\n');
    embed.addFields({
      name: `Authorized Users (${authorizedUsers.length})`,
      value: userList,
      inline: false,
    });
  } else {
    embed.addFields({
      name: 'Authorized Users',
      value: '_No users have been added yet._',
      inline: false,
    });
  }

  return interaction.reply({ embeds: [embed], ephemeral: true });
}

module.exports = { attachUserSubcommands, execute };
