const { getReplies } = require('../utils/dataManager');

/**
 * Handler untuk auto-reply
 * Dipanggil setiap ada message baru di server
 */
function handleAutoReply(message) {
  // Skip pesan dari bot (termasuk diri sendiri)
  if (message.author.bot) return;

  // Skip DM (hanya bekerja di server/guild)
  if (!message.guild) return;

  const guildId = message.guild.id;
  const replies = getReplies(guildId);
  const triggers = Object.keys(replies);

  if (triggers.length === 0) return;

  const messageContent = message.content;

  for (const key of triggers) {
    const entry = replies[key];
    const { trigger, reply, caseSensitive, matchMode } = entry;

    // Tentukan string yang akan dibandingkan
    const msgToCheck = caseSensitive ? messageContent : messageContent.toLowerCase();
    const triggerToCheck = caseSensitive ? trigger : trigger.toLowerCase();

    let matched = false;

    if (matchMode === 'exact') {
      // Exact match: pesan harus persis sama dengan trigger
      matched = msgToCheck === triggerToCheck;
    } else {
      // Contains (default): pesan mengandung trigger
      matched = msgToCheck.includes(triggerToCheck);
    }

    if (matched) {
      message.reply(reply);
      return; // Hanya reply satu kali per pesan (trigger pertama yang cocok)
    }
  }
}

module.exports = { handleAutoReply };
