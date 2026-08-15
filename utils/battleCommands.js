'use strict';

// ============================================================
// Battle Mode Discord command/button handlers — SELF-CONTAINED.
// game.js wires this via THIN hooks only (import + delegation).
// Per-user isolation: every interactive customId ends with the owner's userId;
// handleButton rejects anyone else. Username shown via setAuthor.
// ============================================================

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const battle = require('./battleManager');
const economy = require('./economyManager');
const { CLASSES, GEAR, DROPS, TIER_INFO, PASSIVES, LEGEND_GEAR_RANGES, MYSTERY_BOXES, CRIT } = require('./battleConfig');
const { computeStats, getPassives } = require('./battleEngine');
const unique = require('./uniqueItems');
const pvp = require('./pvpManager');
const { getItem } = require('../utils/shopItems');

const BAG_PAGE_SIZE = 8;
const COLOR = 0x9b59b6;
const PVP_COLOR = 0x5865F2;
const PVP_TURN_CAP = pvp.TURN_CAP;
const uname = (ctx) => {
  // Panel headers ("X's battle/gear/bag…") always show the DISCORD username —
  // charName lives in PvP panels + the ky char sheet only (owner preference).
  return ctx?.user?.username || ctx?.author?.username || 'Player';
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
  const e = new EmbedBuilder().setColor(COLOR).setDescription(text).setTimestamp();
  if (username) e.setAuthor({ name: `${username}` }); // discord.js rejects empty author name (length >= 1)
  return e;
}
function resultEmbed(username, text) {
  const e = new EmbedBuilder().setColor(COLOR).setDescription(text).setTimestamp();
  if (username) e.setAuthor({ name: `${username}` });
  return e;
}
function classPickEmbed(username) {
  return new EmbedBuilder()
    .setAuthor({ name: `${username}'s battle` })
    .setColor(COLOR)
    .setTitle('🎭 Create your character')
    .setDescription('Pick a class to begin your dungeon battle (entry **5,000 💎 Kryztal**):\n\n⚔️ **Warrior** — tanky physical bruiser (ATK/DEF/HP)\n🔮 **Mage** — glass-cannon magic (MATK, squishy)\n🗡️ **Rogue** — fast assassin (SPD/evasion/poison)')
    .setTimestamp();
}
function classPickRow(userId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`battle_class_warrior_${userId}`).setLabel('⚔️ Warrior').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`battle_class_mage_${userId}`).setLabel('🔮 Mage').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`battle_class_rogue_${userId}`).setLabel('🗡️ Rogue').setStyle(ButtonStyle.Secondary),
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
function bagRow(targetId, page, total, viewerId) {
  // customId: battle_bag_(next|prev)_<page>_<targetId>_<viewerId> — LAST segment = executor (clicker must be the one who ran the command)
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`battle_bag_prev_${page}_${targetId}_${viewerId}`).setLabel('◀ Prev').setStyle(ButtonStyle.Secondary).setDisabled(page <= 1),
    new ButtonBuilder().setCustomId(`battle_bag_next_${page}_${targetId}_${viewerId}`).setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= total),
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
function equipStr(equipment, uniqueItems) {
  return ['weapon', 'head', 'armor', 'boots', 'accessory']
    .map((s) => {
      const id = equipment && equipment[s];
      if (!id) return `**${s}:** —`;
      let rarity, name;
      if (GEAR[id]) { rarity = GEAR[id].rarity; name = GEAR[id].name; }
      else if (uniqueItems && uniqueItems[id]) { rarity = uniqueItems[id].rarity; name = uniqueItems[id].name; }
      else return `**${s}:** \`${id}\``;
      return `**${s}:** ${tierBadge(rarity)} ${name} \`${id}\``;
    })
    .join('\n');
}
function tierBadge(rarity) {
  const t = TIER_INFO[rarity];
  return t ? `${t.color}[${t.letter}]` : `[?]`;
}
const STAT_EMOJI = { hp: '❤️', atk: '⚔️', matk: '🔮', def: '🛡️', mdef: '✨', spd: '💨' }; // inline gear stats on `ky char`
function passiveDesc(p) {
  const v = p.value + (p.unit ?? ((PASSIVES[p.id] && PASSIVES[p.id].unit) || ''));
  switch (p.id) {
    case 'berserker': return `Deal enhanced ${v} ATK/MATK damage`;
    case 'precision': return `${v} chance to deal 1.75× critical damage`;
    case 'lifesteal': return `Heal for ${v} of damage dealt`;
    case 'swift': return `+${v} flat SPD (turn order)`;
    case 'fortify': return `Take ${v} less damage`;
    case 'evasion': return `${v} chance to dodge enemy attack`;
    case 'greed': return `Gain ${v} more 🧪 from drops`;
    case 'wisdom': return `Gain ${v} more Char EXP`;
    default: return '';
  }
}
function _cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
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
    .addFields({ name: '⚔️ Equipped', value: equipStr(run.equipment, run.uniqueItems), inline: true })
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
// Mirrors game.js sendLevelUpNotification (can't import it — game.js requires this module).
// Battle profile-XP level-ups deserve the same announcement as casino games.
async function notifyProfileLevelUp(channel, userId, xpResult) {
  if (!channel || !xpResult || !xpResult.leveledUp) return;
  try {
    await channel.send({ embeds: [new EmbedBuilder()
      .setColor(0xfee75c)
      .setTitle('🎉 Level Up!')
      .setDescription(`<@${userId}> is now **Level ${xpResult.newLevel}**!\n\nReward: 💎 **+${xpResult.rewardTotal.toLocaleString()}** Kryztal`)
      .setTimestamp()] });
  } catch {}
}
function dieEmbed(username, res) {
  return new EmbedBuilder()
    .setAuthor({ name: `${username}'s battle` })
    .setColor(0xed4245)
    .setTitle(`💀 You died on Floor ${res.diedAt}`)
    .setDescription(
      `Lost **${res.lost}** unbanked drop(s) + all Char EXP this run.\n\n` +
      `_No checkpoint saved — Extract to lock in depth. \`ky battle\` to try again (5,000 💎)._`
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
        notifyProfileLevelUp(msg.channel, userId, r.xpResult);
      }
    });
  } catch {}
}
// Battle help — paginated (2 pages, ◀▶ buttons, executor-locked)
const HELP_PAGES = [
  {
    title: '⚔️ Battle Mode — Classes & Combat',
    build: () => new EmbedBuilder()
      .setColor(COLOR)
      .setTitle('⚔️ Battle Mode — Classes & Combat (1/2)')
      .setDescription(
        '💡 **THE LOOP**\n`ky battle` → fight floors → collect drops → **Extract** (bank) → `ky sell all` → 🧪 → `ky buygear` + `ky equip` → stronger → delve deeper!\n\n' +
        '🎮 **COMMANDS**\n' +
        '`ky battle` — enter dungeon (**5,000 💎** entry). First time: pick a class.\n' +
        '`ky char` — stats, gear, depth · `ky switch <class>` — swap character\n' +
        '`ky preset [n]` — gear loadouts · `ky bag` — drops · `ky gear` — equipment\n\n' +
        '🎭 **MULTIPLE CHARACTERS**\n' +
        '`ky switch <class>` — one command: owned = free swap, unowned = create (**🧪 5,000**). Gear **per-character**, 🧪/bag/collection **shared**.\n\n' +
        '🎒 **GEAR PRESETS**\n' +
        '`ky preset save <n>` → snapshot 5 slots · `ky preset <n>` → load back instantly.\nFirst **2 free**, unlock 3/4/5 for 🧪 **2k / 5k / 10k**.\n\n' +
        '⚔️ **IN BATTLE (buttons)**\n' +
        '⏩ **Push** — fight 1 floor (can die)\n⚡ **Fast Sweep** — auto 5 floors\n🧪 **Extract** — bank drops + EXP\n\n' +
        '⚔️ **COMBAT** (auto in PvE, pick skills in PvP):\n\n' +
        'Warrior ⚔️ — tank\nSlash 1.0× · Parry Strike 1.6× +block (CD2) · War Cry 2.5× +pierce +DR (CD4)\n\n' +
        'Mage 🔮 — burst\nBolt 1.0× · Fireball 1.7× +burn (CD2) · Meteor 2.5× +burn +pierce (CD4)\n\n' +
        'Rogue 🗡️ — speed\nBackstab 1.0× · Venom Fang 1.5× +poison (CD2) · Shadow Dance 2.0× +2 dodge (CD4)\n_Rogue passive: 8% base evasion (adds with gear, total cap 48%)._\n\n' +
        '_Burn/poison bypass Parry & dodge. Dodge charges consumed by ALL attacks (ults pierce but still use a charge)._'
      )
      .setTimestamp(),
  },
  {
    title: '⚔️ Battle Mode — Gear & Progression',
    build: () => new EmbedBuilder()
      .setColor(COLOR)
      .setTitle('⚔️ Battle Mode — Gear & Progression (2/2)')
      .setDescription(
        '💀 **Death** = lose drops + EXP (this run). **Extract** to keep.\n\n' +
        '💰 **KRYPTONITE (🧪)** — sell drops to get 🧪:\n`ky sell all` · `ky sell d83 5`\n\n' +
        '⚔️ **GEAR** (pass walls):\n`ky shop gear [tier|rates]` → browse\nCommon–Epic fixed (`g1–g23`) · **Legend+ mystery boxes** (`g100+`) — random stats + passive!\nWeapon/head/armor = **pure gacha** (random ATK/MATK, DEF/MDEF)\n`ky buygear <code>` · `ky equip <id>` · `ky sellgear <id|rarity all>`\n⚠️ **Gear locked during battle/duel**\n\n' +
        '🎲 **REROLL**: bad roll? Sell (35% refund) → rebuy → new random!\n\n' +
        '✨ **PASSIVES** (Legend+ gear, auto in PvE & PvP):\n🗡️ Berserker +dmg (100%) · 🎯 Precision crit (50%)\n🩸 Lifesteal heal (65%) · 💨 Swift +SPD\n🛡️ Fortify −dmg (45%) · 🌀 Evasion dodge (40%)\n🧪 Greed +🧪 sell · 📚 Wisdom +EXP\n\n' +
        '📈 **PROGRESSION**\nPush → EXP → level → stats grow → delve deeper → better drops.\nFloor & level **NO CAP** — grind forever!\n\n' +
        '⚔️ **PvP DUELS**: `ky battle @user`\nTurn-based, pick skills, passives active. Level gap dampened. AFK 1 min = forfeit. 🏆'
      )
      .setFooter({ text: '💎 Kryztal = entry · 🧪 Kryptonite = battle currency' })
      .setTimestamp(),
  },
];
function helpPageRow(page, userId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`battle_help_${page - 1}_${userId}`).setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(page <= 1),
    new ButtonBuilder().setCustomId(`battle_help_${page + 1}_${userId}`).setLabel('▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= HELP_PAGES.length),
  );
}
function buildHelpPage(page, userId) {
  page = Math.min(Math.max(1, page || 1), HELP_PAGES.length);
  const embed = HELP_PAGES[page - 1].build();
  embed.setFooter({ text: `Page ${page}/${HELP_PAGES.length} · ` + (embed.data.footer ? embed.data.footer.text : '') });
  return { embed, components: HELP_PAGES.length > 1 ? [helpPageRow(page, userId)] : [] };
}
function handleBattleHelp(context) {
  const { embed, components } = buildHelpPage(1, context.author?.id || context.user?.id);
  return context.reply({ embeds: [embed], components });
}
async function handleEnd(context, userId) {
  if (battle.hasActiveRun(userId)) {
    const res = battle.extractRun(userId);
    notifyProfileLevelUp(context.channel, userId, res.xpResult);
    return context.reply({ embeds: [extractEmbed(uname(context, userId), res)] });
  }
  // PvP forfeit (works any time — your turn or not)
  for (const [fightId, f] of pvp.activePvpFights) {
    if (!f.over && (f.p1.id === userId || f.p2.id === userId)) {
      const res = pvp.forfeitManual(fightId, userId);
      if (res.ok) { _pvpFinish(fightId, f); return context.reply({ embeds: [infoEmbed(uname(context, userId), 'You forfeited the duel.')] }); }
    }
  }
  return context.reply({ content: 'You have no active battle or duel.' });
}
function handleName(context, userId, nameStr) {
  const res = battle.setCharName(userId, nameStr);
  if (!res.ok) return context.reply({ content: res.reason });
  return context.reply({ embeds: [resultEmbed(uname(context, userId), `🏷️ Character name set to **${res.name}**.`)] });
}

