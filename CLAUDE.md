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

Four modules using IIFE pattern with clear separation:

```
UI (ui.js) - Events & DOM
    ↓ calls          ↓ calls
Board (board.js)    Game (game.js)
Rendering/Spatial   State/Logic
    ↑               ↑
    └───────────────┘
         Units (units.js)
         Data from Google Sheets
```

**Load order matters:** board.js → units.js → game.js → ui.js

### Module Responsibilities

- **board.js**: Hex grid geometry, canvas rendering, spatial queries (hexAtPixel, getReachableHexes, hexDistance). No game logic.
- **game.js**: Game state machine, 6 phases, turn management, attack validation. No rendering/DOM.
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

### Attack Types

- **L (Line)**: Straight hex line, blocked by units and "cover" terrain
- **P (Path)**: Shortest path must be clear
- **D (Direct)**: Line-of-sight, blocked by "concealing" terrain

## External Data

Google Sheets ID: `17lSSg1vt-m9sM9kfVxL0Noxy-mGClb8RfzedWf5aDlk`
- "Active Faction List" sheet
- Individual faction sheets (unit stats)
- "terrain map" sheet (terrain rules, faction assignments)

Unit images load from `../nandeck/images/unitImages/` (sibling folder).

## Workflow Orchestration

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

## Task Management

Plan First: Write plan to tasks/todo.md with checkable items
Verify Plan: Check in before starting implementation
Track Progress: Mark items complete as you go
Explain Changes: High-level summary at each step
Document Results: Add review sections to tasks/todo.md
Capture Lessons: Update tasks/lessons.md after corrections

## Core Principles

Simplicity First: Make every change as simple as possible. Impact minimal code.
No Laziness: Find root causes. No temporary fixes. Senior developer standards.
Minimal Impact: Changes should only touch what's necessary. Avoid introducing bugs.
