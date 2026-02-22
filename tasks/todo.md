# Tirs of Traea — Master Todo

---

## Overarching Goals

### Rework Mana & Recharge into Unified Resource System
- [x] Phase 1: Code changes
  - [x] `refillresource` passive — refills resource to max at round start (for once-per-round)
  - [x] `isActionAvailable()` — UI hides action buttons when resource condition fails
  - [x] Dynamic debug resource dropdown — discovers types from deployed units
  - [x] Removed orphaned `empowered` condition (CONDITION_MODS, CONDITION_DEFAULTS, COND_ICONS, CSS)
- [ ] Phase 2: Spreadsheet migration (user)
  - [ ] Convert once-per-game abilities to deploy rule (gainresource) + resource condition + consume
  - [ ] Convert once-per-round abilities to same + refillresource passive
  - [ ] Convert Fire Charged / Forest Charged to damageresource / terrainresource passives
  - [ ] Test all affected factions (Red Ridge, Syli, Primordial Mists)
- [ ] Phase 3: Cleanup (after migration verified)
  - [ ] Remove oncePerGame/oncePerRound parsing and checks (9 dispatch sites + units.js)
  - [ ] Remove usedAbilities/usedAbilitiesThisRound system
  - [ ] Remove hardcoded Fire Charged / Forest Charged triggers
  - [ ] Remove applyRecharge() function

### Make Mobile Friendly
- [ ] Responsive layout — adapt board + panels to portrait/landscape mobile viewports
- [ ] Touch input — tap-to-select, tap-to-move, long-press for info (replace hover/Ctrl-hover)
- [ ] Pinch-to-zoom on hex board
- [ ] Mobile-friendly battle panel — collapsible, swipeable ability buttons
- [ ] Mobile-friendly roster builder / faction select
- [ ] Test on iOS Safari + Android Chrome

### Finish Abilities
- [ ] Complete all faction abilities (see tracker below)
- [ ] Wire remaining spreadsheet defs for Dusters, Syli, Primordial Mists
- [ ] Implement missing factions: Seri (partial), Soli, Tidehaven, Down Town
- [ ] Implement missing effects: `consumeall`, Chaos Telemental deploy-any-terrain picker
- [ ] Fix known bugs: litany/hymn rule ID mismatches, River Rush validTargets, Primordial Prelude

### Explore Native App Options
- [ ] **Godot**: Evaluate feasibility — hex grid rendering, GDScript vs C#, export targets (PC/Mac/iOS/Android/Web)
- [ ] **Alternatives**: Research other frameworks for cross-platform (PC/Mac/mobile) with async multiplayer + push notifications
  - Flutter, React Native, Tauri, Electron, Unity, or stay web-based with PWA + service workers
- [ ] **Async multiplayer**: Design turn notification system (push notifications on mobile, email/webhook fallback)
- [ ] **Data sync**: Evaluate backend options (Firebase, Supabase, custom) for game state persistence
- [ ] Make a decision and document rationale

---

# Ability Implementation Tracker

---

## Needs Testing

Code-complete but not verified in gameplay. Only move to Tested after user confirms.

### Syli (data-driven — missing defs only)
- [ ] Foul Hemolymph (Lidae) — NO DEF in abilityDefs, needs spreadsheet entry
- [ ] Harbringer (Celae) — NO DEF in abilityDefs, needs spreadsheet entry
- [ ] Honeydew (Ash) — NO DEF in abilityDefs, needs spreadsheet entry