// Character page order: ACTIVE char first, then remaining owned chars in CLASSES key order.
function charPageOrder(b) {
  if (!b.activeClass) return [];
  const rest = Object.keys(CLASSES).filter((k) => k !== b.activeClass && b.characters && b.characters[k]);
  return [b.activeClass, ...rest];
}
// `ky char 2` / `ky char mage` — resolve a page hint (number or class name) to a 1-based index.
function parseCharPage(hint, order) {
  if (hint == null || hint === '') return 1;
  const s = String(hint).trim().toLowerCase();
  if (/^\d+$/.test(s)) return Math.min(Math.max(1, parseInt(s, 10)), order.length);
  const idx = order.indexOf(s);
  return idx >= 0 ? idx + 1 : 1;
}
function charRow(targetId, page, total, viewerId) {
  // customId: ..._<targetId>_<page>_<viewerId> — the LAST segment is the EXECUTOR (uniform rule:
  // only whoever ran the command may click; admins paging an inspect target included).
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`battle_charpage_${targetId}_${page - 1}_${viewerId}`).setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(page <= 1),
    new ButtonBuilder().setCustomId(`battle_charpage_${targetId}_${page + 1}_${viewerId}`).setLabel('▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= total),
  );
}
// Compact gear line: tier badge + name + inline stats + compact passives (null → '—').
// Shared by the `ky char` sheet and the preset panel (char visuals unchanged).
function formatGearLine(id, b) {
  if (!id) return '—';
  let rarity, name, stats, passives;
  if (id.startsWith('ky') && b.uniqueItems && b.uniqueItems[id]) {
    rarity = b.uniqueItems[id].rarity; name = b.uniqueItems[id].name;
    stats = b.uniqueItems[id].stats; passives = b.uniqueItems[id].passives || [];
  } else if (GEAR[id]) {
    rarity = GEAR[id].rarity; name = GEAR[id].name; stats = GEAR[id].stats; passives = [];
  } else return `\`${id}\``;
  const statStr = Object.entries(stats || {}).map(([k, v]) => `${STAT_EMOJI[k] || k}+${v}`).join(' · ');
  const passStr = passives.map((p) => {
    if (!PASSIVES[p.id]) return '';
    return PASSIVES[p.id].unit ? `${PASSIVES[p.id].emoji}${p.value}${PASSIVES[p.id].unit}` : `${PASSIVES[p.id].emoji}+${p.value}`; // %: 🩸20% · flat: 💨+16
  }).filter(Boolean).join(' · '); // compact: emoji+value only (full desc stays on `ky gear <id>`)
  return `${tierBadge(rarity)} ${name} \`${id}\` — ${statStr}${passStr ? ' · ' + passStr : ''}`;
}
// Per-character sheet. Reads ONLY per-char fields via `c` + shared root via `b`.
function buildCharEmbed(b, cls, displayName, pageIdx, totalPages) {
  const c = b.characters[cls];
  const clsDef = CLASSES[cls];
  const isActive = cls === b.activeClass;
  const stats = computeStats(c.charLevel, cls, c.equipment, b.uniqueItems || {});
  const totalStat = stats.hp + stats.atk + stats.matk + stats.def + stats.mdef + stats.spd;
  const equipLines = ['weapon', 'head', 'armor', 'boots', 'accessory']
    .map((slot) => `**${slot}:** ${formatGearLine(c.equipment[slot], b)}`)
    .join('\n');
  // Passive summary from equipped unique items
  const { getPassives, getPassivesRaw } = require('./battleEngine');
  const CAPS = require('./battleConfig').PASSIVE_CAPS;
  const passSum = getPassives(c.equipment, b.uniqueItems || {});
  const passRaw = getPassivesRaw(c.equipment, b.uniqueItems || {});
  const baseEva = clsDef.baseEvasion || 0; // Rogue class passive
  const EVA_TOTAL_CAP = require('./battleConfig').EVASION_TOTAL_CAP; // single source of truth (engine + display)
  const effEva = Math.min(baseEva + (passSum.evasion || 0), EVA_TOTAL_CAP);
  const passLines = Object.entries(passSum)
    .filter(([id, v]) => v > 0 && PASSIVES[id])
    .map(([id, v]) => {
      if (id === 'evasion' && baseEva > 0) return `${PASSIVES[id].emoji} ${PASSIVES[id].name} ${effEva}${PASSIVES[id].unit}${effEva >= EVA_TOTAL_CAP ? ' *(MAX)*' : ''}`;
      return `${PASSIVES[id].emoji} ${PASSIVES[id].name} ${v}${PASSIVES[id].unit}${(CAPS[id] && passRaw[id] > v) ? ' *(MAX)*' : ''}`;
    })
    .join('\n');
  let passSection = '';
  if (passLines) passSection = `\n\n**✨ Active Passives:**\n${passLines}`;
  else if (baseEva > 0) passSection = `\n\n**✨ Active Passives:**\n🌀 Evasion ${baseEva}% *(class)*`;
  const banner = isActive
    ? `🟢 ACTIVE · ${clsDef.emoji} ${clsDef.name} — Lv.${c.charLevel}`
    : `⚪ INACTIVE · ${clsDef.emoji} ${clsDef.name} — Lv.${c.charLevel}`;
  const footer = isActive
    ? `Page ${pageIdx}/${totalPages} • ky equip <code> · ky unequip <slot>`
    : `Page ${pageIdx}/${totalPages} • ky switch ${cls} to play this character`;
  return new EmbedBuilder()
    .setAuthor({ name: `${displayName}'s character` })
    .setColor(COLOR)
    .setDescription(
      // first line: status plain, class+level BOLD (embed titles can't do partial bold)
      `${banner.split(' · ')[0]} · **${banner.split(' · ')[1]}**\n\n` +
      `🏷️ Name: ${c.charName || `_(unset — \`ky char name <nama>\`)`}\n` +
      `**Char EXP:** ${c.charExp}/${c.charExpNeeded}\n` +
      `🧪 Kryptonite: **${b.kryptonite.toLocaleString()}** · 🏰 Best depth: **${c.bestDepth}**\n` +
      `⚔️ PvP: **${b.pvpWins || 0}W/${b.pvpLosses || 0}L**${((b.pvpWins || 0) + (b.pvpLosses || 0)) > 0 ? ` (${Math.round((b.pvpWins || 0) / ((b.pvpWins || 0) + (b.pvpLosses || 0)) * 100)}% win rate)` : ''}\n\n` +
      `❤️ HP **${stats.hp}** · ⚔️ ATK **${stats.atk}** · 🔮 MATK **${stats.matk}**\n` +
      `🛡️ DEF **${stats.def}** · ✨ MDEF **${stats.mdef}** · 💨 SPD **${stats.spd}**\n` +
      `**Combat Score: ${totalStat}**\n\n${equipLines}${passSection}`
    )
    .setFooter({ text: footer });
}
// Build one page of the character sheet (re-read fresh data on every call — buttons reuse this).
function renderCharPage(b, targetId, page, viewerId) {
  const order = charPageOrder(b);
  page = Math.min(Math.max(1, page || 1), Math.max(1, order.length));
  const cls = order[page - 1] || b.activeClass;
  const targetUser = economy.getUser(targetId);
  const displayName = battle.getCharName(targetId) || (targetUser && targetUser.username) || targetId;
  return {
    embed: buildCharEmbed(b, cls, displayName, page, order.length),
    components: order.length > 1 ? [charRow(targetId, page, order.length, viewerId)] : [],
    totalPages: order.length,
  };
}
function handleCharacter(context, userId, targetArg, pageArg) {
  // Superadmin can view others (@mention or user ID). Small numbers / class names = page hint (self).
  let targetId = userId;
  let pageHint = pageArg || null;
  const argStr = String(targetArg == null ? '' : targetArg).trim();
  if (argStr) {
    const mentionMatch = argStr.match(/^<@!?(\d+)>$/) || (/^\d{17,20}$/.test(argStr) ? [, argStr] : null);
    if (mentionMatch) {
      if (!economy.isAdmin(userId)) return context.reply({ content: 'Only admins can view other players\' characters.' });
      targetId = mentionMatch[1];
      const targetUser = economy.getUser(targetId);
      if (!targetUser) return context.reply({ content: 'User not found.' });
    } else {
      pageHint = argStr; // `ky char 2` / `ky char mage`
    }
  }
  const bd = getBattle(targetId);
  if (!bd) return context.reply({ content: 'Not registered.' });
  const b = bd.b;
  if (!battle.getActiveChar(b)) {
    const noCharName = targetId === userId ? uname(context, userId) : ((economy.getUser(targetId) || {}).username || targetId);
    return context.reply({ embeds: [infoEmbed(noCharName, 'No character yet.')] });
  }
  const order = charPageOrder(b);
  const { embed, components } = renderCharPage(b, targetId, parseCharPage(pageHint, order), userId); // userId here = the EXECUTOR
  return context.reply({ embeds: [embed], components });
}

function handleBag(context, userId, page) {
  // Admin inspect: @mention or userID
  const argStr = String(page || '');
  const mentionMatch = argStr.match(/^<@!?(\d+)>$/) || (/^\d{17,20}$/.test(argStr) ? [, argStr] : null);
  if (mentionMatch) {
    if (!economy.isAdmin(userId)) return context.reply({ content: 'Only admins can inspect other players.' });
    const targetId = mentionMatch[1];
    const targetUser = economy.getUser(targetId);
    if (!targetUser) return context.reply({ content: 'User not found.' });
    const { embed } = renderBag(targetId, targetUser.username || targetId, 1, userId);
    return context.reply({ embeds: [embed] });
  }
  const username = uname(context, userId);
  const { embed } = renderBag(userId, username, parseInt(page) || 1);
  return context.reply({ embeds: [embed] });
}
const RARITY_INITIAL = { common: 'C', uncommon: 'U', rare: 'R', epic: 'E', legendary: 'L', mythic: 'M', divine: 'D' };
function handleGear(context, userId, itemId) {
  // Admin inspect: @mention or userID → show target's spare gear list
  const argStr = String(itemId || '');
  const mentionMatch = argStr.match(/^<@!?(\d+)>$/) || (/^\d{17,20}$/.test(argStr) ? [, argStr] : null);
  if (mentionMatch) {
    if (!economy.isAdmin(userId)) return context.reply({ content: 'Only admins can inspect other players.' });
    const targetId = mentionMatch[1];
    const targetUser = economy.getUser(targetId);
    if (!targetUser) return context.reply({ content: 'User not found.' });
    const { embed, components } = renderGearList(targetId, targetUser.username || targetId, 1, userId);
    return context.reply({ embeds: [embed], components });
  }
  const username = uname(context, userId);
  const bd = getBattle(userId);
  if (!bd) return context.reply({ content: 'Not registered.' });
  const b = bd.b;
  const lower = String(itemId || '').toLowerCase();

  // Detail view: ky gear <id>  (g* template OR ky* unique)
  if (lower) {
    let name, slot, rarity, stats, passives = [], id, sell;
    let isForeign = false; // admin viewing someone else's gear
    if (lower.startsWith('ky') && b.uniqueItems && b.uniqueItems[lower]) {
      const u = b.uniqueItems[lower];
      id = u.id; name = u.name; slot = u.slot; rarity = u.rarity; stats = u.stats; passives = u.passives || [];
      sell = unique.sellValue(u);
    } else if (lower.startsWith('ky') && economy.isAdmin(userId)) {
      // Admin/superadmin: search ALL users for this kyID
      const data = economy.readEconomy();
      let found = null, ownerName = null;
      for (const [uid, u] of Object.entries(data)) {
        if (u.battle && u.battle.uniqueItems && u.battle.uniqueItems[lower]) {
          found = u.battle.uniqueItems[lower]; ownerName = u.username || uid; break;
        }
      }
      if (!found) return context.reply({ content: 'Gear not found (not in your collection or anyone else\'s).' });
      id = found.id; name = found.name; slot = found.slot; rarity = found.rarity; stats = found.stats; passives = found.passives || [];
      sell = unique.sellValue(found); isForeign = true;
      name = `${name} _(owned by ${ownerName})_`;
    } else if (GEAR[lower]) {
      const g = GEAR[lower]; id = g.id; name = g.name; slot = g.slot; rarity = g.rarity; stats = g.stats; passives = [];
      sell = Math.round((g.price || 0) * battle.GEAR_SELLBACK);
    } else {
      return context.reply({ content: 'Gear not found.' });
    }
    const statStr = Object.entries(stats).map(([k, v]) => `+${v} ${k.toUpperCase()}`).join(', ');
    const embed = new EmbedBuilder()
      .setAuthor({ name: `${username}` })
      .setColor(COLOR)
      .setTitle(`${name}`)
      .setDescription(`**Id:** \`${id}\`\n**Type:** ${_cap(slot)}\n**Tier:** ${tierBadge(rarity)} ${_cap(rarity)}\n**Stats:** ${statStr}`)
      .setTimestamp();
    if (passives.length) {
      embed.addFields({ name: 'Passive' + (passives.length > 1 ? 's' : ''),
        value: passives.map((p) => `${p.emoji || PASSIVES[p.id].emoji} ${PASSIVES[p.id].name} +${p.value}${p.unit ?? PASSIVES[p.id].unit}\n_${passiveDesc(p)}_`).join('\n') });
    }
    if (!isForeign) {
      embed.setFooter({ text: `ky equip ${id} · ky sellgear ${id} → 🧪 ${sell.toLocaleString()}` });
    } else {
      embed.setFooter({ text: '🔒 Read-only (not your gear)' });
    }
    return context.reply({ embeds: [embed] });
  }

  // List view (paginated)
  const { embed, components } = renderGearList(userId, username, 1);
  return context.reply({ embeds: [embed], components });
}

