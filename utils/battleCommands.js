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
const abyss = require('./abyssManager');
const { ABYSS_FLOORS, BOSS_DIALOGUES, STAR_THRESHOLDS, ABYSS_MILESTONES } = require('./abyssConfig');
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
    case 'rupture': return `Attacks ignore ${v} of target's DEF/MDEF`; // Abyssal Edge only — never rolls from boxes
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
  if (abyss.isInAbyssFight(userId)) {
    return context.reply({ content: 'Finish your Abyss fight first (`ky battle abyss`).' }); // E10
  }
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
  battlePanels.set(userId, msg);
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
        '🌌 **ABYSS TOWER** — `ky battle abyss`\n' +
        '10 unique bosses · turn-based (you pick skills) · floors unlock in order · free entry & retry\n' +
        'Rewards **1× per floor, forever** — replays improve stars only · ⭐⭐⭐ = ≤18 turns + HP ≥50%\n' +
        '⚠️ Recommended class & level are a **hint** — gear matters (epic hits a wall at Floor 3).\n\n' +
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
    // Close the delve panel this run belongs to — its buttons must not outlive the run
    // (stale panels stayed clickable and would control the NEXT run from old messages).
    const panel = battlePanels.get(userId);
    if (panel) {
      battlePanels.delete(userId);
      try { await panel.edit({ embeds: [infoEmbed(uname(context, userId), '⚔️ Run ended via `ky end` — this panel is closed.')], components: [] }); } catch {}
    }
    return context.reply({ embeds: [extractEmbed(uname(context, userId), res)] });
  }
  // PvP forfeit (works any time — your turn or not)
  for (const [fightId, f] of pvp.activePvpFights) {
    if (!f.over && (f.p1.id === userId || f.p2.id === userId)) {
      const res = pvp.forfeitManual(fightId, userId);
      if (res.ok) { _pvpFinish(fightId, f); return context.reply({ embeds: [infoEmbed(uname(context, userId), 'You forfeited the duel.')] }); }
    }
  }
  // Abyss fight: `ky end` = flee the tower (R-contract parity with delve/PvP — same
  // mental model: one command ends whatever you're in). No rewards, no penalty.
  if (abyss.isInAbyssFight(userId)) {
    const st = abyssPanels.get(userId);
    const fight = abyss.getAbyssFight(userId);
    if (fight && fight.over) {
      // race window: the killing blow already landed and the victory/defeat panel is
      // mid-render (~3s animation). Do NOT claim a flee — the real result owns the panel.
      return context.reply({ content: 'Your Abyss fight is already ending — check the panel for the result.' });
    }
    if (fight) {
      fight.over = true; fight.winner = 'boss'; fight.forfeit = true;
      if (st) { try { await st.msg.edit({ embeds: [infoEmbed(uname(context, userId), '🚪 You fled the Abyss via `ky end`. No rewards, no penalty.')], components: [] }); } catch {} }
      abyss.endAbyssFight(userId);
      if (st) abyssPanels.delete(userId);
    }
    return context.reply({ embeds: [infoEmbed(uname(context, userId), '🚪 You fled the Abyss. The tower waits for your return.')] });
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
  // Abyss progress (account-level like PvP/Kryptonite): highest cleared + stars
  const abyssData = (b.abyss && Array.isArray(b.abyss.stars)) ? b.abyss : { stars: Array(10).fill(0) };
  let abyssHighest = 0;
  for (let i = 0; i < abyssData.stars.length; i++) if (abyssData.stars[i] > 0) abyssHighest = i + 1;
  const abyssStars = abyssData.stars.reduce((a, x) => a + x, 0);
  const abyssFloorLabel = abyssHighest > 0 ? String(abyssHighest) : '—';
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
  const passLineList = Object.entries(passSum)
    .filter(([id, v]) => v > 0 && PASSIVES[id])
    .map(([id, v]) => {
      if (id === 'evasion' && baseEva > 0) return `${PASSIVES[id].emoji} ${PASSIVES[id].name} ${effEva}${PASSIVES[id].unit}${effEva >= EVA_TOTAL_CAP ? ' *(MAX)*' : ''}`;
      if (id === 'rupture') return `${PASSIVES[id].emoji} ${PASSIVES[id].name} ${v}${PASSIVES[id].unit} — attacks ignore ${v}${PASSIVES[id].unit} of target's DEF/MDEF`; // Abyss Edge: inline desc (new/foreign passive, spec §9.1)
      return `${PASSIVES[id].emoji} ${PASSIVES[id].name} ${v}${PASSIVES[id].unit}${(CAPS[id] && passRaw[id] > v) ? ' *(MAX)*' : ''}`;
    });
  // Rogue class evasion is ALWAYS active in combat — it must be listed even when no gear
  // passive exists (full non-evasion gear used to hide the base 8% entirely).
  if (baseEva > 0 && !passSum.evasion) passLineList.push(`🌀 Evasion ${effEva}% *(class)*`);
  const passLines = passLineList.join('\n');
  let passSection = '';
  if (passLines) passSection = `\n\n**✨ Active Passives:**\n${passLines}`;
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
      `⚔️ PvP: **${b.pvpWins || 0}W/${b.pvpLosses || 0}L**${((b.pvpWins || 0) + (b.pvpLosses || 0)) > 0 ? ` (${Math.round((b.pvpWins || 0) / ((b.pvpWins || 0) + (b.pvpLosses || 0)) * 100)}% win rate)` : ''}\n` +
      `🌌 Abyss: **Floor ${abyssFloorLabel} · ${abyssStars}/30 ⭐**\n\n` +
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
  if (abyss.isInAbyssFight(userId)) return context.reply({ content: 'Finish your Abyss fight first (`ky battle abyss`).' }); // E4
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
      .map(([id, v]) => {
        if (id === 'rupture') return `${PASSIVES[id].emoji} ${PASSIVES[id].name} ${v}${PASSIVES[id].unit} — attacks ignore ${v}${PASSIVES[id].unit} of target's DEF/MDEF`; // Abyss Edge: inline desc (matches ky char)
        return `${PASSIVES[id].emoji} ${PASSIVES[id].name} ${v}${PASSIVES[id].unit}${(CAPS[id] && passRaw[id] > v) ? ' *(MAX)*' : ''}`;
      })
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
  if (abyss.isInAbyssFight(userId)) return context.reply({ content: 'Finish your Abyss fight first (`ky battle abyss`).' }); // E4 — no preset save/load mid-fight
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
    if (!p.ranges) continue; // non-gacha passives (🕳️ Rupture — Abyssal Edge only, never rolls from boxes)
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
// userId -> live DELVE panel message. Tracked so `ky end` (a text command, no button context)
// can close the panel it belongs to — otherwise the old panel keeps working buttons forever
// and, after a NEW run starts, stale panels control the new run from old messages.
const battlePanels = new Map();
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
  if (battle.hasActiveRun(userId) || pvp.isInFight(userId) || abyss.isInAbyssFight(userId))
    return context.reply({ content: 'Finish your current battle/duel first.' });
  if (battle.hasActiveRun(targetId) || pvp.isInFight(targetId) || abyss.isInAbyssFight(targetId))
    return context.reply({ content: 'That player is busy right now.' }); // E12 — target mid-Abyss
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
    if (battle.hasActiveRun(aId) || battle.hasActiveRun(bId) || pvp.isInFight(aId) || pvp.isInFight(bId)
        || abyss.isInAbyssFight(aId) || abyss.isInAbyssFight(bId)) // E11 — mutual lock with Abyss
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

// ---------- ABYSS TOWER (`ky battle abyss`) — turn-based boss fights (spec 2026-08-19) ----------
const ABYSS_COLOR = 0x7c3aed;
const ABYSS_ENTRY_MS = 60_000;   // floor-select panel auto-flee (does NOT reset on selection — anti-stall)
const ABYSS_RESULT_MS = 120_000; // result panel auto-close: buttons die, embed becomes plain progress summary
const ABYSS_AFK_MS = 120_000;    // per player turn — boss fights need thinking time (spec §5.2)
const N_FLOORS = ABYSS_FLOORS.length;
// userId -> { timer, msg, floor } — the entry select+confirm flow (60s)
const abyssEntryStates = new Map();
// userId -> { msg, username } — the live fight panel (AFK/timeout callbacks edit it)
const abyssPanels = new Map();
const abyssAfkTimers = new Map(); // userId -> setTimeout handle
const abyssResultTimers = new Map(); // userId -> result-panel auto-close handle
function armAbyssResultTimer(userId, msg, username) {
  clearAbyssResultTimer(userId);
  const t = setTimeout(async () => {
    abyssResultTimers.delete(userId);
    try { await msg.edit({ embeds: [abyssProgressEmbed(username || 'Player', userId)], components: [] }); } catch { /* message gone */ }
  }, ABYSS_RESULT_MS);
  abyssResultTimers.set(userId, t);
}
function clearAbyssResultTimer(userId) {
  const t = abyssResultTimers.get(userId);
  if (t) { clearTimeout(t); abyssResultTimers.delete(userId); }
}

function clearAbyssAfk(userId) {
  const t = abyssAfkTimers.get(userId);
  if (t) { clearTimeout(t); abyssAfkTimers.delete(userId); }
}
function armAbyssAfk(userId) {
  clearAbyssAfk(userId);
  const t = setTimeout(() => onAbyssAfk(userId), ABYSS_AFK_MS);
  abyssAfkTimers.set(userId, t);
  const f = abyss.getAbyssFight(userId);
  if (f) f.afkTimer = t; // endAbyssFight clears this too (double-safe)
}
// AFK = auto-LOSS (spec §5.2): 2 min without a skill pick on the player's turn.
async function onAbyssAfk(userId) {
  abyssAfkTimers.delete(userId);
  const fight = abyss.getAbyssFight(userId);
  if (!fight || fight.over || fight.awaiting !== 'player') return;
  const st = abyssPanels.get(userId) || {};
  _abyssFinish(st.msg, fight, st.username || ((economy.getUser(userId) || {}).username || 'Player'), { afk: true });
}

// ----- static render helpers (pure — config -> text) -----
function abyssMechanicText(m) {
  if (!m) return null;
  const parts = [];
  if (m.shield) parts.push(`🛡️ **SHIELD** — every ${m.shield.every} turns: barrier absorbing ${Math.round(m.shield.pct * 100)}% max HP`);
  if (m.enrage) parts.push(`🔥 **ENRAGE** — every ${m.enrage.every} turns: ATK +${Math.round(m.enrage.pct * 100)}% (stacking)`);
  if (m.regen) parts.push(`💚 **REGEN** — every ${m.regen.every} turns: heals ${Math.round(m.regen.pct * 100)}% max HP`);
  if (m.counter) parts.push(`⚡ **COUNTER** — you use a CD skill: ${m.counter.chance}% chance it strikes back for ${m.counter.mult}×`);
  if (m.phaseShift) parts.push(`🌑 **PHASE SHIFT** — at ${Math.round(m.phaseShift.at * 100)}% HP: DEF↔MDEF swap + guaranteed stun`);
  if (m.frostAura) parts.push(`🧊 **FROST AURA** — permanent: your physical damage −${Math.round(m.frostAura.physReduction * 100)}%`);
  if (m.swarm) parts.push(`👥 **SWARM** — every ${m.swarm.every} turns: spawns a drone (max ${m.swarm.max}) that hits you on each of its turns for ${Math.round(m.swarm.droneAtkPct * 100)}% boss ATK; untargetable, expires after ${m.swarm.droneTtl} turns`);
  if (m.darkAdapt) parts.push(`🌑 **DARK ADAPTATION** — every ${m.darkAdapt.every} turns: ATK/MATK +${Math.round(m.darkAdapt.pct * 100)}% (stacking)${m.darkAdapt.antiHeal ? `\n🕳️ **SHADOW DRAIN** — your lifesteal −${m.darkAdapt.antiHeal}%, permanent from round 1` : ''}`);
  if (m.p1 && m.p2 && m.p3) parts.push(
    `💀 **THREE PHASES**\n` +
    `> 🩸 **Vampiric** (100–60%): heals ${Math.round((m.p1.lifesteal || 0) * 100)}% of damage dealt to you${m.p1.enrage ? ` · every ${m.p1.enrage.every} turns: ATK +${Math.round(m.p1.enrage.pct * 100)}% (stacking)` : ''}\n` +
    `> ⚡ **Punish** (60–30%): ${m.p2.counter ? `${m.p2.counter.chance}% counter for ${m.p2.counter.mult}× when you use a CD skill${m.p2.counter.antiHeal ? ` · wounds: anti-heal −${m.p2.counter.antiHeal.reduction}% / ${m.p2.counter.antiHeal.turns}t` : ''}` : 'grows more aggressive'}\n` +
    `> 💀 **Berserk** (30–0%): ATK/MATK ×${m.p3.berserk.atk}${m.p3.antiHeal ? ` + anti-heal (lifesteal −${m.p3.antiHeal}%)` : ''}`
  );
  return parts.length ? parts.join('\n') : null;
}
function abyssSkillText(sk) {
  const type = sk.type === 'magic' ? '🔮 magic' : sk.type === 'mixed' ? '⚔️🔮 mixed' : '⚔️ physical';
  const fx = [];
  if (sk.burn) fx.push(`🔥 burn ${sk.burn.pct}% / ${sk.burn.turns}t`);
  if (sk.poison) fx.push(`🧪 poison ${sk.poison.pct}% / ${sk.poison.turns}t`);
  if (sk.cc) { const lbl = sk.cc.kind === 'frozen' ? '❄️' : sk.cc.kind === 'rooted' ? '🌿' : '🪢'; fx.push(`${lbl} ${sk.cc.chance}% ${sk.cc.kind || 'stun'}`); }
  if (sk.heal) fx.push(`💚 heal ${Math.round(sk.heal * 100)}%`);
  if (sk.antiHeal) fx.push(`🚫 anti-heal −${sk.antiHeal.reduction}% / ${sk.antiHeal.turns}t`);
  if (sk.pierceEva) fx.push('💨 pierces evasion');
  if (sk.parry) fx.push('🛡️ parry next hit');
  if (sk.dodge) fx.push('🗡️ 2 dodge charges');
  if (sk.buff) fx.push('⚔️ self-buff');
  return `**${sk.name}** — ${sk.mult}× ${type}${sk.cd ? ` · CD ${sk.cd}` : ''}${fx.length ? ` _(${fx.join(' · ')})_` : ''}`;
}
function abyssArchetype(fl) {
  if (fl.mirror) return '🪞 **Mirror** — copies your stats, your class skills, and half of your gear passives';
  const types = new Set((fl.skills || []).map((s) => s.type));
  const dmg = types.has('physical') && types.has('magic') ? 'hybrid damage' : types.has('magic') ? 'magic damage' : 'physical damage';
  const m = fl.mechanic || {};
  let tag = '';
  if (m.shield) tag = ' · fortified';
  else if (m.regen) tag = ' · self-sustaining';
  else if (m.enrage || m.darkAdapt || (m.p1 && m.p1.enrage)) tag = ' · scales over time';
  else if (m.swarm) tag = ' · swarm summoner';
  else if (m.frostAura) tag = ' · anti-physical';
  else if (m.counter || m.p2) tag = ' · punishes cooldowns';
  else if (m.phaseShift) tag = ' · shapeshifter';
  const crit = fl.crit > 0 ? ` · crit ${Math.round(fl.crit * 100)}% ×${fl.critMult}` : '';
  return `Boss — ${dmg}${tag}${crit}`;
}
// Archetype accent color for floor-scoped embeds (boss info / intro / fight panel).
// Same branch priority as abyssArchetype: tank=blue, sustain=green, aggro=red, chaos=purple;
// no mechanic = tower purple. Outcome embeds keep semantic green/red.
function abyssColor(fl) {
  const m = (fl && fl.mechanic) || {};
  if (m.shield) return 0x3498db;                                                      // tank — F2
  if (m.regen) return 0x57f287;                                                       // sustain — F4
  if (m.enrage || m.darkAdapt || (m.p1 && m.p1.enrage)) return 0xed4245;              // aggro — F3/F9/F10
  if (m.counter || m.p2 || m.phaseShift || m.frostAura || m.swarm) return 0x9b59b6;   // chaos — F5–F8
  return ABYSS_COLOR;                                                                // balanced — F1
}
function abyssFloorLabel(i) { const fl = ABYSS_FLOORS[i]; return `Floor ${fl.id} — ${fl.emoji} ${fl.name}`; }
// CLEARED floors + the next uncompleted one (spec §5.1) — anything beyond stays hidden.
function abyssEntryOptions(progress) {
  const opts = [];
  for (let i = 0; i <= Math.min(progress.highestFloor, N_FLOORS - 1); i++) {
    const isNext = i === progress.highestFloor; // first uncompleted floor (false when ALL are cleared)
    opts.push({
      label: `${abyssFloorLabel(i)}${isNext ? ' 🔒 NEW' : ''}`.slice(0, 100),
      value: String(i),
      description: isNext ? 'Unlocked — not yet cleared' : `Cleared — best ${'⭐'.repeat(progress.stars[i]) || '(no stars)'}`,
    });
  }
  return opts;
}
function abyssSelectRow(userId, progress) {
  return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
    .setCustomId(`battle_abysssel_${userId}`)
    .setPlaceholder('Choose a floor…')
    .addOptions(abyssEntryOptions(progress)));
}
function abyssEntryRow(userId, enterEnabled) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`battle_abyss_enter_${userId}`).setLabel('⚔️ Enter').setStyle(ButtonStyle.Success).setDisabled(!enterEnabled),
    new ButtonBuilder().setCustomId(`battle_abyss_flee_${userId}`).setLabel('🚪 Flee').setStyle(ButtonStyle.Secondary),
  );
}
// Supersede a pending entry/dossier panel (owner round 7: stale panels must die VISIBLY —
// kill the 60s timer, drop the state, and strip the buttons so a stale Enter/Flee click
// can't happen; any click racing the edit still gets an ephemeral note, not silence).
function retireAbyssEntry(userId) {
  const st = abyssEntryStates.get(userId);
  if (!st) return;
  clearTimeout(st.timer);
  abyssEntryStates.delete(userId);
  try { st.msg.edit({ components: [] }); } catch { /* message gone — nothing to do */ }
}
// Dossier actions (post-clear Next/Retry preview + floor browse): Enter / Progress / Flee
function abyssPreviewRow(userId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`battle_abyss_enter_${userId}`).setLabel('⚔️ Enter').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`battle_abyss_prog_${userId}`).setLabel('📋 Progress').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`battle_abyss_flee_${userId}`).setLabel('🚪 Flee').setStyle(ButtonStyle.Secondary),
  );
}
function abyssWelcomeEmbed(username, progress) {
  return new EmbedBuilder()
    .setAuthor({ name: `${username}'s abyss` })
    .setColor(ABYSS_COLOR)
    .setTitle('🌌 ABYSS TOWER')
    .setDescription(
      'Ten bosses guard the climb. Each falls once — but stars are forever.\n\n' +
      `🏆 Highest floor cleared: **${progress.highestFloor}/${N_FLOORS}** · ⭐ Stars: **${progress.totalStars}/${N_FLOORS * 3}**\n\n` +
      'Free entry · full HP every floor · turn-based, 30-turn limit.\n' +
      '_The tower auto-rejects the idle: flee in 60s._'
    )
    .setTimestamp();
}
// Boss info (spec §5.1 step 2). Shows recLevel ONLY — never the tuned level, never gear expectations (discovery by design).
function abyssBossInfoEmbed(username, fl) {
  const dlg = BOSS_DIALOGUES[fl.id] || {};
  const rec = fl.recClass ? `${CLASSES[fl.recClass].emoji} ${CLASSES[fl.recClass].name}` : 'Any class';
  const skills = fl.mirror
    ? ['🪞 Copies **your class skills** at full power — parries, buffs and dodges work for it too.']
    : (fl.skills || []).map(abyssSkillText);
  const mech = abyssMechanicText(fl.mechanic) || '_No special mechanic — a fair fight._';
  const elusive = fl.bossEvasion ? `\n\n💨 **ELUSIVE** — ${fl.bossEvasion}% chance to dodge your attacks (pierce-evasion ults ignore it)` : '';
  return new EmbedBuilder()
    .setAuthor({ name: `${username}'s abyss` })
    .setColor(abyssColor(fl))
    .setTitle(`🌌 Floor ${fl.id} — ${fl.emoji} ${fl.name}`)
    .setDescription(
      `${abyssArchetype(fl)}\n\n` +
      `**Recommended:** ${rec} · Lv ${fl.recLevel}\n\n` +
      `**Skills:**\n${skills.join('\n')}\n\n` +
      `**Mechanic:**\n${mech}${elusive}\n\n` +
      `**Stars:**\n⭐⭐⭐ ≤${STAR_THRESHOLDS.three.turns} turns + HP ≥${STAR_THRESHOLDS.three.hpPct}%\n⭐⭐ ≤${STAR_THRESHOLDS.two.turns} turns\n⭐ any clear\n\n` +
      `> _"${dlg.intro || '…'}"_`
    )
    .setTimestamp();
}
function abyssIntroEmbed(username, fl) {
  const dlg = BOSS_DIALOGUES[fl.id] || {};
  return new EmbedBuilder()
    .setAuthor({ name: `${username}'s abyss` })
    .setColor(abyssColor(fl))
    .setTitle(`🌌 Floor ${fl.id} — ${fl.emoji} ${fl.name}`)
    .setDescription(`> _"${dlg.intro || '…'}"_\n\nThe gate slams shut behind you…`)
    .setTimestamp();
}