### Dusters (smoke tested)
- [x] Sand Stormed (faction rule) — Hidden in Sand ✅ isHidden=true on sand, false off sand, non-Dusters false
- [x] Parting Gift system — grantAbility fires on death, closestAlly targeting ✅ (BUG FIXED: resolveTargets camelCase split)
- [x] Parting Gift chaining — inherited PGs transfer on subsequent death ✅ (Cloak→Ashen got both PG-Cloak + PG-Lance)
- [x] Poison Attack (Ashen) — hit.Poison applies poisoned condition ✅
- [x] Hidden (Cloak) — passive.hidden:always, blocks attacks from dist>1 ✅
- [x] Move undo — position restored correctly ✅
- [x] Attack undo — HP restored correctly ✅
- [ ] Protector (Shield PG) — NOT TESTED (Shield not in roster, needs spreadsheet def)
- [ ] True Sight (Scope PG) — NOT TESTED (Scope not in roster, needs spreadsheet def)
- [ ] Sneak Attack (Sniper PG) — NOT TESTED (needs spreadsheet def)
- [ ] Regen (Stimpak PG) — NOT TESTED (needs spreadsheet def)
- [ ] Tumbler (Slider PG) — NOT TESTED (needs spreadsheet def)
- [ ] Mobile (Greaves PG) — NOT TESTED (needs spreadsheet def)
- [ ] Absorber (Haboob) — NOT TESTED (Haboob not in roster, needs spreadsheet def)
- [ ] Collector (Shiney) — NOT TESTED (Shiney not in roster, needs spreadsheet def)

### Stonehart (smoke tested — previous session)
- [x] All Stonehart abilities — smoke tested. Earth Rune bug found & fixed (resolveTargets hex fallback).

### Red Ridge (smoke tested — previous session)
- [x] Fire Charged (faction rule) + 5 core abilities — smoke tested. hasFlag case-sensitivity bug found & fixed.

### Dusters Smoke Test Summary (2026-02-20)
**BUG FOUND & FIXED:** `resolveTargets()` camelCase tokenizer broke compound keywords (`closestAlly`, `deadAlly`, `allAllies`, `allEnemies`). CamelCase split turned `closestAlly` into tokens `{closest, ally}` but checks looked for `closestally` as single token. **Fix:** check `joined` (pre-tokenized lowercase) for compound keywords instead of `tokens`. This blocked ALL Parting Gift grantability effects and would have affected allAllies/allEnemies hymn targets.

**Resolved abilities (4):** Poison Attack, Parting Gift - Cloak, Hidden, Parting Gift - Lance
**Faction-wide ability:** "Dusters" → `passive.hidden.sand` ✅
**Missing ability defs (13):** HAZWOPER, Shifting Winds, Plagued Memories, Remember - Affliction, Flanker: Brutal, Deprived Recollection, Remember - Hunger, Enfeebling Attack, Sanguine Echoes, Remember - Slaughter, Sand Elemental, Sweeping, Shove

**Legendary passives (3 in game-battle.js):** `plaguedmemories`, `sanguineechoes`, `dutifulreflection` — all need passive flag rules in spreadsheet to expose `hasFlag()` checks.
**No code exists:** `deprivedrecollection` — only a specialRule name, needs full action ability def in spreadsheet.
**Remember abilities (3):** Need allyDeath type rules in spreadsheet — `dispatchAllyDeath()` code path is confirmed working.

---

## Needs Spreadsheet

Code handlers exist. Just needs rules/ability defs added to Google Sheets.

### Dusters — Existing effects, need sheet entries
- [x] Poison Attack (Ashen) — hit.Poison ✅ WORKS (ability def exists)
- [ ] Shove (Lance, Bouncer) — hit.Push.1. Needs "Shove" ability def.
- [ ] HAZWOPER (Hook, Diffuser, Aeolus, Bouncer) — `passive.hazwoper`, effect=`ignoreTerrainRule`, value=`dangerous,poisonous`
- [ ] Shifting Winds (Aeolus) — `action.shiftingwinds`, effect=`relocate` (same as Tree Song for shifting terrain)
- [ ] Enfeebling Attack (Dearth) — `hit.weakness.1`

### Dusters — Code done, need sheet wiring
- [ ] Flanker: Brutal (Cloak) — `targetAdjAlly` condition done. Sheet: hit rule, condition=`targetAdjAlly`, condValue=`>=1`, effect=`bonusDamage`, value=`2`
- [ ] Hover (Jump Pack) — whenAttacked + relocate exist. Sheet: whenAttacked rule, target=self, effect=relocate
- [ ] Hook Pull (Hook) — hit + move + pull exist. Sheet: hit rule, effect1=move value=1, effect2=pull value=1
- [ ] Diffuser (Diffuser) — `onTerrain` condition + `destroyTerrain` effect done. Sheet: two activation rules with condition=`onTerrain`, condValue=`dangerous`
- [ ] Collector (Shiney) — grantability hook done. Sheet: passive rule with `collector` tag
- [ ] Haboob death damage — absorber redirect + `absorbedGifts` value done. Sheet: passive `absorber` tag + death rule, target=`enemy around self`, range=2, effect=damage, value=`absorbedGifts`