const GEAR_PAGE_SIZE = 8;
const GEAR_SLOTS = ['weapon', 'head', 'armor', 'boots', 'accessory'];
const SLOT_EMOJI = { weapon: '⚔️', head: '🪖', armor: '🛡️', boots: '💨', accessory: '💍' };
function gearRow(targetId, page, total, viewerId, slotFilter) {
  // customId: battle_gear_(next|prev)_<page>_<targetId>_<viewerId>_<slot> — viewer = executor, slot = active filter
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`battle_gear_prev_${page}_${targetId}_${slotFilter || 'all'}_${viewerId}`).setLabel('◀ Prev').setStyle(ButtonStyle.Secondary).setDisabled(page <= 1),
    new ButtonBuilder().setCustomId(`battle_gear_next_${page}_${targetId}_${slotFilter || 'all'}_${viewerId}`).setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= total),
  );
}
// Slot filter dropdown — executor-locked (viewerId = whoever ran `ky gear`)
function gearFilterRow(targetId, viewerId, slotFilter) {
  const sel = new StringSelectMenuBuilder()
    .setCustomId(`battle_gearsel_${targetId}_${viewerId}`)
    .setPlaceholder('Filter by slot…')
    .addOptions(
      { label: 'All slots', value: 'all', emoji: '🗂️', default: slotFilter === 'all' || !slotFilter },
      ...GEAR_SLOTS.map((sl) => ({ label: sl.charAt(0).toUpperCase() + sl.slice(1), value: sl, emoji: SLOT_EMOJI[sl], default: slotFilter === sl })),
    );
  return new ActionRowBuilder().addComponents(sel);
}
function renderGearList(userId, username, page, viewerId, slotFilter) {
  slotFilter = GEAR_SLOTS.includes(slotFilter) ? slotFilter : 'all';
  const bd = getBattle(userId);
  if (!bd) return { embed: infoEmbed(username, 'Not registered.'), components: [] };
  const b = bd.b;
  const uniqIds = Object.keys(b.uniqueItems || {})
    .filter((id) => !battle.isEquippedOnAnyChar(b, id)) // G5/G6: an item equips on ONE char — hide equipped copies
    .filter((id) => b.uniqueItems[id].rarity !== 'immortal') // hide IMMORTAL items from gear list (hidden until equipped)
    .filter((id) => slotFilter === 'all' || b.uniqueItems[id].slot === slotFilter)
    .sort((a, c) => (b.uniqueItems[c].boughtAt || '').localeCompare(b.uniqueItems[a].boughtAt || ''));
  const tmplIds = Object.keys(b.bag).filter((id) => GEAR[id] && b.bag[id] > 0)
    .filter((id) => slotFilter === 'all' || GEAR[id].slot === slotFilter)
    .sort((a, c) => (RARITY_RANK[GEAR[c].rarity] || 0) - (RARITY_RANK[GEAR[a].rarity] || 0));
  const lines = [];
  for (const id of uniqIds) {
    const u = b.uniqueItems[id];
    const st = Object.entries(u.stats).map(([k, v]) => `+${v} ${k.toUpperCase()}`).join(', ');
    const ps = (u.passives || []).map((p) => `${p.emoji || PASSIVES[p.id].emoji} ${PASSIVES[p.id].name} ${p.value}${p.unit ?? PASSIVES[p.id].unit}`).join(' ');
    lines.push(`\`${id}\` ${tierBadge(u.rarity)} ${u.name} (${u.slot}) | ${st}${ps ? ' | ' + ps : ''}`);
  }
  for (const id of tmplIds) {
    const g = GEAR[id];
    const st = Object.entries(g.stats).map(([k, v]) => `+${v} ${k.toUpperCase()}`).join(', ');
    lines.push(`\`${id}\` ${tierBadge(g.rarity)} ${g.name} (${g.slot}) ×${b.bag[id]} | ${st}`);
  }
  const filterLabel = slotFilter === 'all' ? '' : `${SLOT_EMOJI[slotFilter]} ${slotFilter} · `;
  if (!lines.length && slotFilter !== 'all') {
    return { embed: new EmbedBuilder().setAuthor({ name: `${username}'s gear` }).setColor(COLOR).setTitle('⚔️ Gear — Spares')
      .setDescription(`_No ${slotFilter} spares._`)
      .setFooter({ text: 'ky gear <id> for details · ky equip <id> · ky sellgear <id>' }),
      components: [gearFilterRow(userId, viewerId || userId, slotFilter)] };
  }
  if (!lines.length) {
    return { embed: new EmbedBuilder().setAuthor({ name: `${username}'s gear` }).setColor(COLOR).setTitle('⚔️ Gear')
      .setDescription('_No spare gear. Visit `ky shop gear` to buy._')
      .setFooter({ text: 'ky gear <id> for details · ky equip <id> · ky sellgear <id>' }), components: [] };
  }
  const total = Math.max(1, Math.ceil(lines.length / GEAR_PAGE_SIZE));
  page = Math.min(Math.max(1, page), total);
  const slice = lines.slice((page - 1) * GEAR_PAGE_SIZE, page * GEAR_PAGE_SIZE);
  const embed = new EmbedBuilder()
    .setAuthor({ name: `${username}'s gear` }).setColor(COLOR).setTitle('⚔️ Gear — Spares')
    .setDescription(slice.join('\n'))
    .setFooter({ text: `${filterLabel}Page ${page}/${total} • ky gear <id> · ky equip <id> · ky sellgear <id>` });
  const rows = [gearFilterRow(userId, viewerId || userId, slotFilter)];
  if (total > 1) rows.push(gearRow(userId, page, total, viewerId || userId, slotFilter));
  return { embed, components: rows };
}