// ----- fight panel -----
function abyssEffectTags(side) {
  const t = [];
  if (side.burn && side.burn.turns > 0) t.push(`🔥 Burn ${side.burn.turns}t`);
  if (side.poison && side.poison.turns > 0) t.push(`🧪 Poison ${side.poison.turns}t`);
  if (side.parry > 0) t.push('🛡️ Parry ready');
  if (side.dodge > 0) t.push(`🗡️ ${side.dodge} dodge`);
  if (side.buff && side.buff.turns > 0) t.push(`⚔️ ATK +${side.buff.atkPct}% (${side.buff.turns}t)`);
  if (side.cc > 0) t.push(side.ccKind === 'frozen' ? '❄️ Frozen' : side.ccKind === 'rooted' ? '🌿 Rooted' : '🪢 Stunned');
  return t;
}
function abyssFightEmbed(fight, note) {
  const fl = fight.floor, p = fight.player, b = fight.boss;
  const sep = '─'.repeat(28);
  const bossFx = abyssEffectTags(b);
  if (b.shield > 0) bossFx.unshift(`🛡️ Shield ${b.shield.toLocaleString()}`);
  if (b.atkMultStack > 1) bossFx.push(`🔥 Enraged +${Math.round((b.atkMultStack - 1) * 100)}%`);
  if (b.drones.length) bossFx.push(`👥 ${b.drones.length} drone(s)`);
  if (fl.mechanic && fl.mechanic.p1 && fl.mechanic.p2) bossFx.push(`💀 Phase ${b.phase}`);
  else if (fl.mechanic && fl.mechanic.phaseShift && b.phase > 1) bossFx.push('💀 Phase 2');
  const playerFx = abyssEffectTags(p);
  if (p.antiHeal && p.antiHeal.turns > 0) playerFx.push(`🚫 Anti-heal −${p.antiHeal.reduction}%`);
  const fx = (arr) => (arr.length ? `\n⚙️ ${arr.join(' · ')}` : '');
  const turnN = fight.over ? fight.turnCount : Math.min(fight.turnCount + 1, abyss.TURN_LIMIT);
  const head = fight.over ? '🏁 Fight Over'
    : fight.awaiting === 'player' ? '🔄 **Your turn — pick a skill**'
    : '💨 The boss is acting…';
  const log = (note || '').trim();
  return new EmbedBuilder()
    .setAuthor({ name: `${abyssPanels.get(fight.userId)?.username || 'Player'}'s abyss` })
    .setColor(abyssColor(fl))
    .setTitle(`🌌 Floor ${fl.id}: ${fl.emoji} ${fl.name} — Turn ${turnN}/${abyss.TURN_LIMIT}`)
    .setDescription(
      `**${fl.emoji} ${fl.name}**\n❤️ ${hpBar20(b.hp, b.hpMax)} ${Math.max(0, b.hp)}/${b.hpMax}${fx(bossFx)}\n${sep}\n` +
      `**🛡️ You**\n❤️ ${hpBar20(p.hp, p.hpMax)} ${Math.max(0, p.hp)}/${p.hpMax}${fx(playerFx)}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n${log ? `${log}\n` : ''}${head}`
    )
    .setTimestamp();
}
// Player skill buttons — CD state read AFTER turn resolution (post-tick, the panel
// renders once the boss phase completes). Disabled while the boss acts.
function abyssSkillRow(fight) {
  const row = new ActionRowBuilder();
  const myTurn = fight.awaiting === 'player' && !fight.over;
  for (const sk of fight.player.skills) {
    const cd = fight.player.cdLeft[sk.id] || 0;
    row.addComponents(new ButtonBuilder()
      .setCustomId(`battle_abyss_skill_${sk.id}_${fight.userId}`)
      .setLabel(`${sk.name}${cd > 0 ? ` (CD:${cd})` : ''}`)
      .setStyle(sk.cd > 0 ? ButtonStyle.Secondary : ButtonStyle.Primary)
      .setDisabled(!myTurn || cd > 0));
  }
  return [row];
}
// Engine events -> English log lines (PvP eventStr style).
function abyssEventLog(events) {
  return (events || []).map((e) => {
    const mine = e.actor === 'player';
    switch (e.type) {
      case 'hit': {
        if (e.parried) return `${e.crit ? '💥 CRIT! ' : ''}🛡️ ${mine ? 'Boss parries' : 'You parry'} ${e.skill} — ${e.dmg}`;
        if (e.dodged) return e.dmg > 0 ? `🗡️ Dodge pierced! ${e.skill} — ${e.dmg}` : '🗡️ Dodged!';
        if (e.evaded) return '💨 Evaded!';
        return `${e.crit ? '💥 CRIT! ' : ''}${mine ? '🗡️' : '☠️'} ${e.skill} — ${e.dmg}${e.absorbed ? ` (shield ate ${e.absorbed})` : ''}`;
      }
      case 'burn': return `🔥 Burn${e.target === 'boss' ? ' (boss)' : ''} — ${e.dmg}`;
      case 'poison': return `🧪 Poison${e.target === 'boss' ? ' (boss)' : ''} — ${e.dmg}`;
      case 'lifesteal': return e.target === 'boss' ? `🩸 Boss drains +${e.heal}` : `🩸 Lifesteal +${e.heal}`;
      case 'heal': return `💚 Boss heals +${e.heal}`;
      case 'cc': { const lbl = e.kind === 'frozen' ? '❄️' : e.kind === 'rooted' ? '🌿' : '🪢'; return `${lbl} ${e.skill} — ${e.kind || 'stunned'}! (next turn skipped)`; }
      case 'ccSkip': { const lbl = e.kind === 'frozen' ? '❄️' : e.kind === 'rooted' ? '🌿' : '🪢'; const k = e.kind || 'stunned'; return `${lbl} ${k.charAt(0).toUpperCase() + k.slice(1)} — turn skipped!`; }
      case 'counter': return '⚡ Counter-attack!';
      case 'antiHeal': return `🚫 Anti-heal — lifesteal −${e.reduction}% (${e.turns >= 999 ? 'permanent' : e.turns + 't'})`;
      case 'drone': return `🐝 Drone strike — ${e.dmg}`;
      case 'mechanic':
        if (e.kind === 'swarm') return `👥 Swarm — ${e.drones} drone(s) active`;
        if (e.kind === 'phaseShift') return '🌑 PHASE SHIFT — DEF↔MDEF swapped + stun!';
        if (e.kind === 'phase') return `💀 The boss enters **Phase ${e.phase}**!`;
        return '';
      default: return '';
    }
  }).filter(Boolean).join('\n');
}