### Dusters — Legendaries (code done, need sheet passive flags)
- [ ] Plagued Memories (Ashen) — `plaguedmemories` flag hook done. Sheet: passive rule with `plaguedmemories` tag
- [ ] Sanguine Echoes (Enmity) — `sanguineechoes` flag hook done. Sheet: passive rule with `sanguineechoes` tag

### Dusters — Remember Abilities (allyDeath trigger done)
- [ ] Remember - Affliction (Ashen) — Sheet: type=`allyDeath`, target=killer, effect=`poisoned`
- [ ] Remember - Conquest (Apocrypha) — Sheet: type=`allyDeath`, target=`closestAlly`, effect=`heal`, value=1
- [ ] Remember - Hunger (Dearth) — Sheet: type=`allyDeath`, target=killer, effect=`weakness`

---

## Needs Spreadsheet (code done)

### Dusters — Legendaries
- [ ] Dutiful Reflection (Apocrypha) — Code done (`dutifulreflection` flag). Sheet: passive rule with `dutifulreflection` tag
- [ ] Deprived Recollection (Dearth) — Code done (`bonusactivation` effect). Sheet: action rule, effect1=damage/1/self, effect2=damage/1/ally, effect3=bonusactivation/ally
- [ ] Remember - Slaughter (Enmity) — Code done (`laststand` effect). Sheet: allyDeath rule, target=`deadAlly`, effect=`laststand`
- [ ] Sand Elemental (Haboob) — Deploy terrain code done (`deployterrain` flag). Sheet: passive rule with `deployterrain` tag (value = terrain name). "Is Earth Terrain" NOT yet implemented.

### Syli
- [ ] Honeydew (Ash) — Code done (`placeterrain` effect + `healing` terrain + Manna→Forest). Sheet: allyDeath rule, target=`deadAlly`, effect=`placeterrain`, value=`manna`. Also needs Manna in terrain sheet with `healing` rule.

---

## Tested & Confirmed

Verified working by user in gameplay.

### Primordial Mists
- [x] Teleport Through Earth — `teleportthrough: earth` via spreadsheet
- [x] Teleport Through Water — `teleportthrough: water` via spreadsheet
- [x] Teleport Through Air — `teleportthrough: air` via spreadsheet
- [x] Teleport Through Chaos — `teleportthrough: chaos`, cross-element teleportation (all terrain in one pool)
- [x] Sharp Thorn (Briar Thorn / Pointy Thicket) — hit: consume mana → burning; whenAttacked: consumeall mana → damage permana
- [x] Stone Armor (Crag Keeper) — passive `resourcemod` mana:armor:1
- [x] Fen Shadow — hit pull 2 (interactive, allows orbiting around source)
- [x] Veiled Stalker — whenAttacked consume mana + reducedamageto, Grasping Bog aura immobilize

### Syli (data-driven — smoke tested)
- [x] Empowered Poison (Purse) — hit.Poison, once-per-game ✅
- [x] Empowered Dizzy (Fion) — hit.Dizzy, once-per-game ✅
- [x] Fae Fire (Light Weaver) — hit.vulnerable.1 ✅
- [x] Infatuate (Laurel) — hit.taunt ✅
- [x] Serenity (Kinnara) — hit.heal.around.2 ✅
- [x] PBAoE (Kinnara) — hit.pbaoe.rng2.dmg1 ✅
- [x] Entrancing (Smoak) — hit.weakness.2 + hit.pull.2 ✅
- [x] Furious Charge (Ocype) — hit.charge.3 ✅
- [x] Life's Thread (Lotter) — hit.heal.line ✅
- [x] Cross Worlds (Ash) — hit.forests.bonusDmg.within.2 ✅
- [x] Touch Me Not (Jewel) — whenAttacked.dodge, once-per-game ✅
- [x] Dodgy (Hazel) — whenAttacked.dodge, once-per-round ✅
- [x] Noroi (Kodama) — whenAttacked.curse + death.curse (permanent) ✅
- [x] Mobile (Purse, Acroci) — passive flag ✅
- [x] Hidden/Forest (Boni) — hidden on forest, not hidden off ✅
- [x] Precise (Way Watcher) — passive flag ✅
- [x] Guardian (Lyair) — flag + lethal intercept teleport ✅
- [x] Dancer (Falling Leaf) — passive flag ✅
- [x] Trickster (Hazel) — action swap positions with ally ✅
- [x] Zephyr (Ael) — action relocate unit ✅
- [x] Tree Song (Kodama) — action relocate forest terrain ✅
- [x] Toter (Acroci) — afterMove teleportally, alliesPassedDuringMove tracking ✅
- [x] Trapper: Spike (Way Watcher) — deploy spike trap (2 dmg + immobilize) ✅
- [x] Forest Charged (faction rule) — recharge usedAbilities on entering forest ✅

