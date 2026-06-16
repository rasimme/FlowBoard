# ADR-0008: HZL DB single-writer constraint

## Status
Accepted

## Date
2026-04-01

## Source
- private spec `specs/T-126-tasksjson-hzl-migration.md` (decision AD-2 invariant) in operator's local FlowBoard project
- public commit `f19bc1f` — `chore: install hzl-core + add hzl-service.js (T-126-1)`
- code-comment invariant in `dashboard/hzl-service.js` (the orchestration layer's docstring)

## Context

ADR-0007 established the HZL-backed task layer with `hzl-service.js` as the orchestration over `hzl-core` primitives. The orchestration layer maintains several invariants that the projection engine alone cannot maintain:

- The bidirectional `Map<flowboardId, ulid>` cache, built on init from the full task list. Adding or deleting a task without updating this map breaks `T-NNN` lookups.
- The full-task RAM cache, write-through. A bypass write to the DB without a corresponding cache update silently returns stale reads.
- The auto-release on `status → review/done` transitions (see `hzl-service.js` lines 702–726). A bypass write that sets status without going through this code leaves a claimed task in `done` state with `agent` and `lease_until` still populated.
- The cache-projection alignment after every write (`_alignProjectionToCache` + `_resyncCachedTask`). HZL's projector has its own auto-COALESCE side-effects on `agent`, `claimed_at`, `lease_until`; the orchestration layer reconciles them with the dashboard's intent.
- The id-retention rule (T-NNN values never reused) enforced by computing the next id from `MAX(existing)`, not from a counter the DB maintains.

Each of these is a layered guarantee on top of HZL's own primitives. None can be enforced if a parallel writer (a CLI invocation, a separate script, a maintenance daemon) writes to `flowboard.db` directly.

The T-126 spec called this out explicitly as "Invariant" (AD-2): *"FlowBoard is the ONLY writer to HZL task data. No external HZL CLI, scripts, or other processes may write to the same DB. This is a hard architectural constraint, not a guideline."*

## Decision

The HZL database (`~/.openclaw/workspace/.hzl/flowboard.db`, path overridable via `HZL_DB_PATH`) has exactly one writer: the FlowBoard dashboard process via `dashboard/hzl-service.js`. No external HZL CLI invocation, no parallel script, no second daemon, no maintenance task that writes outside the orchestration layer.

Reads are unconstrained — operators may run `sqlite3 flowboard.db` for inspection, run analysis scripts, or query projections directly. The `hzl-core` CLI is acceptable for read-only queries. The constraint is *write*-exclusivity.

The boundary is enforced by convention, not by the DB. SQLite's WAL mode does not block external writes; the Node process does not hold an exclusive lock. A second writer would simply succeed and silently corrupt invariants. The constraint is a *don't*, not a *can't*.

## Consequences

- **Cache coherence is preserved.** The orchestration layer's RAM cache, id-map, and projection alignment all rely on the assumption that every write originates in `hzl-service.js`. The constraint makes that assumption true.
- **No multi-process FlowBoard deployment.** Running two dashboard instances against the same DB is forbidden by this rule — they would each maintain their own RAM cache, both believing themselves to be the source of truth, and silently diverge on every write. A future "high-availability" deployment would need a different architecture (e.g. a dedicated HZL service with a real write-coordinator).
- **Recovery procedures must respect the rule.** Restoring from backup means stopping the dashboard process, replacing the DB file, and starting again. Running a migration script against a live DB while the dashboard is running breaks the cache.
- **Read-only tooling is fine and encouraged.** `sqlite3 flowboard.db` for ad-hoc inspection, the `hzl-core` CLI for queries, custom analytics scripts that only `SELECT` — none of these violate the rule. The rule targets writes specifically.
- **The constraint is explicit in code comments.** The orchestration layer's docstring states the rule. Future contributors who consider adding "just one quick maintenance script" should be confronted with the rule before doing so.
- **Hooks call back via API, not DB.** The on-complete hook receiver (`POST /api/hooks/task-complete`) is the right pattern for any callback that needs to update task state — it goes through the dashboard process, which goes through `hzl-service.js`. A hook that wrote to the DB directly would be a violation.
- **External agents writing through the API are not violators.** Per ADR-0003 / ADR-0007, external agents (Codex, Cursor, Claude Code) hit the REST endpoints; those endpoints route through `hzl-service.js`. The single-writer rule is about the *DB layer*, not the *API layer*. Many API callers, one DB writer.