// ----- results -----
function abyssResultRow(fight, won) {
  const row = new ActionRowBuilder();
  if (won && fight.floorIdx + 1 < N_FLOORS) {
    row.addComponents(new ButtonBuilder().setCustomId(`battle_abyss_next_${fight.floorIdx + 1}_${fight.userId}`).setLabel('➡️ Next Floor').setStyle(ButtonStyle.Success));
  }
  if (!won) {
    row.addComponents(new ButtonBuilder().setCustomId(`battle_abyss_retry_${fight.floorIdx}_${fight.userId}`).setLabel('🔄 Retry').setStyle(ButtonStyle.Primary));
  }
  row.addComponents(new ButtonBuilder().setCustomId(`battle_abyss_prog_${fight.userId}`).setLabel('📋 Progress').setStyle(ButtonStyle.Secondary));
  return [row];
}
function abyssVictoryEmbed(username, fl, fight, rec) {
  const dlg = BOSS_DIALOGUES[fl.id] || {};
  const rd = fight.resultData || { turns: '?', hpPct: 0 };
  const stars = rec && rec.ok ? rec.stars : 0;
  const lines = ['⭐'.repeat(stars) + '▫'.repeat(3 - stars)];
  lines.push(`Cleared in **${rd.turns}** turn(s) · HP remaining **${rd.hpPct}%**`);
  if (rec && rec.ok && rec.rewards) {
    const rw = rec.rewards;
    lines.push(`🧪 **+${rw.kryptonite.toLocaleString()}** Kryptonite (base + star bonus)`);
    if (rw.kryztal) lines.push(`💎 **+${rw.kryztal.toLocaleString()}** Kryztal milestone`);
    if (rw.drop) lines.push(`🎁 Gear drop: ${tierBadge(rw.drop.rarity)} **${rw.drop.name}** \`${rw.drop.id}\``);
    for (const t of rw.titles || []) lines.push(`🏷️ Title unlocked: **${t}**`);
  } else {
    lines.push('_First-clear rewards already claimed — replays improve stars only._');
  }
  if (rec && rec.edge) lines.push(`🌌 **${rec.edge.name}** obtained — the ${ABYSS_MILESTONES.allStars.stars}⭐ trophy weapon \`${rec.edge.id}\`!`);
  if (fight.floorIdx + 1 < N_FLOORS) lines.push(`\n🔓 **Floor ${ABYSS_FLOORS[fight.floorIdx + 1].id} — ${ABYSS_FLOORS[fight.floorIdx + 1].name}** is now unlocked.`);
  return new EmbedBuilder()
    .setAuthor({ name: `${username}'s abyss` })
    .setColor(0x57f287)
    .setTitle(`🏆 FLOOR ${fl.id} CLEARED — ${fl.emoji} ${fl.name}`)
    .setDescription(`${lines.join('\n')}\n\n> _"${dlg.victory || '…'}"_`)
    .setTimestamp();
}
function abyssDefeatEmbed(username, fl, fight, opts = {}) {
  const dlg = BOSS_DIALOGUES[fl.id] || {};
  const b = fight.boss;
  const bossPct = Math.max(0, Math.ceil((Math.max(0, b.hp) / b.hpMax) * 100));
  const turns = (fight.resultData && fight.resultData.turns) || fight.turnCount;
  const why = opts.afk
    ? '⌛ You hesitated too long (2 min AFK) — the Abyss claims the absent.'
    : fight.timeout ? '⏳ Turn limit reached — the boss outlasted you.'
    : '💀 You fell.';
  return new EmbedBuilder()
    .setAuthor({ name: `${username}'s abyss` })
    .setColor(0xed4245)
    .setTitle(`💀 DEFEAT — Floor ${fl.id}: ${fl.emoji} ${fl.name}`)
    .setDescription(
      `${why}\n\n` +
      `${fl.emoji} ${fl.name} HP remaining: **${bossPct}%** · You fell on turn **${turns}/${abyss.TURN_LIMIT}**\n\n` +
      `> _"${dlg.defeat || '…'}"_`
    )
    .setTimestamp();
}
// Progress panel — all floors, stars, reward state, Edge milestone (spec §5/D).
function abyssProgressEmbed(username, userId) {
  const prog = abyss.getAbyssProgress(userId);
  const lines = ABYSS_FLOORS.map((fl, i) => {
    const stars = '⭐'.repeat(prog.stars[i]) || '🔒';
    const reward = prog.rewarded[i] ? ' · ✓ rewarded' : '';
    return `${fl.emoji} **Floor ${fl.id} — ${fl.name}** · ${stars}${reward}`;
  });
  const edge = prog.milestones.allStars
    ? `🌌 **${ABYSS_MILESTONES.allStars.title}** — Abyssal Edge claimed`
    : `🌌 Abyssal Edge: **${prog.totalStars}/${ABYSS_MILESTONES.allStars.stars}** stars (3⭐ every floor)`;
  return new EmbedBuilder()
    .setAuthor({ name: `${username}'s abyss` })
    .setColor(ABYSS_COLOR)
    .setTitle('🌌 ABYSS TOWER — Progress')
    .setDescription(
      `${lines.join('\n')}\n\n⭐ **Total stars: ${prog.totalStars}/${N_FLOORS * 3}**\n${edge}\n\n_Climb again: \`ky battle abyss\`_`
    )
    .setTimestamp();
}