### Primordial Mists (smoke tested)
**Spirit Passives:**
- [x] Earth Spirit — teleportthrough:earth + mana from earth terrain ✅
- [x] Air Spirit — teleportthrough:air + mana from air terrain ✅
- [x] Water Spirit — teleportthrough:water ✅ (MISSING: mana.from.water rule in Abilities tab)
- [x] Chaos Spirit — teleportthrough:chaos ✅ (MISSING: mana.from.any rule in Abilities tab)
- [x] Mobile — all spirits have flag ✅
- [x] Stone Armor (resourcemod mana:armor:1) — Crag Keeper +1 armor per mana ✅

**Hit Effects (all consume mana):**
- [x] Tangled Roots — immobilize ✅
- [x] Hard Stone — bonus damage ✅
- [x] Sharp Thorn — burning ✅
- [x] Flowing River — push 2 (interactive) ✅
- [x] Grasping Bog — pull 2 (interactive) ✅
- [x] Rejuvenating Rain — self heal ✅
- [x] Chilling Mist — vulnerable ✅
- [x] Gusting Gale — push 1 + splash damage ✅
- [x] Nothing — silenced ✅

**WhenAttacked:**
- [x] Sharp Thorn Retaliate — damage fires ✅ (BUG: `consumeall` effect not implemented, mana not spent)
- [x] Chilling Mist Reduce — reducedamageto works, mana consumed ✅
- [x] Nothing Dodge — grants dodgy condition for next attack, mana consumed ✅

**Elemental Passives (10/10):**
- [x] isTerrain — 9/9 non-chaos elementals correctly tagged with surface+element ✅
- [x] deployTerrain — all 10 elementals have flag ✅
- [ ] Breaching Void (Chaos) — isTerrain:false (known: needs interactive terrain-type picker)

**Song/Move Actions:**
- [x] Rock Rumble (rubble relocate) — full execute + interactive placement ✅
- [x] Thorny Tanto (brambles) — targeting works ✅
- [x] Marsh Murmur (bog) — targeting works ✅
- [x] Rainy Refrain (rain) — targeting works ✅
- [x] Creeping Shroud (mist) — targeting works ✅
- [x] Winds Whistle (gale) — targeting works ✅
- [x] Tempest Tune (storm) — targeting works ✅
- [ ] River Rush — ❌ FAIL: validTargets="Water" but surface is "pool" (spreadsheet data fix)
- [ ] Primordial Prelude — ❌ FAIL: `placedterrain` validTargets not implemented in code

**Litany/Hymn System:**
- [x] Litany fires: consume mana → increment hymnRepetition ✅ (tested with corrected rule ID)
- [x] Hymn fires at rep 3: allallies get strengthened ✅ (tested with corrected rule ID)
- [ ] ❌ BUG: ALL 9 litany+hymn ability defs have wrong rule IDs (e.g. `hit.litanyofpower` vs actual `hit.litany.of.power`)

**AfterMove:**
- [x] Flowing River — teleportAlly afterMove, gates on mana, tracks alliesPassedDuringMove ✅

**Missing Effect Handlers:**
- [ ] `consumeall` — not implemented (Sharp Thorn retaliate needs it)

