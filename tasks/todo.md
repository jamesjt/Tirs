# Ability Implementation Tracker

## Syli Faction

### Faction Rules
- [x] Fae Walkers — ignore forest/brambles penalties (passive.Fae Walkers)
- [x] Forest Charged — recharge abilities on entering forest (passive.ForestCharged + applyRecharge)

### Custom Code (implemented)
- [x] Guardian (Lyair) — end-of-turn guard targeting + lethal intercept
- [x] Dancer (Falling Leaf) — round-start poise choice (4 options, once-per-game each)
- [x] Trapper: Spike (Way Watcher) — deploy spike traps
- [x] Tree Song (Kodama) — terrain relocate (Move cost, move any forest)
- [x] Toter (Acroci) — afterMove teleport ally (replaces old Phoretic Host)

### Data-Driven (rules + ability defs exist in spreadsheet, dispatch handles them)
- [ ] Empowered Poison (Purse) — hit.Poison, once-per-game. **Needs testing**
- [ ] Empowered Dizzy (Fion) — hit.Dizzy, once-per-game. **Needs testing**
- [ ] Touch Me Not (Jewel) — whenAttacked.dodge, once-per-game. **Needs testing**
- [ ] Dodgy (Hazel) — whenAttacked.dodge, once-per-round. **Needs testing**
- [ ] Trickster (Hazel) — action.move.swap.ally + action.attack.swap.ally. **Needs testing**
- [ ] Foul Hemolymph (Lidae) — whenAttacked.foul (weaken adjacent enemies). **Needs testing**
- [ ] Zephyr (Ael) — action.relocate.rng.2 (push or pull 1). **Needs testing**
- [ ] Harbringer (Celae) — hit.suppress + hit.vulnerable.1. **Needs testing**
- [ ] Furious Charge (Ocype) — hit.charge.3 (bonus dmg if 5+ from start). **Needs testing**
- [ ] Serenity (Kinnara) — hit.heal.around.2 (allies in range heal 1). **Needs testing**
- [ ] PBAoE (Kinnara) — hit.pbaoe.rng2.dmg1 (attack all enemies in range). **Needs testing**
- [ ] Fae Fire (Light Weaver) — hit.vulnerable.1. **Needs testing**
- [ ] Life's Thread (Lotter) — hit.heal.line (allies in line heal 2). **Needs testing**
- [ ] Infatuate (Laurel) — hit.taunt. **Needs testing**
- [ ] Entrancing (Smoak) — hit.weakness.2 + hit.pull.2. **Needs testing**
- [ ] Noroi (Kodama) — whenAttacked.curse.attacker + death.curse.attacker (permanent if killed). **Needs testing**
- [ ] Cross Worlds (Ash) — hit.forests.bonusDmg.within.2. **Needs testing**

### Needs Custom Code
- [ ] Honeydew (Ash) — "When ally dies place Manna terrain. Allies entering Manna heal 1. End of round replace Manna with Forest." New terrain lifecycle.

---

## Dusters Faction

### Faction Rule
- [ ] Sand Stormed — Hidden in Sand. Spreadsheet + code done. **Needs testing.**

### Parting Gift System (core Dusters mechanic) — CODE + SPREADSHEET DONE
Code primitives: `closestAlly` target type, `grantability` effect, `statmod` effect. Chains recursively.
Spreadsheet: All 12 death rules + ability defs wired. **Needs testing.**

- [x] closestAlly target resolution
- [x] grantability effect (transfers ability defs to recipient)
- [x] statmod effect (direct base stat changes: range, maxHealth, move, damage, armor, atkType)
- [x] Spreadsheet wiring — all 12 variants (Bracer, Cloak, Cuirass, Greaves, Jump Pack, Lance, Scope, Shield, Slider, Sniper, Stimpak, Visor)

### Secondary PG Abilities — CODE DONE
These abilities are granted to recipients via Parting Gift. Code handlers implemented:

- [x] Protector (Shield) — `bonusarmor` condition in CONDITION_MODS, aura system handles targeting
- [x] True Sight (Scope) — `truesight` flag bypasses Hidden, Cover/Concealing LoS, Cover LoE in canAttack
- [x] Sneak Attack (Sniper) — `hidden` condition evaluator in evaluateCondition(), +1 dmg if attacker hidden
- [x] Regen (Stimpak) — activation.regen rule, `heal` effect already handled
- [x] Tumbler (Slider) — action.Tumbler rule, `MoveIntoEnemies` already handled
- [x] Hidden (Cloak) — passive.hidden rule already handled
- [x] Mobile (Greaves) — passive.Mobile rule already handled
- [x] Bump (Lance) — hit.Push.1 + hit.Move.Self.1 already handled

