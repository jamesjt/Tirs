# Tidehaven Spreadsheet Entries

All rules and ability defs needed in Google Sheets for the Tidehaven faction code to work.

---

## Rules Tab — New Entries

### Phase 0: Pure data (effects already exist in code)

| ruleName | Special Rule | Type | Action | Condition | Cond Value | validTargets | invalidTargets | Range | Effect 1 | Value 1 | Effect 2 | Value 2 | Effect 3 | Value 3 |
|----------|-------------|------|--------|-----------|------------|-------------|---------------|-------|----------|---------|----------|---------|----------|---------|
| hit.Entrancing.1 | Entrancing | hit | | | | target | | | pull | 1 | | | | |
| hit.Entrancing.2 | Entrancing | hit | | | | target | | | weakness | | | | | |
| hit.Enfeebling | Enfeebling | hit | | | | target | | | weakness | | | | | |
| hit.Whirl | Whirl | hit | | | | target | | | dizzy | | | | | |
| hit.FlankerBrutal | FlankerBrutal | hit | | flanked | >=1 | target | | | bonusdamage | 2 | | | | |
| hit.Bind | Bind | hit | | | | target | | | immobilized | | | | | |
| afterMove.Downpour | Downpour | afterMove | | | | spaces empty around self | | | placeterrain | pool | | | | |
| endActivation.WhirlOfPools | WhirlOfPools | endActivation | | | | spaces empty around self | | | placeterrain | tide | | | | |
| passive.WhirlpoolElemental | WhirlpoolElemental | passive | | | | self | | | isterrain | water | | | | |
| action.Overseer | Overseer | action | non-activation | | | ally | self | D99 | relocate | 1 | | | | |
| action.Command | Command | action | move | | | ally | self | D99 | relocate | 3 | | | | |
| action.CallLightning | CallLightning | action | non-activation | | | empty | | D5 | delayedattack | | | | | |
| action.Duet | Duet | action | non-activation | | | self | | | relocate | 1 | | | | |

**Note:** Splash (Tidebringer) reuses the existing `hit.Aoe.1.Dmg.1` rule — no new rule needed.

### Phase 1: Lightning resource rules

| ruleName | Special Rule | Type | Action | Condition | Cond Value | validTargets | invalidTargets | Range | Effect 1 | Value 1 | Effect 2 | Value 2 | Effect 3 | Value 3 |
|----------|-------------|------|--------|-----------|------------|-------------|---------------|-------|----------|---------|----------|---------|----------|---------|
| passive.lightning.max | lightning.max | passive | | | | self | | | maxresource | lightning:1 | | | | |
| passive.StaticRelay.Move | StaticRelay.Move | passive | | resource | lightning:>=1 | self | | | move | 2 | | | | |
| passive.WaveSkimmers | WaveSkimmers | passive | | | | self | | | ignoreterrain | tide,pool | | | | |
| action.StaticRelay.Transfer | StaticRelay.Transfer | action | non-activation | resource | lightning:>=1 | ally | self | 1 | consume | lightning:1 | gainresource | lightning:1 | | |
| hit.ArcGloves.1 | ArcGloves | hit | | resource | lightning:>=1 | target | | | bonusdamage | 2 | consume | lightning:1 | | |
| hit.ArcGloves.2 | ArcGloves | hit | | resource | lightning:>=1 | closestAlly | | | gainresource | lightning:1 | | | | |
| hit.Flaunt.1 | Flaunt | hit | | resource | lightning:>=1 | target | | | consume | lightning:1 | | | | |
| hit.Flaunt.2 | Flaunt | hit | | resource | lightning:>=1 | enemy around self | | 3 | damage | 1 | | | | |
| hit.Surge.1 | Surge | hit | | resource | lightning:>=1 | target | | | bonusdamage | 2 | consume | lightning:1 | | |
| hit.Surge.2 | Surge | hit | | resource | lightning:>=1 | ally path target | | | gainresource | lightning:1 | | | | |
| hit.Tase.1 | Tase | hit | | resource | lightning:>=1 | target | | | weakness | | consume | lightning:1 | | |

**Note on Tase:** "next ally to damage gains charge" — this may need a special target. For now, leaving the charge-spread rule out. Could be handled via `empower` or a future `onAllyAttack` trigger.

### Phase 2: Abilities using new code features

| ruleName | Special Rule | Type | Action | Condition | Cond Value | validTargets | invalidTargets | Range | Effect 1 | Value 1 | Effect 2 | Value 2 | Effect 3 | Value 3 |
|----------|-------------|------|--------|-----------|------------|-------------|---------------|-------|----------|---------|----------|---------|----------|---------|
| activation.InvigTides | InvigTides | activation | | onsurface | tide,pool | self | | | strengthened | | | | | |
| action.BideTime | BideTime | action | non-activation | | | self | | | protected | | | | | |
| onTurnEnd.BideTime | BideTime.end | onTurnEnd | | | | self | | | strengthened | 2 | | | | |
| action.XMarks | XMarks | action | non-activation | | | empty | | D3 | placemarker | xmarks | | | | |
| hit.Flood.base | Flood.base | hit | | resource | lightning:<1 | path target empty | | | placeterrain | tide | | | | |
| hit.Flood.charged | Flood.charged | hit | | resource | lightning:>=1 | path target empty | | | placeterrain | storm | consume | lightning:1 | | |
| action.HardWater | HardWater | action | non-activation | | | terrain | | D1 | destroyterrain | | strengthened | | protected | |