// ----- driver -----
// THE single terminal path — cleanup first, render second. Every end route (win,
// death, timeout, AFK) lands here; a leaked over-fight would lock the player out.
async function _abyssFinish(msg, fight, username, opts = {}) {
  clearAbyssAfk(fight.userId);
  abyssPanels.delete(fight.userId);
  const won = !opts.afk && fight.winner === 'player';
  let rec = null;
  if (won) rec = abyss.recordClear(fight.userId, fight.floorIdx, fight.resultData.turns, fight.resultData.hpPct);
  abyss.endAbyssFight(fight.userId);
  if (!msg) return;
  // ky end mid-animation lands here with winner='boss' from the forfeit — render the
  // flee state instead of a defeat embed overwriting the "You fled" panel (cosmetic race,
  // both terminal/no-buttons; this just keeps the message honest).
  if (fight.forfeit) {
    try { await msg.edit({ embeds: [infoEmbed(username, '🚪 You fled the Abyss. No rewards, no penalty — climb again anytime with `ky battle abyss`.')], components: [] }); } catch {}
    return;
  }
  const embed = won ? abyssVictoryEmbed(username, fight.floor, fight, rec) : abyssDefeatEmbed(username, fight.floor, fight, opts);
  try { await msg.edit({ embeds: [embed], components: abyssResultRow(fight, won) }); } catch { /* message gone — nothing to do */ }
  // Result buttons are conveniences, not state — auto-close after 2 min so no clickable
  // button outlives its fight (stale Retry/Next panels clickable forever otherwise).
  armAbyssResultTimer(fight.userId, msg, username);
}
// Boss phase animation: "preparing…" -> resolve -> result frame (spec §5.2).
async function _abyssBossPhase(msg, userId, prependLog) {
  const fight = abyss.getAbyssFight(userId);
  if (!fight || fight.over) return;
  try { await msg.edit({ embeds: [abyssFightEmbed(fight, `${prependLog ? prependLog + '\n' : ''}💨 ${fight.floor.name} is preparing an attack…`)], components: [] }); } catch {}
  await sleep(1500);
  const cur = abyss.getAbyssFight(userId);
  if (!cur || cur !== fight || fight.over) return; // ended mid-animation (AFK can't fire here, but be safe)
  const res = abyss.resolveAbyssBossTurn(userId);
  if (!res.ok) { // unreachable by construction — but NEVER strand a live fight without its AFK timer
    abyss.endAbyssFight(userId);
    try { await msg.edit({ embeds: [infoEmbed(uname({ author: { username: 'Player' } }), '⚠️ The Abyss glitched — your fight was voided. No rewards, no penalty.')], components: [] }); } catch {}
    return;
  }
  await sleep(1500);
  const cur2 = abyss.getAbyssFight(userId);
  if (res.over || !cur2 || cur2 !== fight) {
    if (fight.over) return _abyssFinish(msg, fight, (abyssPanels.get(userId) || {}).username || 'Player', res);
    return;
  }
  // Final frame shows ONLY the boss's events — the player already saw their own
  // in the previous frame (owner preference: no stacking player+boss logs together)
  const log = abyssEventLog(res.events) || '…';
  try { await msg.edit({ embeds: [abyssFightEmbed(fight, log || '…')], components: abyssSkillRow(fight) }); } catch {}
  armAbyssAfk(userId);
}
async function _abyssBeginFight(interaction, fight, username) {
  const msg = interaction.message;
  abyssPanels.set(fight.userId, { msg, username });
  try { await interaction.update({ embeds: [abyssIntroEmbed(username, fight.floor)], components: [] }); } catch {}
  await sleep(1500); // boss intro beat (spec §5.1 step 3)
  const cur = abyss.getAbyssFight(fight.userId);
  if (!cur || cur !== fight || fight.over) return;
  if (fight.awaiting === 'boss') return _abyssBossPhase(msg, fight.userId, '💨 The boss moves first!');
  try { await msg.edit({ embeds: [abyssFightEmbed(fight, '⚔️ The fight begins — your move.')], components: abyssSkillRow(fight) }); } catch {}
  armAbyssAfk(fight.userId);
}
// Entry cross-locks (spec E10/E11): delve + PvP checked HERE (abyssManager cannot
// require their managers — circular). busy reason is a ready-to-render string.
async function _abyssStartFromButton(interaction, userId, username, floorIdx) {
  let busy = null;
  if (battle.hasActiveRun(userId)) busy = 'Finish your delve first (`ky end`).';
  else if (pvp.isInFight(userId)) busy = 'Finish your duel first (`ky end`).';
  if (busy) return interaction.update({ embeds: [infoEmbed(username, busy)], components: [] });
  const start = abyss.startAbyssFight(userId, floorIdx, {});
  if (!start.ok) return interaction.update({ embeds: [infoEmbed(username, start.reason)], components: [] });
  return _abyssBeginFight(interaction, start.fight, username);
}

