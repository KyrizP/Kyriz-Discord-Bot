'use strict';

// ============================================================
// Battle Mode Discord command/button handlers — SELF-CONTAINED.
// game.js wires this via THIN hooks only (import + delegation).
// Per-user isolation: every interactive customId ends with the owner's userId;
// handleButton rejects anyone else. Username shown via setAuthor.
// ============================================================

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const battle = require('./battleManager');
const economy = require('./economyManager');
const { CLASSES, GEAR, DROPS } = require('./battleConfig');
const { computeStats } = require('./battleEngine');

const BAG_PAGE_SIZE = 8;
const COLOR = 0x9b59b6;
const uname = (ctx) => ctx.user?.username || ctx.author?.username || 'Player';

// read-only battle-data getter (ensures defaults; does NOT write)
function getBattle(userId) {
  const data = economy.readEconomy();
  const user = data[userId];
  if (!user) return null;
  return { user, b: battle.ensureBattleData(user) };
}
function getKryptonite(userId) { const bd = getBattle(userId); return bd ? bd.b.kryptonite : 0; }

// ---------- embeds ----------
function infoEmbed(username, text) {
  return new EmbedBuilder().setAuthor({ name: `${username}` }).setColor(COLOR).setDescription(text).setTimestamp();
}
function resultEmbed(username, text) {
  return new EmbedBuilder().setAuthor({ name: `${username}` }).setColor(COLOR).setDescription(text).setTimestamp();
}
function classPickEmbed(username) {
  return new EmbedBuilder()
    .setAuthor({ name: `${username}'s delve` })
    .setColor(COLOR)
    .setTitle('🎭 Create your character')
    .setDescription('Pick a class to begin your dungeon battle (entry **15,000 💎 Kryztal**):\n\n⚔️ **Warrior** — tanky physical bruiser (ATK/DEF/HP)\n🔮 **Mage** — glass-cannon magic (MATK, squishy)')
    .setTimestamp();
}
function classPickRow(userId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`battle_class_warrior_${userId}`).setLabel('⚔️ Warrior').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`battle_class_mage_${userId}`).setLabel('🔮 Mage').setStyle(ButtonStyle.Danger),
  );
}
function pushExtractRow(userId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`battle_push_${userId}`).setLabel('⏩ Push Deeper').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`battle_extract_${userId}`).setLabel('🧪 Extract').setStyle(ButtonStyle.Secondary),
  );
}
function bagRow(userId, page, total) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`battle_bag_prev_${page}_${userId}`).setLabel('◀ Prev').setStyle(ButtonStyle.Secondary).setDisabled(page <= 1),
    new ButtonBuilder().setCustomId(`battle_bag_next_${page}_${userId}`).setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= total),
  );
}
function delveFloorEmbed(username, run, note) {
  const hpMax = run.stats.hp;
  const bagCount = Object.values(run.bag).reduce((a, n) => a + n, 0);
  return new EmbedBuilder()
    .setAuthor({ name: `${username}'s delve` })
    .setColor(COLOR)
    .setTitle(`🏰 Dungeon — Floor ${run.floor}`)
    .setDescription(
      `❤️ HP: **${run.hp}/${hpMax}**\n` +
      `🎒 Run bag: **${bagCount}** drop(s) — _unbanked, lost if you die_\n` +
      `✨ Char EXP this run: **${run.expAccum}**\n\n${note}`
    )
    .setTimestamp();
}
function pushWinEmbed(username, res) {
  return new EmbedBuilder()
    .setAuthor({ name: `${username}'s delve` })
    .setColor(COLOR)
    .setTitle(`⚔️ Floor ${res.cleared} cleared!`)
    .setDescription(
      `Looted **${res.drop.name}** \`${res.drop.id}\` (🧪 ${res.drop.value}).\n` +
      `❤️ HP: **${res.hp}**\n\nNext: **Floor ${res.nextFloor}** — push or extract?`
    )
    .setTimestamp();
}
function dieEmbed(username, res) {
  return new EmbedBuilder()
    .setAuthor({ name: `${username}'s delve` })
    .setColor(0xed4245)
    .setTitle(`💀 You died on Floor ${res.diedAt}`)
    .setDescription(
      `Lost **${res.lost}** unbanked drop(s).\n` +
      `✨ Kept **${res.exp}** Char EXP${res.leveledUp ? ` — _Level Up! Now Lv.${res.newLevel}_` : ''}.\n\n` +
      `_Equipped gear is safe. Use \`ky battle\` to try again (15,000 💎)._`
    )
    .setTimestamp();
}
function extractEmbed(username, res) {
  return new EmbedBuilder()
    .setAuthor({ name: `${username}'s delve` })
    .setColor(0x57f287)
    .setTitle('🧪 Extracted!')
    .setDescription(
      `Reached **depth ${res.depth}**.\n` +
      `Banked **${res.banked}** drop(s) + **${res.exp}** Char EXP${res.leveledUp ? ` — _Level Up! Now Lv.${res.newLevel}_` : ''}.\n\n` +
      `_Sell drops with \`ky sell all\`. Best depth: see \`ky char\`._`
    )
    .setTimestamp();
}

