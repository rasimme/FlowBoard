# ADR-0007: HZL Task-Bridge + Brain/Muscle split

## Status
Accepted

## Date
2026-04-01

## Source
- private specs `specs/T-126-tasksjson-hzl-migration.md` and `specs/T-128-agent-orchestration-hzl-bridge.md` in operator's local FlowBoard project
- public commits:
  - `f19bc1f` — `chore: install hzl-core + add hzl-service.js (T-126-1)` (the foundation)
  - `76fe119` — `feat: migrate task routes to hzl-service behind HZL_ENABLED flag (T-126-2)` (the cutover)
  - `f1d17ce` — `feat(T-128): claim/release/complete/checkpoint/comment/stuck/handoff APIs` (the lifecycle bridge)

## Context

Pre-T-126, FlowBoard stored tasks as JSON files (`tasks.json` per project) with full-file rewrites on every change. The model gave no audit trail, no race-safety on concurrent writes, no foundation for multi-agent collaboration. Adding a "claim" feature would have meant either bolting locks onto the file-write path (fragile) or building an event log (a new system from scratch).

A T-125 spike evaluated HZL — an event-sourced SQLite library with a TaskService, EventStore, ProjectionEngine, and several built-in projectors. The CLI was too slow on ARM (~1s per call due to Node startup), but the underlying npm package `hzl-core` exposes the same primitives as direct library calls. That made HZL viable as an *embedded* backend for FlowBoard, not a separate process.

The T-126 spec drew a slogan that became the project's architectural shorthand: **"FlowBoard = brain (specs, canvas, UI), HZL = muscle (tasks, claims, leases, events, SQLite)."** Tasks, lease state, the event log, and SQLite belong to HZL; specs, the canvas, the React UI, and per-project markdown files belong to FlowBoard. The two systems share *only* the agent-id string (per ADR-0003).

T-128 then built the multi-agent task lifecycle on top — claim, release, complete, checkpoint, comment, handoff context, stuck-task detection — using HZL's native event types and projections. The dashboard's `hzl-service.js` became a thin orchestration layer over `hzl-core`'s primitives.

## Decision

This is an umbrella ADR for five inseparable decisions made in the T-126 / T-127 / T-128 wave. They are documented together because each depends on the others — splitting them into individual ADRs would obscure the architecture.

**1. Event-sourced tasks via HZL.** Tasks are no longer JSON files. Every state change appends to the HZL event store; the current state of any task is a projection (`tasks_current` row) computed by replaying events. The event log is append-only and authoritative; projections are recomputable.

**2. Brain/Muscle split.** FlowBoard owns specs (`~/.openclaw/projects/<name>/specs/`), canvas state (`canvas.json`), UI (the React + vanilla dashboard), and per-project markdown (`PROJECT.md`, `DECISIONS.md`). HZL owns tasks, claim/lease state, the event log, and the SQLite database (`flowboard.db`). The two layers share only the agent-id string used as the routing key.

**3. FlowBoard task ids in HZL metadata.** HZL generates ULIDs internally; FlowBoard's `T-NNN` ids are stored in `metadata.flowboard.id`. On server start, `hzl-service.js` builds a bidirectional `Map<flowboardId, ulid>` in RAM for O(1) lookups. `T-NNN` ids retire on delete and are never reused.

**4. FlowBoard status as metadata, not HZL native.** HZL's lifecycle has only the coarse states `ready / in_progress / done / backlog / blocked / archived`. FlowBoard's UI vocabulary needs `open` and `review` in addition. Both statuses are stored: HZL native drives lease and projection mechanics; `metadata.flowboard.status` carries the FlowBoard-domain status. Both update atomically on every write; on doubt, `metadata.flowboard.status` is the source of truth.

**5. Per-task lifecycle as REST surface.** Claim, release, complete, checkpoint, comment, route, handoff-context, and stuck-task detection are exposed as REST endpoints under `/api/projects/:name/tasks/:id/...`. Each maps to one or more HZL event types via `hzl-service.js`. The endpoints are the per-agent contract: any agent — OpenClaw-managed or external (per ADR-0003) — coordinates work entirely through them.

The earlier (pre-T-126) `tasks.json` mechanism is retained as a non-HZL fallback path behind `HZL_ENABLED=false` for legacy deployments and tests; production setups always run with HZL enabled.

## Consequences

- **Lossless audit trail.** "Who did what when" is uncontestable — every decision is a row in the event log; the log is append-only; the current state can always be recomputed.
- **Cheap multi-projection.** The same event stream produces `tasks_current` (Kanban view), `dependencies` (parent/subtask graph), `tags`, `comments_checkpoints` (activity feed), and `projects`. Adding a new projection is a new projector class, not a new write path.
- **Race-safe lease semantics.** Claim and release are events; `tasks_current` is the projection. Two agents claiming concurrently produce two events; the projector applies them in order and the second is rejected. The lease state is never out of sync with the event log.
- **HZL is an embedded library, not a service.** No separate process, no IPC overhead. The dashboard imports `hzl-core` directly via dynamic `import()`. Deployment is one Node process plus one SQLite file.
- **`hzl-service.js` is the single writer.** This is a hard architectural constraint that ADR-0009 (single-writer constraint, planned, T-199-9) makes explicit. The orchestration layer holds invariants — id-map consistency, cache reconciliation, the auto-release on review/done transitions — that fall apart if anything else writes to the same DB.
- **HZL native status is hidden from the UI.** Users see `review`; HZL stores `in_progress`. Raw HZL queries (e.g. `SELECT * FROM tasks_current WHERE status='review'`) return nothing — the right query is `WHERE json_extract(metadata, '$.flowboard.status') = 'review'`.
- **External agents inherit the same surface.** Per ADR-0003, external agents (Codex, Cursor, Claude Code, cron scripts) are first-class on the same REST endpoints. They claim, release, checkpoint, and comment with no per-runtime adapter — the brain/muscle split makes this possible because the muscle (HZL) doesn't know or care which runtime called the API.
- **Migrations need projection rebuilds.** Adding a new projector means rebuilding its projection from the existing event log. The mechanism exists (each projector implements `applyEvent`); the operational discipline is to drop and rebuild the projection table on schema changes, not write a separate migration.
- **HZL upstream changes can break us.** `hzl-core` is an external dependency we don't own. Major version bumps need careful evaluation against our orchestration assumptions (especially around projection auto-side-effects, see comments in `hzl-service.js` lines 130-165).