// ----- command entry: `ky battle abyss` -----
async function handleAbyss(context, userId, args) {
  clearAbyssResultTimer(userId); // a fresh entry panel invalidates any pending result auto-close
  args = args || [];
  if (String(args[0] || '').toLowerCase() === 'lb') return handleAbyssLb(context);
  if (abyss.isInAbyssFight(userId)) return context.reply({ content: '🌌 You are already in an Abyss fight — its panel has your skill buttons.' });
  const username = uname(context, userId);
  const bd = getBattle(userId);
  if (!bd) return context.reply({ content: 'You are not registered yet — use `ky daily` or `ky wallet` first.' });
  if (!battle.getActiveChar(bd.b)) return context.reply({ content: 'Create a character first (`ky battle`).' });
  const stale = abyssEntryStates.get(userId); // a re-run supersedes any pending entry panel
  if (stale) retireAbyssEntry(userId);
  const progress = abyss.getAbyssProgress(userId);
  const msg = await context.reply({
    embeds: [abyssWelcomeEmbed(username, progress)],
    components: [abyssSelectRow(userId, progress), abyssEntryRow(userId, false)],
    fetchReply: true,
  });
  const state = { timer: null, msg, floor: null };
  abyssEntryStates.set(userId, state);
  state.timer = setTimeout(async () => { // auto-flee (E8): buttons die with the edit
    if (abyssEntryStates.get(userId) !== state) return;
    abyssEntryStates.delete(userId);
    try { await msg.edit({ embeds: [infoEmbed(username, '🚪 You fled the Abyss — no floor chosen in 60s.')], components: [] }); } catch {}
  }, ABYSS_ENTRY_MS);
  return msg;
}
// `ky battle abyss lb` — highest floor, then total stars.
function handleAbyssLb(context) {
  const data = economy.readEconomy();
  const rows = [];
  for (const [uid, u] of Object.entries(data)) {
    if (!u || !u.battle) continue;
    const a = abyss.ensureAbyssData(u.battle);
    const totalStars = a.stars.reduce((s, x) => s + x, 0);
    let highest = 0;
    a.stars.forEach((s, i) => { if (s > 0) highest = i + 1; });
    if (highest === 0 && totalStars === 0) continue;
    rows.push({ name: u.username || uid, highest, totalStars });
  }
  if (!rows.length) return context.reply({ content: 'No one has cleared an Abyss floor yet. Be the first — `ky battle abyss`!' });
  rows.sort((x, z) => z.highest - x.highest || z.totalStars - x.totalStars);
  const lines = rows.slice(0, 10).map((r, i) => {
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `**${i + 1}.**`;
    return `${medal} **${r.name}** — 🏰 Floor ${r.highest} · ⭐ ${r.totalStars}/${N_FLOORS * 3}`;
  });
  const embed = new EmbedBuilder()
    .setColor(ABYSS_COLOR)
    .setTitle('🌌 Abyss Tower Leaderboard')
    .setDescription(lines.join('\n'))
    .setFooter({ text: 'Sorted by highest floor, then stars · ky battle abyss' })
    .setTimestamp();
  return context.reply({ embeds: [embed] });
}

