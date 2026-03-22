# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the Project

Serve from project root to access both WebApp and nandeck (unit images):
```bash
npx serve .
```
Then open `http://localhost:3000/WebApp/`

Alternative: serve WebApp directly (unit images won't load):
```bash
npx serve WebApp
```

No build step required - pure HTML/JS/CSS.

## Architecture

Five modules using IIFE pattern with clear separation:

```
UI (ui.js) - Events & DOM
    ↓ calls          ↓ calls
Board (board.js)    Game (game-core/battle/phases.js)
Rendering/Spatial   State/Logic
    ↑               ↑
    └───────────────┘
         Units (units.js)
         Data from Google Sheets
```

**Load order matters:** board.js → units.js → game-core.js → game-battle.js → game-phases.js → net.js → abilities.js → ui.js

### Module Responsibilities

- **board.js**: Hex grid geometry, canvas rendering, spatial queries (hexAtPixel, getReachableHexes, hexDistance). No game logic.
- **game-core.js**: IIFE creating `Game` object. Owns state closure, PHASE constants, freshState/reset/log, createUnit, condition system (add/remove/has/clear/getEffective). No rendering/DOM.
- **game-battle.js**: Extends Game via `((G) => { ... })(Game)`. Battle activation (select/move/attack/undo), attack validation (canAttack, LoS, LoE), terrain rules, objectives, ability utilities (push/pull/toss/level/damageUnit).
- **game-phases.js**: Extends Game. Pre-battle phases (faction/roster/terrain/unit deploy), turn/round management, round-step interactives (shifting, consuming, hot suit, arc fire).
- **ui.js**: Event handlers, phase UI builders, bridges Board and Game. Calls `Board.render(Game.state)`.
- **units.js**: Fetches faction/unit data from Google Sheets via PapaParse CSV endpoint.

### Game State

```javascript
Game.state = {
  phase,              // faction_select | roster_build | terrain_deploy | unit_deploy | battle | game_over
  currentPlayer,      // 1 or 2
  players: { 1: { faction, roster: [], terrainPlacements }, 2: {...} },
  units: [],          // Deployed units with q,r positions
  terrain: Map,       // "q,r" -> {surface}
  objectiveControl,   // "q,r" -> 0|1|2
  // UI state: selectedUnit, selectedAction, highlights, attackTargets
}
```

### Hex System

- Axial coordinates (q, r) for positions
- String keys for maps: `"4,3"`
- Flat-top hexes, neighbors by pixel distance
- Player 1 zone: columns 0-3 (left), Player 2: columns 9-12 (right)

### Targeting Types (L/P/D)

Three geometric targeting patterns used by attacks AND action abilities:

- **L (Line)**: Straight hex line, blocked by units and "cover" terrain
- **P (Path)**: Shortest path must be clear
- **D (Direct)**: Line-of-sight, blocked by "concealing" terrain

`computeActionTargets()` validates L/P/D geometry for all target types (enemies, allies, empty hexes, terrain), not just attacks. For enemies, `canAttack()` adds hidden/LoE checks.

### Ability Targeting (`validTargets` column)

The `validTargets` column on atomic rules is the single source for both purposes:

- **UI click-filtering** (`computeActionTargets`): Matches hex tags — `enemy`, `ally`, `empty`, `spaces` (wildcard), terrain surface names. Determines which hexes highlight as clickable.
- **Effect resolution** (`resolveTargets`): Tokenizes keywords — `lineToTarget`, `aroundTarget`, `allEnemies`, `self`, `path`, etc. Determines who receives the effect when the rule fires.

There is no separate "target" column — `validTargets` serves both roles.

**Never hardcode targeting logic in effect handlers.** The `validTargets` column is the single source of truth for who receives an effect. If a Parting Gift targets `closestAlly`, that filtering happens in `resolveTargets()` — the `applyGrantAbility()` handler should never re-check "is this an ally?". Adding redundant code guards for things the data layer already controls creates maintenance burden, masks data bugs, and violates the data-driven architecture. If targeting is wrong, fix the spreadsheet — don't patch it in code.

## External Data

Google Sheets ID: `17lSSg1vt-m9sM9kfVxL0Noxy-mGClb8RfzedWf5aDlk`
- "Active Faction List" sheet
- Individual faction sheets (unit stats)
- "terrain map" sheet (terrain rules, faction assignments)

Unit images load from `../nandeck/images/unitImages/` (sibling folder).

## Ability System Reference

**When working on abilities, effects, conditions, rules, or the targeting system, read `WebApp/abilities.md` first.** It contains comprehensive documentation of every effect type, condition, rule type, condition evaluator, targeting keyword, passive flag, and integration point in the ability system.

Key topics covered: 3-layer architecture, rule types & triggers, condition evaluators, all effects with value formats, condition defaults & stat modifiers, targeting dual-purpose system, resource system, beam/trap/marker systems, two-rule pattern, action cost system, passive flags, effect queue, and the full public API.

**Before claiming something "needs new code"**: Read the actual implementation in `abilities.js` (specifically `resolveTargets()`, `evaluateCondition()`, `applyEffect()` and their helpers). Documentation can be stale or ambiguous — the code is the source of truth for what the system can already do. Never say "needs new code" based on documentation alone.

## Workflow Orchestration

### 0. Session Startup
Read MEMORY.md (auto-loaded). For ability/faction work, also read the relevant topic file from `memory/` (systems.md, abilities-reference.md, tag-targeting.md) before starting. Check `tasks/agent-log.md` tail for recent handoffs if continuing previous work.

### 1. Plan Mode Default

Enter plan mode for ANY non-trivial task (3+ steps or architectural decisions)
If something goes sideways, STOP and re-plan immediately - don't keep pushing
Use plan mode for verification steps, not just building
Write detailed specs upfront to reduce ambiguity

### 2. Subagent Strategy

Use subagents liberally to keep main context window clean
Offload research, exploration, and parallel analysis to subagents
For complex problems, throw more compute at it via subagents
One task per subagent for focused execution

### 3. Self-Improvement Loop

After ANY correction from the user: update tasks/lessons.md with the pattern
Write rules for yourself that prevent the same mistake
Ruthlessly iterate on these lessons until mistake rate drops
Review lessons at session start for relevant project

### 4. Verification Before Done

Never mark a task complete without proving it works
Diff behavior between main and your changes when relevant
Ask yourself: "Would a staff engineer approve this?"
Run tests, check logs, demonstrate correctness

### 5. Demand Elegance (Balanced)

For non-trivial changes: pause and ask "is there a more elegant way?"
If a fix feels hacky: "Knowing everything I know now, implement the elegant solution"
Skip this for simple, obvious fixes - don't over-engineer
Challenge your own work before presenting it

### 6. Autonomous Bug Fixing

When given a bug report: just fix it. Don't ask for hand-holding
Point at logs, errors, failing tests - then resolve them
Zero context switching required from the user
Go fix failing CI tests without being told how

### 7. Agent System

Read `agents.md` for the agent roster, routing table, and handoff protocol.

**Before starting ANY task**, consult the routing table in agents.md:
- Classify the request by intent and check which agent(s) should own it
- If the task touches ability data/targeting/effects, route through Designer + Data Architect first — don't jump straight to code
- For multi-domain tasks, decompose and route per the sequence templates in agents.md
- Direct slash commands (`/project:engineer`, etc.) bypass routing for targeted work

**After completing ANY task**, invoke PM (`/project:pm`) to update `tasks/dashboard.html` with:
- What was done (recent activity entry)
- Any status changes (faction readiness, goals progress, bugs resolved/found)
- New blocked items or decisions surfaced

PM dashboard: `tasks/dashboard.html`. Agent communication: `tasks/agent-log.md`.

## Task Management

Project Planner: `tasks/dashboard.html` — single source of truth for all tasks. Roadmap, backlog, sprint, faction readiness, blocked items, decisions, recently completed. PM agent owns updates to `PLANNER_DATA`.
Ability Reference: `WebApp/abilities.md` — full ability system documentation (effects, conditions, targeting, passive flags, integration points).
Capture Lessons: Update tasks/lessons.md after corrections
Close the Loop: After ANY session — scrub planner sprint/backlog and plan files for stale/completed/invalidated items. Delete finished plan files. Record "won't do" decisions with reasons. A phantom task is worse than a missing task.

## Core Principles

Simplicity First: Make every change as simple as possible. Impact minimal code.
No Laziness: Find root causes. No temporary fixes. Senior developer standards.
Minimal Impact: Changes should only touch what's necessary. Avoid introducing bugs.
