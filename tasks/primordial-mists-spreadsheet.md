# Primordial Mists — Complete Spreadsheet Rules

All missing rules for the Primordial Mists faction.
- Lines marked **✅** work with existing code
- Lines marked **⚠️** need new code effects before they'll function

---

## PART 1: RULES TAB

Columns: `ruleName | Special Rule | Type | Action | Condition | Condition Value | validTargets | invalidTargets | Range | Effect 1 | Value 1 | Effect 2 | Value 2 | Effect 3 | Value 3 | Effect 4 | Value 4`

Empty cells left blank below. Each row is one rule.

---

### A. Mana Resource Rules (3 rules)

These give Water/Air/Chaos Spirits the same mana-on-terrain-entry that Earth Spirit already has.

| ruleName | Special Rule | Type | E1 | V1 |
|---|---|---|---|---|
| passive.mana.from.water | mana.from.water | passive | terrainresource | water:mana:1 |
| passive.mana.from.air | mana.from.air | passive | terrainresource | air:mana:1 |
| passive.mana.from.any | mana.from.any | passive | terrainresource | any:mana:1 |

> ✅ water and air work — code already checks element name
> ⚠️ `any:mana:1` needs 1-line code fix in terrainresource handler: add `|| match === 'any'` to the surface/element check

---

### B. Signature Hit Rules — On Attack (9 rules) ✅

All follow the pattern: condition=resource/mana gate, consume mana:1, then apply effect to target (or self for heal).

| ruleName | Special Rule | Type | Cond | CondVal | vTargets | E1 | V1 | E2 | V2 | E3 | V3 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| hit.TangledRoots.Immob | TangledRoots.Immob | hit | resource | mana | target | consume | mana:1 | immobilized | endOfRound | | |
| hit.SharpThorn.Burning | SharpThorn.Burning | hit | resource | mana | target | consume | mana:1 | burning | permanent | | |
| hit.FlowingRiver.Push | FlowingRiver.Push | hit | resource | mana | target | consume | mana:1 | push | 2 | | |
| hit.GraspingBog.Pull | GraspingBog.Pull | hit | resource | mana | target | consume | mana:1 | pull | 2 | | |
| hit.RejuvenatingRain.Heal | RejuvenatingRain.Heal | hit | resource | mana | self | consume | mana:1 | heal | 1 | | |
| hit.ChillingMist.Vuln | ChillingMist.Vuln | hit | resource | mana | target | consume | mana:1 | vulnerable | endOfRound | | |
| hit.GustingGale.Push | GustingGale.Push | hit | resource | mana | target | consume | mana:1 | push | 1 | splashdamage | 1 |
| hit.FlightyStorm.Weakness | FlightyStorm.Weakness | hit | resource | mana | target | consume | mana:1 | weakness | endOfRound | | |
| hit.Nothing.Silence | Nothing.Silence | hit | resource | mana | target | consume | mana:1 | silenced | endOfRound | | |

> ✅ All work except:
> ⚠️ `hit.GustingGale.Push` — `splashdamage` effect needs code (deal 1 dmg to enemy adjacent to pushed target)

---

### C. Signature WhenAttacked Rules (5 rules)

| ruleName | Special Rule | Type | Cond | CondVal | vTargets | E1 | V1 | E2 | V2 | E3 | V3 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| whenAttacked.Nothing.Dodge | Nothing.Dodge | whenAttacked | resource | mana | self | consume | mana:1 | dodgy | endOfRound | | |
| whenAttacked.SharpThorn.Retaliate | SharpThorn.Retaliate | whenAttacked | resource | mana | attacker | consumeall | mana | damage | permana | | |
| whenAttacked.ChillingMist.Reduce | ChillingMist.Reduce | whenAttacked | resource | mana | self | consume | mana:1 | reducedamageto | 1 | | |
| whenAttacked.GustingGale.Evade | GustingGale.Evade | whenAttacked | resource | mana | self | consume | mana:1 | move | 2 | reducedamage | 1 |
| whenAttacked.FlightyStorm.Evade | FlightyStorm.Evade | whenAttacked | resource | mana | self | consume | mana:1 | move | 2 | reducedamage | 1 |

