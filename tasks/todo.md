# Ability Implementation Tracker

## Syli Faction

### Faction Rules
- [x] Fae Walkers — ignore forest/brambles penalties (passive.Fae Walkers)
- [x] Forest Charged — recharge abilities on entering forest (passive.ForestCharged + applyRecharge)

### Custom Code (implemented)
- [x] Guardian (Lyair) — end-of-turn guard targeting + lethal intercept (bug fix pending: double nextTurn)
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
- [ ] Sand Stormed — Hidden in Sand. Ability def `Dusters → passive.hidden.sand` + rule `passive.hidden.sand` already exist in spreadsheet. `isHidden()` supports surface-based hidden. **Should work — needs testing.**

### Data-Driven (just need spreadsheet entries + testing)
- [ ] Mobile (Greaves, Jump Pack) — passive.Mobile already exists. **Just wire in spreadsheet.**
- [ ] Shove (Lance, Bouncer) — hit.Push.1 already exists. **Just wire in spreadsheet.**
- [ ] Poison Attack (Ashen) — hit.Poison already exists. **Just wire in spreadsheet.**
- [ ] HAZWOPER (Hook, Diffuser, Aeolus, Bouncer) — ignoreTerrainRule for dangerous+poisonous. **Needs rule:** `passive.hazwoper | passive | self | ignoreTerrainRule | dangerous,poisonous` + ability def.
- [ ] Shifting Winds (Aeolus) — "Move: Move any Shifting Terrain." Same as Tree Song but targeting shifting terrain. **Needs rule:** `action.shiftingwinds | action | shifting | Move | relocate` + ability def. Uses new `relocateTerrain` effect.
- [ ] Enfeebling Attack (Dearth) — hit weakness on attack. **Needs rule:** `hit.weakness.1` + ability def.
- [ ] Regen (Stimpak) — activation trigger, heal self 2. **Needs rule:** `activation.regen | activation | self | heal | 2` + ability def.

### Parting Gift System (core Dusters mechanic) — CODE DONE, needs spreadsheet wiring
Code primitives implemented: `closestAlly` target type, `grantability` effect, `statmod` effect. Chains recursively. Each variant needs Rules + Abilities tab entries:

- [ ] **Parting Gift spreadsheet wiring** — death rules + ability defs for each variant:
  - Bracer: grantAbility(PG-Bracer) + strengthened permanent
  - Cloak: grantAbility(PG-Cloak, Hidden)
  - Cuirass: grantAbility(PG-Cuirass) + statmod(armor=2)
  - Greaves: grantAbility(PG-Greaves, Mobile)
  - Jump Pack: grantAbility(PG-Jump Pack) + statmod(move:2)
  - Lance: Bump (push on hit)
  - Scope: +1 Range + True Sight
  - Shield: Protector (adjacent allies +1 Armor)
  - Slider: Tumbler
  - Sniper: +1 Range + Sneak Attack
  - Stimpak: +1 Health + Regen
  - Visor: +1 Range + attack type becomes Direct
- [ ] Collector (Shiney) — "When gaining a Parting Gift, permanently get +1 Damage." Hook into Parting Gift system.
- [ ] Haboob (Sweeping) — "Absorb Parting Gifts from units dying in Range (no benefit). On death, deal damage = gift count to enemies within 2."

### Needs Custom Code — Unique Abilities
- [ ] Flanker: Brutal (Cloak) — "+2 damage if target is adjacent to an ally." Conditional bonus damage (ally adjacency check).
- [ ] Hover (Jump Pack) — "When damaged by enemy, you may move this unit." whenAttacked reaction → relocate self.
- [ ] True Sight (Scope) — "See through Cover/Concealing. Ignores Hidden and Armor from Cover." Attack validation override.
- [ ] Sneak Attack (Sniper) — "+1 Damage if started turn Hidden from target." Turn-start hidden check → conditional bonus.
- [ ] Protector (Shield) — "Adjacent allies get +1 Armor." Passive armor aura. Similar to existing aura system.
- [ ] Hook Pull (Hook) — "On damage, Move 1 and Pull target 1." Hit trigger → move self + pull target.
- [ ] Diffuser (Diffuser) — "On activation, destroy Dangerous terrain in this space: deal 1 dmg to all enemies in range." Activation action → terrain removal + AoE.

### Needs Custom Code — Remember Abilities (trigger on ANY ally death)
Current `afterDeath` dispatch fires abilities on the dying unit. Remember abilities fire on alive units when a different ally dies. Needs a new dispatch pattern (e.g., `allyDeath` trigger).

- [ ] Remember - Affliction (Ashen) — "On ally death, Poison the enemy that killed them."
- [ ] Remember - Conquest (Apocrypha) — "On ally death, Heal an ally 1."
- [ ] Remember - Slaughter (Enmity) — "On ally death, if they haven't activated this round, activate them now before they die." (Complex: re-activation of dying unit)
- [ ] Remember - Hunger (Dearth) — "On ally death, Weaken the enemy that killed them."

### Needs Custom Code — Complex Legendaries
- [ ] Plagued Memories (Ashen) — "Once/round when damaged, deal 1 dmg to all allies within 3. Reduce incoming damage by amount dealt to allies." whenAttacked → damage redirect with reduction.
- [ ] Dutiful Reflection (Apocrypha) — "Once/round when targeted, pull ally adjacent, that ally becomes target instead." whenAttacked → target intercept + pull + redirect.
- [ ] Sanguine Echoes (Enmity) — "Once/round when damaged, ally within 3 takes all but 1 damage instead." whenAttacked → damage redirect to ally.
- [ ] Deprived Recollection (Dearth) — "Attack: Take 1 dmg, deal 1 dmg to ally, that ally activates now." Action → self-damage + ally re-activation.
- [ ] Sand Elemental (Haboob) — "Is Earth Terrain. On deploy, deploy Sand." Unit counts as terrain + deploy sand.

---

## Notes
- All "data-driven" abilities have rules in the Rules tab + defs in the Abilities tab. The dispatch system handles them automatically. They just need gameplay testing.
- `whenAttacked` trigger, `swap` effect, `heal` effect, `bonusDamagePerTerrain`, `lineToTarget` targeting, `miss` effect, PBAoE around-targeting, `death` trigger — all fully implemented in abilities.js dispatch.
- `suppressed` condition (Harbringer): defined in CONDITION_DEFAULTS, gating logic in selectUnit(), clearing in completeEndActivation(). Applied via hit.suppress rule.
- `relocateTerrain` effect: newly added, supports Tree Song and Shifting Winds (move terrain to new hex).
- `ignoreTerrainRule` passive: fully supports comma-separated rule names (e.g., `dangerous,poisonous`).
