# Lessons Learned

## Hex Space Layering (2025)
Each hex can have 4 independent layers that coexist:
1. **Surface** (terrain) — Cinder, Rubble, Spire, etc. All current terrain is surface.
2. **Weather** — Not yet implemented. Future system.
3. **Unit** — Living game units with health/stats.
4. **Trap** — Clock Traps etc. Separate from terrain, removed when stepped on. Has icon at `nandeck/images/unitImages/redridge/toytrap.png`.

Clock Traps are NOT terrain — they share a space with surfaces and are consumed on entry.

## Ability System Architecture
- Data-driven 3-layer system: atomicRules → abilityDefs → unit.specialRules
- New abilities should be expressible via sheets first; only add code for new mechanics
- `damageUnit()` routes non-attack damage; direct attack damage (`target.health -= dmg`) stays separate
- `allDamaged` target type tracks units damaged during a dispatch cycle via `ctx.damagedUnits`
- Death triggers bypass silenced check (dead units should still trigger death abilities)
- Dead units get immediate terrain creation (no queuing — can't make interactive choices)
- **Ability rule linkage bugs**: If an ability doesn't fire, check the Abilities tab in Google Sheets FIRST. Each Rule column holds ONE rule ID — missing rule IDs means the ability won't dispatch those rules. The code chain is usually correct; the data may be incomplete. Debug with `console.log` in `dispatchMovement`/`dispatch` to list which ruleIds are bound.
- **Spreadsheet column headers**: PapaParse uses `header: true`, so empty column headers become key `""` and are invisible to the `col()` helper. If a rule column has data but no header (e.g. `Ability3` header is blank), the parser silently skips it. Always ensure all Rule/Ability columns have headers (`Ability1`, `Ability2`, `Ability3`, `Ability4`).

## Terrain Map Initialization
- `state.terrain` in `reset()` initializes ALL hexes with `{ surface: null }` — this makes `terrain.has(key)` always truthy.
- Always check `td && td.surface` (not just `terrain.has(key)` or `if (!td)`) when filtering for actual terrain.
- `Board.getPath()` excludes the start hex — prepend it manually when iterating neighbors along the full path.
