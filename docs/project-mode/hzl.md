# HZL Backend

## Purpose

How FlowBoard uses HZL (Hazel) as its event-sourced coordination backend. This doc covers the HZL-specific model and multi-agent state surfaces. For endpoint shapes, see `api-access` (aka `tasks-api.md`). For the workflow-first execution protocol, see `agent-bridge`.

## What HZL is

- **Event-sourced SQLite store**, shipped as the `hzl-core` npm package.
- **Canonical truth** for task state, claims, leases, checkpoints, and comments. All task mutations append events; the current task state is a projection over that event log.
- **Scoped by `project` field**, not by HZL-native projects. HZL itself has no concept of FlowBoard projects — FlowBoard assigns each task a `project` string (the FlowBoard project name) at creation time.
- **Append-only**. History is reconstructable by replaying events. Checkpoints and comments are first-class events, not mutable fields.

## Integration boundary

FlowBoard does not try to mirror every HZL capability in the UI. HZL is the runtime/ledger layer; FlowBoard exposes the parts needed for reliable agent work:

- task state projections
- claims and leases
- checkpoints and comments
- stuck/stale signals
- workflow `start`, `handoff`, and `delegate`
- hook drain for completion notifications

Search, backup, pruning, dependency validation, and hook observability are integrated only when they serve a concrete FlowBoard workflow.

## Storage layout

| File | Role |
|------|------|
| `~/.openclaw/workspace/.hzl/flowboard.db` | HZL event store (canonical) |
| `~/.openclaw/workspace/.hzl/flowboard-cache.db` | Cache DB — read-side projections derived from the event store |

The cache DB is regenerable from the event store. If cache and event store disagree, the event store wins.

## Lease semantics

- A claim records `agent` + `lease_until` (ISO timestamp).
- **Only the claiming agent** may checkpoint, complete, or release — unless `force: true` is passed.
- **Expired lease → steal allowed.** Another agent may claim the task without the original agent's cooperation. The original agent loses ownership at that point.
- **Dependencies** (`depends_on`) block claiming until all referenced tasks are `done`.

The lease is a soft coordination primitive, not a hard lock. Agents must read recent checkpoints/comments before resuming long-running work in case another agent left steering context.

## Workflow semantics

HZL's workflow layer combines primitive task operations into safer multi-step actions. FlowBoard exposes these as API endpoints:

- `POST /api/workflows/start` — resume an agent's in-progress work for a project or claim the next eligible task.
- `POST /api/workflows/handoff` — complete the source task and create follow-on work with carried context.
- `POST /api/workflows/delegate` — create child work, optionally route it and pause the parent.

These workflows are the preferred agent-facing path. Primitive claim/release/complete endpoints remain available for UI actions, debugging, and edge cases.

## Multi-agent state isolation

FlowBoard layers two metadata tables on top of HZL:

| Table | Purpose |
|-------|---------|
| `flowboard_projects` | Canonical project registry (name, display_name, status, assigned_agents, config) |
| `flowboard_agents`   | Per-agent active-project state (`agent_id`, `active_project`, `activated_at`) |

The `flowboard_agents` table is what makes per-agent project activation work. Two agents activating different projects simultaneously each get their own row and their own per-run live-injected `BOOTSTRAP.md` content (the `project-context` hook keys off `agentId` derived from the workspace directory) — without collision on a shared file.

## What does NOT live in HZL

HZL owns coordination state. The following remain filesystem artifacts:

- `PROJECT.md`, `SESSIONS.md`, `DECISIONS.md` — human-readable project docs
- `context/*.md`, `specs/*.md` — capability docs and specs
- `canvas.json` — idea-canvas state (may move to HZL in a future migration)

If you find code treating these as derivable from HZL events, that is a bug.

## Operational pointers

- **Migrations**: `dashboard/migrations.js` holds idempotent migrations m001–m005 (tasks.json → HZL, `_index.md` → `flowboard_projects`, `ACTIVE-PROJECT.md` → `flowboard_agents`, project-path move, session-log consolidation). Run via `node dashboard/migrate-tasks.js` or auto-run on server startup.
- **Env flags**: `HZL_ENABLED=true` must be set for DB-canonical behavior; `HZL_DB_PATH` overrides the default path.
- **Cache rebuild**: deleting `flowboard-cache.db*` forces the server to rebuild projections from the event store on next start.

## Related

- `api-access` — endpoint reference, task model, lifecycle protocol
- `agent-bridge` — workflow-first execution protocol, checkpoint/complete behavior, handoff, multi-agent patterns
- `key-principles` — why DB is canonical and state files are transitional