> ✅ `whenAttacked.Nothing.Dodge` works (consume + dodgy condition)
> ⚠️ `whenAttacked.SharpThorn.Retaliate` — needs `consumeall` (spend all mana) + `permana` (damage = amount consumed)
> ⚠️ `whenAttacked.ChillingMist.Reduce` — needs `reducedamageto` effect (set incoming damage to N)
> ⚠️ `whenAttacked.GustingGale.Evade` / `FlightyStorm.Evade` — needs `reducedamage` (subtract N from incoming) + self-`move` on whenAttacked

---

### D. Signature Passive / Other Rules (4 rules) ⚠️

| ruleName | Special Rule | Type | Cond | CondVal | vTargets | Range | E1 | V1 | E2 | V2 |
|---|---|---|---|---|---|---|---|---|---|---|
| passive.TangledRoots.Prevent | TangledRoots.Prevent | passive | | | self | | preventcondition | mana:1 | | |
| passive.GraspingBog.Aura | GraspingBog.Aura | passive | resource | mana | | 1 | aura | immobilized | | |
| afterMove.FlowingRiver.Pull | FlowingRiver.Pull | afterMove | resource | mana | | | consume | mana:1 | pullthrough | ally |
| movement.RejuvenatingRain.Cleanse | RejuvenatingRain.Cleanse | movement | resource | mana | movedthrough.ally | | consume | mana:1 | heal | 1 |

> ⚠️ ALL need new code:
> - `preventcondition` — on gaining condition, spend mana to prevent it
> - `aura immobilized` — while unit has mana, adjacent enemies are immobilized
> - `pullthrough ally` — pull ally you moved through to your position (afterMove trigger)
> - `movedthrough.ally` target — allies on path during movement

---

### E. Elemental Passives — IsTerrain + Deploy (10 rules) ✅

Each combines isterrain (unit counts as that terrain for teleportation) with deployterrain (place terrain on deploy).

| ruleName | Special Rule | Type | vTargets | E1 | V1 | E2 | V2 |
|---|---|---|---|---|---|---|---|
| passive.ForestElemental | ForestElemental | passive | self | isterrain | forest | deployterrain | forest |
| passive.RockElemental | RockElemental | passive | self | isterrain | rubble | deployterrain | rubble |
| passive.BrambleElemental | BrambleElemental | passive | self | isterrain | brambles | deployterrain | brambles |
| passive.RiverElemental | RiverElemental | passive | self | isterrain | pool | deployterrain | pool |
| passive.BogElemental | BogElemental | passive | self | isterrain | bog | deployterrain | bog |
| passive.RainElemental | RainElemental | passive | self | isterrain | rain | deployterrain | rain |
| passive.MistElemental | MistElemental | passive | self | isterrain | mist | deployterrain | mist |
| passive.WindElemental | WindElemental | passive | self | isterrain | gale | deployterrain | gale |
| passive.StormElemental | StormElemental | passive | self | isterrain | storm | deployterrain | storm |
| passive.ChaosElemental | ChaosElemental | passive | | deployterrain | any | | |

> ✅ All work — isterrain and deployterrain both exist
> ⚠️ Chaos Elemental `deployterrain any` needs code to present terrain-type choice (currently only deploys a fixed surface)

---

### F. Song / Move Action Rules (9 rules)

Terrain relocation abilities. All use `action` type with `Action=Move`. Some have bonus effects on units in the terrain's path.

| ruleName | Special Rule | Type | Action | vTargets | E1 | V1 | E2 | V2 |
|---|---|---|---|---|---|---|---|---|
| action.rockrumble | rockrumble | action | Move | Rubble | relocate | | protected | movedthrough.ally |
| action.thornytanto | thornytanto | action | Move | Brambles | relocate | | | |
| action.riverrush | riverrush | action | Move | Water | relocate | | push | movedthrough.1 |
| action.marshmurmur | marshmurmur | action | Move | Bog | relocate | | poisoned | movedthrough.enemy |
| action.rainyrefrain | rainyrefrain | action | Move | Rain | relocate | | | |
| action.creepingshroud.move | creepingshroud.move | action | Move | Mist | relocate | | | |
| action.windswhistle.move | windswhistle.move | action | Move | Gale | relocate | | | |
| action.tempesttune | tempesttune | action | Move | Storm | relocate | | | |
| action.primordialprelude | primordialprelude | action | Move | placedterrain | relocate | | | |

