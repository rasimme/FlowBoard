---
name: project-context
description: "Regenerates BOOTSTRAP.md with the active project context + rules manifest"
metadata: { "openclaw": { "emoji": "📋", "events": ["command:new", "command:reset", "gateway:startup", "session:compact:after"], "requires": { "config": ["workspace.dir"] } } }
---

# Project Context Hook

Regenerates `BOOTSTRAP.md` when a session starts, compacts, or recovers —
the single entry point the agent reads at session start.

## What It Does

1. Listens to `command:new`, `command:reset`, `gateway:startup`, `session:compact:after`
2. Resolves active project from FlowBoard API (`flowboard_agents` DB); file fallback during migration
3. Writes `BOOTSTRAP.md` with the active project name, the rules manifest
   (lazy-load index — see `dashboard/rules-api.js`), and the per-project
   `PROJECT.md`
4. Agent fetches individual rule sections on demand via
   `GET /api/projects/:name/rules/:section` — rule bodies live in
   `docs/project-mode/*.md`; the pre-migration monolith is archived at
   `docs/project-mode/legacy/PROJECT-RULES.md`

## Why

Without this hook, project context loading depends on an AGENTS.md MANDATORY instruction
which can be overridden by system prompt conflicts (e.g., `/new` greeting instructions).
This hook guarantees the bootstrap is current at every session entry.