function renderBag(userId, username, page, viewerId) {
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
  return { embed, components: total > 1 ? [bagRow(userId, page, total, viewerId || userId)] : [], totalPages: total };
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
  if (pvp.isInFight(userId)) return context.reply({ content: 'Finish your duel first (`ky end`).' });
  const res = battle.sellGear(userId, (code || '').trim(), qty);
  if (!res.ok) return context.reply({ content: res.reason });
  return context.reply({ embeds: [resultEmbed(uname(context, userId), `🧪 Sold **${res.sold}× ${res.name}** for **${res.kryptonite.toLocaleString()}** Kryptonite (35% sellback).`)] });
}
function handleEquip(context, userId, code) {
  if (pvp.isInFight(userId)) return context.reply({ content: 'Finish your duel first (`ky end`).' });
  code = (code || '').trim();
  const res = battle.equip(userId, code);
  if (!res.ok) return context.reply({ content: res.reason });
  const bd = getBattle(userId);
  let name = code;
  if (code.startsWith('ky') && bd && bd.b.uniqueItems[code]) name = bd.b.uniqueItems[code].name;
  else if (GEAR[code]) name = GEAR[code].name;
  const movedNote = res.swapped ? (res.swapped.startsWith('ky') ? ' Previous unique returned to collection.' : ' Previous gear moved to bag.') : '';
  return context.reply({ embeds: [resultEmbed(uname(context, userId), `⚙️ Equipped **${name}** → **${res.slot}**.${movedNote ? ' ' + movedNote : ''}`)] });
}
function handleUnequip(context, userId, slot) {
  if (pvp.isInFight(userId)) return context.reply({ content: 'Finish your duel first (`ky end`).' });
  slot = (slot || '').trim().toLowerCase();
  if (slot === 'all') {
    const res = battle.unequipAll(userId);
    if (!res.ok) return context.reply({ content: res.reason });
    return context.reply({ embeds: [resultEmbed(uname(context, userId), `⚙️ Unequipped **${res.count}** item(s) — gear moved to bag/collection.`)] });
  }
  const res = battle.unequip(userId, slot);
  if (!res.ok) return context.reply({ content: res.reason });
  const bd = getBattle(userId);
  const id = res.itemId;
  const isKy = id && id.startsWith('ky');
  let name = id;
  if (isKy && bd && bd.b.uniqueItems[id]) name = bd.b.uniqueItems[id].name;
  else if (id && GEAR[id]) name = GEAR[id].name;
  const dest = isKy ? 'returned to collection' : 'moved to bag';
  return context.reply({ embeds: [resultEmbed(uname(context, userId), `⚙️ Unequipped **${name}** (${res.slot}) — ${dest}.`)] });
}

// G3: a player with an open duel challenge may not change/switch class (challenge would build on stale data).
function hasPendingChallenge(userId) {
  for (const key of challengeTimers.keys()) {
    const [aId, bId] = key.split('_');
    if (aId === userId || bId === userId) return true;
  }
  return false;
}
// `ky switch <class>` — ONE command, auto-detect:
//   owned class  -> instant free swap
//   unowned      -> confirmation embed+button (🧪 CHAR_CHANGE_COST) — money NEVER moves without the click
//   no arg       -> list characters + which is active
async function handleSwitchClass(context, userId, args) {
  args = args || [];
  const cls = String(args[0] || '').toLowerCase();
  if (!cls) {
    return context.reply({ content: 'Usage: `ky switch <class>` — free swap to a character you own (a class you don\'t own yet offers creation, 🧪 5,000). See `ky char` for your characters.' });
  }
  if (!Object.hasOwn(CLASSES, cls)) { // hasOwn: inherited keys ('constructor') must not pass
    const bd = getBattle(userId);
    return context.reply({ content: 'Invalid class. You own: ' + (bd && bd.b.characters ? Object.keys(bd.b.characters).join(', ') : 'none') + '.' });
  }
  if (pvp.isInFight(userId)) return context.reply({ content: 'Finish your duel first (`ky end`).' });
  if (hasPendingChallenge(userId)) return context.reply({ content: 'You have a pending duel challenge — settle it first.' });
  const bd = getBattle(userId);
  if (!bd || !battle.getActiveChar(bd.b)) return context.reply({ content: 'Create a character first (`ky battle`).' }); // switch needs >=1 char — don't offer creation to a classless player
  const owned = bd.b.characters && bd.b.characters[cls];
  if (!owned) {
    // Unowned -> paid creation, gated behind an explicit confirm button.
    const price = battle.CHAR_CHANGE_COST;
    const kry = bd ? bd.b.kryptonite || 0 : 0;
    if (kry < price) return context.reply({ content: `You don't own a ${CLASSES[cls].name} yet. Creating one costs 🧪 ${price.toLocaleString()} Kryptonite (you have ${kry.toLocaleString()}).` });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`battle_buyclass_${userId}_${cls}`).setLabel(`Create — 🧪 ${price.toLocaleString()}`).setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`battle_buyclass_${userId}_cancel`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    );
    const sent = await context.reply({ embeds: [infoEmbed(uname(context),
      `🎭 You don't own a **${CLASSES[cls].emoji} ${CLASSES[cls].name}** character yet.\n\n` +
      `Create one for **🧪 ${price.toLocaleString()} Kryptonite**? It starts at **Lv.1** with no gear.\n` +
      `Your current character is kept safe — swap back free anytime.\n\n_Auto-cancels in 60s._`)], components: [row], fetchReply: true });
    armBuyclassTimer(userId, sent); // 60s no-click expiry; any manual action clears it
    return sent;
  }
  const res = battle.switchClass(userId, cls);
  if (!res.ok) return context.reply({ content: res.reason });
  const bAfter = getBattle(userId); // RE-READ: bd is a pre-switch snapshot — displaying from it would show the OLD char
  const c = bAfter ? battle.getActiveChar(bAfter.b) : null;
  const cd = CLASSES[res.switchedTo];
  return context.reply({ embeds: [resultEmbed(uname(context, userId),
    `🔄 Switched to **${cd.emoji} ${cd.name}** — Lv.${c ? c.charLevel : '?'} · 🏰 Best depth **${c ? c.bestDepth : 0}**.\n\n` +
    `Gear is per-character — check \`ky char\` and re-equip.`)] });
}
// Legacy alias (pre-deploy naming; hidden from help): identical behavior.
async function handleChangeClass(context, userId, args) { return handleSwitchClass(context, userId, args); }
function handleBuyGear(context, userId, code) {
  if (pvp.isInFight(userId)) return context.reply({ content: 'Finish your duel first (`ky end`).' });
  const args = String(code || '').toLowerCase().split(/\s+/).filter(Boolean);
  const code0 = args[0];
  // Mystery box (g100+) -> generate a kyXXXX unique
  if (code0 && MYSTERY_BOXES[code0]) {
    const box = MYSTERY_BOXES[code0];
    const res = battle.buyUnique(userId, box.tier, box.slot); // weapon rolls ATK/MATK randomly (pure gacha)
    if (!res.ok) return context.reply({ content: res.reason });
    const u = res.unique;
    const statStr = Object.entries(u.stats).map(([k, v]) => `+${v} ${k.toUpperCase()}`).join(' · ');
    const passStr = u.passives.map((p) => `${p.emoji || PASSIVES[p.id].emoji} ${PASSIVES[p.id].name} ${p.value}${p.unit ?? PASSIVES[p.id].unit}`).join(' | ');
    const sell = unique.sellValue(u);
    const embed = new EmbedBuilder()
      .setAuthor({ name: `${uname(context, userId)}` }).setColor(COLOR)
      .setTitle(`🎉 ${u.name}`)
      .setDescription(`\`${u.id}\` — ${tierBadge(u.rarity)}\n**${statStr}**\n${passStr}`)
      .addFields({ name: 'Equip & Sell', value: `\`ky equip ${u.id}\` · \`ky sellgear ${u.id}\` → 🧪 ${sell.toLocaleString()}` })
      .setFooter({ text: `🧪 ${res.kryptonite.toLocaleString()} Kryptonite left` });
    return context.reply({ embeds: [embed] });
  }
  // Template (g1-g23) — fixed stats
  if (code0 && GEAR[code0]) {
    const res = battle.buyGear(userId, code0);
    if (!res.ok) return context.reply({ content: res.reason });
    return context.reply({ embeds: [resultEmbed(uname(context, userId), `🛒 Bought **${res.name}** \`${code0}\` for 🧪 **${res.price.toLocaleString()}**.\nEquip with \`ky equip ${code0}\` · 🧪 left: **${res.kryptonite.toLocaleString()}**`)] });
  }
  return context.reply({ content: 'Unknown gear code. See `ky shop gear` for the list of codes.' });
}