**Missing Spreadsheet Wiring:**
- [ ] Water Spirit: needs `passive.mana.from.water` + `passive.use.mana.max.1` in Abilities tab
- [ ] Chaos Spirit: needs `passive.mana.from.any` + `passive.use.mana.max.1` in Abilities tab
- [ ] Flighty Storm: NO DEF in abilityDefs
- [ ] All 9 litany defs: wrong rule IDs (concatenated vs dotted)
- [ ] All 9 hymn defs: wrong rule IDs (concatenated vs dotted)
- [ ] River Rush: validTargets should be "Pool" not "Water"

### Seri
- [x] Light's Shadow (faction rule) — `swapterrainrule: fae mist:revealing:concealing`, terrain rule swap system
- [x] One with Shadow — `teleportthrough: concealing`, rule-based teleportation

---

## Completed

### Syli — Faction Rules
- [x] Fae Walkers — ignore forest/brambles penalties
- [x] Forest Charged — recharge abilities on entering forest

### Syli — Custom Code
- [x] Guardian (Lyair) — end-of-turn guard targeting + lethal intercept
- [x] Dancer (Falling Leaf) — round-start poise choice
- [x] Trapper: Spike (Way Watcher) — deploy spike traps
- [x] Tree Song (Kodama) — terrain relocate
- [x] Toter (Acroci) — afterMove teleport ally

### Dusters — Core Systems
- [x] closestAlly target resolution
- [x] grantability effect (transfers ability defs)
- [x] statmod effect (direct base stat changes)
- [x] Spreadsheet wiring — all 12 Parting Gift variants
- [x] allyDeath trigger — `dispatchAllyDeath()` fires on surviving allies
- [x] targetAdjAlly condition — for Flanker: Brutal
- [x] onTerrain condition + destroyTerrain effect — for Diffuser
- [x] Collector hook — +1 damage per grantability in grantability handler
- [x] Haboob absorber redirect — intercepts grantability, tracks `_absorbedGifts`
- [x] absorbedGifts value resolver — death rule can reference gift count
- [x] Plagued Memories pre-damage hook — deal 1 to allies within 3, reduce incoming
- [x] Sanguine Echoes pre-damage hook — closest ally within 3 takes excess damage

### Dusters — Legendaries (Phase 2)
- [x] Dutiful Reflection (Apocrypha) — pre-attack target redirect, pulls closest ally to intercept
- [x] Bonus activation queue system — `queueBonusActivation()`, nextTurn check, _bonusActivation flag
- [x] bonusactivation effect — grants target a bonus activation (for Deprived Recollection)
- [x] laststand effect + deadally target — dying unit revives at 1 HP, activates, then dies
- [x] Sand Elemental deploy terrain — interactive placement (like traps), empty hexes not in enemy zone

### Terrain Effects (Phase 2)
- [x] placeterrain effect — places terrain at target hex
- [x] healing terrain rule — allies entering heal 1 (for Manna/Honeydew)
- [x] Manna→Forest end-of-round conversion — after evanescent step

### Primordial Mists — Core Systems
- [x] `extraNeighborsFn` in Board.getReachableHexes() — generic portal/teleport BFS extension with per-neighbor cost
- [x] "Is Terrain" flag (`_isTerrain`, `_isTerrainSurface`, `_isTerrainElement`) in bindUnit()
- [x] `getTerrainElementAt(q, r)` — terrain element lookup including is-terrain units
- [x] Spirit teleportation in getMoveRange() + getMovementContext() — cost-0 portals between matching-element terrain
- [x] Teleport-aware path traversal in moveUnit() — skips Punish/occupant checks for non-adjacent steps
- [x] Fix deployterrain value reading — getPassiveList instead of getPassiveMod for string terrain names
- [x] Hymns of Creation — litany effect increments per-player repetition counter, hymn fires at 3
- [x] `allallies`/`allenemies` target types in resolveTargets()
- [x] `pushfromterrain`/`pulltoterrain` effects + `findNearestTerrainByElement()` helper
- [x] Hymn repetition HUD display (♪ N/3) for Primordial Mists players
- [x] Attack undo expanded: healthSnapshots capture conditions/positions/resources + hymnRepetition restore
- [x] Litany of Potential — `replace` effect, interactive unit selection UI, `executeReplacement()` in game-battle.js
- [x] `covered` condition — ray-cast for cover terrain between attacker/target
- [x] `flanked` condition — direction-aware check for allies opposite the target

