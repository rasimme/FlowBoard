# HZL Event Sourcing

## What

The data layer underneath every FlowBoard task is an **event-sourced** SQLite store called HZL. Every state change — task created, status changed, claim acquired, comment added, checkpoint written — appends an immutable event to the event log. The current state of any task is a *projection* derived from replaying events: a row in the `tasks_current` table (and sibling tables `comments_checkpoints`, `dependencies`, `tags`, `projects`) computed by projection engines that consume events and update materialized views.

FlowBoard does not own this code. HZL ships as `hzl-core`, an external npm dependency. FlowBoard's `dashboard/hzl-service.js` is a *thin orchestration layer* over `hzl-core`'s `TaskService`, `EventStore`, `ProjectionEngine`, and the individual projectors.

The architectural slogan from the original migration spec (T-126): **"FlowBoard = brain (specs, canvas, UI), HZL = muscle (tasks, claims, leases, events, SQLite)."**

## Why

The system needed three things at once and event-sourcing was the cheapest way to get all three.

**Lossless audit trail.** Multi-agent collaboration only works when "who did what when" is uncontestable. With event-sourcing, every decision is a row in the event log; the log is append-only; the current state can always be recomputed. Compare the alternative — CRUD over `tasks_current` directly — where overwriting a status loses the previous state and the actor; getting auditability back means bolting a separate audit table onto every write path. Event-sourcing makes audit the *primary* representation; the projection is the convenience.

**Cheap multi-projection.** The same event stream produces `tasks_current` (Kanban view), `dependencies` (parent/subtask graph), `tags`, `comments_checkpoints` (activity feed), and `projects`. Each is a focused materialized view. Adding a new projection is a new projector class, not a new write path — the events already contain everything needed.

**Race-safe lease semantics.** Claim and release are events; `tasks_current` is the projection. Two agents claiming concurrently produce two events; the projector applies them in order and rejects the second. The lease state is never out of sync with the event log.

The earlier (pre-T-126) implementation stored tasks as JSON files (`tasks.json` per project) with full-file rewrites on every change. That model gave none of the above and had data-corruption races on concurrent writes. The migration to HZL was a foundational architectural change; the *brain vs muscle* split (FlowBoard owns specs/canvas/UI, HZL owns tasks/events) emerged from it. ADR coverage of this decision is currently a backlog item (T-199-1).

## How

The data path on a task mutation looks like this:

```
client (UI or API)
    │
    │  POST /api/projects/X/tasks/T-42/claim {agent: "dev-botti"}
    ▼
dashboard/server.js  (HTTP layer)
    │
    │  hzlService.claimTask("X", "T-42", {agent, lease})
    ▼
dashboard/hzl-service.js  (orchestration)
    │
    │  resolves T-42 → ULID via in-memory id map
    │  validates routing, checks lease conflicts at the cache level
    │
    ▼
hzl-core: TaskService.claimTask(ulid, {agent_id, author})
    │
    │  appends event to EventStore   (claim_acquired event row)
    ▼
hzl-core: ProjectionEngine
    │
    │  TasksCurrentProjector consumes the event:
    │    UPDATE tasks_current SET agent=?, claimed_at=?, lease_until=? WHERE task_id=?
    │
    │  CommentsCheckpointsProjector / TagsProjector / etc. ignore non-relevant events
    ▼
dashboard/hzl-service.js  (post-write reconcile)
    │
    │  re-reads tasks_current[ulid] → updates RAM cache
    │  returns dashboard-shaped task object (FlowBoard's id, status, etc.)
    ▼
client receives 200 response with updated task
```

**Five core projectors** subscribe to the event stream:

- `TasksCurrentProjector` — produces `tasks_current` (one row per active task, the Kanban projection).
- `DependenciesProjector` — produces `dependencies` (parent/subtask graph for subtask roll-up).
- `TagsProjector` — produces `tags` (per-task tag membership).
- `ProjectsProjector` — produces `projects` (per-project counts and metadata).
- `CommentsCheckpointsProjector` — produces `comments_checkpoints` (the activity feed).

**FlowBoard-specific status lives in metadata, not in HZL's native status.** HZL's lifecycle has only the coarse states `ready / in_progress / done / backlog / blocked / archived`. FlowBoard adds `review` (work submitted, awaiting acceptance) and uses `open` instead of `ready` in the UI vocabulary. Both are stored: HZL's native status drives lease and projection mechanics; `metadata.flowboard.status` carries the FlowBoard-domain status. The mapping is in `FB_TO_HZL` and `HZL_TO_FB` tables in `hzl-service.js`. Both update atomically on every write so they cannot drift; if they ever did, `metadata.flowboard.status` is the source of truth for the UI.

**FlowBoard task ids are stored in HZL metadata.** HZL's `task_id` is a ULID (auto-generated, sortable, opaque). FlowBoard's `T-NNN` ids are stored in `metadata.flowboard.id`. On server start, `hzl-service.js` loads every task and builds a bidirectional `Map<flowboardId, ulid>` in RAM for O(1) lookups. The cache is invariantly consistent with the DB — every write updates both — but is never authoritative; on any doubt, `rebuildCache()` reloads from HZL.

