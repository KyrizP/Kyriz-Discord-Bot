# Kyriz — Personal Assistant Discord Bot

A personal Discord bot with auto-reply, economy system, and games.

---

## Features

- Auto-Reply
- Economy System (Kryztal currency, leveling, XP)
- Blackjack
- Wallet, Daily Rewards, Transfers
- Leaderboard (Server / Global)

---

## Setup Guide

### 1. Create Bot in Discord Developer Portal

1. Open **[discord.com/developers/applications](https://discord.com/developers/applications)**
2. Login with your Discord account
3. Click **"New Application"** > name it **Kyriz** > **"Create"**
4. Go to **"Bot"** in the sidebar
5. Click **"Reset Token"** > **"Yes, do it!"** > **"Copy"**

> **WARNING:** Never share your bot token with anyone.

### Enable Intents

Still on the **Bot** page, scroll to **Privileged Gateway Intents** and enable:

- **MESSAGE CONTENT INTENT** (required — for reading messages and prefix commands)
- **SERVER MEMBERS INTENT** (required — for server leaderboard filtering)

Click **"Save Changes"**

---

### 2. Get Bot Token & Client ID

- **Bot Token:** Already copied from step 1
- **Client ID:** Go to **"General Information"** > copy **"Application ID"**

---

### 3. Get Discord User ID (for Superadmin)

1. Open Discord > **Settings** > **Advanced** > enable **"Developer Mode"**
2. Right-click your profile > **"Copy User ID"**

---

### 4. Setup Project

Requires **Node.js 18+**. Check with:

```bash
node --version
```

---

### 5. Fill .env File

Open `.env` in the `discord-bot/` folder:

```env
DISCORD_TOKEN=paste_bot_token_here
CLIENT_ID=paste_client_id_here
SUPERADMIN_ID=paste_your_user_id_here
```

> No quotes, no spaces around `=`

---

### 6. Install Dependencies

```bash
cd discord-bot
npm install
```

---

### 7. Register Slash Commands

```bash
npm run deploy
```

> Run this again whenever you change command structure.

---

### 8. Invite Bot to Server

1. Go to **OAuth2** in Developer Portal
2. Under **SCOPES**, check: `bot`, `applications.commands`
3. Under **BOT PERMISSIONS**, check: `Send Messages`, `Read Message History`, `Use Slash Commands`
4. Copy the generated URL and open it in browser
5. Select your server > **"Authorize"**

---

### 9. Run Bot

```bash
npm start
```

---

## Commands

### Auto-Reply (Admin only)

| Command | Function |
|---------|----------|
| `/kyriz autoreply add` | Add an auto-reply |
| `/kyriz autoreply remove` | Remove an auto-reply |
| `/kyriz autoreply edit` | Edit an auto-reply |
| `/kyriz autoreply list` | View all auto-replies |

### User Management (Superadmin only)

| Command | Function |
|---------|----------|
| `/kyriz user add` | Grant config access |
| `/kyriz user remove` | Revoke config access |
| `/kyriz user list` | View authorized users |

### Game & Economy

All commands support both slash (`/kyriz`) and prefix (`ky`).

| Slash Command | Prefix | Function |
|---------------|--------|----------|
| `/kyriz blackjack [bet]` | `ky bj [bet]` | Play Blackjack |
| `/kyriz wallet` | `ky wallet` | Check balance and stats |
| `/kyriz daily` | `ky daily` | Claim daily reward (resets 00:00 WIB) |
| `/kyriz transfer @user amount` | `ky transfer @user amount` | Send Kryztal to another user |
| `/kyriz leaderboard` | `ky lb` | Server top 10 |
| `/kyriz leaderboard scope:all` | `ky lb all` | Global top 10 |
| `/kyriz help` | `ky help` | View available commands |

---

## File Structure

```
discord-bot/
├── index.js                  # Entry point
├── commands/
│   ├── autoreply.js          # /kyriz autoreply commands
│   ├── user.js               # /kyriz user commands
│   └── game.js               # Blackjack, economy, leaderboard
├── handlers/
│   └── autoReply.js          # Auto-reply logic
├── utils/
│   ├── dataManager.js        # Read/write JSON data
│   ├── permissionCheck.js    # User access check
│   ├── economyManager.js     # Economy, XP, leveling
│   └── cardDeck.js           # Card deck and Blackjack mechanics
├── data/
│   ├── replies.json          # Auto-reply config
│   ├── users.json            # Authorized users
│   └── economy.json          # Player data (auto-generated)
├── deploy-commands.js        # Register slash commands
├── package.json
├── .env                      # Token & config (DO NOT share)
├── .gitignore
└── README.md
```

---

## FAQ

**Q: Slash commands not showing in Discord?**
A: Run `npm run deploy` again. Global commands can take up to 1 hour to appear.

**Q: Bot online but not replying?**
A: Make sure **MESSAGE CONTENT INTENT** is enabled in Developer Portal > Bot.

**Q: Leaderboard shows global instead of server?**
A: Enable **SERVER MEMBERS INTENT** in Developer Portal > Bot.
