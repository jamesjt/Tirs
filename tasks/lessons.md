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

## Temporal Dead Zone in Closures (2026-02-20)
- **Pattern**: When a closure references a `const`/`let` variable that's declared LATER in the same scope, calling the closure before the declaration executes causes `ReferenceError: Cannot access 'X' before initialization`.
- **Specific case**: `getMoveRange()` and `getMovementContext()` in game-battle.js declared `const ignoresTerrain = (rule, q, r) => Abilities.ignoresTerrainRule(u, rule, q, r, terrainAuraMap)` BEFORE `const terrainAuraMap = ...` was declared. The closure captured the binding, but calling `ignoresTerrain()` in the impassable-terrain loop (before the `terrainAuraMap` line) hit the TDZ.
- **Symptom**: `showActivationHighlights()` → `getMoveRange()` crashes silently (no try-catch), leaving stale targeting highlights and preventing `showPhase()`/`render()` from running. Game appears "stuck" in targeting mode with cyan dots.
- **Fix**: Move `const terrainAuraMap = ...` BEFORE any closures that reference it.
- **Prevention**: Always declare captured variables ABOVE closures that reference them. Never rely on hoisting for `const`/`let`.

## Variable Shadowing in IIFE Modules (2026-02-20)
- **Pattern**: When a function parameter or local variable shares the same name as a module-level variable in an IIFE, JS silently resolves to the inner scope. Writes intended for the module-level variable go to the parameter/local instead.
- **Specific case**: `enterAbilityTargeting(abilityName, unit, targeting, ...)` had a parameter `targeting` that shadowed the module-level `targeting` state object in ui.js. When the function wrote `targeting.ability = { ... }`, it wrote to the parameter (getTargeting data), not the state. The hex-click handler checked module-level `targeting.ability` → found null → all ability clicks silently ignored.
- **Detection**: If an ability enters targeting mode (status bar shows "select target") but clicks on valid hexes do nothing, check for variable shadowing between function params and module-level state.
- **Fix**: Rename the inner variable (parameter/local) to a distinct name (e.g. `tdata`). Leave module-level references unchanged.
- **Prevention**: Never name function parameters the same as module-level IIFE state variables. Use descriptive, distinct names.

## Ability Design Constraints
- **Hit rule + action rule conflict**: `dispatch('afterAttack')` in abilities.js skips hit rules from abilities that also have action rules (line ~1157-1158). This prevents combining both rule types in a single ability def. Workaround: use the generic `empower` effect to buff the next attack via a condition, then process it in `attackUnit()`.

## Generic Rules Over Ability-Specific Effects
- Design spreadsheet effects to be **GENERIC**, not ability-specific.
- **Bad**: `firerune` effect that only works for one ability, with hardcoded logic in `attackUnit()`.
- **Good**: `empower` effect with value `effect,severity,instances` — works for any ability that needs to buff future attacks.
- The code handles the **MECHANIC** (empowering attacks); the spreadsheet specifies **WHAT** effect and **HOW MANY**.
- Same principle applies everywhere: prefer `push` with a value over `pushSpecificUnit`, `heal` over `healSelf`, etc.
- When designing a new ability, ask: "Can this be expressed as a generic effect with parameters?" If yes, build the generic version.

## Resource System Design (2026-02-21)
- **Resource types are arbitrary strings** — no hardcoded registry. A type exists when a `gainresource` effect creates it on a unit.
- **Initialization via deploy rules**, not code: `type: deploy, target: self, effect: gainresource, value: typename:amount`. The `afterDeploy` dispatch already fires at deploy time.
- **`maxresource` passive only needed for cap > 1** — `getMaxResource()` defaults to 1 when no passive exists.
- **Once-per-game = deploy gives 1 resource + action consumes it.** No `oncePerGame` flag needed.
- **Once-per-round = same + `refillresource` passive** refills to max at round start.
- **Rechargeable = same + `damageresource`/`terrainresource` passives** grant resource on triggers.
- **Multi-resource units** (e.g., Runesmith with 3 rune types): each resource type is independent, each ability gates on its own `resource` condition.
- **`isActionAvailable(unit, ruleId)`** checks the action rule's condition before showing the button — so depleted resources hide the button.

## Targeting Is Data-Driven — Don't Duplicate in Code
- **Pattern**: Effect handlers (e.g. `applyGrantAbility`, `applyHeal`) receive pre-filtered targets from `resolveTargets()`. The `validTargets` column in the Rules spreadsheet controls who receives each effect.
- **Mistake**: Adding a hardcoded `if (t.player !== ctx.unit.player) continue` guard in `applyGrantAbility()` to ensure only allies receive Parting Gifts — when the spreadsheet already specifies `validTargets: "closestAlly"`, which `resolveTargets()` resolves to same-player units only.
- **Why it's wrong**: Redundant with data. Masks spreadsheet bugs instead of surfacing them. Creates a second place to maintain targeting rules. Breaks if a future ability legitimately needs to grant an ability to an enemy.
- **Rule**: If targeting seems wrong, inspect the spreadsheet `validTargets` value and `resolveTargets()` keyword handler FIRST. Fix the data or the resolver — never patch individual effect handlers.
- **Before adding any filter to an effect handler**, ask: "Is `resolveTargets()` already responsible for this filtering?" If yes, stop.

