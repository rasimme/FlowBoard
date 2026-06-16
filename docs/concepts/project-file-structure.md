# Project File Structure

## What it is

The set of files every project carries (`PROJECT.md`, `SESSIONS.md`, `DECISIONS.md`, `context/`, `specs/`) and the rule for what belongs in files versus the database.

## Why it exists

A project needs durable, human-readable knowledge that survives every session — but it must not become a second, stale source of truth for operational state. The split exists to keep those concerns apart: Markdown holds *stable knowledge and history*; the DB (HZL + metadata) holds *current task/canvas state*.

## How it works

- **`PROJECT.md`** — stable project map (goal, scope, background, important files) and the canonical home for project-specific **development rules** ([ADR-0027](../adr/0027-agent-doc-separation.md)); served to every agent via bootstrap. **Task-neutral** — never current task state.
- **`SESSIONS.md`** — append-only session log (what was done, outcomes, next step); one entry per session.
- **`DECISIONS.md`** — durable decision records (what/why/when), written when a decision is made.
- **`context/`** — lazy-loaded reference docs; **`specs/`** — task specs, created only via `POST /api/projects/:name/specs/:taskId`, never hand-written.
- **DB-canonical:** task and canvas state live in HZL / DB tables ([HZL Event Sourcing](hzl-event-sourcing.md), ADR-0007); files like `tasks.json`/`canvas.json`/`ACTIVE-PROJECT.md` are legacy fallbacks, not authoritative when the API is reachable.

The agent-facing operational version of these rules is `docs/project-mode/project-files.md`; this concept doc is the *why*.

## Consequences

- An agent reads current work from the Tasks API, not by scanning files — and treats `PROJECT.md` as background, not a task list.
- New projects are scaffolded directly into this structure (post-m005), including the `## Development rules` stub.

## Where the code lives

- `dashboard/project-lifecycle.js` — scaffolding.
- Agent rules: `docs/project-mode/project-files.md`.
- Related: [ADR-0027](../adr/0027-agent-doc-separation.md), [ADR-0007](../adr/0007-hzl-task-bridge-and-brain-muscle-split.md).