> ✅ Simple relocate (thornytanto, rainyrefrain, creepingshroud.move, windswhistle.move, tempesttune) — same pattern as existing Tree Song
> ⚠️ `movedthrough.ally` / `movedthrough.enemy` / `movedthrough.1` — bonus effects on units in relocate path need code
> ⚠️ `Water` as validTargets — element-based targeting (match Pool/Bog/Rain) needs code (or change to `"Pool, Bog, Rain"`)
> ⚠️ `placedterrain` — Primordial Prelude moves any terrain placed by the player (or any Elemental unit), needs custom targeting

---

### G. Activation Rules — Terrain Creation (2 rules) ⚠️

Creeping Shroud and Winds Whistle create terrain each activation, in addition to their Move action.

| ruleName | Special Rule | Type | vTargets | E1 | V1 | E2 | V2 |
|---|---|---|---|---|---|---|---|
| activation.creepingshroud | creepingshroud.create | activation | adjacentto.mist, empty | placeterrain | mist | damage | allenemies.inmist.1 |
| activation.windswhistle | windswhistle.create | activation | adjacentto.gale, empty | placeterrain | gale | | |

> ⚠️ Both need code:
> - `adjacentto.mist` / `adjacentto.gale` target — select empty hex adjacent to existing terrain of that type
> - `allenemies.inmist.1` — deal 1 damage to all enemies standing on mist terrain (Creeping Shroud only)

---

### H. Litany Hit Rules (9 rules) ✅

Each consumes mana and increments the Hymns of Creation repetition counter. The `litany` effect's value names the Hymn ability def to dispatch at 3 repetitions.

| ruleName | Special Rule | Type | Cond | CondVal | E1 | V1 | E2 | V2 |
|---|---|---|---|---|---|---|---|---|
| hit.litanyoflife | litany.of.life | hit | resource | mana | consume | mana:1 | litany | Hymn of Life |
| hit.litanyofprotection | litany.of.protection | hit | resource | mana | consume | mana:1 | litany | Hymn of Protection |
| hit.litanyofpower | litany.of.power | hit | resource | mana | consume | mana:1 | litany | Hymn of Power |
| hit.litanyofcurrents | litany.of.currents | hit | resource | mana | consume | mana:1 | litany | Hymn of Currents |
| hit.litanyofenticement | litany.of.enticement | hit | resource | mana | consume | mana:1 | litany | Hymn of Enticement |
| hit.litanyofshivers | litany.of.shivers | hit | resource | mana | consume | mana:1 | litany | Hymn of Shivers |
| hit.litanyofguidance | litany.of.guidance | hit | resource | mana | consume | mana:1 | litany | Hymn of Guidance |
| hit.litanyofdread | litany.of.dread | hit | resource | mana | consume | mana:1 | litany | Hymn of Dread |
| movement.litanyofpotential | litany.of.potential | movement | | | replaceterrain | | gainresource | mana:1 |

> ✅ First 8 litanies work — consume + litany dispatch chain exists
> ⚠️ Litany of Potential is movement-triggered (not hit): "when leaving terrain you placed, may replace with any terrain, gain mana, increment repetitions." Needs custom movement hook + interactive terrain choice.
> **Note**: Litany of Potential also needs a 3rd effect: `litany | Hymn of Potential` — but the movement rule only has E3/V3 columns available. You may need to chain this or add the litany effect as E3/V3.

Full Litany of Potential row (with 3 effects):

| ruleName | Special Rule | Type | E1 | V1 | E2 | V2 | E3 | V3 |
|---|---|---|---|---|---|---|---|---|
| movement.litanyofpotential | litany.of.potential | movement | replaceterrain | | gainresource | mana:1 | litany | Hymn of Potential |

---

### I. Hymn Rules (9 rules) ✅

Dispatched automatically when repetition counter hits 3. Type `hymn` in the trigger system.

