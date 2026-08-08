# Battle Mode v2 — Roadmap

> **Status: ROADMAP, bukan plan siap-implement.** v2 dibangun di atas v1 yg sudah live & di-test. Detail desain + implementation plan ditulis **saat v1 udah jalan & v2 di-prioritize**. Jangan implement langsung dari doc ini — brainstorm dulu.
> **Spec:** `docs/superpowers/specs/2026-08-08-battle-mode-design.md` (§14).

## v2 features (dari spec §14)
1. **PvP async interactive duels** — turn-based, button-driven, correspondence-style (no real-time sync). Turn order by SPD. No drops/EXP (pure adu kekuatan). **HIGH PRIORITY** (butuh karakter/ekonomi v1 dulu).
2. **Superadmin "cheat": generate Kryptonite** ⚗️ — command owner-only buat grant Kryptonite (testing/iseng). **DEFERRED dari v1** (owner mau main fair dulu).
3. **Daily merchant price variance** — harga beli merchant roll harian dlm range (meta "jual pas hari bagus"). Engine `merchantPrice` udah distrukturin buat ini (tinggal add daySeed).
4. **Rogue + class lain** — ATK/SPD crit-focused. Crit via gear affix/skill (no 7th core stat).
5. **Crit gear affixes** — mis. ring "Crit +10%", damage ×2 on crit.
6. **Gear expansion → epic/legendary/divine** — data-driven (tambah item di `battleConfig`). **Naikin floor ceiling** biar floor sangat tinggi reachable. (v1 starter gear cap `rare`.)
7. **Boss / server-wide raid** — co-op damage pool vs boss. Sosial.
8. **Entry-fee scaling** per char level (player kuat bayar lebih → self-throttle).
9. **Battle leaderboard** — by bestDepth / PvP rating.
10. **Re-class** (ganti class) for Kryptonite.

## Open design questions (resolve pas v2 di-prioritize)
- **PvP:** rating system (ELO?) · reward selain bragging? · async turn timeout berapa lama?
- **Cheat:** scope (Kryptonite doang? item? level?) · logging/audit biar nggak disalahgunakan?
- **Crit:** gear-stat terpisah ato affix-only? base crit chance?
- **Raid:** max player? raid HP scaling? distribusi reward?
- **Gear expansion:** berapa item per tier? drop-only ato craftable juga?

## Dependencies
- Semua v2 build di atas v1 engine (`battleEngine`), state (`battleManager`), & field ekonomi yg udah live + tested.
- PvP + raid butuh karakter ada (post-v1).

## Jadi plan beneran kapan?
Saat ready: brainstorm slice v2 yg di-prioritize (mis. PvP duluan) → update spec → `writing-plans` → file baru `2026-08-XX-battle-mode-v2-<slice>.md`.
