# Ability Implementation Tracker

---

## Needs Testing

Code-complete but not verified in gameplay. Only move to Tested after user confirms.

### Syli (data-driven, all dispatched via spreadsheet)
- [ ] Empowered Poison (Purse) — hit.Poison, once-per-game
- [ ] Empowered Dizzy (Fion) — hit.Dizzy, once-per-game
- [ ] Touch Me Not (Jewel) — whenAttacked.dodge, once-per-game
- [ ] Dodgy (Hazel) — whenAttacked.dodge, once-per-round
- [ ] Trickster (Hazel) — action.move.swap.ally + action.attack.swap.ally
- [ ] Foul Hemolymph (Lidae) — whenAttacked.foul (weaken adjacent enemies)
- [ ] Zephyr (Ael) — action.relocate.rng.2 (push or pull 1)
- [ ] Harbringer (Celae) — hit.suppress + hit.vulnerable.1
- [ ] Furious Charge (Ocype) — hit.charge.3 (bonus dmg if 5+ from start)
- [ ] Serenity (Kinnara) — hit.heal.around.2 (allies in range heal 1)
- [ ] PBAoE (Kinnara) — hit.pbaoe.rng2.dmg1 (attack all enemies in range)
- [ ] Fae Fire (Light Weaver) — hit.vulnerable.1
- [ ] Life's Thread (Lotter) — hit.heal.line (allies in line heal 2)
- [ ] Infatuate (Laurel) — hit.taunt
- [ ] Entrancing (Smoak) — hit.weakness.2 + hit.pull.2
- [ ] Noroi (Kodama) — whenAttacked.curse.attacker + death.curse.attacker
- [ ] Cross Worlds (Ash) — hit.forests.bonusDmg.within.2

### Dusters (data-driven, dispatched via spreadsheet)
- [ ] Sand Stormed (faction rule) — Hidden in Sand
- [ ] Parting Gift system — all 12 death rules + ability defs
- [ ] Protector (Shield PG) — bonusarmor aura
- [ ] True Sight (Scope PG) — truesight bypasses Hidden/Cover/Concealing
- [ ] Sneak Attack (Sniper PG) — +1 dmg if attacker hidden
- [ ] Regen (Stimpak PG) — activation heal
- [ ] Tumbler (Slider PG) — move into enemies action
- [ ] Hidden (Cloak PG) — passive hidden
- [ ] Mobile (Greaves PG) — passive mobile
- [ ] Bump (Lance PG) — hit push + move self

### Stonehart
- [ ] All Stonehart abilities — via spreadsheet. Known issue: column 12 header typo may affect Lightning Rune card text.

### Red Ridge
- [ ] Fire Charged (faction rule) + 5 core abilities

---

## Needs Spreadsheet

Code handlers exist. Just needs rules/ability defs added to Google Sheets.

### Dusters — Existing effects, need sheet entries
- [ ] Shove (Lance, Bouncer) — hit.Push.1. Needs "Shove" ability def.
- [ ] Poison Attack (Ashen) — hit.Poison. Ability def may exist.
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