| ruleName | Special Rule | Type | vTargets | E1 | V1 |
|---|---|---|---|---|---|
| hymn.hymnoflife | hymn.of.life | hymn | allallies | heal | 1 |
| hymn.hymnofprotection | hymn.of.protection | hymn | allallies | protected | endOfRound |
| hymn.hymnofpower | hymn.of.power | hymn | allallies | strengthened | endOfRound |
| hymn.hymnofcurrents | hymn.of.currents | hymn | allenemies | pushfromterrain | water |
| hymn.hymnofenticement | hymn.of.enticement | hymn | allenemies | pulltoterrain | water |
| hymn.hymnofshivers | hymn.of.shivers | hymn | allenemies | vulnerable | endOfRound |
| hymn.hymnofguidance | hymn.of.guidance | hymn | allallies | move | 1 |
| hymn.hymnofdread | hymn.of.dread | hymn | allenemies | weakness | endOfRound |
| hymn.hymnofpotential | hymn.of.potential | hymn | self | replace | |

> ✅ Most work — heal, conditions, pushfromterrain, pulltoterrain, replace all exist
> ⚠️ `hymn.hymnofguidance` — `move 1` targeting `allallies` needs interactive per-unit movement (move each ally 1 space)

---

## PART 2: ABILITIES TAB

Columns: `Abilities | 1/game | 1/round | Ability1 | Ability2 | Ability3 | Ability4`

---

### A. Signature Abilities (9 new entries)

Each references its hit rule + defensive/passive rule.

| Abilities | 1/game | 1/round | Ability1 | Ability2 |
|---|---|---|---|---|
| Tangled Roots | FALSE | FALSE | hit.TangledRoots.Immob | passive.TangledRoots.Prevent |
| Sharp Thorn | FALSE | FALSE | hit.SharpThorn.Burning | whenAttacked.SharpThorn.Retaliate |
| Flowing River | FALSE | FALSE | hit.FlowingRiver.Push | afterMove.FlowingRiver.Pull |
| Grasping Bog | FALSE | FALSE | hit.GraspingBog.Pull | passive.GraspingBog.Aura |
| Rejuvenating Rain | FALSE | FALSE | hit.RejuvenatingRain.Heal | movement.RejuvenatingRain.Cleanse |
| Chilling Mist | FALSE | FALSE | hit.ChillingMist.Vuln | whenAttacked.ChillingMist.Reduce |
| Gusting Gale | FALSE | FALSE | hit.GustingGale.Push | whenAttacked.GustingGale.Evade |
| Flighty Storm | FALSE | FALSE | hit.FlightyStorm.Weakness | whenAttacked.FlightyStorm.Evade |
| Nothing | FALSE | FALSE | hit.Nothing.Silence | whenAttacked.Nothing.Dodge |

---

### B. Elemental Abilities (10 new entries)

Each references its combined isterrain+deploy passive rule.

| Abilities | 1/game | 1/round | Ability1 |
|---|---|---|---|
| Forest Elemental | FALSE | FALSE | passive.ForestElemental |
| Rock Elemental | FALSE | FALSE | passive.RockElemental |
| Bramble Elemental | FALSE | FALSE | passive.BrambleElemental |
| River Elemental | FALSE | FALSE | passive.RiverElemental |
| Bog Elemental | FALSE | FALSE | passive.BogElemental |
| Rain Elemental | FALSE | FALSE | passive.RainElemental |
| Mist Elemental | FALSE | FALSE | passive.MistElemental |
| Wind Elemental | FALSE | FALSE | passive.WindElemental |
| Storm Elemental | FALSE | FALSE | passive.StormElemental |
| Chaos Elemental | FALSE | FALSE | passive.ChaosElemental |

---

### C. Song / Move Abilities (9 new entries)

Creeping Shroud and Winds Whistle have both activation (create terrain) and action (move terrain) rules.

| Abilities | 1/game | 1/round | Ability1 | Ability2 |
|---|---|---|---|---|
| Rock Rumble | FALSE | FALSE | action.rockrumble | |
| Thorny Tanto | FALSE | FALSE | action.thornytanto | |
| River Rush | FALSE | FALSE | action.riverrush | |
| Marsh Murmur | FALSE | FALSE | action.marshmurmur | |
| Rainy Refrain | FALSE | FALSE | action.rainyrefrain | |
| Creeping Shroud | FALSE | FALSE | activation.creepingshroud | action.creepingshroud.move |
| Winds Whistle | FALSE | FALSE | activation.windswhistle | action.windswhistle.move |
| Tempest Tune | FALSE | FALSE | action.tempesttune | |
| Primordial Prelude | FALSE | FALSE | action.primordialprelude | |

