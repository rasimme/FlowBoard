# Specify Workflow

## Purpose

System-level reference for the Specify capability — the structured path from idea (canvas note or chat input) to spec + task(s) in FlowBoard. For the agent-injected prompt instructions, see `specify-prompt.md`.

## Overview

Specify turns unstructured input into:
1. A written **spec document** (markdown, stored in `context/`)
2. One or more **FlowBoard tasks** linked to the spec

It runs as a guided agent session with user confirmation before any persistence.

## Session Model

Specify sessions are in-memory (RAM-only, lost on server restart). They track:

| Field | Description |
|-------|-------------|
| `id` | `specify-{timestamp}` |
| `project` | Target project |
| `origin` | `canvas` or `chat` |
| `sourceNoteIds` | Canvas note IDs being processed |
| `agentId` | Agent running the session |
| `status` | `active` → `completed` / `aborted` |

### Constraints
- One active session per agent
- No overlapping `sourceNoteIds` within the same project
- Sessions are created by the promote endpoint or recognized chat triggers

## Session API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/specify/sessions` | List sessions. Query: `?project=`, `?status=` |
| `GET` | `/specify/sessions/:id` | Get session details |
| `POST` | `/specify/sessions/:id/abort` | Abort session (notes stay on canvas) |
| `POST` | `/specify/sessions/:id/complete` | Mark session done |

## Workflow Steps

1. **ANALYZE** — Agent assesses input across 5 categories (Scope, Users, Data, Behavior, Constraints). Determines Simple vs Complex.

2. **CLARIFY** (Complex only) — Max 4 questions, one at a time, with recommended answers. Stops early on user signal ("weiter"/"passt").

3. **GENERATE** — Agent writes spec from template (`context/specify-spec-template.md`). Decides task structure:
   - Simple → 1 task
   - Medium → Parent + subtasks (spec on parent)
   - Complex → Parent + subtasks (individual specs per subtask)

4. **CONFIRM** — Summary shown to user. Explicit confirmation required before any writes.

5. **PERSIST** — In strict order: write spec file(s) → create task(s) via API → delete source canvas notes (batch delete). Session marked complete.

6. **ERROR HANDLING** — On failure at any persist step: undo partial writes, abort session, inform user. Notes stay on canvas.

## Entry Points

- **Canvas Promote** — Dashboard UI selects notes → POST promote → agent webhook
- **Chat Trigger** — Agent recognizes Specify-triggering phrases in conversation

## Spec Storage

Specs are written to `~/.openclaw/projects/<project>/context/` and indexed in `specs/_index.json` with FlowBoard task ID mappings.

## Integration with Tasks API

Specify creates tasks via the standard `POST /api/projects/:name/tasks` endpoint. The created tasks reference their spec via `links` or `metadata`. This is not a separate task creation path — Specify is a workflow that uses the Tasks API.
