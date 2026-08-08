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
  const user = battle.ensureUser(data, userId); // auto-register superadmin (in-memory for display)
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
    .setAuthor({ name: `${username}'s battle` })
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
function actionRow(userId, run, disableAll = false) {
  const noProgress = disableAll || !run || !run.cleared; // Extract disabled until >=1 floor cleared
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`battle_push_${userId}`).setLabel('⏩ Push').setStyle(ButtonStyle.Success).setDisabled(disableAll),
    new ButtonBuilder().setCustomId(`battle_fsweep_${userId}`).setLabel('⚡ Fast Sweep').setStyle(ButtonStyle.Primary).setDisabled(disableAll),
    new ButtonBuilder().setCustomId(`battle_extract_${userId}`).setLabel('🧪 Extract').setStyle(ButtonStyle.Secondary).setDisabled(noProgress),
  );
}
function bagRow(userId, page, total) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`battle_bag_prev_${page}_${userId}`).setLabel('◀ Prev').setStyle(ButtonStyle.Secondary).setDisabled(page <= 1),
    new ButtonBuilder().setCustomId(`battle_bag_next_${page}_${userId}`).setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= total),
  );
}
function hpBar(hp, maxHp) {
  const seg = 10;
  const f = Math.max(0, Math.min(seg, Math.round((hp / maxHp) * seg)));
  return '█'.repeat(f) + '░'.repeat(seg - f);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Battle animation frame: shows enemy + player HP bars mid-clash
function fightFrameEmbed(username, floor, frame, playerMaxHp, enemyMaxHp) {
  const ehp = frame ? Math.max(0, frame.ehp) : 0;
  const php = frame ? Math.max(0, frame.php) : 0;
  return new EmbedBuilder()
    .setAuthor({ name: `${username}'s battle` })
    .setColor(0xfee75c)
    .setTitle(`⚔️ Floor ${floor} — Clash!`)
    .setDescription(
      `🧟 **Enemy**\n${hpBar(ehp, enemyMaxHp)} ${ehp}/${enemyMaxHp}\n\n` +
      `🛡️ **You**\n${hpBar(php, playerMaxHp)} ${php}/${playerMaxHp}`
    )
    .setTimestamp();
}
function equipStr(equipment) {
  return ['weapon', 'head', 'armor', 'boots', 'accessory']
    .map((s) => { const id = equipment && equipment[s]; const it = id ? GEAR[id] : null; return `**${s}:** ${it ? it.name : '—'}`; })
    .join('\n');
}
function delveFloorEmbed(username, run, note) {
  const maxHp = run.stats.hp;
  const hp = Math.max(0, run.hp);
  const bagCount = Object.values(run.bag).reduce((a, n) => a + n, 0);
  return new EmbedBuilder()
    .setAuthor({ name: `${username}'s battle` })
    .setColor(COLOR)
    .setTitle(`🏰 Dungeon — Floor ${run.floor}`)
    .setDescription(
      `❤️ **${hp}/${maxHp}**\n${hpBar(hp, maxHp)}\n\n` +
      `🎒 Run bag: **${bagCount}** drop(s) · ✨ EXP: **${run.expAccum}** _(lost if you die)_\n\n${note}`
    )
    .addFields({ name: '⚔️ Equipped', value: equipStr(run.equipment), inline: true })
    .setTimestamp();
}
function pushWinEmbed(username, res, run) {
  const maxHp = run.stats.hp;
  return new EmbedBuilder()
    .setAuthor({ name: `${username}'s battle` })
    .setColor(COLOR)
    .setTitle(`⚔️ Floor ${res.cleared} cleared!`)
    .setDescription(
      `Looted **${res.drop.name}** \`${res.drop.id}\` (🧪 ${res.drop.value}).\n` +
      `❤️ **${res.hp}/${maxHp}**\n${hpBar(res.hp, maxHp)}\n\nNext: **Floor ${res.nextFloor}**.`
    )
    .setTimestamp();
}
function fastSweepEmbed(username, res, run) {
  const maxHp = run.stats.hp;
  const dropList = Object.keys(res.drops).map((id) => `${DROPS[id] ? DROPS[id].name : id} ×${res.drops[id]}`).join(', ') || 'none';
  return new EmbedBuilder()
    .setAuthor({ name: `${username}'s battle` })
    .setColor(COLOR)
    .setTitle(`⚡ Fast Sweep — ${res.cleared} floor(s) cleared!`)
    .setDescription(
      `Loot: ${dropList}\n` +
      `❤️ **${res.hp}/${maxHp}**\n${hpBar(res.hp, maxHp)}\n\nNow at **Floor ${res.floor}**.`
    )
    .setTimestamp();
}
function dieEmbed(username, res) {
  return new EmbedBuilder()
    .setAuthor({ name: `${username}'s battle` })
    .setColor(0xed4245)
    .setTitle(`💀 You died on Floor ${res.diedAt}`)
    .setDescription(
      `Lost **${res.lost}** unbanked drop(s) + all Char EXP this run.\n\n` +
      `_No checkpoint saved — Extract to lock in depth. \`ky battle\` to try again (15,000 💎)._`
    )
    .setTimestamp();
}
function extractEmbed(username, res) {
  return new EmbedBuilder()
    .setAuthor({ name: `${username}'s battle` })
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
    return context.reply({ content: '⚔️ You already have an active battle. Use **Push** / **Extract**, or end it with `ky end`.' });
  }
  const username = uname(context);
  const res = battle.startDelve(userId);
  if (!res.ok) {
    if (res.needClass) return context.reply({ embeds: [classPickEmbed(username)], components: [classPickRow(userId)] });
    return context.reply({ content: res.reason });
  }
  const note = (res.run.floor > 1 ? `⚡ Auto-swept to floor ${res.run.floor} (no loot — push for drops).\n` : '') + 'Push for loot, or Extract to bank (`ky end` also works).';
  const msg = await context.reply({ embeds: [delveFloorEmbed(username, res.run, note)], components: [actionRow(userId, res.run)] });
  // Auto-extract on 2-min idle: frees the run if the player goes AFK (so they can start a new battle + RAM freed)
  try {
    msg.createMessageComponentCollector({ idle: 120000 }).on('end', async () => {
      if (battle.hasActiveRun(userId)) {
        const r = battle.extractRun(userId);
        try { await msg.edit({ embeds: [extractEmbed(username, r)], components: [] }); } catch {}
      }
    });
  } catch {}
}
function handleEnd(context, userId) {
  if (!battle.hasActiveRun(userId)) return context.reply({ content: 'You have no active battle.' });
  const res = battle.extractRun(userId);
  return context.reply({ embeds: [extractEmbed(uname(context), res)] });
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
const RARITY_RANK = { divine: 6, legendary: 5, epic: 4, rare: 3, uncommon: 2, common: 1 };
function handleShopEquipment(context, userId) {
  const username = uname(context);
  const gear = Object.values(GEAR).sort((a, b) => (RARITY_RANK[b.rarity] || 0) - (RARITY_RANK[a.rarity] || 0));
  const lines = gear.map((g) => {
    const st = Object.entries(g.stats).map(([k, v]) => `+${v} ${k.toUpperCase()}`).join(', ');
    return `\`${g.id}\` ${g.name} _(${g.rarity}, ${g.slot})_ — 🧪 ${g.price.toLocaleString()} | ${st}`;
  });
  const embed = new EmbedBuilder()
    .setAuthor({ name: `${username}` })
    .setColor(COLOR)
    .setTitle('🛒 Shop — Gear')
    .setDescription(`Buy with 🧪 Kryptonite. Earn Kryptonite by selling dungeon drops (\`ky sell\`). Highest rarity on top.\n\n${lines.join('\n')}`)
    .setFooter({ text: 'ky buygear <code> · ky sellgear <code>' });
  return context.reply({ embeds: [embed] });
}

// ---------- slash subcommand registration ----------
// Battle mode is PREFIX-ONLY (ky battle, ky char, ky bag, ...).
// /kyriz already has 23 subcommands; adding 6 more would exceed Discord's
// 25-option-per-command limit (caused "Invalid Array length" on deploy). So none here.
function attachSubcommands(_commandBuilder) { /* prefix-only — no slash subcommands registered */ }

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
    return interaction.update({ embeds: [delveFloorEmbed(username, res.run, 'Your adventure begins!')], components: [actionRow(userId, res.run)] });
  }

  if (customId.startsWith('battle_push_')) {
    const run0 = battle.getRun(userId);
    if (!run0) return interaction.reply({ content: 'No active battle.', ephemeral: true });
    if (run0.animating) return interaction.deferUpdate(); // prevent double-click during animation
    const playerMaxHp = run0.stats.hp;
    const res = battle.nextFloor(userId);
    if (!res.ok) return interaction.reply({ content: res.reason, ephemeral: true });
    run0.animating = true;
    try {
      // 3-frame battle animation (~1.4s): start -> mid -> final (HP bars depleting)
      const log = res.log || [];
      const frames = [log[0], log[Math.floor(log.length / 2)], log[log.length - 1]];
      const floor = res.cleared || res.diedAt;
      await interaction.update({ embeds: [fightFrameEmbed(username, floor, frames[0], playerMaxHp, res.enemyMaxHp)], components: [actionRow(userId, null, true)] });
      await sleep(700);
      if (frames[1] && (frames[1].php !== frames[0].php || frames[1].ehp !== frames[0].ehp)) {
        try { await interaction.message.edit({ embeds: [fightFrameEmbed(username, floor, frames[1], playerMaxHp, res.enemyMaxHp)] }); } catch {}
        await sleep(700);
      }
      if (res.won) { try { await interaction.message.edit({ embeds: [pushWinEmbed(username, res, battle.getRun(userId))], components: [actionRow(userId, battle.getRun(userId))] }); } catch {} }
      else { try { await interaction.message.edit({ embeds: [dieEmbed(username, res)], components: [] }); } catch {} }
    } finally { run0.animating = false; }
    return;
  }

  if (customId.startsWith('battle_fsweep_')) {
    const run0 = battle.getRun(userId);
    if (!run0) return interaction.reply({ content: 'No active battle.', ephemeral: true });
    if (run0.animating) return interaction.deferUpdate(); // no overlap with Push/another FastSweep
    run0.animating = true;
    try {
      const res = battle.fastSweep(userId, 5);
      if (!res.ok) { await interaction.reply({ content: res.reason, ephemeral: true }); return; }
      if (res.died) { await interaction.update({ embeds: [dieEmbed(username, res)], components: [] }); return; }
      const run = battle.getRun(userId);
      await interaction.update({ embeds: [fastSweepEmbed(username, res, run)], components: [actionRow(userId, run)] });
    } catch (_) { /* ignore edit/race errors */ } finally { run0.animating = false; }
    return;
  }

  if (customId.startsWith('battle_extract_')) {
    const run0 = battle.getRun(userId);
    if (run0 && run0.animating) return interaction.deferUpdate(); // don't extract mid-Push/FastSweep animation
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
  handleBattle, handleEnd, handleCharacter, handleBag, handleSell, handleSellGear, handleBuyGear, handleEquip, handleUnequip, handleShopEquipment,
  getKryptonite,
};