### Data-Driven (need spreadsheet entries + testing)
- [ ] Shove (Lance, Bouncer) — hit.Push.1 already exists. **Needs "Shove" ability def in Abilities tab.**
- [ ] Poison Attack (Ashen) — hit.Poison already exists. Ability def exists. **Needs testing.**
- [ ] HAZWOPER (Hook, Diffuser, Aeolus, Bouncer) — ignoreTerrainRule for dangerous+poisonous. **Needs rule:** `passive.hazwoper | passive | self | ignoreTerrainRule | dangerous,poisonous` + ability def.
- [ ] Shifting Winds (Aeolus) — "Move: Move any Shifting Terrain." Same as Tree Song but targeting shifting. **Needs rule:** `action.shiftingwinds | action | shifting | Move | relocate` + ability def.
- [ ] Enfeebling Attack (Dearth) — hit weakness on attack. **Needs rule:** `hit.weakness.1` + ability def.

### Needs Custom Code — Unique Abilities
- [ ] Flanker: Brutal (Cloak) — "+2 damage if target is adjacent to an ally." Conditional bonus damage.
- [ ] Hover (Jump Pack) — "When damaged by enemy, you may move this unit." whenAttacked → relocate self.
- [ ] Hook Pull (Hook) — "On damage, Move 1 and Pull target 1." Hit trigger → move self + pull target.
- [ ] Diffuser (Diffuser) — "On activation, destroy Dangerous terrain in this space: deal 1 dmg to all enemies in range."
- [ ] Collector (Shiney) — "When gaining a Parting Gift, permanently get +1 Damage." Hook into grantability.
- [ ] Haboob (Sweeping) — "Absorb Parting Gifts from units dying in Range. On death, deal damage = gift count to enemies within 2."

### Needs Custom Code — Remember Abilities (trigger on ANY ally death)
Current `afterDeath` dispatch fires on the dying unit. Remember abilities fire on alive units when a different ally dies. Needs `allyDeath` trigger.

- [ ] Remember - Affliction (Ashen) — "On ally death, Poison the enemy that killed them."
- [ ] Remember - Conquest (Apocrypha) — "On ally death, Heal an ally 1."
- [ ] Remember - Slaughter (Enmity) — "On ally death, if they haven't activated this round, activate them now before they die."
- [ ] Remember - Hunger (Dearth) — "On ally death, Weaken the enemy that killed them."

### Needs Custom Code — Complex Legendaries
- [ ] Plagued Memories (Ashen) — "Once/round when damaged, deal 1 dmg to all allies within 3. Reduce incoming damage by amount dealt."
- [ ] Dutiful Reflection (Apocrypha) — "Once/round when targeted, pull ally adjacent, that ally becomes target instead."
- [ ] Sanguine Echoes (Enmity) — "Once/round when damaged, ally within 3 takes all but 1 damage instead."
- [ ] Deprived Recollection (Dearth) — "Attack: Take 1 dmg, deal 1 dmg to ally, that ally activates now."
- [ ] Sand Elemental (Haboob) — "Is Earth Terrain. On deploy, deploy Sand."

---

## Notes
- All "data-driven" abilities have rules in the Rules tab + defs in the Abilities tab. The dispatch system handles them automatically. They just need gameplay testing.
- `whenAttacked` trigger, `swap` effect, `heal` effect, `bonusDamagePerTerrain`, `lineToTarget` targeting, `miss` effect, PBAoE around-targeting, `death` trigger — all fully implemented in abilities.js dispatch.
- `suppressed` condition (Harbringer): defined in CONDITION_DEFAULTS, gating logic in selectUnit(), clearing in completeEndActivation(). Applied via hit.suppress rule.
- `relocateTerrain` effect: supports Tree Song and Shifting Winds (move terrain to new hex).
- `ignoreTerrainRule` passive: fully supports comma-separated rule names (e.g., `dangerous,poisonous`).
- `closestAlly` target type: returns single closest alive ally of ctx.unit.
- `grantability` effect: pushes named ability defs to target's abilities array. Skips duplicates. Recalcs auras.
- `statmod` effect: direct stat changes — `stat:N` (add) or `stat=V` (set). Supports range, maxHealth, move, damage, armor, atkType.
- `bonusarmor` condition: added to CONDITION_MODS (+1 armor). Used by Protector aura.
- `truesight` flag: checked in canAttack() — bypasses Hidden, Cover/Concealing LoS, Cover LoE. Combo with Piercing fully handled.
- `hidden` condition evaluator: checks isHidden(ctx.unit) for Sneak Attack's conditional bonus damage.