---

## Future Factions
- Seri — Light's Shadow + One with Shadow done. Needs: remaining unit abilities, spreadsheet wiring.
- Soli — Not Started
- Tidehaven — Not Started
- Primordial Mists — Spirit Teleportation + Is Terrain + Hymns of Creation + Litany of Potential done. Needs: mana system (resource primitives done), terrain-move variants, signature passives, spreadsheet wiring.
  - [ ] Chaos Telemental — deploy any terrain type
- Down Town — Not Started

---

## Notes
- All "data-driven" abilities have rules in the Rules tab + defs in the Abilities tab. The dispatch system handles them automatically.
- `whenAttacked`, `swap`, `heal`, `bonusDamagePerTerrain`, `lineToTarget`, `miss`, PBAoE, `death` trigger — all implemented in abilities.js.
- `suppressed` condition: gating in selectUnit(), clearing in completeEndActivation().
- `relocateTerrain` effect: supports Tree Song and Shifting Winds.
- `ignoreTerrainRule` passive: comma-separated rule names.
- `closestAlly` target: returns single closest alive ally.
- `grantability`: transfers abilities, redirects to absorber in range, triggers Collector +1 dmg.
- `statmod`: `stat:N` (add) or `stat=V` (set).
- `bonusarmor` condition: +1 armor via CONDITION_MODS.
- `truesight` flag: bypasses Hidden/Cover/Concealing in canAttack().
- `hidden` evaluator: conditional bonus damage for Sneak Attack.
- `onTerrain` condition: checks unit standing on terrain with specific rule.
- `destroyTerrain` effect: nulls terrain surface at target positions.
- `targetAdjAlly` condition: checks target has attacker's allies adjacent.
- `absorbedGifts` value: reads `unit._absorbedGifts` for Haboob death damage.
- `plaguedmemories` flag: pre-damage hook in attackUnit(), once/round.
- `sanguineechoes` flag: pre-damage hook in attackUnit(), once/round.
- `dutifulreflection` flag: pre-attack target redirect in attackUnit(), pulls closest ally within 3, once/round.
- `placeterrain` effect: places terrain at target hex position.
- `healing` terrain rule: allies entering heal 1 (owner check via terrain.player).
- Manna→Forest: end-of-round step in game-phases.js converts manna terrain to forest.
- `deployterrain` flag: interactive terrain placement on deploy (like traps). Uses `pendingDeployTerrain` state.
- `bonusactivation` effect: queues target for bonus activation via `queueBonusActivation()`.
- Bonus activation queue: `G.state.bonusActivations[]`, checked at start of `nextTurn()`. Unit gets `_bonusActivation` flag.
- `laststand` effect: revives `deadAlly` at 1 HP, queues bonus activation. Cleaned up in `completeEndActivation()`.
- `deadally` target type: resolves to `ctx.deadAlly` in `resolveTargets()`.
- Teleport Through: `teleportthrough` passive flag. Values can be element names (`earth`, `water`, `air`, `fire`, `chaos`) or terrain rule names (`concealing`, `difficult`, etc.). Element matching uses `info.element`; rule matching uses `getEffectiveRules()` for per-unit perception. Portals grouped by match key. Uses `buildSpiritPortals()` in game-battle.js + `extraNeighborsFn` in Board.getReachableHexes().
- `swapterrainrule` passive: value format `surface:oldRule:newRule` (e.g. `fae mist:revealing:concealing`). `getEffectiveRules(unit, surface)` in abilities.js applies swaps. `hasTerrainRule(q,r,rule,unit)` in game-battle.js uses it when unit param provided. Threaded into onEnterHex, getMoveRange, getMovementContext, selectUnit (invigorating), isHidden.
- "Is Terrain": `isterrain` passive flag (value=surface like `forest`). Sets `unit._isTerrain`, `_isTerrainSurface`, `_isTerrainElement`. Checked by `getTerrainElementAt()` for Spirit portals.
- Teleport path traversal: non-adjacent path steps (hexDistance > 1) skip Punish and occupant/Tumbler checks. `onEnterHex` still fires at destination.
