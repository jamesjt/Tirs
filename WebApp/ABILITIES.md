# Ability System Reference

## 1. Architecture Overview

The ability system uses a **3-layer data-driven architecture** where most abilities require only spreadsheet data, not code. The system is implemented as an IIFE module (`const Abilities = (() => { ... })()`) in `abilities.js` (~2700 lines).

### Three Layers

```
Layer 1 (Unit Data)     — Unit specialRules[] reference ability names
                            e.g. unit.specialRules = [{ name: "Bump", text: "Push 1" }]
                                          ↓ resolved by bindUnit()
Layer 2 (Ability Defs)  — Ability name → { ruleIds[], oncePerGame, oncePerRound }
                            e.g. "Bump" → { ruleIds: ["hit.Bump.Push.1"], oncePerGame: false }
                                          ↓ looked up during dispatch
Layer 3 (Atomic Rules)  — Rule ID → { type, target, effects[], condition, conditionValue, ... }
                            e.g. "hit.Bump.Push.1" → { type: "hit", target: "target", effects: [{ effect: "push", value: "1" }] }
```

### Data Flow

```
Google Sheets CSV → units.js parsing → Abilities.setAtomicRules() + setAbilityDefs()
                                                    ↓
                              Game.createUnit() → Abilities.bindUnit(unit)
                                                    ↓
                              Game hooks → Abilities.dispatch(trigger, ctx) → executeRules → applyEffect
```

---

## 2. Data Stores & Constants

### `atomicRules` (object)
Layer 3 store. Keyed by rule name (e.g. `"hit.Bump.Push.1"`). Each value:
```js
{
  ruleName: string,     // e.g. "hit.Bump.Push.1"
  type: string,         // spreadsheet type: "hit", "passive", "action", etc.
  target: string,       // target spec: "target", "self", "aroundTarget unit", etc.
  effects: [            // array of { effect, value } pairs
    { effect: "push", value: "1" },
    { effect: "burning", value: "" }
  ],
  condition: string,    // condition gate: "resource", "flanked", "adjenemies", etc.
  conditionValue: string, // condition param: "lightning:>=1", ">=1", etc.
  action: string,       // action cost: "move", "attack", "non-activation", "Move,Attack"
  range: string,        // range column: "D6", "L3", "6"
  los: string,          // LoS requirement
  validTargets: string, // tag-based target filter: "ally", "enemy,terrain", etc.
  invalidTargets: string // tag-based exclusion filter
}
```

### `abilityDefs` (object)
Layer 2 store. Keyed by display name (e.g. `"Bump"`). Each value:
```js
{
  name: string,
  ruleIds: string[],    // references into atomicRules, e.g. ["hit.Bump.Push.1"]
  oncePerGame: boolean,
  oncePerRound: boolean
}
```

### `effectQueue` (array)
Interactive effects waiting for player clicks. Entries vary by type:
```js
{
  type: string,         // "push", "pull", "move", "create", "relocate", "relocateTerrain", "terrainRide"
  unit: object,         // unit being moved/affected
  refQ: number,         // reference position (push away from / pull toward)
  refR: number,
  remaining: number,    // remaining distance
  noStay: boolean,      // if true, unit can't stay in place
  chainRules: array,    // deferred aroundTarget rules to fire after resolution
  validHexes: Set,      // pre-computed valid hexes (for create/relocateTerrain)
  surface: string,      // terrain surface to create (for create)
  player: number        // terrain ownership
}
```

### `CONDITION_DEFAULTS` (object)
Maps condition IDs to default durations. Used by `applyConditionEffect()` to determine how long conditions last when no override is specified.

| Condition | Default Duration | Notes |
|-----------|-----------------|-------|
| burning | permanent | Self-damage after attack |
| immobilized | endOfActivation | Blocks movement |
| poisoned | endOfActivation | Damage = spaces moved |
| dizzy | endOfActivation | Move OR attack, not both |
| disarmed | endOfActivation | Blocks attacks |
| silenced | endOfActivation | Blocks ability dispatch |
| taunted | endOfActivation | Filters attack targets |
| vulnerable | endOfRound | -1 armor |
| protected | endOfRound | +1 armor |
| strengthened | untilAttack | +1 damage, consumed on attack |
| weakness | endOfActivation | -1 damage |
| leveled | permanent | Terrain replacement marker |
| movebonus | endOfActivation | +N move |
| break | permanent | Permanent armor -1 (stacks) |
| arcfire | permanent | Flame seed marker |
| moveintoenemies | endOfActivation | Can move through enemies |
| glidermark | manual | Deferred damage, resolved in endActivation |
| overwatch | endOfRound | Counter-attack on enemies attacking in range |
| suppressed | manual | Cannot activate, cleared on teammate activation end |
| dodgy | endOfRound | Miss chance on incoming attacks |
| tumbler | endOfRound | Move through enemies + deal damage |
| guarded | manual | Guardian intercept target |

### `TYPE_TRIGGER` (object)
Maps spreadsheet rule `type` column to dispatch trigger strings:

| Spreadsheet Type | Dispatch Trigger | When It Fires |
|-----------------|-----------------|---------------|
| hit | afterAttack | After attack damage is dealt |
| passive | statCalc | Scanned at stat calculation time (not dispatched) |
| death | afterDeath | When the unit dies |
| activation | afterSelect | When the unit is selected for activation |
| action | playerAction | When player clicks an action button |
| movement | onMovement | When unit enters an enemy-occupied hex |
| onAttack | onAttack | Before attack resolves (Toss) |
| afterMove | afterMove | After movement completes |
| whenAttacked | whenAttacked | Before damage is dealt to this unit |
| endActivation | endActivation | At end of unit's activation |
| allyDeath | afterAllyDeath | When an allied unit dies |
| deploy | afterDeploy | When unit is deployed to the board |
| hymn | hymn | Fired by Litany at 3 repetitions |
| onTurnEnd | turnEnd | After activation ends, after endOfActivation conditions clear |

### Other Constants