// ---------- gear presets: `ky preset` — snapshots of all 5 equipment slots ----------
// One preset slot per page (page k = slot k); ◀/▶ re-renders fresh from disk.
// customId battle_presetpage_<page>_<userId> — page BEFORE userId so the generic
// owner check (last segment = executor) locks paging to whoever ran the command.
function presetRow(viewerId, page, total) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`battle_presetpage_${page - 1}_${viewerId}`).setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(page <= 1),
    new ButtonBuilder().setCustomId(`battle_presetpage_${page + 1}_${viewerId}`).setLabel('▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= total),
  );
}
function buildPresetPanel(b, userId, page, viewerId) {
  const total = Math.max(1, b.presetSlots || 1);
  page = Math.min(Math.max(1, page || 1), total);
  const preset = b.presets && b.presets[page - 1];
  let desc;
  if (!preset) {
    desc = `_(empty — \`ky preset save ${page}\`)_`;
  } else {
    const gearLines = GEAR_SLOTS.map((slot) => `**${slot}:** ${formatGearLine(preset.slots && preset.slots[slot], b)}`).join('\n');
    const passSum = getPassives(preset.slots, b.uniqueItems || {});
    const { getPassivesRaw: gpr } = require('./battleEngine');
    const CAPS = require('./battleConfig').PASSIVE_CAPS;
    const passRaw = gpr(preset.slots, b.uniqueItems || {});
    const passLine = Object.entries(passSum)
      .filter(([id, v]) => v > 0 && PASSIVES[id])
      .map(([id, v]) => `${PASSIVES[id].emoji} ${PASSIVES[id].name} ${v}${PASSIVES[id].unit}${(CAPS[id] && passRaw[id] > v) ? ' *(MAX)*' : ''}`)
      .join('\n');
    desc = `${gearLines}\n\n**✨ Active Passives:**\n${passLine || '—'}`;
  }
  const nextPrice = battle.PRESET_SLOT_PRICES[b.presetSlots + 1];
  const footerTail = b.presetSlots >= battle.PRESET_SLOTS_CAP || !nextPrice
    ? 'Max slots reached'
    : `Next slot: 🧪 ${nextPrice.toLocaleString()} · ky preset buy slot`;
  const displayName = (economy.getUser(userId) || {}).username || userId;
  return {
    embed: new EmbedBuilder()
      .setAuthor({ name: `${displayName}'s presets` })
      .setColor(COLOR)
      .setTitle(`🎒 Gear Presets — Slot ${page}/${total}`)
      .setDescription(desc)
      .setFooter({ text: `Slot ${page}/${total} • ${footerTail} • ky preset save|delete|<n>` }),
    components: total > 1 ? [presetRow(viewerId || userId, page, total)] : [],
  };
}
// preset-buy confirm expiry: 60s no click -> auto-cancel (buttons die, no charge).
// Mirrors buyclassTimers: one timer per user; any manual click or a NEW confirm clears the old one.
const PRESETBUY_MS = 60_000;
const presetBuyTimers = new Map(); // userId -> setTimeout handle
function clearPresetBuyTimer(userId) {
  if (presetBuyTimers.has(userId)) { clearTimeout(presetBuyTimers.get(userId)); presetBuyTimers.delete(userId); }
}
function armPresetBuyTimer(userId, message) {
  clearPresetBuyTimer(userId); // a fresh confirm supersedes any pending one
  presetBuyTimers.set(userId, setTimeout(async () => {
    presetBuyTimers.delete(userId);
    try { await message.edit({ embeds: [infoEmbed('', '⌛ Preset slot purchase expired — no Kryptonite spent.')], components: [] }); } catch { /* message deleted — nothing to do */ }
  }, PRESETBUY_MS));
}
// `ky preset buy [slot]` — pre-checks here (cap / kryptonite → direct reason, no buttons);
// money only moves on the Confirm click (manager re-checks again).
async function handlePresetBuy(context, userId, bd) {
  const b = bd.b;
  const cap = battle.PRESET_SLOTS_CAP;
  const price = battle.PRESET_SLOT_PRICES[b.presetSlots + 1];
  if (b.presetSlots >= cap || !price) return context.reply({ content: `Preset slots maxed out (${cap}/${cap}).` });
  const kry = b.kryptonite || 0;
  if (kry < price) return context.reply({ content: `The next preset slot costs 🧪 ${price.toLocaleString()} Kryptonite — you have 🧪 ${kry.toLocaleString()}.` });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`battle_presetbuy_${userId}`).setLabel(`Unlock — 🧪 ${price.toLocaleString()}`).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`battle_presetcancel_${userId}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );
  const sent = await context.reply({ embeds: [infoEmbed(uname(context),
    `🎒 Unlock preset slot **${b.presetSlots + 1}/${cap}**?\n\n` +
    `Slots: **${b.presetSlots}/${cap} → ${b.presetSlots + 1}/${cap}** · Price: **🧪 ${price.toLocaleString()}** · Kryptonite after: **${(kry - price).toLocaleString()}**\n\n` +
    `_Auto-cancels in 60s._`)], components: [row], fetchReply: true });
  armPresetBuyTimer(userId, sent); // 60s no-click expiry; any manual action clears it
  return sent;
}
// `ky preset` panel · `save <n>` · `delete|del <n>` · `buy [slot]` · bare `<n>` = load
async function handlePreset(context, userId, args) {
  args = args || [];
  if (pvp.isInFight(userId)) return context.reply({ content: 'Finish your duel first (`ky end`).' });
  if (hasPendingChallenge(userId)) return context.reply({ content: 'You have a pending duel challenge — settle it first.' });
  const bd = getBattle(userId);
  if (!bd) return context.reply({ content: 'You are not registered.' });
  const sub = String(args[0] || '').toLowerCase();
  if (!sub) {
    const { embed, components } = buildPresetPanel(bd.b, userId, 1, userId);
    return context.reply({ embeds: [embed], components });
  }
  const username = uname(context, userId);
  if (sub === 'save') {
    const r = battle.presetSave(userId, args[1]);
    return context.reply(r.ok ? { embeds: [resultEmbed(username, `💾 Preset **${r.slot}** saved — snapshot of all 5 equipment slots.`)] } : { content: r.reason });
  }
  if (sub === 'delete' || sub === 'del') {
    const r = battle.presetDelete(userId, args[1]);
    return context.reply(r.ok ? { embeds: [resultEmbed(username, `🗑️ Preset **${r.slot}** cleared.`)] } : { content: r.reason });
  }
  if (sub === 'buy') return handlePresetBuy(context, userId, bd); // 'slot' arg optional
  const r = battle.presetLoad(userId, args[0]);
  return context.reply(r.ok ? { embeds: [resultEmbed(username, `✅ Preset **${r.loaded}** loaded — all 5 equipment slots swapped instantly.`)] } : { content: r.reason });
}
const RARITY_RANK = { divine: 6, legendary: 5, epic: 4, rare: 3, uncommon: 2, common: 1 };
const SHOP_PAGE_SIZE = 8;
function shopGearRow(userId, page, total) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`battle_shopgear_prev_${page}_${userId}`).setLabel('◀ Prev').setStyle(ButtonStyle.Secondary).setDisabled(page <= 1),
    new ButtonBuilder().setCustomId(`battle_shopgear_next_${page}_${userId}`).setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= total),
  );
}
function renderShopGear(userId, username, page, tierFilter) {
  page = page || 1;
  const tierOrder = ['divine', 'mythic', 'legendary', 'epic', 'rare', 'uncommon', 'common'];
  const boxSlots = ['weapon', 'head', 'armor', 'boots', 'accessory'];
  const boxByTS = {}; for (const b of Object.values(MYSTERY_BOXES)) boxByTS[b.tier + '_' + b.slot] = b;
  const lines = [];
  for (const tier of tierOrder) {
    if (tierFilter && tier !== tierFilter) continue;
    const ti = TIER_INFO[tier];
    if (tier === 'legendary' || tier === 'mythic' || tier === 'divine') {
      for (const slot of boxSlots) {
        const box = boxByTS[tier + '_' + slot];
        const r = LEGEND_GEAR_RANGES[tier][slot];
        let preview;
        if (slot === 'weapon') preview = `+${r.atk[0]}-${r.atk[1]} ATK/MATK`;
        else if (slot === 'head' || slot === 'armor') preview = `1 stat DEF/MDEF +${r.stat[0]}-${r.stat[1]}`;
        else if (slot === 'boots') preview = `+${r.spd[0]}-${r.spd[1]} SPD`;
        else preview = `2 random stats`;
        lines.push(`\`${box.code}\` ${ti.color}[${ti.letter}] ${box.name}  |  ${preview} · ${ti.passives} passive${ti.passives > 1 ? 's' : ''}  |  🧪 ${ti.price.toLocaleString()}`);
      }
    } else {
      for (const g of Object.values(GEAR)) {
        if (g.rarity !== tier) continue;
        const st = Object.entries(g.stats).map(([k, v]) => `+${v} ${k.toUpperCase()}`).join(', ');
        lines.push(`\`${g.id}\` ${ti.color}[${ti.letter}] ${g.name} (${g.slot})  |  ${st}  |  🧪 ${g.price.toLocaleString()}`);
      }
    }
  }
  const total = Math.max(1, Math.ceil(lines.length / SHOP_PAGE_SIZE));
  page = Math.min(Math.max(1, page), total);
  const slice = lines.slice((page - 1) * SHOP_PAGE_SIZE, page * SHOP_PAGE_SIZE);
  const embed = new EmbedBuilder()
    .setAuthor({ name: `${username}` })
    .setColor(COLOR)
    .setTitle('🛒 Shop — Gear' + (tierFilter ? ` (${_cap(tierFilter)})` : ''))
    .setDescription(`Top = highest rarity. **Legend+ = mystery boxes** (random stats + passive). Pure gacha (ATK/MATK, DEF/MDEF — random). Unhappy? Sell (35%) + rebuy to reroll. Check \`ky shop gear rates\` for stat & passive % ranges.\n\n${slice.join('\n')}`)
    .setFooter({ text: `Page ${page}/${total} • ky buygear <code> · ky sellgear <code>` });
  return { embed, components: total > 1 ? [shopGearRow(userId, page, total)] : [], total };
}
function handleShopEquipment(context, userId, tierArg) {
  const t = String(tierArg || '').toLowerCase();
  if (t === 'rates' || t === 'rate' || t === 'info') {
    return context.reply({ embeds: [renderGearRates(uname(context, userId))] });
  }
  const valid = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic', 'divine'];
  const filter = valid.includes(t) ? t : null;
  const { embed, components } = renderShopGear(userId, uname(context, userId), 1, filter);
  return context.reply({ embeds: [embed], components });
}
function renderGearRates(username) {
  const R = require('./battleConfig').LEGEND_GEAR_RANGES;
  const P = require('./battleConfig').PASSIVES;
  const TI = require('./battleConfig').TIER_INFO;
  const tiers = ['legendary', 'mythic', 'divine'];
  const shortName = { legendary: 'L', mythic: 'M', divine: 'D' };
  let desc = '**📊 STAT RANGES** (random within range)\n\n';
  desc += '**Weapon** (ATK or MATK, random):\n';
  for (const t of tiers) desc += `  ${TI[t].color}${shortName[t]} +${R[t].weapon.atk[0]}-${R[t].weapon.atk[1]}\n`;
  desc += '\n**Head/Armor** (DEF or MDEF, random 1 stat):\n';
  for (const t of tiers) desc += `  ${TI[t].color}${shortName[t]} Head +${R[t].head.stat[0]}-${R[t].head.stat[1]} · Armor +${R[t].armor.stat[0]}-${R[t].armor.stat[1]}\n`;
  desc += '\n**Boots** (SPD):\n';
  for (const t of tiers) desc += `  ${TI[t].color}${shortName[t]} +${R[t].boots.spd[0]}-${R[t].boots.spd[1]}\n`;
  desc += '\n**Accessory** (2 random different stats):\n';
  for (const t of tiers) desc += `  ${TI[t].color}${shortName[t]} +${R[t].accessory.main[0]}-${R[t].accessory.main[1]} (SPD +${R[t].accessory.spd[0]}-${R[t].accessory.spd[1]})\n`;
  desc += `\n**✨ PASSIVE RANGES** (random type, random %)\n`;
  desc += '```';
  desc += 'Passive'.padEnd(14) + '  ';
  for (const t of tiers) desc += shortName[t].padEnd(10);
  desc += '\n';
  for (const [id, p] of Object.entries(P)) {
    desc += (p.emoji + ' ' + p.name).padEnd(14) + '  ';
    for (const t of tiers) desc += (p.ranges[t][0] + '-' + p.ranges[t][1] + (p.unit || '')).padEnd(10);
    desc += '\n';
  }
  desc += '```\n';
  desc += `Legend: 1 passive · Mythic: 1 passive · Divine: **2 passives** (different types)\n`;
  desc += `Stacking caps: Berserker 100% · Precision (crit) ${Math.round(CRIT.cap * 100)}% · Lifesteal 65% · Fortify 45% · Evasion 40%\n`;
  desc += `_Sell back at 35% + rebuy to reroll!_`;
  return new EmbedBuilder().setAuthor({ name: `${username}` }).setColor(COLOR)
    .setTitle('🎰 Mystery Box Rates & Ranges').setDescription(desc)
    .setFooter({ text: 'ky shop gear [tier] to browse · ky buygear <code> to buy' });
}


