# Project Files

## Purpose

Defines the standard file structure and conventions for FlowBoard projects. Each project lives at `~/.openclaw/projects/<name>/`.

## File Split

| File | Purpose | Character |
|------|---------|-----------|
| `PROJECT.md` | Current state, next steps, bootstrap-worthy overview | Slim, frequently updated |
| `SESSIONS.md` | Chronological session log | Append-only timeline |
| `DECISIONS.md` | Durable architecture and design reasoning | Why-records, rarely deleted |
| `canvas.json` | Spatial idea workspace | API-managed (see canvas-and-notes.md) |

### PROJECT.md

The bootstrap document. Should be readable in isolation and give an agent enough context to start working. Contains:

- Project goal / one-liner
- Current status and active focus
- Key next steps
- Git repo reference (if applicable)
- Tech stack summary

**Not for:** session history, decision rationale, task lists, specs.

### SESSIONS.md

Chronological log of work sessions. Each entry records:
- Date and agent
- What was done
- Key outcomes or blockers

Append-only. Old entries are not edited.

### DECISIONS.md

Durable reasoning records. Each entry answers:
- What was decided
- Why (trade-offs, alternatives considered)
- When

Decisions persist across sessions. They're the "institutional memory" of the project.

## Context Directory

`context/` holds detailed reference material loaded on demand:

- Spec documents (from Specify workflow)
- Architecture notes
- Research / analysis docs
- Implementation notes
- Capability docs (like this one)

Context docs are **lazy-loaded** - agents read them when relevant, not on every session start.

## Spec Index

`specs/_index.json` maps FlowBoard task IDs to spec file paths:
```json
{
  "T-042": "context/T-042-auth-flow.md",
  "T-043": "context/T-043-data-model.md"
}
```

## Project Registry & State

Project registry and per-agent active-project state are DB-backed (m005+). For endpoints and DB details, see `tasks-api.md` § Project & Agent State.

**Migration note:** `ACTIVE-PROJECT.md` and `_index.md` may still exist as stale local artifacts from older installs. They are never authoritative when the FlowBoard API is available; trust `flowboard_projects` and `flowboard_agents` instead.