**Note:** Hard Water `validTargets` should filter to water terrain surfaces only (tide, pool, etc.). May need `terrain:tide` or similar tag.

### Phase 3: Abilities using custom effect handlers

| ruleName | Special Rule | Type | Action | Condition | Cond Value | validTargets | invalidTargets | Range | Effect 1 | Value 1 |
|----------|-------------|------|--------|-----------|------------|-------------|---------------|-------|----------|---------|
| hit.ChainLightning | ChainLightning | hit | | resource | lightning:>=1 | target | | | chainlightning | 2 |
| action.LightBeam | LightBeam | action | non-activation | | | empty unit enemy ally | | L9 | lightbeam | |
| hit.Rapacious | Rapacious | hit | | | | target | | | rapacious | |

---

## Abilities Tab — New Entries

| Ability Name | Once Per Game | Once Per Round | Rules |
|-------------|--------------|----------------|-------|
| Tidehaven | N | N | passive.lightning.max, passive.StaticRelay.Move, passive.WaveSkimmers, action.StaticRelay.Transfer |
| Entrancing | N | N | hit.Entrancing.1, hit.Entrancing.2 |
| Enfeebling Attack | N | N | hit.Enfeebling |
| Whirl | N | N | hit.Whirl |
| Flanker Brutal | N | N | hit.FlankerBrutal |
| Splash | N | N | hit.Aoe.1.Dmg.1 |
| Bind | N | N | hit.Bind |
| Downpour | N | N | afterMove.Downpour |
| Whirl of Pools | N | N | endActivation.WhirlOfPools |
| Whirlpool Elemental | N | N | passive.WhirlpoolElemental |
| Overseer | N | N | action.Overseer |
| Command | N | Y | action.Command |
| Call Lightning | N | N | action.CallLightning |
| Duet | N | Y | action.Duet |
| Invigorating Tides | N | N | activation.InvigTides |
| Bide Time | N | N | action.BideTime, onTurnEnd.BideTime |
| X Marks the Spot | N | N | action.XMarks |
| Flood | N | N | hit.Flood.base, hit.Flood.charged |
| Hard Water | N | Y | action.HardWater |
| Arc Gloves | N | N | hit.ArcGloves.1, hit.ArcGloves.2 |
| Flaunt | N | N | hit.Flaunt.1, hit.Flaunt.2 |
| Surge | N | N | hit.Surge.1, hit.Surge.2 |
| Tase | N | N | hit.Tase.1 |
| Chain Lightning | N | N | hit.ChainLightning |
| Light Beam | N | N | action.LightBeam |
| Rapacious | N | N | hit.Rapacious |

**Note:** Existing abilities (Poison Attack, Scout, Mobile, Hidden Water, Hidden No Surface, Delayed Effect, Dancer, Tumbler, Move-or-Fire) are already in the spreadsheet — no changes needed.

---

## Unit Special Rules (Tidehaven tab)

Verify each unit's Special Rules column references the correct ability names:

| Unit | Special Rules |
|------|--------------|
| Jellyfish | Poison Attack, Scout, Hidden (Water) |
| Lookout | Overseer, Scout |
| Swab | Hard Water |
| Taser | Tase |
| Arc Pugilist | Arc Gloves |
| Bravo | Flaunt |
| Conductor | Surge, Enfeebling Attack |
| Fiddler Crab | Hidden (No Surface), Invigorating Tides, Bind |
| Iaidoka | Bide Time, Mobile |
| Lightkeeper | Light Beam |
| Lurking Torrent | Delayed Effect, Downpour, Whirl |
| Mudskipper | Hidden (No Surface), Invigorating Tides, Tumbler |
| Sandpiper | Hidden (No Surface), Mobile, Invigorating Tides |
| Siren | Entrancing, Hidden (Water) |
| Swashbuckler | Dancer |
| Tidebringer | Splash, Flood |
| Blade Dancer | Dancer, Flanker Brutal, Duet |
| Boltcaster | Chain Lightning, Call Lightning |
| Captain | X Marks the Spot, Command, Move-or-Fire |
| Charybdis | Whirlpool Elemental, Whirl of Pools, Rapacious |

---

## Terrain Map Tab — Verify/Add

Ensure these terrain surfaces exist with appropriate rules:

| Surface | Element | Rules needed |
|---------|---------|-------------|
| tide | water | difficult, evanescent (or shifting?) |
| pool | water | difficult |
| storm | water/lightning | dangerous?, evanescent |
| rain | water | evanescent? |
| whirlpool | water | consuming |

These surfaces must be defined for Wave Skimmers (`ignoreterrain tide,pool`) and Flood/Downpour to create valid terrain.