// ---------- PvP (turn-based duels) ----------
// Cosmetics name wrap — mirrors handleBattleLb's title/badge resolution exactly.
function cosmeticWrap(cosmetics, name) {
  const c = cosmetics || {};
  const titleItem = c.title ? getItem(c.title) : null;
  const badgeItem = c.badge ? getItem(c.badge) : null;
  const prefix = titleItem ? `[${(titleItem.emoji && titleItem.emoji !== '\u{1F3F7}️') ? titleItem.emoji + ' ' : ''}${titleItem.effect.value}] ` : '';
  const suffix = badgeItem ? ` ${badgeItem.effect.value}` : '';
  return `${prefix}${name}${suffix}`;
}
function hpBar20(hp, hpMax) {
  const seg = Math.max(0, Math.min(20, Math.round((Math.max(0, hp) / Math.max(1, hpMax)) * 20)));
  return '█'.repeat(seg) + '░'.repeat(20 - seg);
}
const PVP_SLOT_EMOJI = { weapon: '⚔️', head: '🪖', armor: '🛡️', boots: '💨', accessory: '💍' };
function pvpGearLine(c) {
  const parts = [];
  for (const slot of ['weapon', 'head', 'armor', 'boots', 'accessory']) {
    const id = c.equipment && c.equipment[slot];
    if (!id) continue;
    let rarity, name;
    if (id.startsWith('ky') && c.uniqueItems && c.uniqueItems[id]) { rarity = c.uniqueItems[id].rarity; name = c.uniqueItems[id].name; }
    else if (GEAR[id]) { rarity = GEAR[id].rarity; name = GEAR[id].name; }
    else continue;
    const ti = TIER_INFO[rarity] || { color: '', letter: '?' };
    parts.push(`${PVP_SLOT_EMOJI[slot]}${ti.color}[${ti.letter}] ${name}`);
  }
  return parts.length ? parts.join(' · ') : '—';
}
function renderPvpPanel(fight, note) {
  const a = fight.p1, b = fight.p2;
  const sep = '─'.repeat(28);
  const clsEm = (c) => CLASSES[c.charClass] ? CLASSES[c.charClass].emoji : '';
  const nm = (c) => `${cosmeticWrap(c.cosmetics, c.charName || c.username)} · Lv.${c.charLevel} ${CLASSES[c.charClass].name} ${clsEm(c)}`;
  const hpLine = (c) => `❤️ ${hpBar20(c.hp, c.hpMax)}`;
  const statsLine = (c) => `❤️ HP ${c.hp} · ⚔️ ATK ${c.stats.atk} · 🔮 MATK ${c.stats.matk}\n🛡️ DEF ${c.stats.def} · ✨ MDEF ${c.stats.mdef} · 💨 SPD ${c.stats.spd}`;
  const playerBlock = (c) => `**${nm(c)}**\n${hpLine(c)}\n${sep}\n${statsLine(c)}\n${sep}\n${pvpGearLine(c)}`;
  const turnN = fight.over ? fight.turnCount : Math.min(fight.turnCount + 1, PVP_TURN_CAP);
  const activeNm = fight.over ? '🏁 Duel Over' : `🔄 ${(fight[fight.active].charName || fight[fight.active].username)}'s turn`;
  const log = (note || '').trim();
  const logSection = log ? `${log}\n${activeNm}` : activeNm;
  const embed = new EmbedBuilder().setColor(PVP_COLOR)
    .setTitle(`⚔️ DUEL ARENA — Turn ${turnN}/${PVP_TURN_CAP}`)
    .setDescription(
      `${playerBlock(a)}\n\n` +
      `⚡ **V S** ⚡\n\n` +
      `${playerBlock(b)}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n${logSection}`
    );
  return embed;
}
function pvpSkillRow(fight) {
  const actor = fight[fight.active];
  const row = new ActionRowBuilder();
  for (const sk of actor.skills) {
    const cd = actor.cdLeft[sk.id] || 0;
    row.addComponents(new ButtonBuilder()
      .setCustomId(`pvp_skill_${sk.id}_${fight.id}_${actor.id}`)
      .setLabel(`${sk.name}${cd > 0 ? ` (CD${cd})` : ''}`)
      .setStyle(sk.cd > 0 ? ButtonStyle.Secondary : ButtonStyle.Primary)
      .setDisabled(cd > 0));
  }
  return [row];
}
function pvpResultEmbed(fight) {
  const winKey = fight.winner, loseKey = winKey === 'p1' ? 'p2' : 'p1';
  const win = fight[winKey], lose = fight[loseKey];
  const clsEm = (c) => CLASSES[c.charClass] ? CLASSES[c.charClass].emoji : '';
  const charNm = (c) => c.charName || c.username;
  const nm = (c) => `${charNm(c)} · Lv.${c.charLevel} ${CLASSES[c.charClass].name} ${clsEm(c)}`;
  const reason = fight.afkForfeit ? `${charNm(lose)} went AFK` : fight.manualForfeit ? `${charNm(lose)} forfeited` : fight.timeout ? 'Turn cap — decided by HP%' : 'Knockout';
  return new EmbedBuilder().setColor(PVP_COLOR).setTitle('⚔️ Duel Over')
    .setDescription(`🏆 **${charNm(win)}** wins!\n_${reason}_\n\n` +
      `**${nm(fight.p1)}**\n❤️ ${hpBar20(fight.p1.hp, fight.p1.hpMax)}\n\n` +
      `**${nm(fight.p2)}**\n❤️ ${hpBar20(fight.p2.hp, fight.p2.hpMax)}`
    );
}
const pvpMessages = new Map(); // fightId -> live Discord message (for edits + AFK callback)
function _pvpFinish(fightId, fight) {
  const loserKey = fight.winner === 'p1' ? 'p2' : 'p1';
  battle.recordPvp(fight[fight.winner].id, fight[loserKey].id);
  const m = pvpMessages.get(fightId);
  if (m) { try { m.edit({ embeds: [pvpResultEmbed(fight)], components: [] }); } catch (_) {} }
  pvpMessages.delete(fightId);
  pvp.endFight(fightId);
}
function _onForfeitFor(fightId) {
  return (fid, f) => _pvpFinish(fid, f);
}

const PVP_CHALLENGE_MS = 60_000; // challenge auto-expires after 60s
const challengeTimers = new Map(); // `${aId}_${bId}` -> setTimeout handle
// buyclass confirm expiry: 60s no click -> auto-cancel (buttons die, no charge). One timer per user;
// any manual action (Create/Cancel) or a NEW confirm clears the old one first.
const BUYCLASS_MS = 60_000;
const buyclassTimers = new Map(); // userId -> setTimeout handle
function clearBuyclassTimer(userId) {
  if (buyclassTimers.has(userId)) { clearTimeout(buyclassTimers.get(userId)); buyclassTimers.delete(userId); }
}
function armBuyclassTimer(userId, message) {
  clearBuyclassTimer(userId); // a fresh confirm supersedes any pending one
  buyclassTimers.set(userId, setTimeout(async () => {
    buyclassTimers.delete(userId);
    try { await message.edit({ embeds: [infoEmbed('', '⌛ Character creation expired — no Kryptonite spent.')], components: [] }); } catch { /* message deleted — nothing to do */ }
  }, BUYCLASS_MS));
}
function clearChallengeTimer(aId, bId) {
  const key = `${aId}_${bId}`;
  if (challengeTimers.has(key)) { clearTimeout(challengeTimers.get(key)); challengeTimers.delete(key); }
}