// ----- abyss buttons (routed from handleButton; executor already verified) -----
async function handleAbyssButton(interaction, userId, username) {
  const customId = interaction.customId;

  if (customId.startsWith('battle_abyss_flee_')) {
    const state = abyssEntryStates.get(userId);
    if (!state || state.msg.id !== interaction.message.id) return interaction.reply({ content: '⌛ This Abyss panel expired — your newest panel (above) is the active one.', ephemeral: true }); // stale panel: visible, not silent
    clearTimeout(state.timer);
    abyssEntryStates.delete(userId);
    return interaction.update({ embeds: [infoEmbed(username, '🚪 You fled the Abyss. Come back stronger.')], components: [] });
  }

  if (customId.startsWith('battle_abyss_enter_')) {
    const state = abyssEntryStates.get(userId);
    if (!state || state.msg.id !== interaction.message.id) return interaction.reply({ content: '⌛ This Abyss panel expired — your newest panel (above) is the active one.', ephemeral: true }); // stale panel: visible, not silent
    if (state.floor == null) return interaction.deferUpdate(); // Enter enabled only after a selection — belt and braces
    clearTimeout(state.timer); // cancel the 60s timer on EVERY exit path
    abyssEntryStates.delete(userId);
    return _abyssStartFromButton(interaction, userId, username, state.floor);
  }

  if (customId.startsWith('battle_abyss_retry_') || customId.startsWith('battle_abyss_next_') || customId.startsWith('battle_abyss_prog_')) {
    clearAbyssResultTimer(userId); // panel actioned — its auto-close is no longer wanted
  }
  if (customId.startsWith('battle_abyss_retry_') || customId.startsWith('battle_abyss_next_')) {
    const parts = customId.split('_'); // battle, abyss, retry|next, <floorIdx>, <userId>
    const floorIdx = parseInt(parts[3], 10);
    if (!(floorIdx >= 0) || floorIdx >= N_FLOORS) return interaction.deferUpdate();
    // Owner UX: dossier first (same as floor pick at entry) — read the kit, then Enter/Progress/Flee.
    // Re-registers the entry state so Enter/Flee staleness guards + 60s auto-flee work unchanged.
    const gate = abyss.canEnterFloor(userId, floorIdx);
    if (!gate.ok) return interaction.update({ embeds: [infoEmbed(username, gate.reason)], components: [] });
    retireAbyssEntry(userId); // any older pending panel is superseded — buttons stripped
    const prog = abyss.getAbyssProgress(userId);
    const embed = abyssBossInfoEmbed(username, ABYSS_FLOORS[floorIdx])
      .setFooter({ text: '⚔️ Enter starts the fight · 📋 check progress · auto-flee in 60s' });
    await interaction.update({ embeds: [embed], components: [abyssSelectRow(userId, prog), abyssPreviewRow(userId)] });
    const msg = interaction.message;
    const state = { timer: null, msg, floor: floorIdx };
    abyssEntryStates.set(userId, state);
    state.timer = setTimeout(async () => { // auto-flee (E8): buttons die with the edit
      if (abyssEntryStates.get(userId) !== state) return;
      abyssEntryStates.delete(userId);
      try { await msg.edit({ embeds: [infoEmbed(username, '🚪 You fled the Abyss — no floor entered in 60s.')], components: [] }); } catch {}
    }, ABYSS_ENTRY_MS);
    return;
  }

  if (customId.startsWith('battle_abyss_prog_')) {
    const state = abyssEntryStates.get(userId); // from a dossier preview: kill its 60s timer so it can't clobber this embed
    if (state && state.msg.id === interaction.message.id) { clearTimeout(state.timer); abyssEntryStates.delete(userId); }
    return interaction.update({ embeds: [abyssProgressEmbed(username, userId)], components: [] });
  }

  if (customId.startsWith('battle_abyss_skill_')) {
    const fight = abyss.getAbyssFight(userId);
    if (!fight) return interaction.reply({ content: 'This Abyss fight has ended.', ephemeral: true });
    if (fight.over || fight.animating) return interaction.deferUpdate();
    clearAbyssAfk(userId); // close the AFK race window synchronously BEFORE any await
    const skillId = customId.split('_').slice(3, -1).join('_');
    const res = abyss.resolveAbyssPlayerTurn(userId, skillId);
    if (!res.ok) { armAbyssAfk(userId); return interaction.reply({ content: res.reason || 'Invalid action.', ephemeral: true }); }
    fight.animating = true; // UI-side double-click lock (buttons are removed, but stale messages exist)
    const st = abyssPanels.get(userId) || {};
    const msg = interaction.message;
    abyssPanels.set(userId, { msg, username: st.username || username });
    try {
      const playerLog = abyssEventLog(res.events) || '…';
      try { await interaction.deferUpdate(); } catch {}
      try { await msg.edit({ embeds: [abyssFightEmbed(fight, playerLog)], components: [] }); } catch {}
      await sleep(1500);
      const cur = abyss.getAbyssFight(userId);
      if (res.over || !cur || cur !== fight) {
        if (fight.over) return _abyssFinish(msg, fight, st.username || username, res);
        return;
      }
      await _abyssBossPhase(msg, userId, playerLog);
    } finally { fight.animating = false; }
    return;
  }

  return interaction.deferUpdate();
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
    if (abyss.isInAbyssFight(ownerId)) return interaction.update({ embeds: [infoEmbed(uname(interaction, ownerId), 'Finish your Abyss fight first (`ky battle abyss`).')], components: [] }); // E4
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

  // Abyss Tower entry/fight/result buttons (customIds end with the executor's userId)
  if (customId.startsWith('battle_abyss_')) return handleAbyssButton(interaction, userId, username);

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
  if (customId.startsWith('battle_abysssel_')) {
    // battle_abysssel_<userId> — floor picker on the Abyss entry panel
    const userId = customId.split('_')[2];
    if (interaction.user.id !== userId)
      return interaction.reply({ content: '⛔ This is not your Abyss panel.', ephemeral: true });
    const state = abyssEntryStates.get(userId);
    if (!state || state.msg.id !== interaction.message.id) return interaction.reply({ content: '⌛ This Abyss panel expired — your newest panel (above) is the active one.', ephemeral: true }); // stale panel: visible, not silent
    const floorIdx = parseInt((interaction.values || [])[0], 10);
    if (!(floorIdx >= 0) || floorIdx >= N_FLOORS) return interaction.deferUpdate();
    const gate = abyss.canEnterFloor(userId, floorIdx);
    if (!gate.ok) return interaction.update({ embeds: [infoEmbed(uname(interaction, userId), gate.reason)], components: [] });
    state.floor = floorIdx; // timer does NOT reset — it runs out its remaining time (anti-stall)
    const prog = abyss.getAbyssProgress(userId);
    return interaction.update({
      embeds: [abyssBossInfoEmbed(uname(interaction, userId), ABYSS_FLOORS[floorIdx])],
      components: [abyssSelectRow(userId, prog), abyssPreviewRow(userId)],
    });
  }
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
  handlePvp, handleChangeClass, handleSwitchClass, handlePreset, handleAbyss,
  getKryptonite,
};