- **`PASSIVE_ONLY_EFFECTS`** — Effects resolved at scan time, not dispatch: `ignoreTerrainRule`, `ignoreTerrain`, `mobile`, `moveintoenemies`, `maxresource`, `resetresource`, `refillresource`, `tag`, `isterrain`, `swapterrainrule`, `teleportthrough`, `resourcemod`, `deployterrain`, `hidden`, `immuneforcedmove`, `preventcondition`, `ignoreBaseArmor`
- **`INTERACTIVE_EFFECTS`** — Effects skipped by `applyRuleSideEffects()`: push, pull, move, relocate, teleportally, teleportterrain, create terrain types
- **`NEGATIVE_CONDITIONS`** — Conditions that can be blocked by `preventcondition`: burning, immobilized, poisoned, dizzy, disarmed, silenced, taunted, vulnerable, weakness
- **`TARGET_NOISE`** — Noise words filtered from target parsing: "the", "a", "an", "in", "on", "to", "of"

---

## 3. Data Loading & Unit Binding

### `setAtomicRules(data)`
Merges parsed rule objects into the `atomicRules` store. Called from `units.js` after parsing the unified Rules spreadsheet tab.

### `setAbilityDefs(data)`
Merges parsed ability definitions into `abilityDefs`. Validates that all referenced `ruleIds` exist in `atomicRules`. Called from `units.js` after parsing the Abilities tab.

### `bindUnit(unit)`
Called by `Game.createUnit()` for every deployed unit. Resolves the unit's `specialRules[].name` strings to ability definitions from `abilityDefs`. Also:
- Auto-adds faction-wide ability (e.g. "Tidehaven" ability def applied to all Tidehaven units)
- Initializes `unit.usedAbilities = new Set()` for once-per-game tracking
- Initializes `unit.resources = {}` from `maxresource` passive effects
- Checks for `isTerrain` passive flag
- Logs warnings for unresolved ability names

**Result:** `unit.abilities` becomes an array of `{ name, text, def, ruleIds[] }` objects.

---

## 4. Dispatch System

### `dispatch(trigger, ctx)` — Main Entry Point
**Parameters:**
- `trigger` — string: `"afterAttack"`, `"afterDeath"`, `"afterSelect"`, `"roundStart"`, `"endActivation"`, `"turnEnd"`, `"whenAttacked"`, `"afterDeploy"`, `"afterAllyDeath"`
- `ctx` — context object: `{ unit, target?, attacker?, damage?, damagedUnits?, killer?, deadAlly?, occupant? }`

**Returns:** `boolean` — true if effects were queued in the effectQueue

**Flow:**
1. Sets `isQueuing = true` (push/pull/move effects will be queued instead of executing)
2. For each ability on `ctx.unit`:
   - Skip if unit is silenced
   - Map trigger to spreadsheet type via `TRIGGER_TO_TYPE`
   - Skip action-type rules (those are player-activated, not auto-dispatched)
   - Check once-per-game and once-per-round gates
   - For endActivation with interactive targeting: set `pendingEndActTarget` for UI
   - Call `executeRules(ab.ruleIds, triggerType, ctx)`
   - Mark once-per-game/round as used
3. Sets `isQueuing = false`
4. Returns whether effectQueue has entries

**Called by:** Game hooks in `selectUnit()`, `moveUnit()`, `attackUnit()`, `completeEndActivation()`, `startRound()`, `deployUnit()`

### `executeRules(ruleIds, triggerType, ctx)`
Core rule executor. For each rule ID:
1. Look up rule in `atomicRules`
2. Check type matches trigger
3. Evaluate condition via `evaluateCondition()`
4. Resolve targets via `resolveTargets()`
5. Apply `invalidTargets` filter
6. Apply all effects via `applyEffect()`
7. Handle deferred chain rules (aroundTarget rules when push/pull is pending)

### `dispatchAllyDeath(deadUnit, killer)`
Fires `allyDeath` rules on ALL surviving allies of the dead unit. Creates context `{ unit: ally, deadAlly: deadUnit, killer, target: killer }` for each ally.

### `dispatchMovement(unit, occupant)`
Fires `movement` rules when a unit enters an enemy-occupied hex (e.g. Impactful push). Uses specialized `applyMovementEffect()` instead of `applyEffect()`.

---

## 5. Target Resolution

### `resolveTargets(targetType, ctx, rule)` — Core Engine
**Parameters:**
- `targetType` — string from rule's target column (e.g. `"self"`, `"aroundTarget unit"`, `"allEnemies"`, `"empty, aroundTarget"`, `"pathToTarget"`)
- `ctx` — dispatch context
- `rule` — rule object (for range extraction)

**Returns:** Array of unit objects, hex positions `{q,r}`, or mixed entries

**Resolution Process:**
1. Tokenize target string by splitting camelCase and commas
2. Filter noise words (the, a, an, in, on, to, of)
3. Check legacy mappings for old-format strings
4. Check for special non-compositional keywords first
5. Determine anchor unit
6. Apply area tokens to expand from anchor
7. Apply filter tokens to narrow results

### Special Keywords (Non-Compositional)
Checked on the joined lowercase target string before any tokenization:

| Keyword | Returns |
|---------|---------|
| `deadally` | `ctx.deadAlly` (the ally that just died) |
| `closestally` | Nearest living ally by hex distance |
| `lowestcostally` | Living ally with lowest cost |
| `attackedenemy` | Enemies damaged during this activation (`activationState.damagedEnemies`), last-attacked first |
| `allallies` | All living units of same player |
| `allenemies` | All living units of opposing player |
| `damaged` | `ctx.damagedUnits[]` or fallback to `ctx.target` |
| `linetotarget` | Units on straight line from unit to target (via `resolveLineToTarget`) |
| `pathtotarget` | Units on BFS path from unit to target (via `resolvePathToTarget`) |

### Anchor Determination
Which unit to expand from:

| Token | Anchor |
|-------|--------|
| `target` / `atktarget` | `ctx.target` |
| `attacker` | `ctx.attacker` |
| `occupant` | `ctx.occupant` |
| (default) | `ctx.unit` (self) |

### Single-Token Shortcuts
If only one meaningful token remains: `self` → ctx.unit, `target`/`atktarget` → ctx.target, `attacker` → ctx.attacker, `enemy` → ctx.target

### Area Tokens
Expand from anchor position:

| Token | Behavior |
|-------|----------|
| `around` / `adjacent` | Hex neighbors of anchor (radius from rule.range, default 1) |
| `line` | Straight-line hexes between unit and anchor |
| `path` | BFS shortest-path hexes between unit and anchor |
| `own` | Include anchor's hex itself in results |

### Filter/Return Type Tokens

| Token | Behavior |
|-------|----------|
| `spaces` / `empty` | Return hex positions {q,r}, optionally filtered for unoccupied |
| `terrain` | Return mixed unit/terrain results, filter by terrain rule tokens |
| `units` / `unit` / `enemy` / `ally` | Return unit objects, filter by player relationship |

### Helper Functions

- **`resolveLineToTarget(ctx)`** — For Piercing. Uses stored `attackPath` or straight-line direction.
- **`resolvePathToTarget(ctx)`** — BFS path between unit and target, returns units along it.
- **`findShortestPath(fromQ, fromR, toQ, toR)`** — Generic BFS on hex grid, returns intermediate hexes.
- **`unitsInLine(attacker, target)`** — Living units on straight line between two units.
- **`unitsOnPath(path)`** — Living units on intermediate hexes of a path.

---

## 6. Effect Application

### `applyEffect(targets, effect, value, ctx, rule)` — Master Dispatcher
Routes effects by name. The optional `rule` parameter is passed through from `executeRules()` so that effect handlers like `applyPlaceBeam` can read the rule's range, check sibling effects, etc. Skip passive-only effects. Conditions route to `applyConditionEffect()`. Terrain types route to `applyTerrainCreateEffect()`. Everything else goes through the switch.

### Damage & Heal Effects

| Function | Effect Name | Behavior |
|----------|-------------|----------|
| `applyDamageEffect` | `damage`, `piercing` | Ability damage: value - target armor, min 1. For `piercing` on passives: LoE bypass flag. On beams: value = max targets to penetrate (0/blank = unlimited). |
| `applyBonusDamage` | `bonusdamage` | Flat bonus to ctx.target, no armor calc |
| `applyBonusDamagePerTerrain` | `bonusdamageperterrain` | Count terrain hexes of type within radius, deal as damage. Value: `"terrainName,radius"` |
| `applyArmorReduce` | `armorreduce` | Permanently reduce target's armor stat |
| `applyHeal` | `heal` | Heal targets up to maxHealth |
| `applyReduceDamageTo` | `reducedamageto` | Set damage cap on targets (`_reduceDamageTo` flag) |

### Movement Effects

| Function | Effect Name | Behavior |
|----------|-------------|----------|
| `applyPush` | `push` | Push targets away from ctx.unit. Checks `immuneforcedmove`. Queued if `isQueuing`. |
| `applyPull` | `pull` | Pull targets toward ctx.unit. Same gating as push. |
| `applyMove` | `move` | Move ctx.unit toward ctx.target (self-pull mechanic). |
| `applyRelocate` | `relocate` | Queue interactive placement. Units: `effectQueue` entry type='relocate'. Terrain: compute valid empty hexes, queue 'relocateTerrain'. Value = range. |
| `applySwap` | `swap` | Swap positions of ctx.unit and ctx.target. Calls onEnterHex + updateObjectiveControl + recalcAuras. |
| `applyPushFromTerrain` | `pushfromterrain` | Push away from nearest terrain of element type. Value: `"element:distance"` |
| `applyPullToTerrain` | `pulltoterrain` | Pull toward nearest terrain of element type. Value: `"element:distance"` |

### Condition Effects

| Function | Effect Name | Behavior |
|----------|-------------|----------|
| `applyConditionEffect` | Any key in CONDITION_DEFAULTS | Apply condition with default or overridden duration. Value overrides: `"turn"` → endOfActivation, `"permanent"` → permanent, numeric → stored as condValue. |
| `applyEmpower` | `empower` | Apply empower condition with manual duration. Value: `"effect,severity,instances"` (e.g. `"burning,,1"`). Processed later by `processEmpowerments()` in game-battle.js. |

### Terrain Effects

| Function | Effect Name | Behavior |
|----------|-------------|----------|
| `applyTerrainCreateEffect` | Any terrain type name | Create terrain at target hexes. If queuing and count limited, queue interactive selection. |
| `applyDestroyTerrain` | `destroyterrain` | Remove terrain surface from target hexes. |
| `applyPlaceMarker` | `placemarker` | Place marker at target hexes in `state.markers`. Value = type (default `"xmarks"`). |
| `applyPlaceTerrain` | `placeterrain` | Place terrain of specified surface. Value: `"surface"` or `"surface:count"`. May queue interactively. |

### Resource Effects

| Function | Effect Name | Behavior |
|----------|-------------|----------|
| `applyConsume` | `consume` | Consume resources from ctx.unit. Value: `"type:amount"` or `"type:all"`. Tracks consumed amount in `ctx.consumed[type]`. |
| `applyGainResource` | `gainresource` | Grant resource to targets, capped by `getMaxResource()`. Value: `"type:amount"`. |
| `applyLitany` | `litany` | Increment hymn counter. At 3, reset and fire hymn rules. Value = hymn ability name. |

### Complex Effects

| Function | Effect Name | Behavior |
|----------|-------------|----------|
| `applyChainLightning` | `chainlightning` | Bounce from initial target. Walks 6 directions, finds nearest unvisited unit within range. Enemies take damage (attacker dmg - target armor); allies gain lightning. Recurses until no targets. Value = bounce range. |
| `applyLightBeam` | `lightbeam` | Directional line. Determines direction from unit to clicked hex, walks full line. Without lightning: first enemy gets vulnerable. With lightning: ALL enemies get vulnerable + first ally gains charge, consumes lightning. |
| `applyRapacious` | `rapacious` | Heal self 1, deal 1 bonus damage. If target survives, remove from board (q=-99) and store in `rapaciousCaptures[]` for round-end return. |

### Meta Effects

