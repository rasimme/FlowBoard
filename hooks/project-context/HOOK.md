---
name: project-context
description: "Live-injects the active-project bootstrap (Identity + rules manifest + live task state + PROJECT.md) into bootstrapFiles on every agent run"
metadata: { "openclaw": { "emoji": "📋", "events": ["agent:bootstrap"], "requires": { "config": ["workspace.dir"] } } }
---

# Project Context Hook

Injects a `FLOWBOARD.md` entry into OpenClaw's bootstrap-files array
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
3. Resolves the active project from the FlowBoard API (`GET /api/status`),
   passing `&sessionKey=` when the event context supplies one.
   If the API is unreachable, the hook emits projectless context by default.
   Legacy `ACTIVE-PROJECT.md` fallback is opt-in only via
   `FLOWBOARD_ALLOW_ACTIVE_PROJECT_FILE_FALLBACK=true` for explicit migration
   recovery windows. An authoritative `null` from the API means "no project
   active" and never triggers the file fallback.
4. Builds the bootstrap document in memory:
   - `# Active Project: <name>` header, followed by a `Binding: session|agent`
     line when the server reports which binding layer answered (ADR-0039).
     The raw session key is never written into the document.
   - `## Identity` section with the agent's canonical id
   - Rules manifest (lazy-load index — see `dashboard/rules-api.js`)
   - Live operational task state from `/api/projects/<name>/tasks`
   - Embedded `PROJECT.md` from `~/.openclaw/projects/<name>/` as task-neutral project knowledge
5. Puts a `FLOWBOARD.md` entry (path `<workspaceDir>/FLOWBOARD.md`) into
   `event.context.bootstrapFiles`. An entry that already has that name or
   path is replaced; otherwise one is appended. No other entry is touched —
   in particular a workspace's own `BOOTSTRAP.md` is left alone.
6. Agent fetches individual rule sections on demand via
   `GET /api/projects/:name/rules/:section` — rule bodies live in
   `docs/project-mode/*.md`.

## Consumed context fields

From `event.context` (all optional unless noted):

| Field | Use |
|---|---|
| `bootstrapFiles` | **Required.** The mutable array the hook adds `FLOWBOARD.md` to; the hook returns early if it is absent. |
| `workspaceDir` | Canonical `agentId` source (`workspace-<id>` → `<id>`), and the path of the injected entry. |
| `agentId` | Fallback identity when no id can be derived from the workspace; `main` if neither is available (T-168 precedence, unchanged). |
| `sessionKey` | Forwarded to `GET /api/status` as `&sessionKey=` so a session-scoped binding answers this run (ADR-0039). Dropped when empty, non-string, over 256 characters, or containing control characters. It is context, never authorization, and is never rendered into the bootstrap text. |
| `pluginConfig` | Merged over the plugin defaults (`dashboardBaseUrl`, `projectsDir`). |

`sessionId` is not consumed.

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

## Why the entry is called FLOWBOARD.md

OpenClaw reserves `BOOTSTRAP.md` for its one-shot onboarding file. Once a
workspace has finished setup, core drops a `BOOTSTRAP.md` entry at
`<workspaceDir>/BOOTSTRAP.md` again *after* the `agent:bootstrap` hooks have
run, and it strips any context file whose basename is `BOOTSTRAP.md` unless
bootstrap mode is `full`. Up to T-501 the hook injected its document under
that name, so the project context never reached the prompt on a set-up
workspace. The hook now uses its own name and never modifies `BOOTSTRAP.md`.
The regression test `dashboard/test-hook-core-bootstrap-filter.mjs` re-runs
both core rules against the injected entry.

**Which sessions see it.** On OpenClaw 2026.9 and newer, core re-applies its
per-session allowlists after the hooks: subagent runs keep only `AGENTS.md`
and cron runs keep only `AGENTS.md`, `SOUL.md`, `IDENTITY.md` and `USER.md`.
`FLOWBOARD.md` therefore reaches main, direct and group sessions; subagents
receive their FlowBoard work through the handoff package instead. On older
hosts the allowlists run before the hooks, so every run type sees it.

**Size.** The hook does not trim the document. OpenClaw applies its own
per-file limit (`bootstrapMaxChars`, default 20000 characters) and total
limit (`bootstrapTotalMaxChars`, default 60000) and truncates beyond them.
Very large `PROJECT.md` files are the usual reason to hit the per-file limit.

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
- ADR: `docs/adr/0039-session-scoped-project-binding.md` (session-scoped binding)
- Bundled reference pattern: `src/hooks/bundled/bootstrap-extra-files/handler.ts`
- Type: `WorkspaceBootstrapFile` in `src/agents/workspace.ts`
