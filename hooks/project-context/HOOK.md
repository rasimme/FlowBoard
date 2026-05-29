---
name: project-context
description: "Live-injects the active-project bootstrap (Identity + rules manifest + live task state + PROJECT.md) into bootstrapFiles on every agent run"
metadata: { "openclaw": { "emoji": "📋", "events": ["agent:bootstrap"], "requires": { "config": ["workspace.dir"] } } }
---

# Project Context Hook

Replaces the `BOOTSTRAP.md` entry in OpenClaw's bootstrap-files array
with a freshly built document on every agent run. The single source of
truth is the FlowBoard DB (`flowboard_agents.active_project`), read via
the local API.

## What It Does

1. Listens to `agent:bootstrap` (fires before every agent run; covers
   all session boundaries including `/new`, `/reset`, gateway startup,
   compaction-after, daily reset, idle expiry, and project activation
   via `PUT /api/status`).
2. Derives the canonical `agentId` from the workspace directory name
   (`workspace-<id>` → `<id>`, plain `workspace` → `main`).
3. Resolves the active project from the FlowBoard API (`GET /api/status`).
   If the API is unreachable, the hook emits projectless context by default.
   Legacy `ACTIVE-PROJECT.md` fallback is opt-in only via
   `FLOWBOARD_ALLOW_ACTIVE_PROJECT_FILE_FALLBACK=true` for explicit migration
   recovery windows. An authoritative `null` from the API means "no project
   active" and never triggers the file fallback.
4. Builds the bootstrap document in memory:
   - `# Active Project: <name>` header
   - `## Identity` section with the agent's canonical id
   - Rules manifest (lazy-load index — see `dashboard/rules-api.js`)
   - Live operational task state from `/api/projects/<name>/tasks`
   - Embedded `PROJECT.md` from `~/.openclaw/projects/<name>/` as task-neutral project knowledge
5. Replaces the `BOOTSTRAP.md` entry in `event.context.bootstrapFiles`
   with the freshly built content. If no entry exists, appends one.
6. Agent fetches individual rule sections on demand via
   `GET /api/projects/:name/rules/:section` — rule bodies live in
   `docs/project-mode/*.md`.

## Why agent:bootstrap (and not command:new / command:reset)

Earlier versions of this hook subscribed to `command:new`,
`command:reset`, `gateway:startup`, and `session:compact:after`, and
wrote `BOOTSTRAP.md` to disk. That covered explicit session boundaries
but missed:

- **Daily reset** (default 4:00 local) — creates a new `sessionId`
  without firing `command:new`.
- **Idle expiry** — same, on the next message after the idle window.
- **Project activation via `PUT /api/status`** — pure DB write, no
  command event.

`agent:bootstrap` fires once before every agent run and exposes
`event.context.bootstrapFiles` as a mutable array — exactly the pattern
the bundled `bootstrap-extra-files` hook uses to inject extra files.
Live-injecting from the canonical DB on every run guarantees the
bootstrap matches the current state, removes the file-write hot path,
and eliminates the cache↔projection drift class of bugs.

## Failure Modes

- **Status API unreachable**: emits projectless context by default; rules manifest
  still served (inline fallback if `rules-api.js` cannot be required).
  `ACTIVE-PROJECT.md` fallback is available only when
  `FLOWBOARD_ALLOW_ACTIVE_PROJECT_FILE_FALLBACK=true` is set for a migration
  recovery window.
- **Tasks API unreachable**: still injects active-project context, but the
  `Operational Task State` section becomes an explicit blocker and tells the
  agent not to infer task focus from `PROJECT.md`, `SESSIONS.md`, memory, or
  conversation history.
- **No active project**: writes only the Identity section so the agent
  can still call `PUT /api/status` with the correct `agentId`.
- **Build error**: leaves `bootstrapFiles` untouched (whatever the
  workspace loader found stands), logs a warning. Never throws.

## References

- Spec: `specs/T-168-hook-lifecycle-coverage.md` (T-168-3)
- Bundled reference pattern: `src/hooks/bundled/bootstrap-extra-files/handler.ts`
- Type: `WorkspaceBootstrapFile` in `src/agents/workspace.ts`
