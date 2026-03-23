# Playbooks — Step-by-Step Workflows

Expanded versions of the pipeline sequences in agents.md.

---

## Playbook 1: New Ability Implementation

**Pipeline:** Designer (spec) → Data (sheet) → Engineer (code if needed) → QA (verify)

### Step 1: Design Spec (Systems Designer)
1. Read `WebApp/abilities.md` — understand existing effect types and targeting keywords
2. Determine if the ability can be expressed with existing effects or needs new code
3. Write the spec:
   - Rule type (hit, action, whenAttacked, passive, death, deploy, endActivation, allyDeath)
   - Effect(s) and value format
   - validTargets string (both UI filtering tags and resolution keywords)
   - Condition gates (if any)
   - Cost (action/move points, resource consumption)
4. Check for the two-rule pattern: does this ability need a passive + action combo?
5. Output: rule spec ready for spreadsheet entry

### Step 2: Spreadsheet Wiring (Data Architect)
1. Read the spec from Step 1
2. Add atomic rule(s) to the Rules tab in Google Sheets
3. Add ability def(s) to the Abilities tab, linking rule IDs
4. Verify: rule IDs in Abilities tab match Rules tab exactly (dotted format)
5. Verify: all required columns have headers (PapaParse silent-skip bug)
6. If faction sheet needs column updates, make those too
7. Output: spreadsheet entries committed, rule IDs documented

### Step 3: Code Changes (Engineer — only if needed)
1. If the spec uses only existing effects: skip this step
2. If new effect type needed:
   a. Add case to `applyEffect` switch in `abilities.js`
   b. Add condition to `CONDITION_DEFAULTS`, `CONDITION_MODS`, `COND_ICONS` in `game-core.js`
   c. Add CSS class `cond-{id}` in `styles.css`
   d. Ensure undo captures new state fields
3. Run `node --check` on all modified files
4. Handoff to QA via `tasks/agent-log.md`

### Step 4: Verification (QA Tester)
1. Load the game, deploy the unit with the new ability
2. Test the ability fires on correct trigger
3. Test targeting highlights correct hexes
4. Test effect resolves on correct targets
5. Test undo restores all state
6. Test edge cases: silenced, immobilized, hidden, unit at 1 HP
7. Document results in `tasks/todo.md` (move to "Tested & Confirmed" or report bug)

---

## Playbook 2: Bug Fix

**Pipeline:** QA (reproduce + root cause) → Engineer (fix) → QA (verify)

### Step 1: Reproduce & Root Cause (QA Tester)
1. Reproduce the bug — document exact steps
2. Read `tasks/lessons.md` — check if this matches a known pattern
3. Trace the code path from trigger to failure
4. Identify root cause with file:function:line
5. Output: bug report with repro steps, root cause, severity

### Step 2: Fix (Engineer)
1. Read the bug report
2. Fix the root cause (not a symptom patch)
3. Check for similar patterns elsewhere in the codebase
4. Run `node --check` on modified files
5. Handoff to QA

### Step 3: Verify (QA Tester)
1. Reproduce original bug — confirm it's fixed
2. Test adjacent functionality for regressions
3. If fix reveals a reusable pattern, add to `tasks/lessons.md`
4. Update `tasks/todo.md`

---

## Playbook 3: New Faction

**Pipeline:** Designer (mechanics) → Data (schema) → Engineer (effects) → QA (test) → Art (flag assets)

### Step 1: Faction Design (Systems Designer)
1. Define faction identity: theme, playstyle, mechanical hook
2. Define faction rule (passive that applies to all units)
3. Design 8-12 unit abilities using existing effect types where possible
4. Identify which abilities need new code (new effects, new conditions, new targeting)
5. Output: faction spec with all ability specs

### Step 2: Spreadsheet Schema (Data Architect)
1. Create faction sheet in Google Sheets with standard columns
2. Enter unit stats (HP, move, attack, range, targeting type)
3. Wire all atomic rules in Rules tab
4. Wire all ability defs in Abilities tab
5. Add faction to "Active Faction List" sheet
6. Add terrain assignments to "terrain map" sheet

### Step 3: Code Changes (Engineer)
1. For each ability needing new code, follow Playbook 1 Step 3
2. If faction rule needs new mechanic, implement in game-battle.js or abilities.js
3. Run `node --check` on all modified files

### Step 4: Verification (QA Tester)
1. For each ability, follow Playbook 1 Step 4
2. Test faction rule applies to all units
3. Test faction vs each existing faction for interaction bugs
4. Document results in `tasks/todo.md`

### Step 5: Art Catalog (Art Director)
1. Flag missing unit images
2. Flag missing SFX/VFX for new effects
3. Document in `tasks/art-needs.md`