**FlowBoard is the only writer.** This is a hard architectural constraint, not a guideline. No external HZL CLI invocation, no parallel script, no second daemon. The orchestration layer holds invariants (id-map consistency, cache reconciliation, the auto-release on review/done transitions described in the [Kanban concept](kanban.md)) that fall apart if anything else writes to the same DB.

**Cache write-through.** Reads come from the in-memory cache (zero DB hits per Kanban poll). Writes go HZL API → update cache → return. The cache is rebuilt on server restart and on explicit corruption recovery. Document T-176 in the operator's spec backlog discusses refactoring this cache; the architecture today is the simplest thing that works.

## Consequences

- **The event log is the authoritative history.** Querying "when did dev-botti claim T-42?" goes directly to the event log; no audit table to keep in sync. The same query on an old, abandoned, archived task gives the full record decades later.
- **Projections can be rebuilt.** If a projector logic bug were to corrupt `tasks_current`, the recovery is to drop the projection table and replay the event log. No data is lost in projection-layer bugs.
- **HZL's native status is hidden from the UI.** Users see `review`; HZL stores `in_progress`. The metadata layer makes this seamless but it means raw HZL queries (e.g. `SELECT * FROM tasks_current WHERE status='review'`) return nothing — the right query is `WHERE json_extract(metadata, '$.flowboard.status') = 'review'`.
- **One-writer constraint is load-bearing.** Anything that writes to the HZL DB outside of `hzl-service.js` will eventually corrupt invariants — id-map inconsistency, cache divergence, missed status side-effects. Don't add a second writer; route through the service.
- **Performance is sub-millisecond per write.** SQLite local + prepared statements + RAM cache for reads gives single-digit-millisecond latency on the hot path. The dashboard's 5-second polling is bounded by network and JSON serialization, not DB.
- **Migrations need projection rebuilds.** Adding a new projector means rebuilding its projection from the existing event log. The mechanism exists (each projector implements `applyEvent`); the operational discipline is to drop and rebuild the projection table on schema changes, not to write a separate migration.

- **Known exception to event-only writes (T-293 finding, tracked in T-176).** `_alignProjectionToCache()` in `hzl-service.js` patches `claimed_at`/`lease_until` in the projection via direct SQL because HZL's event vocabulary has no "clear claim metadata without changing status" primitive. A projection rebuilt purely from the event log will not reproduce these patches. The planned fix is the derive-on-read cache refactor (T-176), which removes the write-through path entirely.
- **`metadata.flowboard.id` values never get reused.** When a task is deleted, its T-NNN id is retired from the active map but stays in archived events. The next created task gets `MAX(existing) + 1`, not "the deleted one's slot." This is intentional — reusing ids would silently confuse historical references in commits, comments, and specs.
- **Not everything in the events DB file is event-sourced.** Since T-344 the canvas tables (`canvas_notes`, `canvas_connections`, `canvas_meta`) live as plain relational tables in the same `flowboard.db` file — last-write-wins rows, no event log, no projection (ADR-0025). They share the file for its operational guarantees (canonical, watermark-protected per ADR-0018, single writer per ADR-0008), not for the event-sourcing model: the append-only triggers guard only the `events` table, and canvas state is deliberately *not* derivable from events. Event-sourcing is the model for task and coordination state, not a blanket rule for the file.

## Code

- `dashboard/hzl-service.js` — the orchestration layer. Init in `init()`, status mapping in `FB_TO_HZL` / `HZL_TO_FB` (lines 35-52), id map handling around `_alignProjectionToCache` and `_resyncCachedTask`, cache lifecycle in `rebuildCache()`, the public surface (`createTask`, `updateTask`, `claimTask`, `releaseTask`, `completeTask`, `addCheckpoint`, `addComment`, `archiveTask`, `purgeTrash`).
- `dashboard/migrate-tasks.js` — one-shot migration from the legacy `tasks.json` files to HZL. Read-only after migration unless invoked manually.
- `~/.openclaw/workspace/.hzl/flowboard.db` — the SQLite event store + projections (path overridable via `HZL_DB_PATH`).
- External: `hzl-core` package — `TaskService`, `EventStore`, `ProjectionEngine`, `EventType`, `TasksCurrentProjector`, `DependenciesProjector`, `TagsProjector`, `ProjectsProjector`, `CommentsCheckpointsProjector`. The dashboard imports these directly via dynamic `import()` in `hzl-service.js:280-288`.

## See also

- [Kanban](kanban.md) — the user-facing surface that this data layer powers
- [Multi-Agent Model](multi-agent-model.md) — how `tasks_current.agent` and lease projections enable collaboration
- T-199-1 (backlog) — foundation ADR for the HZL Task-Bridge that anchors this concept
- T-176 (operator backlog) — refactoring the orchestration cache (does not change the event-sourcing design, only the cache implementation)
