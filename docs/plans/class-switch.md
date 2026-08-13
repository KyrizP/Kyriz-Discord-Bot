# Class Switch System — Implementation Plan

## Status: PLANNING (Brainstorm Phase)

---

## 1. Overview

Fitur untuk switch class (Warrior ↔ Mage, dan future classes) tanpa kehilangan progress class sebelumnya. Setiap class memiliki data terpisah (level, exp, bestDepth, equipment), sementara resource (kryptonite, bag, uniqueItems) shared.

---

## 2. Data Structure

### Current (flat)
```json
{
  "battle": {
    "charLevel": 200,
    "charClass": "mage",
    "charExp": 500,
    "charExpNeeded": 10050,
    "charName": "DarkMage",
    "equipment": { "weapon": "ky1a2b", ... },
    "bestDepth": 150,
    "kryptonite": 15000,
    "bag": { "d1": 50 },
    "uniqueItems": { "ky1a2b": { ... } },
    "pvpWins": 20,
    "pvpLosses": 5
  }
}
```

### New (multi-character)
```json
{
  "battle": {
    "activeClass": "mage",
    "characters": {
      "mage": {
        "charLevel": 200,
        "charExp": 500,
        "charExpNeeded": 10050,
        "charName": "DarkMage",
        "bestDepth": 150,
        "equipment": { "weapon": "ky1a2b", ... },
        "scoreAchievedAt": "2026-..."
      },
      "warrior": {
        "charLevel": 60,
        "charExp": 100,
        "charExpNeeded": 3050,
        "charName": "IronKnight",
        "bestDepth": 30,
        "equipment": { "weapon": null, ... },
        "scoreAchievedAt": null
      }
    },
    "kryptonite": 15000,
    "bag": { "d1": 50 },
    "uniqueItems": { "ky1a2b": { ... } },
    "pvpWins": 20,
    "pvpLosses": 5
  }
}
```

### Per-Character Fields
- `charLevel`, `charExp`, `charExpNeeded`
- `charName`
- `bestDepth`
- `equipment` (5 slots each)
- `scoreAchievedAt`

### Shared Fields
- `kryptonite`
- `bag` (drops)
- `uniqueItems` (gacha gear collection)
- `pvpWins`, `pvpLosses`

---

## 3. Commands

| Command | Effect | Cost |
|---------|--------|------|
| `ky battle` (first time) | Pick class, create character (existing flow) | Free |
| `ky changeclass <warrior/mage>` | Create NEW class character if doesn't exist | 5,000 🧪 |
| `ky switchclass` | Toggle to the other existing class | Free |

### Guards
- ❌ Cannot switch during active battle run (`activeRuns`)
- ❌ Cannot switch during active PvP fight (`activePvpFights`)
- ❌ Cannot create class that already exists

---

## 4. Leaderboard Changes

### Main LB (`ky lb battle [all]`)
- **One entry per player** — shows class with highest `bestDepth`
- Sort: bestDepth → Combat Score → scoreAchievedAt

### Per-Class LB (NEW)
- `ky lb battle warrior [all]` — Warrior rankings only
- `ky lb battle mage [all]` — Mage rankings only
- A player can appear in both class LBs

---

## 5. Critical Guards (Anti-Exploit)

### Equipment Isolation Bug Prevention
When selling or equipping gear, check ALL characters' equipment — not just active:

```js
function isEquippedOnAnyChar(battleData, itemId) {
  if (!battleData.characters) return false;
  for (const charData of Object.values(battleData.characters)) {
    if (!charData.equipment) continue;
    for (const slot of Object.values(charData.equipment)) {
      if (slot === itemId) return true;
    }
  }
  return false;
}
```

**Apply to:**
- `applyEquip()` — prevent equipping item already on another char
- `applySellGear()` — prevent selling item equipped on inactive char
- `applySellGear()` bulk rarity sell — skip items equipped on any char

---

## 6. Data Migration (Lazy, Backwards Compatible)

In `ensureBattleData()`:
```js
if (b.charClass && !b.characters) {
  b.characters = {};
  b.characters[b.charClass] = {
    charLevel: b.charLevel,
    charExp: b.charExp,
    charExpNeeded: b.charExpNeeded,
    charName: b.charName,
    bestDepth: b.bestDepth,
    equipment: { ...b.equipment },
    scoreAchievedAt: b.scoreAchievedAt,
  };
  b.activeClass = b.charClass;
  // Clean up flat fields
  delete b.charLevel; delete b.charExp; delete b.charExpNeeded;
  delete b.charClass; delete b.charName; delete b.bestDepth;
  delete b.equipment; delete b.scoreAchievedAt;
}
```

Proven pattern — same approach as existing v1.1 backfill in `ensureBattleData()`.

---

## 7. Files to Modify

| File | Change Scope |
|------|-------------|
| `utils/battleConfig.js` | No change (pure data) |
| `utils/battleEngine.js` | No change (pure math) |
| `utils/battleManager.js` | **Major** — ensureBattleData, all apply-* fns, leaderboard, new changeClass/switchClass |
| `utils/battleCommands.js` | **Medium** — UI embeds, new commands, LB filter |
| `utils/pvpManager.js` | No change (pure engine) |
| `utils/uniqueItems.js` | No change (pure gacha) |
| `utils/economyManager.js` | No change (decoupled) |
| `commands/game.js` | **Minor** — route new prefix commands |

---

## 8. Open Questions

- [ ] Should `ky switchclass` cost anything? (Current plan: free)
- [ ] Max classes per player? (Current: unlimited, future-proof)
- [ ] Show inactive class info in `ky profile`?

---

## 9. Verification Plan

1. Run existing test suite (`node test/battleManager.test.js`, `node test/pvp.test.js`)
2. Add new tests for: migration, changeClass, switchClass, equipment isolation
3. Manual test: create char → changeclass → switchclass → battle → end → check data
4. Verify leaderboard shows correct class per player
