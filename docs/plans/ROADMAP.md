# Kyriz — Feature Roadmap

Antrian fitur berikutnya. Satu baris per fitur: konsep singkat → nanti di-brainstorm jadi spec + plan saat giliran tiba.

| # | Fitur | Status | Catatan |
|---|---|---|---|
| 1 | **Class Switch** (multi-character per akun, `ky switch` satu command (auto-detect + tombol konfirmasi beli)) + bonus `ky unequip all` | 🔨 Plan siap: `docs/superpowers/plans/2026-08-15-class-switch.md` | Spec: `docs/superpowers/specs/2026-08-15-class-switch-design.md`. unequip all masuk Task 3 (dengan test anti-stacking & anti-duplikasi) |
| 2 | **Preset Gear** (loadout 5-slot per akun, SLOT BERNOMOR 1-5, panel paginated 1 slot/page; 2 gratis, `ky preset buy slot` via tombol — harga menanjak 🧪 2k/5k/10k) | 🔨 Plan siap v2: `docs/superpowers/plans/2026-08-15-preset-gear.md` | Spec v2: `docs/superpowers/specs/2026-08-15-preset-gear-design.md`. Eksekusi SETELAH class-switch. Final: slot bernomor (boleh timpa), buy via command+tombol (bukan shop), purge-on-sell anti infinite-🧪, harga slot menanjak |
| 3 | **Abyss Tower** (Spiral Abyss-style boss tower, 10 floor turn-based, weekly reset, star rating, Kryptonite + gear rewards, class-recommended per floor) | 📝 Spec + Plan siap: `docs/superpowers/specs/2026-08-19-abyss-tower-design.md` | Plan: `docs/superpowers/plans/2026-08-19-abyss-tower.md`. 6 tasks: config → state → combat → UI → reset timer → polish |
| 4 | — | 💡 slot kosong | _(daftar fitur berikutnya di sini)_ |

**Cara pakai:** tambah baris + 1-2 kalimat konsep → saat gilirannya, brainstrom → spec → plan → eksekusi (urutan workflow superpowers).
