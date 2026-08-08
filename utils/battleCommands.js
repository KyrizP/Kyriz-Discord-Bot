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
const uname = (ctx, userId) => {
  const dn = ctx.user?.username || ctx.author?.username || 'Player';
  if (userId) { const cn = battle.getCharName(userId); if (cn) return cn; } // charName overrides discord username
  return dn;
};
const BATTLE_IDLE_MS = 120000; // auto-extract after this many ms idle (tunable)

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
  const username = uname(context, userId);
  const res = battle.startDelve(userId);
  if (!res.ok) {
    if (res.needClass) return context.reply({ embeds: [classPickEmbed(username)], components: [classPickRow(userId)] });
    return context.reply({ content: res.reason });
  }
  const note = (res.run.floor > 1 ? `⚡ Auto-swept to floor ${res.run.floor} (no loot — push for drops).\n` : '') + 'Push for loot, or Extract to bank (`ky end` also works).';
  const msg = await context.reply({ embeds: [delveFloorEmbed(username, res.run, note)], components: [actionRow(userId, res.run)] });
  // Auto-extract on idle: frees the run if the player goes AFK.
  // Scoped to THIS run (myRun) so a stale collector from a PREVIOUS battle can't extract a newer run.
  const myRun = res.run;
  try {
    msg.createMessageComponentCollector({ idle: BATTLE_IDLE_MS }).on('end', async () => {
      if (battle.getRun(userId) === myRun) { // only if THIS run is still the active one
        const r = battle.extractRun(userId);
        try { await msg.edit({ embeds: [extractEmbed(username, r)], components: [] }); } catch {}
      }
    });
  } catch {}
}
function handleBattleHelp(context) {
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('⚔️ Battle Mode — How to Play')
    .setDescription(
      '💡 **THE LOOP**\n' +
      '`ky battle` → fight floors → collect drops → **Extract** (bank) → `ky sell all` → 🧪 → `ky buygear` + `ky equip` → stronger → delve deeper!\n\n' +
      '🎮 **COMMANDS**\n' +
      '`ky battle` — enter dungeon (**15,000 💎** entry). First time: pick a class.\n' +
      '`ky char` — view stats, gear, 🧪, best depth · `ky char name <nama>` — set name\n' +
      '`ky bag` — your drops (sellable) · `ky gear` — your equipment\n\n' +
      '⚔️ **IN BATTLE (buttons)**\n' +
      '⏩ **Push** — fight **1 floor** (animated clash). Can die.\n' +
      '⚡ **Fast Sweep** — auto-fight **5 floors** at once (fast, blind — riskier).\n' +
      '🧪 **Extract** — bank drops + EXP (safe). Locked until you clear ≥1 floor.\n\n' +
      '💀 **Death** = lose drops + EXP (this run only). **Extract** to keep them.\n' +
      '_Push your luck: extract early (safe) or go deeper (more loot, more risk)._\n\n' +
      '💰 **KRYPTONITE (🧪)** — drops are NOT 🧪, you must **sell** them:\n' +
      '`ky sell all` → sell all drops → 🧪 · `ky sell d83 5` → sell 5 of d83\n\n' +
      '⚔️ **GEAR** (get stronger — pass walls without leveling):\n' +
      '`ky shop gear` (browse) → `ky buygear g1` (buy w/ 🧪) → `ky equip g1` (equip) → stats up!\n' +
      '`ky sellgear g1` → sell spare gear (40% back).\n\n' +
      '📈 **PROGRESSION**\n' +
      'Push → Char EXP → level up → base stats grow. Gear → more stats → delve deeper → better drops.\n' +
      'Stuck at a floor? **Grind** (sweep + push + extract) → level/gear up → pass it!\n' +
      '_Floor & level have **NO CAP** — grind forever._'
    )
    .addFields({ name: '🔮 Coming in v2', value: "Psst... wanna know what's special? ⚔️ **PVP DUELS** — fight other players head-to-head. Pure power, no mercy, no loot lost — just bragging rights. Get strong NOW so you're ready. 😤🔥", inline: false })
    .setFooter({ text: 'ky battle help | 💎 Kryztal = entry · 🧪 Kryptonite = battle currency' });
  return context.reply({ embeds: [embed] });
}
function handleEnd(context, userId) {
  if (!battle.hasActiveRun(userId)) return context.reply({ content: 'You have no active battle.' });
  const res = battle.extractRun(userId);
  return context.reply({ embeds: [extractEmbed(uname(context, userId), res)] });
}
function handleName(context, userId, nameStr) {
  const res = battle.setCharName(userId, nameStr);
  if (!res.ok) return context.reply({ content: res.reason });
  return context.reply({ embeds: [resultEmbed(uname(context, userId), `🏷️ Character name set to **${res.name}**.`)] });
}

