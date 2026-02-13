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
