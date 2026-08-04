const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { isAuthorizedUser } = require('../utils/permissionCheck');
const { addReply, removeReply, editReply, getReplies } = require('../utils/dataManager');

// ============================================================
// Command Definition: /kyriz autoreply
// ============================================================

const data = new SlashCommandBuilder()
  .setName('kyriz')
  .setDescription('Kyriz Personal Assistant Bot')

  // ---- /kyriz autoreply add ----
  .addSubcommandGroup((group) =>
    group
      .setName('autoreply')
      .setDescription('Manage auto-replies')

      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('Add a new auto-reply')
          .addStringOption((opt) =>
            opt.setName('trigger').setDescription('The word or phrase to detect').setRequired(true)
          )
          .addStringOption((opt) =>
            opt.setName('reply').setDescription('The bot response').setRequired(true)
          )
          .addBooleanOption((opt) =>
            opt
              .setName('case_sensitive')
              .setDescription('Should uppercase/lowercase matter? (default: false)')
              .setRequired(false)
          )
          .addStringOption((opt) =>
            opt
              .setName('match_mode')
              .setDescription('Matching mode (default: contains)')
              .setRequired(false)
              .addChoices(
                { name: 'contains — message contains the trigger', value: 'contains' },
                { name: 'exact — message must match exactly', value: 'exact' }
              )
          )
      )

      // ---- /kyriz autoreply remove ----
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('Remove an auto-reply')
          .addStringOption((opt) =>
            opt.setName('trigger').setDescription('The trigger to remove').setRequired(true)
          )
      )

      // ---- /kyriz autoreply edit ----
      .addSubcommand((sub) =>
        sub
          .setName('edit')
          .setDescription('Edit an existing auto-reply')
          .addStringOption((opt) =>
            opt.setName('trigger').setDescription('The trigger to edit').setRequired(true)
          )
          .addStringOption((opt) =>
            opt.setName('reply').setDescription('New response').setRequired(false)
          )
          .addBooleanOption((opt) =>
            opt
              .setName('case_sensitive')
              .setDescription('Should uppercase/lowercase matter?')
              .setRequired(false)
          )
          .addStringOption((opt) =>
            opt
              .setName('match_mode')
              .setDescription('Matching mode')
              .setRequired(false)
              .addChoices(
                { name: 'contains — message contains the trigger', value: 'contains' },
                { name: 'exact — message must match exactly', value: 'exact' }
              )
          )
      )

      // ---- /kyriz autoreply list ----
      .addSubcommand((sub) =>
        sub.setName('list').setDescription('View all configured auto-replies')
      )
  );

// ============================================================
// Command Handler
// ============================================================

async function execute(interaction) {
  const guildId = interaction.guild.id;
  const userId = interaction.user.id;

  // Permission check: Superadmin & Authorized User only
  if (!isAuthorizedUser(guildId, userId)) {
    return interaction.reply({
      content: 'You do not have permission to use this command. Contact the Superadmin to get access.',
      ephemeral: true,
    });
  }

  const subcommand = interaction.options.getSubcommand();

  switch (subcommand) {
    case 'add':
      return handleAdd(interaction, guildId);
    case 'remove':
      return handleRemove(interaction, guildId);
    case 'edit':
      return handleEdit(interaction, guildId);
    case 'list':
      return handleList(interaction, guildId);
  }
}

// ---- ADD ----
async function handleAdd(interaction, guildId) {
  const trigger = interaction.options.getString('trigger');
  const reply = interaction.options.getString('reply');
  const caseSensitive = interaction.options.getBoolean('case_sensitive') ?? false;
  const matchMode = interaction.options.getString('match_mode') ?? 'contains';

  const result = addReply(guildId, trigger, reply, caseSensitive, matchMode);

  if (!result.success) {
    return interaction.reply({ content: result.message, ephemeral: true });
  }

  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('Auto-Reply Added')
    .addFields(
      { name: 'Trigger', value: `\`${trigger}\``, inline: true },
      { name: 'Reply', value: reply, inline: true },
      { name: '\u200b', value: '\u200b', inline: true },
      { name: 'Case Sensitive', value: caseSensitive ? 'Yes' : 'No', inline: true },
      { name: 'Match Mode', value: matchMode === 'exact' ? 'Exact' : 'Contains', inline: true }
    )
    .setTimestamp();

  return interaction.reply({ embeds: [embed], ephemeral: true });
}

// ---- REMOVE ----
async function handleRemove(interaction, guildId) {
  const trigger = interaction.options.getString('trigger');
  const result = removeReply(guildId, trigger);

  if (!result.success) {
    return interaction.reply({ content: result.message, ephemeral: true });
  }

  return interaction.reply({
    content: `Auto-reply \`${trigger}\` has been removed.`,
    ephemeral: true,
  });
}

// ---- EDIT ----
async function handleEdit(interaction, guildId) {
  const trigger = interaction.options.getString('trigger');
  const reply = interaction.options.getString('reply') ?? null;
  const caseSensitive = interaction.options.getBoolean('case_sensitive') ?? null;
  const matchMode = interaction.options.getString('match_mode') ?? null;

  // Check if at least one field is provided
  if (reply === null && caseSensitive === null && matchMode === null) {
    return interaction.reply({
      content: 'You must fill in at least one field to edit (reply, case_sensitive, or match_mode).',
      ephemeral: true,
    });
  }

  const result = editReply(guildId, trigger, reply, caseSensitive, matchMode);

  if (!result.success) {
    return interaction.reply({ content: result.message, ephemeral: true });
  }

  // Get updated data to display
  const replies = getReplies(guildId);
  const key = trigger.toLowerCase();
  const updated = replies[key];

  const embed = new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle('Auto-Reply Updated')
    .addFields(
      { name: 'Trigger', value: `\`${trigger}\``, inline: true },
      { name: 'Reply', value: updated.reply, inline: true },
      { name: '\u200b', value: '\u200b', inline: true },
      { name: 'Case Sensitive', value: updated.caseSensitive ? 'Yes' : 'No', inline: true },
      { name: 'Match Mode', value: updated.matchMode === 'exact' ? 'Exact' : 'Contains', inline: true }
    )
    .setTimestamp();

  return interaction.reply({ embeds: [embed], ephemeral: true });
}

// ---- LIST ----
async function handleList(interaction, guildId) {
  const replies = getReplies(guildId);
  const triggers = Object.keys(replies);

  if (triggers.length === 0) {
    return interaction.reply({
      content: 'No auto-replies configured yet. Use `/kyriz autoreply add` to create one.',
      ephemeral: true,
    });
  }

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('Auto-Reply List')
    .setDescription(`Total: **${triggers.length}** auto-replies`)
    .setTimestamp();

  for (const key of triggers) {
    const entry = replies[key];
    const caseLabel = entry.caseSensitive ? 'CS' : 'CI';
    const modeLabel = entry.matchMode === 'exact' ? 'Exact' : 'Contains';
    embed.addFields({
      name: `\`${entry.trigger}\` [${caseLabel}, ${modeLabel}]`,
      value: entry.reply,
      inline: false,
    });
  }

  embed.setFooter({
    text: 'CS = Case Sensitive | CI = Case Insensitive',
  });

  return interaction.reply({ embeds: [embed], ephemeral: true });
}

module.exports = { data, execute };
