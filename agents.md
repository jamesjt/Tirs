# Multi-Agent Workflow — Tirs of Traea

This document defines the agent team, routing rules, and coordination protocols. Referenced automatically by CLAUDE.md — read this at session start.

---

## Agent Roster

| # | Agent | Command | Domain | Owns |
|---|-------|---------|--------|------|
| 1 | Systems Designer | `/project:designer` | Ability design, balance, faction identity, rule specs | abilities.md, faction spreadsheet specs |
| 2 | Engineer | `/project:engineer` | JS implementation, bug fixes, architecture, code health | WebApp/*.js |
| 3 | Producer/PM | `/project:pm` | Task tracking, dashboard, coordination, CD liaison | tasks/dashboard.html, tasks/todo.md |
| 4 | UX/UI Designer | `/project:ux` | Layout, CSS, player experience, info hierarchy | styles.css, index.html, ui.js (DOM only) |
| 5 | QA Tester | `/project:qa` | Testing, edge cases, bug repro, verification | tasks/lessons.md (bug patterns) |
| 6 | Data Architect | `/project:data` | Google Sheets schema, spreadsheet entries, data validation | Sheet structure, units.js parsing |
| 7 | Multiplayer Engineer | `/project:multiplayer` | net.js, networking, sync, lobby, async turns | net.js, backend design |
| 8 | Mobile Specialist | `/project:mobile` | Responsive layout, touch input, mobile UX | Mobile CSS, touch events |
| 9 | Performance Engineer | `/project:perf` | Profiling, optimization, render perf, memory | Hot paths in board.js, ui.js |
| 10 | Art Director | `/project:art` | Flags needed SFX, VFX, animations — catalogs only | tasks/art-needs.md |

Utility: `/project:status` — Quick dashboard summary (no agent role, just reads and reports).

**Creative Director** = the human. Final authority on all design decisions, priorities, and approvals.

---

## Orchestrator Routing

When the Creative Director sends a prompt, classify it and route to the right agent(s).

### Route by Intent

| Intent Pattern | Route To |
|---------------|----------|
| "design X" / "how should X work" / "balance X" / "what if X" | Systems Designer |
| "implement X" / "build X" / "add X to code" / "fix X" | Engineer |
| "status" / "what's left" / "prioritize" / "update dashboard" | PM |
| "UI for X" / "layout" / "CSS" / "visual feedback" / "panel" | UX/UI Designer |
| "test X" / "verify X" / "is X working" / "bug: X" / "broken" | QA Tester |
| "spreadsheet" / "sheet data" / "column" / "parsing" / "rule ID" | Data Architect |
| "multiplayer" / "network" / "sync" / "lobby" / "net.js" | Multiplayer Engineer |
| "mobile" / "touch" / "responsive" / "pinch" / "portrait" | Mobile Specialist |
| "slow" / "optimize" / "performance" / "memory" / "profil" | Performance Engineer |
| "art" / "animation" / "SFX" / "VFX" / "visual effect" / "sound" | Art Director |
| Multi-domain task | Decompose into subtasks, route each |
| Ambiguous | Ask the Creative Director before routing |

### Multi-Agent Sequences

Common pipelines for compound tasks:

| Task Type | Pipeline |
|-----------|----------|
| **New ability** | Designer (spec) → Data Architect (sheet entries) → Engineer (if new effect needed) → QA (verify) |
| **Bug fix** | QA (reproduce + root cause) → Engineer (fix) → QA (verify) |
| **New faction** | Designer (mechanics) → Data Architect (schema) → Engineer (new effects) → QA (test) → Art Director (flag assets) |
| **UI overhaul** | UX Designer (mockup/plan) → Engineer (implement) → Data Architect (if spreadsheet-driven) → QA (test) |
| **Data-driven feature** | Designer/UX (spec) → Engineer (code) → Data Architect (populate sheet) → QA (verify) |
| **Mobile feature** | Mobile Specialist (design) → UX (adapt) → Engineer (implement) → QA (test) |
| **Multiplayer feature** | Multiplayer Engineer (protocol) → Engineer (integrate) → QA (test) |
| **Polish pass** | Art Director (catalog needs) → UX (prioritize) → Engineer (implement top items) |

---

## Handoff Protocol

Agents communicate via **`tasks/agent-log.md`**. Append entries in this format:

```
### [DATE] [TIME] | [FROM_AGENT] -> [TO_AGENT]
**Task**: Brief description
**Summary**: What was done, what's needed next
**Files touched**: list of modified files
**Blockers**: any blocking issues (or "none")
**CD Decision**: yes/no — if yes, state the question
```

Rules:
- Always append, never edit previous entries
- PM reads the log to build the dashboard
- Keep entries concise (5-10 lines max)
- If no handoff needed, set TO_AGENT to "Complete"

---

## Context Budgets

Each agent should read ONLY what it needs to stay focused and efficient.

| Agent | Must Read | May Read | Skip |
|-------|-----------|----------|------|
| Systems Designer | abilities.md, MEMORY.md, faction specs in tasks/ | todo.md | All .js source code |
| Engineer | CLAUDE.md, abilities.md (if ability work), relevant .js | tasks/lessons.md, todo.md | Spreadsheet specs, dashboard |
| PM | tasks/todo.md, tasks/dashboard.html, tasks/agent-log.md | CLAUDE.md (architecture only) | All .js, abilities.md |
| UX/UI Designer | index.html, styles.css, ui.js | board.js (rendering) | game-*.js, abilities.js |
| QA Tester | CLAUDE.md, tasks/lessons.md, relevant .js for the bug | todo.md | Spreadsheet specs |
| Data Architect | units.js, abilities.md, MEMORY.md | game-core.js (createUnit) | ui.js, board.js |
| Multiplayer Engineer | net.js, game-core.js, CLAUDE.md (state shape) | game-phases.js (turn flow) | abilities.js, board.js |
| Mobile Specialist | index.html, styles.css, ui.js (event handling) | board.js (canvas/touch) | game-*.js, abilities.js |
| Performance Engineer | board.js, ui.js, game-battle.js (hot paths) | abilities.js (dispatch perf) | Spreadsheet specs, tasks/ |
| Art Director | All .js (scan for placeholders), styles.css, index.html | abilities.md (effect types) | tasks/ (except art-needs.md) |

---

## Escalation Rules

Surface to Creative Director (don't proceed unilaterally) when:

1. A design decision has multiple valid approaches with different tradeoffs
2. A bug fix requires changing game mechanics (not just code)
3. Two agents would need conflicting changes to the same file
4. Spreadsheet schema changes would break existing data
5. Any change to CLAUDE.md or agents.md itself
6. Scope creep — the task is growing beyond what was asked
7. Art/audio decisions that affect game feel or player experience

---

## Agent Interaction Rules

- Agents do NOT share context windows. Each runs as an independent subagent.
- The orchestrator (main session) sees all agent outputs and relays relevant context.
- For direct invocation (`/project:engineer do X`), skip routing — run the agent immediately.
- After multi-agent workflows, invoke PM to update the dashboard.
- Any agent can append to `tasks/lessons.md` when discovering a reusable pattern or pitfall.
- The Art Director only catalogs — never modifies code or creates assets.
- **Data completion gate**: When a feature reads from spreadsheet columns, the orchestrator must verify the data exists before marking the feature complete. If the column is empty or missing entries, invoke Data Architect or sheets-cli to populate it. A feature without its data is not shipped.