| Function | Effect Name | Behavior |
|----------|-------------|----------|
| `applyGrantAbility` | `grantability` | Grant named abilities to targets. Checks `absorber` flag for redirect, `collector` flag for +1 damage. Calls `recalcAuras()`. |
| `applyStatMod` | `statmod` | Direct stat modification. Value: comma-separated `"stat=val"` (set) or `"stat:val"` (add). Supports: atkType, armor, range, maxhealth, move, damage. |
| `applyBonusActivation` | `bonusactivation` | Grant bonus activation via `Game.queueBonusActivation()`. |
| `applyLastStand` | `laststand` | Revive ctx.deadAlly with 1 HP + queue bonus activation. Sets `_lastStand` flag. |
| `applyReplace` | `replace` | Initiate replacement UI. Filters faction catalog for undeployed units, sets `state.pendingReplacement`. |

---

## 7. Condition Evaluation

### `evaluateCondition(condStr, condValue, ctx)`
**Parameters:**
- `condStr` — condition name (e.g. `"resource"`, `"flanked"`, `"adjenemies"`)
- `condValue` — condition parameter (e.g. `"lightning:>=1"`, `">=2"`)
- `ctx` — context with `unit`, `target`, `attacker`

**Returns:** `boolean`

### All Cases

| Case | What It Checks | CondValue Format |
|------|---------------|------------------|
| `adjenemies` | Count of adjacent enemies vs comparison | `">=2"`, `"<1"` |
| `not` / `ifnot` | Unit does NOT have the named condition | condition ID |
| `has` / `ifhas` | Unit HAS the named condition | condition ID |
| `targetarmor` / `iftargetarmor` | Target's effective armor vs comparison | `">=1"`, `"<2"` |
| `targetbasehealth` / `iftargetbasehealth` | Target's maxHealth vs comparison | `"<=3"` |
| `round` / `ifround` | Current game round vs value. Supports: specific rounds (`"4"`), comma-list (`"2,3"`), comparison (`"<=2"`), keywords (`"odd"`, `"even"`) | `"1,4"`, `"<=2"`, `"odd"` |
| `targetcost` / `iftargetcost` | Target's cost vs comparison | `"<=4"`, `">3"` |
| `distfromstart` | Target's distance from activation start hex | `">=3"` |
| `aliveallies` | Count of living allies vs comparison | `">=2"` |
| `hidden` | Unit is hidden (concealing terrain, passive, etc.) | — |
| `onterrain` | Unit is on terrain with a specific rule | rule name |
| `targetadjally` | Count of attacker's allies adjacent to target | `">=1"` |
| `covered` | Cover terrain on LoS line between attacker/target (ray-cast) | comparison val |
| `flanked` | Attacker's allies on opposite side of target (direction-aware) | `">=1"` |
| `resource` | Unit's resource count vs comparison. Supports comma-separated AND logic for multiple resources. | `"lightning:>=1"`, `"mana:<1"`, `"lightbeam,lightning:>=1"` |
| `onsurface` | Unit's hex terrain surface matches list | `"tide,pool"` |
| (default) | Falls through to `evaluateConditionLegacy()` | — |

### `evaluateConditionLegacy(condStr, ctx)`
Fallback for old monolithic condition strings. Handles patterns like `"adjEnemies>=2"`, `"ifNotBurning"`, `"ifHasPoisoned"`, `"ifTargetArmor>=1"` via regex matching.

### Comparison Helpers
- **`parseComparison(val)`** — Extracts operator and number from `">=2"` → `{ op: ">=", num: 2 }`
- **`compare(actual, op, expected)`** — Generic comparison: `<`, `<=`, `>`, `>=`, `=`/`==`, `!=`

---

## 8. Passive System

Passive rules have type `"passive"` and trigger `"statCalc"`. They are never dispatched — instead they are scanned on demand by these functions:

### `getPassiveMod(unit, stat)`
Sums all passive stat modifiers for a unit. Scans passive rules for effects matching the stat name (e.g. `damage`, `armor`, `move`). Also handles `resourcemod` effects with format `"type:stat:perUnit"` (e.g. `"mana:armor:1"` — adds +1 armor per mana held).

**Called by:** `Game.getEffective(unit, stat)` — the central stat calculation function.