async function handlePvp(context, userId, targetId) {
  if (!targetId) return context.reply({ content: 'Mention someone to duel: `ky battle @user`' });
  if (targetId === userId) return context.reply({ content: 'You cannot duel yourself.' });
  if (battle.hasActiveRun(userId) || pvp.isInFight(userId))
    return context.reply({ content: 'Finish your current battle/duel first.' });
  if (battle.hasActiveRun(targetId) || pvp.isInFight(targetId))
    return context.reply({ content: 'That player is busy right now.' });
  const data = economy.readEconomy();
  const me = data[userId], foe = data[targetId];
  const hasChar = (u) => u && u.battle && battle.getActiveChar(battle.ensureBattleData(u));
  if (!hasChar(me)) return context.reply({ content: 'Create a character first: `ky battle`.' });
  if (!hasChar(foe)) return context.reply({ content: 'That player has no character.' });
  const embed = new EmbedBuilder().setColor(PVP_COLOR)
    .setTitle('⚔️ Duel Challenge')
    .setDescription(`<@${userId}> challenges <@${targetId}> to a duel!\nAccept within **60s** or it expires. Turn-based, 1-min turn timer.`);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`pvp_accept_${userId}_${targetId}`).setLabel('Accept').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`pvp_decline_${userId}_${targetId}`).setLabel('Decline').setStyle(ButtonStyle.Danger),
  );
  const msg = await context.reply({ embeds: [embed], components: [row], allowedMentions: { users: [targetId] } });
  // Challenge expiry timer — auto-decline after 60s if no response
  const key = `${userId}_${targetId}`;
  challengeTimers.set(key, setTimeout(() => {
    challengeTimers.delete(key);
    try { msg.edit({ embeds: [infoEmbed('', 'Duel challenge expired (no response in 60s).')], components: [] }); } catch (_) {}
  }, PVP_CHALLENGE_MS));
}

async function handlePvpButton(interaction) {
  const customId = interaction.customId;

  if (customId.startsWith('pvp_accept_')) {
    const parts = customId.split('_'); // pvp_accept_<aId>_<bId>
    const aId = parts[2], bId = parts[3];
    clearChallengeTimer(aId, bId); // cancel expiry timer — challenge being resolved
    if (interaction.user.id !== bId) return interaction.reply({ content: '⛔ This challenge is not yours.', ephemeral: true });
    if (battle.hasActiveRun(aId) || battle.hasActiveRun(bId) || pvp.isInFight(aId) || pvp.isInFight(bId))
      return interaction.update({ embeds: [infoEmbed('', 'Duel cancelled — a player is now busy.')], components: [] });
    const data = economy.readEconomy();
    const aU = data[aId], bU = data[bId];
    const hasChar = (u) => u && u.battle && battle.getActiveChar(battle.ensureBattleData(u));
    if (!hasChar(aU) || !hasChar(bU))
      return interaction.update({ embeds: [infoEmbed('', 'Duel cancelled — a player no longer has a character.')], components: [] });
    const makePlayer = (uid) => {
      const u = data[uid]; const b = u.battle;
      const c = battle.getActiveChar(b); const cls = battle.getCharClass(b);
      const stats = computeStats(pvp.pvpEffLevel(c.charLevel), cls, c.equipment, b.uniqueItems || {}); // PvP: dampened level (gear full)
      return { id: uid, username: u.username || 'Player', charName: c.charName, charLevel: c.charLevel, charClass: cls,
        stats, skills: CLASSES[cls].skills, equipment: c.equipment, uniqueItems: b.uniqueItems || {}, cosmetics: u.cosmetics || {} };
    };
    const fightId = `pvp_${Date.now().toString(36)}_${aId}`;
    const fight = pvp.startFight(fightId, makePlayer(aId), makePlayer(bId));
    pvpMessages.set(fightId, interaction.message);
    pvp.startAfkTimer(fightId, _onForfeitFor(fightId));
    const firstNote = `Duel begins! ${cosmeticWrap(fight[fight.active].cosmetics, fight[fight.active].charName || fight[fight.active].username)} moves first.`;
    return interaction.update({ embeds: [renderPvpPanel(fight, firstNote)], components: pvpSkillRow(fight) });
  }

  if (customId.startsWith('pvp_decline_')) {
    const parts = customId.split('_');
    const aId = parts[2], bId = parts[3];
    if (interaction.user.id !== bId && interaction.user.id !== aId) return interaction.reply({ content: '⛔ Not yours.', ephemeral: true });
    clearChallengeTimer(aId, bId); // cancel expiry timer — challenge being resolved
    return interaction.update({ embeds: [infoEmbed('', 'Duel declined.')], components: [] });
  }

  if (customId.startsWith('pvp_skill_')) {
    // pvp_skill_<skillId>_<fightId...>_<actorId>
    const parts = customId.split('_');
    const actorId = parts[parts.length - 1];
    const skillId = parts[2];
    const fightId = parts.slice(3, -1).join('_');
    const fight = pvp.getFight(fightId);
    if (!fight) return interaction.reply({ content: 'This duel has ended.', ephemeral: true });
    if (interaction.user.id !== actorId) return interaction.reply({ content: 'Not your turn yet.', ephemeral: true });
    const res = pvp.resolvePvpTurn(fightId, actorId, skillId);
    if (!res.ok) return interaction.reply({ content: res.reason || 'Invalid action.', ephemeral: true });

    const eventStr = (res.events || []).map((e) => {
      if (e.type === 'hit') {
        if (e.parried) return `${e.crit ? '💥 CRIT! ' : ''}🛡️ Parried! ${e.skill} — ${e.dmg}`;
        if (e.dodged) return e.dmg > 0 ? `🗡️ Shadow Dodge pierced! ${e.skill} — ${e.dmg}` : '🗡️ Shadow Dodge!';
        if (e.evaded) return '💨 Missed!';
        return `${e.crit ? '💥 CRIT! ' : ''}🗡️ ${e.skill} — ${e.dmg}`;
      }
      if (e.type === 'burn') return `🔥 Burn — ${e.dmg}`;
      if (e.type === 'poison') return `🧪 Poison — ${e.dmg}`;
      if (e.type === 'lifesteal') return `🩸 +${e.heal}`;
      return '';
    }).filter(Boolean).join('\n');

    pvp.clearAfkTimer(fightId); // close the AFK race window synchronously BEFORE any await
    pvpMessages.set(fightId, interaction.message);
    let renderOk = true;
    try {
      await interaction.deferUpdate();
      await interaction.message.edit({ embeds: [renderPvpPanel(fight, eventStr || '...')], components: [] });
    } catch (_) { renderOk = false; } // stale interaction (message deleted / token expired)
    if (renderOk) await sleep(700);
    if (res.over) {
      // _pvpFinish owns the result render + recordPvp + endFight (timer already cleared above)
      if (renderOk) { try { await interaction.message.edit({ embeds: [pvpResultEmbed(fight)], components: [] }); } catch (_) {} }
      _pvpFinish(fightId, fight);
    } else if (fight.over) {
      return; // opponent forfeited (ky end) during the 700ms animation — forfeit path owns the result render
    } else {
      // ALWAYS restart the timer for the new active player (prevents hang if render failed)
      pvp.startAfkTimer(fightId, _onForfeitFor(fightId));
      if (renderOk) { try { await interaction.message.edit({ embeds: [renderPvpPanel(fight, eventStr || ' ')], components: pvpSkillRow(fight) }); } catch (_) {} }
    }
    return;
  }
}

// ---------- slash subcommand registration ----------
// Battle mode is PREFIX-ONLY (ky battle, ky char, ky bag, ...).
// /kyriz already has 23 subcommands; adding 6 more would exceed Discord's
// 25-option-per-command limit (caused "Invalid Array length" on deploy). So none here.
function attachSubcommands(_commandBuilder) { /* prefix-only — no slash subcommands registered */ }

