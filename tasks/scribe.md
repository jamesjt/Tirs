# Scribe — Interaction Ledger

Append-only log of every substantive user prompt, interpretation, action, and outcome.

## Entry Format

```
---
Label - HH:MM TZ DD-MM-YY [HH:MM UTC]
- User: [verbatim prompt — typos and all]
- Digest: [what Claude understood the request to mean]
- Action: [what was done — files modified, design decisions, agents invoked]

Xmin — HH:MM TZ DD-MM-YY [HH:MM UTC]
```

## Rules
- Run `date "+%H:%M %Z %d-%m-%y" && date -u "+%H:%M UTC"` for real timestamps
- User line is verbatim. Never summarize.
- Plan and execution are separate entries when a plan precedes work.
- Design decisions that affect game mechanics get a `- Decision:` line.
- Keep entries concise — list files touched, not full diffs.
- If clarifying questions asked, include Q&A between User and Digest.
- Monthly: if month changed since last entry, rename to `tasks/scribe-YYYY-MM.md`, start fresh.

---

## Log

---
Memory & Scribe System — Plan - (session start, retroactive)
- User: we were in the middle of something before webstorm rudely interrupted.
- User: if you're having trouble it was looking the VCI folder and seeing if there is learnings from that claude.md and related files setup
- User: yeah lets make a plan for implementing all of it especially scribe
- User: and the memory system
- Digest: User wanted to adapt VCI's 4-layer memory architecture (especially Scribe interaction ledger and session notes) to the Tirs game dev project. Explored VCI's full file system (CLAUDE.md, IDENTITY.md, SOUL.md, MEMORY-SYSTEM.md, SCRIBE.md, TOOLS.md, playbook/, skills/, knowledge/) and compared against Tirs' existing setup.
- Action: Explored VCI project structure. Designed 5-phase plan: Scribe system, Session Notes, File Map, Quality Gates, Pipeline Playbooks. Plan approved.
- Decision: Skip Layer 1 (Knowledge Graph) — abilities.md + Sheets already serve that role. Skip IDENTITY.md/SOUL.md — agent commands define roles. Keep MEMORY.md and lessons.md separate (different audiences).

---
Memory & Scribe System — Execution - (same session, retroactive)
- User: (plan approved)
- Digest: Implement all 5 phases of the VCI adaptation plan.
- Action: Created tasks/scribe.md, tasks/sessions/TEMPLATE.md, tasks/playbooks.md. Modified CLAUDE.md (File Map, Scribe section, Session Notes section, Quality Gates). Modified agents.md (context budgets).
