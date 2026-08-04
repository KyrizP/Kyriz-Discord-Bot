const { EmbedBuilder } = require('discord.js');
const { isSuperAdmin, isAuthorizedUser } = require('../utils/permissionCheck');
const { addAuthorizedUser, removeAuthorizedUser, getAuthorizedUsers } = require('../utils/dataManager');

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
          .setDescription('Add a user who can configure the bot (Superadmin only)')
          .addUserOption((opt) =>
            opt.setName('target').setDescription('The user to add').setRequired(true)
          )
      )

      // ---- /kyriz user remove ----
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('Remove a user\'s config access (Superadmin only)')
          .addUserOption((opt) =>
            opt.setName('target').setDescription('The user to remove').setRequired(true)
          )
      )

      // ---- /kyriz user list ----
      .addSubcommand((sub) =>
        sub.setName('list').setDescription('View the list of users with config access')
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
      content: 'Only the **Superadmin** can add users.',
      ephemeral: true,
    });
  }

  const targetUser = interaction.options.getUser('target');

  if (targetUser.bot) {
    return interaction.reply({
      content: 'Cannot add a bot as an authorized user.',
      ephemeral: true,
    });
  }

  if (isSuperAdmin(targetUser.id)) {
    return interaction.reply({
      content: 'Superadmin already has full access by default.',
      ephemeral: true,
    });
  }

  const result = addAuthorizedUser(guildId, targetUser.id);

  if (!result.success) {
    return interaction.reply({ content: result.message, ephemeral: true });
  }

  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('User Added')
    .setDescription(`${targetUser} can now configure Kyriz in this server.`)
    .setTimestamp();

  return interaction.reply({ embeds: [embed], ephemeral: true });
}

// ---- USER REMOVE ----
async function handleUserRemove(interaction, guildId, userId) {
  if (!isSuperAdmin(userId)) {
    return interaction.reply({
      content: 'Only the **Superadmin** can remove users.',
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

  const result = removeAuthorizedUser(guildId, targetUser.id);

  if (!result.success) {
    return interaction.reply({ content: result.message, ephemeral: true });
  }

  const embed = new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle('Access Removed')
    .setDescription(`${targetUser} can no longer configure Kyriz in this server.`)
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