// ---------- button handler (delegated from game.js handleButton) ----------
async function handleButton(interaction) {
  const customId = interaction.customId;
  if (customId.startsWith('pvp_')) return handlePvpButton(interaction);
  if (!customId.startsWith('battle_')) return null;
  // battle_buyclass_<userId>_<class|cancel> — paid char creation confirm. BEFORE the generic
  // owner check: last segment is the class (or 'cancel'), not the userId.
  if (customId.startsWith('battle_buyclass_')) {
    const parts = customId.split('_'); // battle, buyclass, userId, cls|cancel
    const ownerId = parts[2];
    const tail = parts.slice(3).join('_');
    if (interaction.user.id !== ownerId) return interaction.reply({ content: "This isn't your character creation.", ephemeral: true });
    if (!buyclassTimers.has(ownerId)) return interaction.deferUpdate(); // panel expired (auto-cancelled) — ignore stale click
    clearBuyclassTimer(ownerId); // manual action reached first — stop the timer
    if (tail === 'cancel') return interaction.update({ embeds: [infoEmbed(uname(interaction, ownerId), 'Cancelled — no Kryptonite spent.')], components: [] });
    // Re-run guards at click time (state may have changed since the embed was posted)
    if (pvp.isInFight(ownerId)) return interaction.update({ embeds: [infoEmbed(uname(interaction, ownerId), 'Finish your duel first (`ky end`).')], components: [] });
    if (hasPendingChallenge(ownerId)) return interaction.update({ embeds: [infoEmbed(uname(interaction, ownerId), 'You have a pending duel challenge — settle it first.')], components: [] });
    const res = battle.changeClass(ownerId, tail); // manager re-checks: owned class, cap, kryptonite, run-lock (G1/G9)
    if (!res.ok) return interaction.update({ embeds: [infoEmbed(uname(interaction, ownerId), res.reason)], components: [] });
    const cd = CLASSES[tail];
    return interaction.update({ embeds: [resultEmbed(uname(interaction, ownerId),
      `🎭 New character created: **${cd.emoji} ${cd.name}** — **Lv.1** activated!\n` +
      `Paid 🧪 ${battle.CHAR_CHANGE_COST.toLocaleString()} · 🧪 left: **${res.kryptonite.toLocaleString()}**\n\n` +
      `Gear is per-character — equip it with \`ky equip <code>\`.`)], components: [] });
  }

  // battle_presetbuy_<userId> / battle_presetcancel_<userId> — paid preset-slot unlock confirm.
  // BEFORE the generic owner check (mirrors battle_buyclass_): explicit executor check + 60s timer stale-guard.
  if (customId.startsWith('battle_presetbuy_') || customId.startsWith('battle_presetcancel_')) {
    const ownerId = customId.split('_')[2];
    if (interaction.user.id !== ownerId) return interaction.reply({ content: "This isn't your purchase.", ephemeral: true });
    if (!presetBuyTimers.has(ownerId)) return interaction.deferUpdate(); // panel expired (auto-cancelled) — ignore stale click
    clearPresetBuyTimer(ownerId); // manual action reached first — stop the timer
    if (customId.startsWith('battle_presetcancel_'))
      return interaction.update({ embeds: [infoEmbed(uname(interaction, ownerId), 'Cancelled — no Kryptonite spent.')], components: [] });
    // Re-run guards at click time (state may have changed since the embed was posted)
    if (pvp.isInFight(ownerId)) return interaction.update({ embeds: [infoEmbed(uname(interaction, ownerId), 'Finish your duel first (`ky end`).')], components: [] });
    if (hasPendingChallenge(ownerId)) return interaction.update({ embeds: [infoEmbed(uname(interaction, ownerId), 'You have a pending duel challenge — settle it first.')], components: [] });
    const res = battle.buyPresetSlot(ownerId); // manager re-checks: cap, kryptonite, run-lock
    if (!res.ok) return interaction.update({ embeds: [infoEmbed(uname(interaction, ownerId), res.reason)], components: [] });
    return interaction.update({ embeds: [resultEmbed(uname(interaction, ownerId),
      `🎒 Preset slot unlocked — **${res.presetSlots}/${battle.PRESET_SLOTS_CAP}** slots now.\n` +
      `Paid 🧪 ${res.price.toLocaleString()} · 🧪 left: **${res.kryptonite.toLocaleString()}**\n\n` +
      `Save a build into it: \`ky preset save ${res.presetSlots}\`.`)], components: [] });
  }

  // battle_charpage_<targetId>_<page> — handled BEFORE the generic owner check (last segment = page, not userId).
  if (customId.startsWith('battle_charpage_')) {
    const parts = customId.split('_'); // battle, charpage, targetId, page, viewerId
    if (parts.length < 5) return interaction.deferUpdate(); // stale pre-fix panel
    const targetId = parts[2];
    const page = parseInt(parts[3], 10) || 1;
    const viewerId = parts[4];
    if (interaction.user.id !== viewerId)
      return interaction.reply({ content: "This isn't your panel — run the command yourself.", ephemeral: true });
    const bd = getBattle(targetId);
    if (!bd) return interaction.reply({ content: 'Not registered.', ephemeral: true });
    if (!battle.getActiveChar(bd.b)) return interaction.update({ embeds: [infoEmbed('', 'No character yet.')], components: [] });
    const { embed, components } = renderCharPage(bd.b, targetId, page, viewerId);
    return interaction.update({ embeds: [embed], components });
  }
  const userId = customId.slice(customId.lastIndexOf('_') + 1); // owner is always last segment
  if (interaction.user.id !== userId) {
    return interaction.reply({ content: '⛔ This is not yours.', ephemeral: true });
  }
  const username = uname(interaction, userId);

  // class pick -> create character + start delve
  const classMatch = customId.match(/^battle_class_(warrior|mage|rogue)_/);
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
      else { try { await interaction.message.edit({ embeds: [dieEmbed(username, res)], components: [] }); } catch {} notifyProfileLevelUp(interaction.channel, userId, res.xpResult); }
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
      if (res.died) { await interaction.update({ embeds: [dieEmbed(username, res)], components: [] }); notifyProfileLevelUp(interaction.channel, userId, res.xpResult); return; }
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
    notifyProfileLevelUp(interaction.channel, userId, res.xpResult);
    return interaction.update({ embeds: [extractEmbed(username, res)], components: [] });
  }

  const bagMatch = customId.match(/^battle_bag_(next|prev)_(\d+)_(\d+)_(\d+)$/);
  if (bagMatch) {
    let page = parseInt(bagMatch[2], 10);
    page = bagMatch[1] === 'next' ? page + 1 : page - 1;
    const targetId = bagMatch[3]; // viewer == userId from the generic owner check above
    const targetName = (economy.getUser(targetId) || {}).username || targetId;
    const { embed, components } = renderBag(targetId, targetName, page, userId);
    return interaction.update({ embeds: [embed], components });
  }

  const shopGearMatch = customId.match(/^battle_shopgear_(next|prev)_(\d+)_/);
  if (shopGearMatch) {
    let page = parseInt(shopGearMatch[2], 10);
    page = shopGearMatch[1] === 'next' ? page + 1 : page - 1;
    const { embed, components } = renderShopGear(userId, username, page);
    return interaction.update({ embeds: [embed], components });
  }

  const gearMatch = customId.match(/^battle_gear_(next|prev)_(\d+)_(\d+)_(all|weapon|head|armor|boots|accessory)_(\d+)$/);
  if (gearMatch) {
    let page = parseInt(gearMatch[2], 10);
    page = gearMatch[1] === 'next' ? page + 1 : page - 1;
    const targetId = gearMatch[3];
    const slotFilter = gearMatch[4];
    const targetName = (economy.getUser(targetId) || {}).username || targetId;
    const { embed, components } = renderGearList(targetId, targetName, page, userId, slotFilter);
    return interaction.update({ embeds: [embed], components });
  }

  const presetPageMatch = customId.match(/^battle_presetpage_(\d+)_(\d+)$/);
  if (presetPageMatch) {
    // battle_presetpage_<page>_<userId> — the generic owner check above already locked the executor
    const bd = getBattle(userId);
    if (!bd) return interaction.reply({ content: 'Not registered.', ephemeral: true });
    const { embed, components } = buildPresetPanel(bd.b, userId, parseInt(presetPageMatch[1], 10) || 1, userId);
    return interaction.update({ embeds: [embed], components });
  }

  // battle_help_<page>_<userId> — same pattern: page before userId
  const helpPageMatch = customId.match(/^battle_help_(\d+)_(\d+)$/);
  if (helpPageMatch) {
    const { embed, components } = buildHelpPage(parseInt(helpPageMatch[1], 10) || 1, userId);
    return interaction.update({ embeds: [embed], components });
  }

  return interaction.deferUpdate();
}

async function handleBattleLb(context, subArgs) {
  // Args: [all] [warrior|mage] in ANY order — e.g. `ky lb battle mage all` = global mage board.
  const args = (subArgs || []).map((a) => String(a).toLowerCase());
  const isAll = args.includes('all');
  let classFilter = null;
  for (const a of args) {
    if (a === 'all') continue;
    if (Object.hasOwn(CLASSES, a)) { classFilter = a; continue; }
    return context.reply({ content: 'Usage: `ky lb battle [all] [class]` — `all` = global scope, class name = per-class board. Combine freely: `ky lb battle mage all`.' });
  }
  let memberIds = null;
  let scopeLabel = 'Global';
  if (!isAll && context.guild) {
    try {
      const members = await context.guild.members.fetch({ limit: 1000 });
      memberIds = new Set(members.keys());
      scopeLabel = 'Server';
    } catch { /* fallback to global */ }
  }
  const board = battle.getBattleLeaderboard(10, memberIds, classFilter);
  if (!board.length) return context.reply({ content: 'No characters yet. Be the first — `ky battle`!' });
  const lines = board.map((p, i) => {
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `**${i + 1}.**`;
    const rawName = p.username || 'Unknown';
    const displayName = rawName.length > 16 ? [...rawName].slice(0, 15).join('') + '…' : rawName;
    const c = p.cosmetics || {};
    const titleItem = c.title ? getItem(c.title) : null;
    const badgeItem = c.badge ? getItem(c.badge) : null;
    const prefix = titleItem ? `[${(titleItem.emoji && titleItem.emoji !== '\u{1F3F7}️') ? titleItem.emoji + ' ' : ''}${titleItem.effect.value}] ` : '';
    const suffix = badgeItem ? ` ${badgeItem.effect.value}` : '';
    const className = CLASSES[p.charClass] ? CLASSES[p.charClass].name : (p.charClass.charAt(0).toUpperCase() + p.charClass.slice(1));
    const clsEmoji = CLASSES[p.charClass] ? CLASSES[p.charClass].emoji : '';
    return `${medal} ${prefix}**${displayName}**${suffix} — 🏰 ${p.bestDepth} · Lv.${p.charLevel} ${className} ${clsEmoji}`;
  });
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(`🏆 Battle Leaderboard — ${scopeLabel}${classFilter ? ` · ${CLASSES[classFilter].emoji} ${CLASSES[classFilter].name}` : ''}`)
    .setDescription(lines.join('\n'))
    .setFooter({ text: `🏰 = best floor depth · ky lb battle [all] [class]${isAll ? ' — global' : ' — add "all" for global'}` })
    .setTimestamp();
  return context.reply({ embeds: [embed] });
}


// Select menus: battle_gearsel_<targetId>_<viewerId> — slot filter on ky gear (executor-locked)
async function handleSelectMenu(interaction) {
  const customId = interaction.customId || '';
  if (customId.startsWith('battle_gearsel_')) {
    const parts = customId.split('_'); // battle, gearsel, targetId, viewerId
    if (parts.length < 4) return interaction.deferUpdate();
    const targetId = parts[2];
    const viewerId = parts[3];
    if (interaction.user.id !== viewerId)
      return interaction.reply({ content: "This isn't your gear panel — run `ky gear` yourself.", ephemeral: true });
    const slot = (interaction.values && interaction.values[0]) || 'all';
    const targetName = (economy.getUser(targetId) || {}).username || targetId;
    const { embed, components } = renderGearList(targetId, targetName, 1, viewerId, slot);
    return interaction.update({ embeds: [embed], components });
  }
  return interaction.deferUpdate();
}

module.exports = {
  attachSubcommands, handleButton, handleSelectMenu,
  handleBattle, handleBattleHelp, handleBattleLb, handleEnd, handleName, handleCharacter, handleBag, handleGear, handleSell, handleSellGear, handleBuyGear, handleEquip, handleUnequip, handleShopEquipment,
  handlePvp, handleChangeClass, handleSwitchClass, handlePreset,
  getKryptonite,
};