## Close the Loop: Plans, Decisions, and Task Hygiene
- **When a CLAUDE.md rule or lessons.md entry invalidates a planned approach**: immediately update/remove the corresponding items in the Project Planner (`tasks/dashboard.html` PLANNER_DATA), sprint focus, and any active plan files. A decision NOT to do something is still a decision — record it.
- **When work is completed**: delete the plan file (or the completed items from it). Plan files should not survive past implementation. If a plan is approved→implemented→verified, it's done — kill the file.
- **Stale items cost more than missing items**: A phantom task that "looks like work to do" causes agents to re-investigate, re-plan, or re-implement code that's already shipped. Closing items promptly saves future context.
- **Process**: After any code/data change session:
  1. Check: does this change obsolete any planner backlog/sprint items? Move to recentlyCompleted or remove.
  2. Check: does this change conflict with any active plan files? Update or delete.
  3. Check: does this session's work resolve any blocked items? Unblock them.
- **Recording "won't do" decisions**: When a planned item is intentionally skipped (e.g. "ally guard in applyGrantAbility — skipped per data-driven targeting rule"), note the reason in the planner or agent-log. Don't just silently not do it.

## Verify Code Before Claiming "Needs New Code" (2026-03-03)
- **Pattern**: When analyzing whether an ability needs new code or is pure data, reading documentation summaries instead of actual code leads to false "needs new code" conclusions.
- **Specific case**: `resolveTargets()` `around` keyword already reads `rule.range` for variable radius (line 314: `const radius = rule ? (parseInt(rule.range, 10) || 1) : 1`). Documentation described it as "hex neighbors of anchor" which sounded like radius-1 only. Analysis concluded "Ho, ho! my lads!" (allies within 2) needed a new `allieswithin` keyword — but `self around ally` with `range: 2` already works.
- **Impact**: False "needs code" claims waste engineer time, delay faction implementation, and erode trust in build-vs-data assessments.
- **Fix**: Designer agent now has READ access to abilities.js for verification. CLAUDE.md and designer.md both require reading actual code (`resolveTargets`, `evaluateCondition`, `applyEffect`) before claiming something needs new mechanics.
- **Rule**: Never say "needs new code" based on documentation alone. Read the function. Cite what you checked.

## Google Sheets API: ALWAYS Use `append`, NEVER `batchUpdate` for Adding Rows (2026-03-04)
- **Pattern**: When adding new rows to a Google Sheet, the `spreadsheets.values.batchUpdate` (or `update`) API writes to the SPECIFIED RANGE starting from row 1. If you pass `range: 'Rules!A:S'` with row data, it overwrites from A1 downward — destroying the header row and existing data.
- **Specific case**: Used `sheets.spreadsheets.values.batchUpdate()` with `data: [{ range: 'Rules!A:S', values: rulesRows }]` to add 13 Down Town rules. This wrote to rows 1-13, overwriting the header and first 12 data rows. Same error on the Abilities tab. Required manual restore from Google Sheets version history.
- **Impact**: Lost 12 rules + 11 ability defs + both headers. ~30 minutes of recovery work. Required user to manually restore from version history.
- **Fix**: ALWAYS use `sheets.spreadsheets.values.append()` with `insertDataOption: 'INSERT_ROWS'` when adding new rows. This finds the last row with data and appends below it.
- **Correct pattern**:
  ```javascript
  sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: 'TabName!A:Z',
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows }
  });
  ```
- **NEVER use**: `batchUpdate` or `update` with a column-only range (e.g. `A:S`) for new data — it writes from row 1.
- **Rule**: Before ANY Google Sheets write, confirm: "Am I appending or updating existing rows?" Append → `append()`. Update specific cells → `update()` with an explicit row range (e.g. `Rules!A257:S257`).

## No Runtime Patches for Spreadsheet Data
- **NEVER inject rules or ability defs via runtime patches in code** (e.g. `Abilities.setAtomicRules(...)` in units.js). The spreadsheet is the single source of truth for ability data and is trivially editable. Runtime patches are junk code that obscures the real data source, creates maintenance burden, and confuses future debugging.
- If an ability needs a new rule or changed ruleIds, **tell the user to update the spreadsheet**. Don't add "temporary" code patches — they always outlive their welcome.
- Code changes should only be for new *mechanics* that the data system can't express, not for data that belongs in the spreadsheet.