### `hasFlag(unit, flag)`
Checks if a unit has a passive flag. Searches **both** the unit's conditions array (temporary flags like Glider's `moveintoenemies`) **and** passive rule effects (permanent flags like Impactful's `moveintoenemies`).

**Common flags:** `mobile`, `moveintoenemies`, `precise`/`ignoreBaseArmor`, `immuneforcedmove`, `woundup`, `falcongust`, `hotsuit`, `delayedattack`, `moveorfire`, `calculated`, `forestcharged`, `piercing`, `deploytrap`, `plaguedmemories`, `sanguineechoes`, `dutifulreflection`, `dancer`

**Pre-damage hooks in `attackUnit()`:** Three Dusters legendary passives intercept damage in `attackUnit()` before normal damage is applied:
- `plaguedmemories` — deal 1 damage to all allies within range 3, reduce incoming damage. Once per round.
- `sanguineechoes` — closest ally within 3 takes excess damage above target's health. Once per round.
- `dutifulreflection` — pre-attack target redirect; pulls closest ally within 3 to intercept, swaps attack target. Once per round.

**Dancer system (Syli — Falling Leaf):** Round-start non-auto step. Each Dancer picks 1 of 4 poise effects per round (each usable once across the game): +1 Damage (strengthened), +2 Move (movebonus), Dodgy, Tumbler (moveintoenemies + 1 dmg per enemy). Tracked via `dancerUsed: Set` on unit.

### `hasFlagPassive(unit, flag)`
Like `hasFlag()` but checks **only** passive ability effects, **not** conditions. Used to distinguish innate flags from condition-granted ones (e.g. Impactful has innate `moveintoenemies`, while Glider gets it from a condition).

### `getPassiveList(unit, effectName)`
Collects all comma-separated values from passive effects matching a name. Returns array of strings.
- Example: `getPassiveList(unit, 'hidden')` → `['forest', 'mist']` or `['always']`
- Example: `getPassiveList(unit, 'ignoreTerrainRule')` → `['difficult', 'impassable']`

### `getReduceDamageCap(unit)`
Scans passive and whenAttacked rules for `reducedamageto` effects. Returns the minimum cap value found, or `Infinity` if none.

---

## 9. Action System

Actions are player-activated abilities (click a button in the battle panel). They use rule type `"action"` and have an `action` column specifying cost.

### `getActions(unit)`
**Returns:** Array of action descriptors for UI buttons:
```js
{
  name: string,           // ability name
  displayName: string,    // button label (may differ for dual-cost: "Clock Toys (Move)")
  actionCost: string,     // "move", "attack", "non-activation"
  actionRuleId: string,   // specific rule ID for this action
  oncePerGame: boolean,
  oncePerRound: boolean,
  // ... other ability def fields
}
```
Handles dual-cost abilities (comma-separated action column like `"Move,Attack"`) by creating separate button entries.

**Two-rule pattern for actions:** When an ability has multiple action rules with conditions, `getActions()` evaluates the conditions and selects only the first matching variant (rule order in ability def = priority). This mirrors how hit rules work — only the matching condition fires. Falls back to the first rule if none match (UI grays it out via `isActionAvailable`).

### `isActionAvailable(unit, actionRuleId)`
Checks if an action rule's conditions are currently met (e.g. resource gates like `resource lightning:>=1`). Used by UI to gray out unavailable action buttons.

### `getTargeting(abilityName, actionRuleId)`
Gets targeting parameters for a targeted action. Returns:
```js
{
  range: number,
  atkType: string,        // "D", "L", "P"
  los: string,
  cost: string,
  rawDamage: number,
  validTargets: string,   // tag-based filter (if present)
  invalidTargets: string
}
```
Returns `null` for non-targeted actions (e.g. Glider self-buff, Clock Toys).

**Two targeting paths:**
1. **Tag-based** (when `validTargets` present): UI calls `computeActionTargets()` for hex-level filtering
2. **Legacy** (range-based): Standard enemy targeting using range/atkType with `canAttack()` validation

### `computeActionTargets(unit, targeting)`
Board-wide target resolution using tag-based filtering. For each hex on the board:
1. Collect tags: `unit`, `ally`, `enemy`, `self`, `terrain`, surface names, `trap`, `empty`, plus unit data tags from `getUnitTags()`
2. Check if any tag matches `validTargets`
3. Check no tag matches `invalidTargets`
4. For enemy units with `atkType`: validate via `Game.canAttack()` (range, LoS, LoE)

**Returns:** Array of `{ type, key, q, r, unit?, surface?, trap? }`

### `executeAction(abilityName, ctx, actionRuleId)`
Fires action rules, then fires sibling hit rules from the same ability (for actions that also deal damage). Sets `isQueuing = true`, tracks once-per-game/round usage.

---

## 10. Effect Queue

During `dispatch()` and `executeAction()`, `isQueuing` is set to true. Push/pull/move/create effects are collected in `effectQueue` rather than executing immediately. The UI then drains the queue via player clicks.

### Queue Inspection

| Function | Returns | Purpose |
|----------|---------|---------|
| `hasPendingEffects()` | boolean | Are there queued effects? |
| `peekEffect()` | effect or null | Read front-of-queue without removing |

### `getEffectTargetHexes()`
Computes valid destination hexes for the front-of-queue effect:
- **create / relocateTerrain**: returns pre-computed `validHexes`
- **terrainRide**: returns single destination hex
- **push**: neighbors farther from reference position
- **pull / move**: neighbors closer to or equal distance from reference
- Unless `noStay`, includes current position (stay in place)
- Excludes occupied and impassable hexes

**Returns:** `Set<hexKey>` or null

### `resolveEffect(q, r)`
Player clicked a valid hex. Resolves the front-of-queue effect:
- **create**: places terrain, decrements remaining or shifts queue
- **relocateTerrain**: moves terrain from source to dest, queues terrainRide if unit was on source
- **terrainRide**: moves unit to destination
- **Staying in place**: fires chain rules, shifts queue
- **push/pull/move**: moves unit, calls onEnterHex and updateObjectiveControl, decrements remaining

Fires `chainRules` after resolution completes.

### `skipEffect()`
Skip the front-of-queue effect (ESC key). Fires chain rules before removing.

### `clearEffectQueue()`
Empties the entire queue. Called on deselect or activation end.

### `fireChainRules(eff)`
Fires deferred `aroundTarget` rules that were chained to a push/pull effect. These rules need to wait until the push/pull resolves to know the target's final position.

---

## 10b. Beam System

Beams are persistent board effects that apply conditions to units in their path. Managed in `game-battle.js`.

### Data Model
```js
state.beams = [{
  unit,            // owning unit (beam removed on death)
  player,          // player number
  targetQ, targetR, // direction target hex (not endpoint)
  conditions: [],  // condition IDs applied to occupants (e.g. ["vulnerable"])
  penetrate,       // boolean — can beam pass through targets?
  maxPenetrations, // int — 0 = unlimited, N = stop after N targets
  range,           // max hex distance from unit
  targetFilter,    // "enemy", "ally", "all"
  damage, damageOnce, // optional direct damage
  blockedBy,       // terrain surfaces that block the beam
  color,           // optional render color
}]
```

### Key Functions (game-battle.js)
- **`placeBeam(unit, config)`** — Creates beam, calls `updateBeamConditions()`.
- **`removeBeam(unit)`** — Removes beam owned by unit.
- **`getActiveBeamHexes(beam)`** — Pixel-ray with tight perpendicular tolerance (`hexSize * 0.25`) for clean every-other-column lines. Count-based penetration: stops after `maxPenetrations` targets (0 = unlimited).
- **`updateBeamConditions()`** — Reconciliation: strips all `beam`-duration conditions from all units, recomputes active hexes, reapplies matching conditions. Cached in `state._beamHexCache`.

### Creation via `applyPlaceBeam(value, ctx, rule)`
- **Value column**: Comma-separated tokens — condition names + optional target filter keyword.
  - `vulnerable` → conditions: [vulnerable], targetFilter: enemy (default)
  - `strengthened,ally` → conditions: [strengthened], targetFilter: ally
  - `vulnerable,all` → conditions: [vulnerable], targetFilter: all
- **Target filter**: `ally`, `enemy`, or `all` keyword in value sets who the beam affects. Default: `enemy`.
- **Piercing**: Checks if same rule has a `piercing` effect. Value = max targets (0/blank = unlimited).
- **Range**: Parsed from rule's `range` column (strips letter prefix, e.g. `D9` → 9)

### Two-Rule Pattern for Beams
Use opposite resource conditions to control piercing:
- Uncharged rule: `placebeam vulnerable` (no piercing effect)
- Charged rule: `placebeam vulnerable` + `piercing` effect (beam penetrates)

`getActions()` selects the matching variant based on current resource state.

### Lifecycle
1. Action rule fires → `applyPlaceBeam()` creates beam
2. `updateBeamConditions()` applies conditions to occupants
3. Any position change (move/push/death) → `updateBeamConditions()` re-reconciles
4. Owner dies in `damageUnit()` → beam removed
5. Undo restores `prevBeams` snapshot

---

## 11. Combat Checks

### `checkMiss(target, attacker)`
Pre-damage miss check. Called before damage is applied in `attackUnit()`.
1. Check `dodgy` condition on target (consumed on use)
2. Scan target's `whenAttacked` rules for `miss` effects
3. Respect once-per-game/round gates and silenced condition

**Returns:** `{ abilityName, oncePerGame, oncePerRound }` if miss, or `null`

### `isHidden(unit)`
Determines if a unit is hidden (can only be targeted at range 1). Sources:
- Concealing terrain (after `getEffectiveRules()` check for swapped rules)
- Passive `hidden` effect with value `"always"`
- `nosurface` — hidden when on no terrain and no objective
- Specific surface names — hidden when on matching terrain

**Negated by:** Revealing terrain (checks for `vulnerable` condition with `source: 'revealing'`)

### `tryPreventCondition(unit, conditionId)`
Checks if unit can prevent a negative condition via `preventcondition` passive effect. Must not be silenced. Condition must be in `NEGATIVE_CONDITIONS` set. If found, fires `applyRuleSideEffects()` for side effects (e.g. consuming mana) and returns `true`.

**Called by:** `Game.addCondition()` — prevents the condition from being added.

---

## 12. Aura System

### `getTerrainAuraMap(forUnit)`
Scans all living units for passive rules targeting `"spaces, around"` where the effect name is a known terrain type. Projects **virtual terrain** onto neighboring hexes. Used by movement cost calculations to treat aura-projected terrain like real terrain.

**Returns:** `Map<hexKey, [{surface, player}]>`

### `recalcAuras()`
Full recalculation of aura conditions across all units:
1. Strip all conditions with `duration: 'aura'` from all living units
2. Scan all passive rules with `around`/`adjacent` targeting
3. Resolve targets and apply aura-duration conditions

**Called after:** Any position change (move, push, pull, deploy, death, swap, grantability).

---

## 13. Terrain Immunity & Effective Rules

### `ignoresTerrainRule(unit, ruleName, q, r, terrainAuraMap?)`
Checks two passive effects:
- **`ignoreTerrainRule`** — value = comma-separated rule names (e.g. `"difficult,impassable"`). Skips globally regardless of surface.
- **`ignoreTerrain`** — value = comma-separated surface names (e.g. `"forest,brambles"`). Skips only negative rules (difficult, impassable, dangerous, poisonous, revealing) on matching surfaces.

Also checks aura-projected terrain via `terrainAuraMap`.

**Called by:** `getMoveRange()`, `getMovementContext()`, `onEnterHex()` in game-battle.js.

### `getEffectiveRules(unit, surface)`
Gets terrain rules for a surface as perceived by a unit. Applies `swapterrainrule` passive effects (format: `"surface:oldRule:newRule"`) to swap rules. Returns raw rules when unit is null.

---

## 14. EndActivation Interactive Targeting

Some abilities fire at end of activation and need the player to pick a target interactively.

### `getPendingEndActTarget()`
Returns the `pendingEndActTarget` object or null. UI checks this to enter interactive targeting mode.

### `computeEndActTargets(unit)`
Computes valid targets using tag-based filtering (`validTags`: ally, enemy, self, alldamaged; `invalidTags` for exclusion).

**Returns:** Array of `{ type, key, q, r, unit }`

### `executeEndActWithTarget(target)`
Fires the pending endActivation rules with the chosen target. Tracks once-per usage. Clears `pendingEndActTarget`.

### `clearPendingEndAct()`
Clears pending targeting state (on cancel).

---

## 15. Specialized Helpers

### Deploy Checks

| Function | Purpose |
|----------|---------|
| `hasDeployRule(template, effect)` | Check if unit template has a deploy-type rule with a specific effect (e.g. Scout on concealing terrain) |
| `getDeployTrapInfo(template)` | Get deploy trap info: `{ type, count, range }`. Value format: `"type,count"` |

### On-Attack (Toss)

| Function | Purpose |
|----------|---------|
| `hasOnAttackRules(unit)` | Does unit have any onAttack rules? (not silenced, not used) |
| `getTossSourceHexes(unit)` | Valid toss source positions (adjacent allies + terrain) → `Map<hexKey, target>` |
| `getTossDestHexes(targetQ, targetR)` | Unoccupied non-impassable hexes adjacent to attack target → `Set<hexKey>` |
| `getOnAttackBonusDamage(unit)` | Bonus damage value from onAttack rules |
| `getHitBonusDamage(unit, target)` | Predicted total bonus damage from hit rules whose conditions pass. Used for damage preview. |

### After-Move (Level, Teleport)

| Function | Purpose |
|----------|---------|
| `hasAfterMoveRules(unit)` | Does unit have afterMove rules? |
| `getAfterMoveData(unit)` | Get afterMove terrain options: `{ abilityName, terrainOptions[], oncePerGame }` |
| `markAbilityUsed(unit, abilityName)` | Mark ability as used (for once-per-game tracking outside dispatch) |
| `getAfterMoveTeleports(unit)` | Get afterMove teleport abilities: `[{ abilityName, oncePerGame, effectType, allowedTypes?, ruleId }]` |

### Resource Helpers

| Function | Purpose |
|----------|---------|
| `getMaxResource(unit, type)` | Max capacity from `maxresource` passive (default 1) |
| `getResourceCount(unit, type)` | Current resource count |
| `getPassiveResourceDefs(unit)` | Discover resource types: `{ type: maxValue }` |
| `getAllResourceTypes()` | All resource types across all deployed units |

### Other Helpers

| Function | Purpose |
|----------|---------|
| `getUnitTags(unit)` | Collect `tag` passive effect values (lowercase). Used by `computeActionTargets()`. |
| `resolveValue(valueStr, ctx)` | Dynamic value resolution. Handles: `unitsmove`, `unitsdamage`, `unitsrange`, `unitsarmor`, `targetmove`, `unitdamage`, `absorbedgifts`, `consumed<type>`, `resource<type>`, and plain integers. |
| `forEachRule(unit, opts, fn)` | Central rule iterator with type filtering, once-per-game skip, condition eval. |
| `forEachEffect(unit, opts, fn)` | Iterates individual effects within matching rules. Wraps `forEachRule`. |
| `applyRuleSideEffects(unit, ruleId, ctx)` | Apply all non-interactive effects from a rule. Used by teleport/level handlers that handle the primary effect themselves. |
| `findNearestTerrainByElement(unit, element)` | Find closest hex with terrain of specified element type. |

---

## 16. Integration Points

### game-core.js (3 calls)
| Call Site | Abilities Function | Purpose |
|-----------|-------------------|---------|
| `createUnit()` | `bindUnit(u)` | Resolve abilities at unit creation |
| `addCondition()` | `tryPreventCondition(unit, id)` | Gate conditions via passive immunity |
| `getEffective()` | `getPassiveMod(unit, stat)` | Add passive stat modifiers |

### game-battle.js (80+ calls)
Key integration points:

| Call Site | Abilities Function | Purpose |
|-----------|-------------------|---------|
| `selectUnit()` | `dispatch('afterSelect')` | Fire activation triggers |
| `selectUnit()` | `hasFlag('falcongust')`, `hasFlag('woundup')` | Check interactive activation abilities |
| `getMoveRange()` | `hasFlag('mobile')`, `ignoresTerrainRule()`, `getTerrainAuraMap()` | Movement budget, terrain immunity |
| `moveUnit()` | `recalcAuras()`, `hasAfterMoveRules()`, `dispatchMovement()` | Post-move aura recalc, afterMove triggers |
| `attackUnit()` | `checkMiss()`, `isHidden()`, `dispatch('afterAttack')`, `dispatch('afterDeath')`, `dispatchAllyDeath()` | Combat resolution + triggers |
| `completeEndActivation()` | `dispatch('endActivation')`, `dispatch('turnEnd')` | End-of-activation + turn-end triggers |
| `onEnterHex()` | `hasFlag('forestcharged')`, `getPassiveList('terrainresource')` | Terrain entry resource gains |
| `undoLastAction()` | Restores `usedAbilities`, `prevMarkers` | Undo support |

### game-phases.js (12+ calls)
| Call Site | Abilities Function | Purpose |
|-----------|-------------------|---------|
| `deployUnit()` | `hasDeployRule()`, `dispatch('afterDeploy')`, `getDeployTrapInfo()`, `hasFlag('deployterrain')` | Deploy rules and traps |
| `startRound()` | `dispatch('roundStart')`, `getPassiveList('refillresource')`, `getMaxResource()`, `hasFlag('dancer')`, `recalcAuras()` | Round-start triggers, resource refill |
| `endRound()` | `getPassiveList('resetresource')` | Resource reset |

### ui.js (90+ calls)
| Category | Key Calls | Purpose |
|----------|----------|---------|
| Action buttons | `getActions()`, `isActionAvailable()`, `getTargeting()`, `computeActionTargets()`, `executeAction()` | Build panel, validate, execute |
| Effect queue | `hasPendingEffects()`, `peekEffect()`, `getEffectTargetHexes()`, `resolveEffect()`, `skipEffect()`, `clearEffectQueue()` | Interactive push/pull/move drainage |
| EndActivation | `getPendingEndActTarget()`, `computeEndActTargets()`, `executeEndActWithTarget()`, `clearPendingEndAct()` | Interactive target picking |
| Resources | `getPassiveResourceDefs()`, `getMaxResource()`, `getAllResourceTypes()`, `getResourceCount()` | Resource display in battle panel |
| Passive checks | `hasFlag()`, `hasFlagPassive()`, `hasOnAttackRules()`, `hasAfterMoveRules()` | UI gating for buttons and highlights |

### units.js (2 calls)
| Call Site | Purpose |
|-----------|---------|
| `setAtomicRules(allAtomicRules)` | Load Layer 3 rules from Rules tab |
| `setAbilityDefs(allAbilityDefs)` | Load Layer 2 defs from Abilities tab |

---

## 17. Public API Reference

All functions exposed on the `Abilities` object:

```js
// Data Access
Abilities.atomicRules          // getter → atomicRules object
Abilities.abilityDefs          // getter → abilityDefs object
Abilities.setAtomicRules(data)
Abilities.setAbilityDefs(data)

// Unit Binding
Abilities.bindUnit(unit)

// Dispatch
Abilities.dispatch(trigger, ctx)              → boolean
Abilities.dispatchAllyDeath(deadUnit, killer)
Abilities.dispatchMovement(unit, occupant)

// Passives
Abilities.getPassiveMod(unit, stat)           → number
Abilities.getPassiveList(unit, effectName)    → string[]
Abilities.hasFlag(unit, flag)                 → boolean
Abilities.hasFlagPassive(unit, flag)          → boolean

// Combat Checks
Abilities.checkMiss(target, attacker)         → { abilityName, oncePerGame, oncePerRound } | null
Abilities.isHidden(unit)                      → boolean
Abilities.getReduceDamageCap(unit)            → number
Abilities.tryPreventCondition(unit, condId)   → boolean
Abilities.getHitBonusDamage(unit, target)     → number

// Auras
Abilities.recalcAuras()
Abilities.getTerrainAuraMap(forUnit)          → Map

// Deploy
Abilities.hasDeployRule(template, effect)     → boolean
Abilities.getDeployTrapInfo(template)         → { type, count, range } | null

// Terrain
Abilities.ignoresTerrainRule(unit, rule, q, r, auraMap?) → boolean
Abilities.getEffectiveRules(unit, surface)    → string[]

// Resources
Abilities.getMaxResource(unit, type)          → number
Abilities.getResourceCount(unit, type)        → number
Abilities.getPassiveResourceDefs(unit)        → { type: maxValue }
Abilities.getAllResourceTypes()               → string[]

// On-Attack (Toss)
Abilities.hasOnAttackRules(unit)              → boolean
Abilities.getTossSourceHexes(unit)            → Map
Abilities.getTossDestHexes(targetQ, targetR)  → Set
Abilities.getOnAttackBonusDamage(unit)        → number

// After-Move
Abilities.hasAfterMoveRules(unit)             → boolean
Abilities.getAfterMoveData(unit)              → { abilityName, terrainOptions[], oncePerGame } | null
Abilities.markAbilityUsed(unit, abilityName)
Abilities.applyRuleSideEffects(unit, ruleId, ctx?)
Abilities.getAfterMoveTeleports(unit)         → array

// Actions
Abilities.getActions(unit)                    → array of action descriptors
Abilities.isActionAvailable(unit, actionRuleId) → boolean
Abilities.getTargeting(abilityName, ruleId?)  → targeting object | null
Abilities.executeAction(abilityName, ctx, ruleId?)

// Tag-Based Targeting
Abilities.getUnitTags(unit)                   → string[]
Abilities.computeActionTargets(unit, targeting) → array of target entries
Abilities.resolveValue(valueStr, ctx)         → number | null

// EndActivation Interactive Targeting
Abilities.getPendingEndActTarget()            → object | null
Abilities.computeEndActTargets(unit)          → array
Abilities.executeEndActWithTarget(target)
Abilities.clearPendingEndAct()

// Effect Queue
Abilities.hasPendingEffects()                 → boolean
Abilities.peekEffect()                        → effect | null
Abilities.getEffectTargetHexes()              → Set | null
Abilities.resolveEffect(q, r)                 → boolean
Abilities.skipEffect()
Abilities.clearEffectQueue()

// Condition Lookup
Abilities.getConditionDefault(id)             → string | null
```

---

## 18. Execution Flow Examples

### Example: Unit Attacks With Hit Rules
```
1. Player clicks enemy unit
2. UI calls Game.attackUnit(targetHex)
3.   → checkMiss(target, attacker) — check dodgy/miss abilities
4.   → dispatch('whenAttacked', { unit: target, attacker }) — defensive triggers
5.   → Calculate damage (getEffective for dmg/armor, check precise, reduceDamageTo)
6.   → Apply damage to target
7.   → Process empowerments (burning/bonusdamage stored on attacker)
8.   → snapshotAllUnits() — for undo
9.   → dispatch('afterAttack', { unit: attacker, target, damage })
10.      → executeRules() for each matching hit rule
11.         → evaluateCondition() — check gates (resource, flanked, etc.)
12.         → resolveTargets() — find who/what to affect
13.         → applyEffect() for each effect — push/pull queued, conditions applied
14.  → If target dead: dispatch('afterDeath'), dispatchAllyDeath()
15.  → Return to UI — check hasPendingEffects()
16.  → If effects queued: enterEffectTargeting() loop
17.     → peekEffect() → getEffectTargetHexes() → highlight
18.     → Player clicks hex → resolveEffect(q, r) → repeat until drained
19.  → finishEffectQueue() → check auto-end activation
```

### Example: Player Uses Free Action
```
1. Player clicks action button (e.g. "X Marks the Spot")
2. UI reads action cost = "non-activation"
3.   → getTargeting(abilityName) — returns validTargets spec
4.   → computeActionTargets(unit, targeting) — highlight valid hexes
5. Player clicks valid hex
6.   → executeAction(abilityName, { unit, target, targetQ, targetR })
7.      → executeRules(ruleIds, 'playerAction', ctx)
8.         → applyEffect → applyPlaceMarker → adds to state.markers
9.   → act._nonActivationUsed = true (but unit can still move + attack)
10.  → Push actionHistory for undo
11.  → showActivationHighlights() — unit still has move + attack available
```

### Example: Passive Stat Calculation
```
1. Game needs unit's effective damage
2.   → Game.getEffective(unit, 'damage')
3.      → base = unit.damage
4.      → + condition modifiers (strengthened +1, weakness -1)
5.      → + Abilities.getPassiveMod(unit, 'damage')
6.         → forEachEffect(unit, { type: 'passive' }, ...)
7.            → Check each passive rule for 'damage' effect
8.            → Sum all matching values
9.            → Check resourcemod effects (e.g. +1 per mana)
10.     → Return total
```

---

## 19. Two-Rule Pattern

A core design pattern where an ability has **two rules with opposite conditions** so that only one fires depending on unit state. The condition column gates which variant applies.

### How It Works
Both rules are listed in the ability's `ruleIds`. During execution, `executeRules()` evaluates each rule's condition — only the matching variant fires.

### For Hit Rules (automatic)
`executeRules()` already evaluates conditions per-rule, so two hit rules with opposite conditions just work:
- `hit.Ability.Basic`: condition=`resource`, value=`lightning:<1` → fires when uncharged
- `hit.Ability.Charged`: condition=`resource`, value=`lightning:>=1` → fires when charged

### For Action Rules (via getActions dedup)
`getActions()` evaluates conditions across multiple action rules for the same ability and selects only the first matching variant. This produces ONE button, not two:
- `action.Ability`: condition=`resource`, value=`lightbeam,lightning:<1` → uncharged variant
- `action.Ability.Charged`: condition=`resource`, value=`lightbeam,lightning:>=1` → charged variant

Rule order in the ability def determines priority (first match wins).

### Multi-Resource Conditions
The `resource` condition evaluator supports comma-separated checks with AND logic:
- `lightbeam,lightning:>=1` → unit must have lightbeam >= 1 AND lightning >= 1
- `lightbeam,lightning:<1` → unit must have lightbeam >= 1 AND lightning < 1

### Example: Light Beam (Tidehaven)
```
Abilities tab:
  Light Beam → ruleIds: [action.LightBeam, action.LightBeam.Charged]

Rules tab:
  action.LightBeam:         condition=resource, value=lightbeam,lightning:<1
                             effects: consume lightbeam, placebeam vulnerable
  action.LightBeam.Charged: condition=resource, value=lightbeam,lightning:>=1
                             effects: consume lightbeam, placebeam vulnerable, piercing (unlimited)
```
- Without lightning: uncharged rule fires, beam stops at first enemy
- With lightning: charged rule fires, beam has piercing (penetrates through all enemies)