---

### D. Litany Abilities (9 new entries)

Each references its hit rule (or movement rule for Potential).

| Abilities | 1/game | 1/round | Ability1 |
|---|---|---|---|
| Litany of Life | FALSE | FALSE | hit.litanyoflife |
| Litany of Protection | FALSE | FALSE | hit.litanyofprotection |
| Litany of Power | FALSE | FALSE | hit.litanyofpower |
| Litany of Currents | FALSE | FALSE | hit.litanyofcurrents |
| Litany of Enticement | FALSE | FALSE | hit.litanyofenticement |
| Litany of Shivers | FALSE | FALSE | hit.litanyofshivers |
| Litany of Guidance | FALSE | FALSE | hit.litanyofguidance |
| Litany of Dread | FALSE | FALSE | hit.litanyofdread |
| Litany of Potential | FALSE | TRUE | movement.litanyofpotential |

> Note: Litany of Potential is 1/round = TRUE (once per round trigger).

---

### E. Hymn Abilities (9 new entries)

These are referenced by the litany effect's value field. Not on any unit directly — they're looked up programmatically when the repetition counter hits 3.

| Abilities | 1/game | 1/round | Ability1 |
|---|---|---|---|
| Hymn of Life | FALSE | FALSE | hymn.hymnoflife |
| Hymn of Protection | FALSE | FALSE | hymn.hymnofprotection |
| Hymn of Power | FALSE | FALSE | hymn.hymnofpower |
| Hymn of Currents | FALSE | FALSE | hymn.hymnofcurrents |
| Hymn of Enticement | FALSE | FALSE | hymn.hymnofenticement |
| Hymn of Shivers | FALSE | FALSE | hymn.hymnofshivers |
| Hymn of Guidance | FALSE | FALSE | hymn.hymnofguidance |
| Hymn of Dread | FALSE | FALSE | hymn.hymnofdread |
| Hymn of Potential | FALSE | FALSE | hymn.hymnofpotential |

---

### F. Updates to EXISTING Ability Entries (3 updates)