function handleCharacter(context, userId) {
  const username = uname(context, userId);
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
      `🏷️ Name: ${b.charName || `_(unset — \`ky char name <nama>\`)`}\n` +
      `**Char EXP:** ${b.charExp}/${b.charExpNeeded}\n` +
      `🧪 Kryptonite: **${b.kryptonite.toLocaleString()}** · 🏰 Best depth: **${b.bestDepth}**\n\n` +
      `❤️ HP **${stats.hp}** · ⚔️ ATK **${stats.atk}** · 🔮 MATK **${stats.matk}**\n` +
      `🛡️ DEF **${stats.def}** · ✨ MDEF **${stats.mdef}** · 💨 SPD **${stats.spd}**\n\n${equipLines}`
    )
    .setFooter({ text: 'ky equip <code> · ky unequip <slot>' });
  return context.reply({ embeds: [embed] });
}

function handleBag(context, userId, page) {
  const username = uname(context, userId);
  const { embed } = renderBag(userId, username, page || 1);
  return context.reply({ embeds: [embed] });
}
function handleGear(context, userId) {
  const username = uname(context, userId);
  const bd = getBattle(userId);
  if (!bd) return context.reply({ content: 'Not registered. Use `ky register` first.' });
  const b = bd.b;
  const eqLines = ['weapon', 'head', 'armor', 'boots', 'accessory']
    .map((slot) => { const id = b.equipment[slot]; const it = id ? GEAR[id] : null; return `**${slot}:** ${it ? `${it.name} \`${id}\`` : '—'}`; })
    .join('\n');
  const owned = Object.entries(b.bag).filter(([id, n]) => GEAR[id] && n > 0);
  const ownedLines = owned.map(([id, n]) => {
    const it = GEAR[id]; const sb = Math.round(it.price * 0.4);
    return `\`${id}\` ${it.name} ×${n} — \`ky equip ${id}\` | sell \`ky sellgear ${id}\` → 🧪 ${sb}`;
  }).join('\n') || '_No spare gear. Visit `ky shop gear`._';
  const embed = new EmbedBuilder()
    .setAuthor({ name: `${username}'s gear` })
    .setColor(COLOR)
    .setTitle('⚔️ Gear')
    .setDescription(`**Equipped:**\n${eqLines}\n\n**Owned (spare):**\n${ownedLines}`)
    .setFooter({ text: 'ky equip <code> · ky unequip <slot> · ky sellgear <code>' });
  return context.reply({ embeds: [embed] });
}

function renderBag(userId, username, page) {
  const bd = getBattle(userId);
  if (!bd) return { embed: infoEmbed(username, 'Not registered.'), components: [], totalPages: 1 };
  const drops = Object.entries(bd.b.bag).filter(([id, c]) => DROPS[id] && c > 0); // drops only — gear is in `ky gear`
  const total = Math.max(1, Math.ceil(drops.length / BAG_PAGE_SIZE));
  page = Math.min(Math.max(1, page), total);
  const slice = drops.slice((page - 1) * BAG_PAGE_SIZE, page * BAG_PAGE_SIZE);
  let desc = '';
  let totalValue = 0;
  for (const [id, count] of slice) {
    desc += `\`${id}\` ${DROPS[id].name} ×${count} — 🧪 ${DROPS[id].value} ea (🧪 ${(DROPS[id].value * count).toLocaleString()})\n`;
    totalValue += DROPS[id].value * count;
  }
  if (!desc) desc = '_Your bag is empty. Delve to find drops!_';
  const embed = new EmbedBuilder()
    .setAuthor({ name: `${username}'s bag` })
    .setColor(COLOR)
    .setTitle('🎒 Battle Bag (drops)')
    .setDescription(desc + (totalValue ? `\n**Drop value:** 🧪 ${totalValue.toLocaleString()} (\`ky sell all\`)` : '') + `\n_Gear? \`ky gear\`_`)
    .setFooter({ text: `Page ${page}/${total} • ky sell all | ky sell <code> [n]` });
  return { embed, components: total > 1 ? [bagRow(userId, page, total)] : [], totalPages: total };
}

async function handleSell(context, userId, what) {
  const username = uname(context, userId);
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
function handleSellGear(context, userId, code, qty) {
  const res = battle.sellGear(userId, (code || '').trim(), qty);
  if (!res.ok) return context.reply({ content: res.reason });
  return context.reply({ embeds: [resultEmbed(uname(context, userId), `🧪 Sold **${res.sold}× ${res.name}** for **${res.kryptonite.toLocaleString()}** Kryptonite (40% sellback each).`)] });
}
function handleEquip(context, userId, code) {
  code = (code || '').trim();
  const res = battle.equip(userId, code);
  if (!res.ok) return context.reply({ content: res.reason });
  const name = GEAR[code] ? GEAR[code].name : code;
  return context.reply({ embeds: [resultEmbed(uname(context, userId), `⚙️ Equipped **${name}** → **${res.slot}**.` + (res.swapped ? ' Previous gear moved to bag.' : ''))] });
}
function handleUnequip(context, userId, slot) {
  const res = battle.unequip(userId, (slot || '').trim().toLowerCase());
  if (!res.ok) return context.reply({ content: res.reason });
  return context.reply({ embeds: [resultEmbed(uname(context, userId), `⚙️ Unequipped **${res.slot}** → moved to bag.`)] });
}
function handleBuyGear(context, userId, code) {
  code = (code || '').trim();
  const res = battle.buyGear(userId, code);
  if (!res.ok) return context.reply({ content: res.reason });
  return context.reply({ embeds: [resultEmbed(uname(context, userId), `🛒 Bought **${res.name}** \`${code}\` for 🧪 **${res.price.toLocaleString()}**.\nEquip with \`ky equip ${code}\` · 🧪 left: **${res.kryptonite.toLocaleString()}**`)] });
}
const RARITY_RANK = { divine: 6, legendary: 5, epic: 4, rare: 3, uncommon: 2, common: 1 };
function handleShopEquipment(context, userId) {
  const username = uname(context, userId);
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
  const username = uname(interaction, userId);

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
    if (!run0) return interaction.reply({ content: 'No active battle — use `ky battle` to start one. (Your previous run may have ended or the bot restarted.)', ephemeral: true });
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
    if (!run0) return interaction.reply({ content: 'No active battle — use `ky battle` to start one. (Your previous run may have ended or the bot restarted.)', ephemeral: true });
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
  handleBattle, handleBattleHelp, handleEnd, handleName, handleCharacter, handleBag, handleGear, handleSell, handleSellGear, handleBuyGear, handleEquip, handleUnequip, handleShopEquipment,
  getKryptonite,
};