// ---------- handlers (context = interaction OR message) ----------
async function handleBattle(context, userId) {
  if (battle.hasActiveRun(userId)) {
    return context.reply({ content: '⚔️ You already have an active battle. Use **Push** or **Extract** first.' });
  }
  const username = uname(context);
  const res = battle.startDelve(userId);
  if (!res.ok) {
    if (res.needClass) return context.reply({ embeds: [classPickEmbed(username)], components: [classPickRow(userId)] });
    return context.reply({ content: res.reason });
  }
  const sweptCount = Object.values(res.swept).reduce((a, n) => a + n, 0);
  const note = (res.run.floor > 1 ? `⚡ Auto-swept to floor ${res.run.floor} (${sweptCount} drop(s) looted).\n` : '') + 'Push deeper for more, or Extract to bank.';
  return context.reply({ embeds: [delveFloorEmbed(username, res.run, note)], components: [pushExtractRow(userId)] });
}

function handleCharacter(context, userId) {
  const username = uname(context);
  const bd = getBattle(userId);
  if (!bd) return context.reply({ content: 'Not registered. Use `ky register` first.' });
  const b = bd.b;
  if (!b.charClass) return context.reply({ embeds: [infoEmbed(username, 'No character yet. Use `ky battle` to create one.')] });
  const stats = computeStats(b.charLevel, b.charClass, b.equipment);
  const cls = CLASSES[b.charClass];
  const equipLines = ['weapon', 'head', 'armor', 'boots', 'accessory']
    .map((slot) => {
      const id = b.equipment[slot];
      const item = id ? GEAR[id] : null;
      return `**${slot}:** ${item ? `${item.name} \`${id}\`` : '—'}`;
    }).join('\n');
  const embed = new EmbedBuilder()
    .setAuthor({ name: `${username}'s character` })
    .setColor(COLOR)
    .setTitle(`${cls.emoji} ${cls.name} — Level ${b.charLevel}`)
    .setDescription(
      `**Char EXP:** ${b.charExp}/${b.charExpNeeded}\n` +
      `🧪 Kryptonite: **${b.kryptonite.toLocaleString()}** · 🏰 Best depth: **${b.bestDepth}**\n\n` +
      `❤️ HP **${stats.hp}** · ⚔️ ATK **${stats.atk}** · 🔮 MATK **${stats.matk}**\n` +
      `🛡️ DEF **${stats.def}** · ✨ MDEF **${stats.mdef}** · 💨 SPD **${stats.spd}**\n\n${equipLines}`
    )
    .setFooter({ text: 'ky equip <code> · ky unequip <slot>' });
  return context.reply({ embeds: [embed] });
}

function handleBag(context, userId, page) {
  const username = uname(context);
  const { embed } = renderBag(userId, username, page || 1);
  return context.reply({ embeds: [embed] });
}

function renderBag(userId, username, page) {
  const bd = getBattle(userId);
  if (!bd) return { embed: infoEmbed(username, 'Not registered.'), components: [], totalPages: 1 };
  const entries = Object.entries(bd.b.bag).filter(([, c]) => c > 0);
  const drops = entries.filter(([id]) => DROPS[id]);
  const gears = entries.filter(([id]) => GEAR[id]);
  const total = Math.max(1, Math.ceil((drops.length + gears.length) / BAG_PAGE_SIZE));
  page = Math.min(Math.max(1, page), total);
  const slice = [...drops, ...gears].slice((page - 1) * BAG_PAGE_SIZE, page * BAG_PAGE_SIZE);
  let desc = '';
  let totalValue = 0;
  for (const [id, count] of slice) {
    if (DROPS[id]) {
      desc += `\`${id}\` ${DROPS[id].name} ×${count} — 🧪 ${DROPS[id].value} ea (🧪 ${(DROPS[id].value * count).toLocaleString()})\n`;
      totalValue += DROPS[id].value * count;
    } else if (GEAR[id]) {
      const sb = Math.round(GEAR[id].price * 0.4);
      desc += `\`${id}\` ${GEAR[id].name} ×${count} — \`ky equip ${id}\` | sell \`ky sellgear ${id}\` → 🧪 ${sb}\n`;
    }
  }
  if (!desc) desc = '_Your bag is empty. Delve to find drops!_';
  const embed = new EmbedBuilder()
    .setAuthor({ name: `${username}'s bag` })
    .setColor(COLOR)
    .setTitle('🎒 Battle Bag')
    .setDescription(desc + (totalValue ? `\n**Drop value:** 🧪 ${totalValue.toLocaleString()} (\`ky sell all\`)` : ''))
    .setFooter({ text: `Page ${page}/${total} • ky sell all | ky sell <code> [n]` });
  return { embed, components: total > 1 ? [bagRow(userId, page, total)] : [], totalPages: total };
}

async function handleSell(context, userId, what) {
  const username = uname(context);
  what = (what || 'all').trim();
  let res;
  if (what === '' || what === 'all') res = battle.sell(userId, 'all');
  else {
    const parts = what.split(/\s+/);
    res = battle.sell(userId, parts[0], parts[1]); // code, qty(all|number)
  }
  if (res.reason) return context.reply({ content: res.reason });
  return context.reply({ embeds: [resultEmbed(username, `🧪 Sold **${res.sold}** drop(s) for **${res.kryptonite.toLocaleString()}** Kryptonite.`)] });
}
function handleSellGear(context, userId, code) {
  const res = battle.sellGear(userId, (code || '').trim());
  if (!res.ok) return context.reply({ content: res.reason });
  return context.reply({ embeds: [resultEmbed(uname(context), `🧪 Sold **${res.name}** for **${res.kryptonite.toLocaleString()}** Kryptonite (40% sellback).`)] });
}
function handleEquip(context, userId, code) {
  code = (code || '').trim();
  const res = battle.equip(userId, code);
  if (!res.ok) return context.reply({ content: res.reason });
  const name = GEAR[code] ? GEAR[code].name : code;
  return context.reply({ embeds: [resultEmbed(uname(context), `⚙️ Equipped **${name}** → **${res.slot}**.` + (res.swapped ? ' Previous gear moved to bag.' : ''))] });
}
function handleUnequip(context, userId, slot) {
  const res = battle.unequip(userId, (slot || '').trim().toLowerCase());
  if (!res.ok) return context.reply({ content: res.reason });
  return context.reply({ embeds: [resultEmbed(uname(context), `⚙️ Unequipped **${res.slot}** → moved to bag.`)] });
}
function handleBuyGear(context, userId, code) {
  code = (code || '').trim();
  const res = battle.buyGear(userId, code);
  if (!res.ok) return context.reply({ content: res.reason });
  return context.reply({ embeds: [resultEmbed(uname(context), `🛒 Bought **${res.name}** \`${code}\` for 🧪 **${res.price.toLocaleString()}**.\nEquip with \`ky equip ${code}\` · 🧪 left: **${res.kryptonite.toLocaleString()}**`)] });
}
function handleShopEquipment(context, userId) {
  const username = uname(context);
  const lines = Object.values(GEAR).map((g) => {
    const st = Object.entries(g.stats).map(([k, v]) => `+${v} ${k.toUpperCase()}`).join(', ');
    return `\`${g.id}\` ${g.name} _(${g.rarity}, ${g.slot})_ — 🧪 ${g.price.toLocaleString()} | ${st}`;
  });
  const embed = new EmbedBuilder()
    .setAuthor({ name: `${username}` })
    .setColor(COLOR)
    .setTitle('🛒 Shop — Equipment')
    .setDescription(`Buy with 🧪 Kryptonite. Earn Kryptonite by selling dungeon drops.\n\n${lines.join('\n')}`)
    .setFooter({ text: 'Equipment also appears at the back of `ky shop`.' });
  return context.reply({ embeds: [embed] });
}

// ---------- slash subcommand registration ----------
function attachSubcommands(commandBuilder) {
  commandBuilder
    .addSubcommand((sub) => sub.setName('battle').setDescription('Enter the dungeon (costs 15,000 Kryztal)'))
    .addSubcommand((sub) => sub.setName('character').setDescription('View your character (stats, gear, Kryptonite)'))
    .addSubcommand((sub) => sub.setName('bag').setDescription('View your battle bag (drops & gear)'))
    .addSubcommand((sub) => sub.setName('sell').setDescription('Sell drops for Kryptonite')
      .addStringOption((o) => o.setName('item').setDescription('all | <code> | <code> <qty>').setRequired(false)))
    .addSubcommand((sub) => sub.setName('equip').setDescription('Equip gear from your bag')
      .addStringOption((o) => o.setName('item').setDescription('gear code, e.g. g1').setRequired(false)))
    .addSubcommand((sub) => sub.setName('buygear').setDescription('Buy equipment with Kryptonite')
      .addStringOption((o) => o.setName('item').setDescription('gear code, e.g. g1').setRequired(true)));
}

// ---------- button handler (delegated from game.js handleButton) ----------
async function handleButton(interaction) {
  const customId = interaction.customId;
  if (!customId.startsWith('battle_')) return null;
  const userId = customId.slice(customId.lastIndexOf('_') + 1); // owner is always last segment
  if (interaction.user.id !== userId) {
    return interaction.reply({ content: '⛔ This is not yours.', ephemeral: true });
  }
  const username = interaction.user.username;

  // class pick -> create character + start delve
  const classMatch = customId.match(/^battle_class_(warrior|mage)_/);
  if (classMatch) {
    const create = battle.createCharacter(userId, classMatch[1]);
    if (!create.ok) return interaction.update({ embeds: [infoEmbed(username, create.reason)], components: [] });
    const res = battle.startDelve(userId);
    if (!res.ok) return interaction.update({ embeds: [infoEmbed(username, res.reason || 'Could not start battle.')], components: [] });
    return interaction.update({ embeds: [delveFloorEmbed(username, res.run, 'Your adventure begins! Push or Extract.')], components: [pushExtractRow(userId)] });
  }

  if (customId.startsWith('battle_push_')) {
    const res = battle.nextFloor(userId);
    if (!res.ok) return interaction.reply({ content: res.reason, ephemeral: true });
    if (res.won) return interaction.update({ embeds: [pushWinEmbed(username, res)], components: [pushExtractRow(userId)] });
    return interaction.update({ embeds: [dieEmbed(username, res)], components: [] });
  }

  if (customId.startsWith('battle_extract_')) {
    const res = battle.extractRun(userId);
    if (!res.ok) return interaction.reply({ content: res.reason, ephemeral: true });
    return interaction.update({ embeds: [extractEmbed(username, res)], components: [] });
  }

  const bagMatch = customId.match(/^battle_bag_(next|prev)_(\d+)_/);
  if (bagMatch) {
    let page = parseInt(bagMatch[2], 10);
    page = bagMatch[1] === 'next' ? page + 1 : page - 1;
    const { embed, components } = renderBag(userId, username, page);
    return interaction.update({ embeds: [embed], components });
  }

  return interaction.deferUpdate();
}

module.exports = {
  attachSubcommands, handleButton,
  handleBattle, handleCharacter, handleBag, handleSell, handleSellGear, handleBuyGear, handleEquip, handleUnequip, handleShopEquipment,
  getKryptonite,
};