These already exist but need mana resource rules added (matching Earth Spirit's pattern).

| Abilities | 1/game | 1/round | Ability1 | Ability2 | Ability3 |
|---|---|---|---|---|---|
| Water Spirit | FALSE | FALSE | passive.water.spirit | passive.mana.from.water | passive.use.mana.max.1 |
| Air Spirit | FALSE | FALSE | passive.air.spirit | passive.mana.from.air | passive.use.mana.max.1 |
| Chaos Spirit | FALSE | FALSE | passive.chaos.spirit | passive.mana.from.any | passive.use.mana.max.1 |

> Currently Water/Air/Chaos Spirit only have their teleport rule (Ability1). Add the mana resource (Ability2) and mana cap (Ability3).

---

## PART 3: TOTALS

| Category | Rules | Ability Defs |
|---|---|---|
| Mana resource | 3 | - |
| Signature hit | 9 | 9 |
| Signature whenAttacked | 5 | (included above) |
| Signature other | 4 | (included above) |
| Elemental passives | 10 | 10 |
| Song/Move actions | 9 | 9 |
| Activation (terrain create) | 2 | (included above) |
| Litany hit | 9 | 9 |
| Hymn | 9 | 9 |
| **Total new** | **60** | **46** |
| Updates | - | 3 |

---

## PART 4: CODE WORK NEEDED

### Works Now (paste and play) — ~40 rules
- All 8 standard litany hit rules (consume + litany)
- 7 of 9 hymn rules (heal, conditions, pushfromterrain, pulltoterrain, replace)
- 8 of 9 signature hit rules (consume + simple effect)
- 1 signature whenAttacked (Nothing.Dodge)
- All 10 elemental IsTerrain + deploy passives (9 standard + Chaos)
- 5 simple song/move relocates (thornytanto, rainyrefrain, creepingshroud.move, windswhistle.move, tempesttune)
- 2 mana resource rules (water, air)

### Needs Small Code Fixes — ~5 rules
- `terrainresource any:mana:1` — add `|| match === 'any'` wildcard (1 line)
- `deployterrain any` — present terrain type picker during deploy (Chaos Elemental)
- `splashdamage 1` — after push, deal 1 dmg to enemy adjacent to pushed target (Gusting Gale)
- `move 1` on allallies in hymn context — interactive per-unit mass move (Hymn of Guidance)

### Needs New Effect Handlers — ~15 rules
- `consumeall` + `permana` — spend all mana, damage = amount spent (Sharp Thorn retaliate)
- `reducedamageto N` — set incoming damage to N on whenAttacked (Chilling Mist)
- `reducedamage N` — subtract N from incoming damage on whenAttacked (Gusting Gale, Flighty Storm evade)
- Self-`move` in whenAttacked context — move self before damage resolves (Gusting Gale, Flighty Storm)
- `preventcondition` — on gaining a condition, spend mana to cancel it (Tangled Roots)
- `aura immobilized` — continuous immobilize on adjacent enemies while unit has mana (Grasping Bog)
- `pullthrough ally` — pull ally you moved through to your position (Flowing River afterMove)
- `movedthrough.ally` / `movedthrough.enemy` targets — resolve to units on movement path (Rejuvenating Rain, terrain-move bonuses)
- `adjacentto.X` targeting — hex adjacent to existing terrain of type X (Creeping Shroud/Winds Whistle activation)
- `allenemies.inmist` targeting — enemies standing on mist terrain (Creeping Shroud activation damage)
- `replaceterrain` — interactive terrain type swap on movement trigger (Litany of Potential)
- Element-based `validTargets` for relocate — "Water" matches Pool/Bog/Rain (River Rush)
- `placedterrain` targeting — relocate any terrain the player placed (Primordial Prelude)

---

## PART 5: UNIT → ABILITY MAPPING (for reference)

### Huntresses (Spirits) — 10 units
| Unit | Ability 1 | Ability 2 | Ability 3 |
|---|---|---|---|
| Verdant Sentinel | Tangled Roots | Earth Spirit | Mobile |
| Crag Keeper | Hard Stone | Earth Spirit | Mobile |
| Briar Thorn | Sharp Thorn | Earth Spirit | Mobile |
| River Runner | Flowing River | Water Spirit | Mobile |
| Fen Shadow | Grasping Bog | Water Spirit | Mobile |
| Cloud Burst | Rejuvenating Rain | Water Spirit | Mobile |
| Veiled Stalker | Chilling Mist | Air Spirit | Mobile |
| Wind Lash | Gusting Gale | Air Spirit | Mobile |
| Whirling Warden | Flighty Storm | Air Spirit | Mobile |
| Oblivion's Veil | Nothing | Chaos Spirit | Mobile |

### Elementals — 10 units
| Unit | Ability 1 | Ability 2 | Ability 3 | Ability 4 |
|---|---|---|---|---|
| Whisper Vines | Tangled Roots | Forest Elemental | Tree Song | Litany of Life |
| Stoic Monolith | Hard Stone | Rock Elemental | Rock Rumble | Litany of Protection |
| Pointy Thicket | Sharp Thorn | Bramble Elemental | Thorny Tanto | Litany of Power |
| Wandering Brook | Flowing River | River Elemental | River Rush | Litany of Currents |
| Sunken Call | Grasping Bog | Bog Elemental | Marsh Murmur | Litany of Enticement |
| Drenching Downpour | Rejuvenating Rain | Rain Elemental | Rainy Refrain | Litany of Life |
| Creeping Shroud | Chilling Mist | Mist Elemental | Creeping Shroud | Litany of Shivers |
| Howling Breeze | Gusting Gale | Wind Elemental | Winds Whistle | Litany of Guidance |
| Rolling Thunder | Flighty Storm | Storm Elemental | Tempest Tune | Litany of Dread |
| Breaching Void | Nothing | Chaos Elemental | Primordial Prelude | Litany of Potential |

> Note: "Creeping Shroud" is both the unit name and the ability name (Ability 3 for the Mist elemental).
> Note: Tree Song already exists in the spreadsheet — no new entry needed for it.
> Note: Hard Stone already exists in the spreadsheet — no new entry needed for it.
> Note: Litany of Life is shared by Whisper Vines and Drenching Downpour — only 1 entry needed.
