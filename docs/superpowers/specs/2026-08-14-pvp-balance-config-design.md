# PvP Balance Config v1.5 — Design

**Date:** 2026-08-14 · **Status:** implemented (uncommitted) · **Scope:** PvP only, PvE untouched

## Problem

Live PvP (v1.4 tuning: burn ×1.2 flat, War Cry DR 25, deterministic damage) produced cliff-shaped winrates under simulation (AI-optimal, 200-800 duels/cell):

- **WvM epic gear: 100% warrior at every level** (Lv50-800) — mage unplayable at the most common gear tier
- Divine sustain mirrors swung 0%↔100% by build/level
- MvM had a structural second-mover artifact (burn ticks before action → double-KO races credit the wrong side ~100%)

Root causes found by grid-search (30+ configs):

1. **Deterministic races.** With no per-hit randomness, any knob change flips outcomes 100↔0 instead of shifting a gradient (burn 1.48→1.52 = 100%→0%).
2. **Class growth drift.** Mage matk grows 3.0/level vs warrior atk 2.2 — the WvM gap changes sign across levels, so no flat multiplier fits all levels.
3. **Warrior mitigation uptime.** Parry (-75% every 2 turns) + War Cry DR scale with fight length; raising HP (1.3+) or lowering damage (0.62) makes warrior dominant at mid levels — HP 1.15 / damage 0.7 are the validated stability points.

## Design — 4 knobs in `utils/pvpManager.js`

| Knob | Value | Why |
|---|---|---|
| `PVP_DAMAGE_ROLL` | 0.15 (new) | ±15% per-hit roll. Turns cliffs into gradients; enables comebacks (underdog never at 0%). |
| `PVP_BURN_BASE/SLOPE` | 0.95 + 0.0100 × effLevel (was ×1.2 flat) | Tracks the growth drift so WvM stays centered across levels. |
| `PVP_WARCRY_DR_CAP` | 15 (was 25) | Parry uptime + DR stacked to lock mages out. |
| `PVP_HP_RATIO` / `PVP_DAMAGE_MULT` | 1.15 / 0.7 (unchanged) | Proven stability points — 1.3+ HP or 0.62 damage breaks epic-tier balance. |

Explicitly NOT changed (owner decision): live stats, SPD (first-move order), level dampen, per-matchup HP scaling, skill kits. Grinding (level, gear, passives) must keep paying.

## Evidence (sim, warrior winrate)

- Epic WvM: **38-64% across Lv80-500** (was 100% everywhere)
- Policy matrix (4 warrior × 4 mage tactics incl. parry-bait, fireball-spam, ult timing): "reasonable vs reasonable" cells 43-53% at Lv100-200; bad play punished 0-4% (skill expression); tactic choice swings matchups (strategy matters)
- Fireball-spam counter-play = gear: 3-8% at epic → 47-49% at divine (grinding answers tactics)
- Level gaps: ±3 neutral, ~15 = 16%, 30+ decisive
- Mirrors: first-mover strong (~84-100%) by design — SPD/challenger decides (owner-approved)
- PvE verified untouched & balanced: warrior vs mage avg death floor Δ ≤ 1.0 floor at Lv50/150/300, all gear tiers; ATK growth 2.2 vs 2.0 shifts it ≤ 0.7 floor (noise) — keep 2.2

## Known trade-offs

- Sub-Lv50 duels are cliffy in any config (base stat gaps dominate pre-gear); population is small/transient
- Divine sustain-mirror drifts mage-lean above ~Lv400 (9-30%) — unfixable without touching PvE stats
- **Maintenance:** when first players reach ~Lv400, retune `PVP_BURN_SLOPE` (one number) using live W/L records

## Files

- `utils/pvpManager.js` — knobs + `pvpBurnMult()`, roll in damage line, DR cap, export
- `test/pvp.test.js` — fixed 4 stale v1.4 assertions; deterministic-roll mocks (stateful `Math.random`); new tests: roll bounds, DR cap 15, burn formula
- `utils/battleCommands.js` — one help-text line about PvP tuning
