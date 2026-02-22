---
name: project-context
description: "Auto-injects active project context (PROJECT-RULES.md + PROJECT.md) into bootstrap files"
metadata: { "openclaw": { "emoji": "📋", "events": ["command:new", "command:reset", "gateway:startup"], "requires": { "config": ["workspace.dir"] } } }
---

# Project Context Hook

Automatically loads project context when a session starts, compacts, or recovers.

## What It Does

1. Listens to `agent:bootstrap` events
2. Reads `ACTIVE-PROJECT.md` from the workspace
3. If a project is active, reads `PROJECT-RULES.md` and `projects/[name]/PROJECT.md`
4. Injects both files as additional bootstrap files into the session context

## Why

Without this hook, project context loading depends on an AGENTS.md MANDATORY instruction
which can be overridden by system prompt conflicts (e.g., /new greeting instructions).
This hook ensures project context is always available, regardless of instructions.
