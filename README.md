# 🤖 Kyriz — Personal Assistant Discord Bot

Bot Discord personal dengan fitur auto-reply yang bisa dikonfigurasi langsung dari Discord menggunakan slash commands.

---

## 📋 Daftar Isi

1. [Buat Bot di Discord Developer Portal](#1--buat-bot-di-discord-developer-portal)
2. [Dapatkan Bot Token & Client ID](#2--dapatkan-bot-token--client-id)
3. [Dapatkan Discord User ID](#3--dapatkan-discord-user-id-untuk-superadmin)
4. [Setup Project](#4--setup-project)
5. [Isi File .env](#5--isi-file-env)
6. [Install Dependencies](#6--install-dependencies)
7. [Register Slash Commands](#7--register-slash-commands)
8. [Invite Bot ke Server](#8--invite-bot-ke-server)
9. [Jalankan Bot](#9--jalankan-bot)
10. [Cara Pakai Commands](#10--cara-pakai-commands)
11. [Deploy ke Railway (Online 24/7)](#11--deploy-ke-railway-gratis-online-247)

---

## 1. 🌐 Buat Bot di Discord Developer Portal

1. Buka **[discord.com/developers/applications](https://discord.com/developers/applications)**
2. Login dengan akun Discord kamu
3. Klik tombol **"New Application"** (kanan atas)
4. Beri nama: **Kyriz** → klik **"Create"**
5. Di sidebar kiri, klik **"Bot"**
6. Klik **"Reset Token"** → **"Yes, do it!"**
7. Klik **"Copy"** untuk menyalin token → **SIMPAN BAIK-BAIK!**

> ⚠️ **JANGAN PERNAH** share token bot kamu ke siapapun! Token = password bot kamu.

### Aktifkan Intents

Masih di halaman **Bot**, scroll ke bawah ke bagian **Privileged Gateway Intents**, aktifkan:

- ✅ **MESSAGE CONTENT INTENT** (WAJIB — supaya bot bisa baca isi pesan)
- ✅ **SERVER MEMBERS INTENT** (opsional, untuk fitur user mention)

Klik **"Save Changes"**

---

## 2. 🔑 Dapatkan Bot Token & Client ID

### Bot Token
- Sudah di-copy di langkah sebelumnya
- Kalau lupa, bisa ke **Bot** → **"Reset Token"** lagi

### Client ID (Application ID)
1. Di sidebar, klik **"General Information"**
2. Cari **"Application ID"**
3. Klik **"Copy"**

---

## 3. 👤 Dapatkan Discord User ID (untuk Superadmin)

1. Buka Discord (app atau web)
2. Pergi ke **Settings** → **Advanced** → aktifkan **"Developer Mode"**
3. Klik kanan profil kamu (di chat atau member list)
4. Klik **"Copy User ID"**

---

## 4. 📁 Setup Project

Pastikan kamu sudah punya **Node.js 18+** terinstall. Cek dengan:

```bash
node --version
```

Kalau belum punya, download di [nodejs.org](https://nodejs.org/).

---

## 5. 📝 Isi File .env

Buka file `.env` di folder `discord-bot/`, lalu isi dengan data kamu:

```env
DISCORD_TOKEN=paste_token_bot_disini
CLIENT_ID=paste_client_id_disini
SUPERADMIN_ID=paste_user_id_kamu_disini
```

> ⚠️ Jangan pakai tanda kutip, dan jangan ada spasi sebelum/sesudah `=`

---

## 6. 📦 Install Dependencies

```bash
cd discord-bot
npm install
```

---

## 7. 🚀 Register Slash Commands

Jalankan sekali untuk mendaftarkan slash commands ke Discord:

```bash
npm run deploy
```

Kamu akan melihat output:
```
🔄 Mendaftarkan slash commands ke Discord...
✅ Slash commands berhasil didaftarkan!
```

> ℹ️ Jalankan ulang command ini setiap kali kamu menambah/mengubah structure command.

---

## 8. 📨 Invite Bot ke Server

1. Buka **[discord.com/developers/applications](https://discord.com/developers/applications)**
2. Pilih aplikasi **Kyriz**
3. Di sidebar, klik **"OAuth2"**
4. Scroll ke **"OAuth2 URL Generator"**
5. Di **SCOPES**, centang:
   - ✅ `bot`
   - ✅ `applications.commands`
6. Di **BOT PERMISSIONS**, centang:
   - ✅ `Send Messages`
   - ✅ `Read Message History`
   - ✅ `Use Slash Commands`
7. Copy **Generated URL** di bagian bawah
8. Buka URL tersebut di browser
9. Pilih server yang kamu mau → **"Authorize"**

---

## 9. ▶️ Jalankan Bot

```bash
npm start
```

Kamu akan melihat:
```
╔══════════════════════════════════════════╗
║   🤖 Kyriz — Personal Assistant Bot      ║
╠══════════════════════════════════════════╣
║   ✅ Online sebagai: Kyriz#1234          ║
║   🌐 Server: 1                           ║
╚══════════════════════════════════════════╝
```

Bot sekarang **online** dan siap dipakai! 🎉

---

## 10. 💡 Cara Pakai Commands

### Auto-Reply

| Command | Contoh | Fungsi |
|---------|--------|--------|
| `/kyriz autoreply add` | `trigger: halo` `reply: Halo juga! 👋` | Tambah auto-reply |
| `/kyriz autoreply remove` | `trigger: halo` | Hapus auto-reply |
| `/kyriz autoreply edit` | `trigger: halo` `reply: Hey!` | Edit auto-reply |
| `/kyriz autoreply list` | — | Lihat semua auto-reply |

**Parameter opsional untuk `add` dan `edit`:**
- `case_sensitive`: `true` / `false` (default: `false`)
- `match_mode`: `exact` / `contains` (default: `contains`)

### User Management (Superadmin Only)

| Command | Contoh | Fungsi |
|---------|--------|--------|
| `/kyriz user add` | `target: @temanku` | Beri akses config |
| `/kyriz user remove` | `target: @temanku` | Hapus akses config |
| `/kyriz user list` | — | Lihat daftar user |

---

## 11. ☁️ Deploy ke Railway (Gratis, Online 24/7)

Supaya bot tetap online walau laptop kamu mati:

### Persiapan: Upload ke GitHub

1. Buat repository baru di [github.com](https://github.com) (set ke **Private**!)
2. Push kode bot:

```bash
cd discord-bot
git init
git add .
git commit -m "Initial commit: Kyriz bot"
git branch -M main
git remote add origin https://github.com/USERNAME_KAMU/kyriz-bot.git
git push -u origin main
```

> ⚠️ Pastikan `.env` sudah ada di `.gitignore` supaya token tidak ter-upload!

### Deploy ke Railway

1. Buka **[railway.app](https://railway.app)** → Login dengan GitHub
2. Klik **"New Project"** → **"Deploy from GitHub Repo"**
3. Pilih repository **kyriz-bot**
4. Setelah project dibuat, klik **"Variables"**
5. Tambahkan variable (sama seperti `.env`):
   - `DISCORD_TOKEN` = token bot kamu
   - `CLIENT_ID` = client id kamu
   - `SUPERADMIN_ID` = user id kamu
6. Di **Settings** → **Deploy** → pastikan start command: `npm start`
7. Klik **"Deploy"**

✅ Bot sekarang **online 24/7** — bahkan kalau laptop kamu mati!

### Update Bot

Setiap kali kamu push perubahan ke GitHub, Railway akan **auto re-deploy**:

```bash
git add .
git commit -m "Update fitur baru"
git push
```

---

## 📁 Struktur File

```
discord-bot/
├── index.js                  # Entry point
├── commands/
│   ├── autoreply.js          # /kyriz autoreply commands
│   └── user.js               # /kyriz user commands
├── handlers/
│   └── autoReply.js          # Auto-reply logic
├── utils/
│   ├── dataManager.js        # Baca/tulis JSON data
│   └── permissionCheck.js    # Cek akses user
├── data/
│   ├── replies.json          # Config auto-reply
│   └── users.json            # Daftar authorized users
├── deploy-commands.js        # Register slash commands
├── package.json
├── .env                      # Token & config (JANGAN di-share!)
├── .gitignore
└── README.md                 # File ini
```

---

## ❓ FAQ

**Q: Slash commands tidak muncul di Discord?**
A: Jalankan `npm run deploy` ulang. Commands bisa butuh waktu ~1 jam untuk muncul secara global.

**Q: Bot online tapi tidak reply pesan?**
A: Pastikan **MESSAGE CONTENT INTENT** sudah diaktifkan di Developer Portal → Bot.

**Q: Bagaimana cara tambah fitur baru?**
A: Buat file command baru di folder `commands/`, register di `deploy-commands.js` dan `index.js`. Struktur kode sudah modular, jadi tinggal tambah tanpa mengubah yang sudah ada.

**Q: Data auto-reply hilang setelah restart?**
A: Data disimpan di `data/replies.json`. Selama file tersebut tidak dihapus, data aman. Di Railway, pertimbangkan menggunakan database (misal SQLite) untuk storage yang lebih persistent.
