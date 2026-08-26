# Tasks Endpoints

Task CRUD + lifecycle (claim, release, complete, checkpoint, comment, route,
handoff, approve/reject), canonical work state, and transient stuck-indicator
actions. HZL is always enabled in current FlowBoard releases.

## CRUD

### `GET /api/projects/:name/tasks`

List tasks for a project. Add `?exceptionReview=pending` (or `reviewed`) to
show only exception-created tasks in that review state.

**Response 200:** `{"ok": true, "tasks": [{"id": "T-197-7", "title": "...", "status": "review", "agent": "claude-code", "claimedAt": "...", "leaseUntil": "...", "lastCheckpointAt": "...", ...}, ...]}`

### `GET /api/projects/:name/tasks/:id`

Return one canonical task projection. Unknown projects or task IDs return **404**.

**Response 200:** `{"ok": true, "task": {<task>}}`. For a parent task,
`task.progress` is exactly `{ "done": <number>, "inProgress": <number>,
"total": <number> }`; it is the live subtask summary. Numeric progress is
only present on checkpoint events (`POST .../checkpoint`) and is not a task
progress shape.

### `GET /api/projects/:name/exceptions`

Minimal exception-review inbox. `status` defaults to `pending` and accepts
`pending` or `reviewed`. Each returned task includes `creationAudit` (origin,
exception and policy reason) and `exceptionReview`.

**Response 200:** `{"ok": true, "status": "pending", "count": 1, "tasks": [...]}`

### `POST /api/projects/:name/tasks`

Create a task.

**Body:** `{"title": "...", "priority": "high|medium|low", "parentId"?, "workState"?: "working|waiting|blocked|paused", "workStateDetails"?: {"reason"?, "waitingFor"?, "responsible"?, "checkAgainAt"?, "setAt"?}, ...}`. `checkAgainAt` uses an ISO-8601 date-time with an explicit timezone. `setAt` is server-owned: a client value is ignored and the server stamps the write time; responses always expose the normalized key.
**Response 201:** `{"ok": true, "task": {<created>}}`

#### Structured batch creation (T-449-4)

For a structured unit of work, the endpoint also accepts exactly one parent and
one or more subtasks in a single request:

```json
{
  "parent": { "title": "Release API", "description": "...", "priority": "high" },
  "subtasks": [
    { "title": "Implement endpoint", "description": "..." },
    { "title": "Add coverage", "description": "...", "priority": "low" }
  ]
}
```

The response is `200 { "ok": true, "batch": true, "parent": {...},
"subtasks": [...] }`. IDs are allocated by the server; each child has
`parentId` set to the returned parent ID. A child priority is preserved when
provided, otherwise it inherits the parent's priority. Structure-discipline
reviews are calculated for every item independently. The complete request is
validated before the first write, and any later failure purges all tasks from
the request, so the operation is all-or-nothing. Batch items cannot set
`parentId` or `forceId`.

Task creation is not gated on governance mode or Specify. On a
`standard`/`development` item, `taskDiscipline` may attach a `structureReview`
marker with one or both machine-readable reasons — `missing_description` (no
`description`) and `title_pattern` (a bare verb-stub title, e.g. "Fix API") —
without rejecting the item. Specify is an optional clarification workflow.
The legacy governance-mode endpoint remains a separate
compatibility/configuration surface; its `compat`/`enforce` value is not the
task-creation contract.

### `GET|PUT /api/projects/:name/task-discipline`

Read or set the project's `discipline` (`list`, `standard`, or `development`).
The read response includes `default`, `values`, and `canChange`; setting an
invalid value returns `400`. This setting controls non-blocking structure
reviews only.

### `POST /api/projects/:name/tasks/:id/structure-review`

Acknowledge a pending `structureReview`. The server supplies reviewer and
timestamp from the resolved principal; the transition is one-way and a second
acknowledgement returns `409`.

A marker is attached only at creation — `PUT` never adds one — but a
still-`pending` marker is not otherwise permanent: fixing the reason a `PUT`
addresses (giving the task a `description`, renaming a stub title) drops that
one reason, and the marker clears once none remain. This self-retirement only
ever touches a `pending` marker; once `reviewed`, a marker is history and is
never rewritten or cleared by a later edit.

### `PUT /api/projects/:name/tasks/:id`

Update a task. Property whitelist enforced server-side.

**Body:** any whitelisted subset (`title`, `priority`, `status`, `workState`, `workStateDetails`, `routedAgent`, ...).
**Response 200:** `{"ok": true, "task": {<updated>}}`

`workState` is additional state and does not replace the lifecycle.  Every task
read returns all five `workStateDetails` keys (missing values are `null`) and
returns the canonical `workState`; the retired top-level `blocked` Boolean is
neither accepted nor returned. Lifecycle transitions do not auto-unblock or
rewrite `workStateDetails`.

**Guarded status transitions (T-186).** Generic PUT does NOT silently perform privileged workflow transitions:

| Transition | Behaviour |
|---|---|
| `review` → `done` | **409** with `Use POST /api/projects/:project/tasks/:id/approve for review -> done`. Use `/approve`. |
| `done` → `open` / `in-progress` / `review` / `backlog` | **409**. Pass `adminOverride: true` together with a `reason` (and optional `actor`) to bypass; the override is recorded as an audit comment. |
| `done` → `archived` | Allowed (terminal cleanup). |
| `archived` → `done` | Allowed (restore from archive). |
| Other transitions | Allowed. |

### `DELETE /api/projects/:name/tasks/:id`

Soft-delete (tombstones with `trashedAt`).

**Response 200:** `{"ok": true}`

### `DELETE /api/projects/:name/tasks/trash`

Permanently purge all soft-deleted tasks for the project.

**Response 200:** `{"ok": true, "purged": <n>}`

## Lifecycle

### `POST /api/projects/:name/tasks/:id/claim`

Claim a task. Optimistic-concurrency via lease. Successful claims automatically
transition the task to `in-progress`; no additional `PUT` is required.

**Body:** `{"agent": "<id>", "lease"?: <minutes>}`

**Response 200:** `{"ok": true, "task": {<task with claim fields populated>}}`
**409** `ALREADY_CLAIMED` — another agent holds an unexpired lease.
**409** `PARENT_NOT_CLAIMABLE` — parent task blocks subtask claim.
**403** `ROUTING_MISMATCH` — task is routed to a different agent.

### `POST /api/projects/:name/tasks/:id/release`

Release a claim.

**Body:** `{"agent": "<id>", "force"?: boolean}`
**Response 200:** `{"ok": true, ...}`
**403** `NOT_OWNER` unless `force: true` and caller has admin context.

### `POST /api/projects/:name/tasks/:id/complete`

Transition the task to `review` (work done, awaiting acceptance). For subtasks, the parent's status is recalculated.

**Body:** `{"agent": "<id>"}`
**Response 200:** `{"ok": true, "task": {<task in review>}}`
**403** `AGENT_REQUIRED` or `NOT_OWNER`.
**404** if the task doesn't exist.

Acceptance (review → done) is performed via `POST /api/projects/:name/tasks/:id/approve` — see below.

### `POST /api/projects/:name/tasks/:id/approve`

Review/admin action — accept a task that is in `review` and finalise it as `done`. Unlike `/complete`, this is **not** owner-gated; it represents a human/admin reviewer signing off.

**Body:** `{"actor"?: "<id>", "reason"?: "<text>"}`
**Response 200:** `{"ok": true, "task": {<task in done>}}`
**409** `NOT_IN_REVIEW` — task is not in `review`.
**404** task not found.

The approval is recorded as a comment on the task (`Approved by <actor> (review -> done)`), surfaced via `GET .../comments` and in the activity feed.

### `POST /api/projects/:name/tasks/:id/exception-review`

One-way review action for exception-created tasks. The server resolves the
reviewer and timestamp from the authenticated principal; body-supplied
reviewer or timestamp fields are ignored.

**Response 200:** `{"ok": true, "task": {"exceptionReview": {"status": "reviewed", "reviewer": "telegram:42", "reviewedAt": "..."}}}`
**403** `EXCEPTION_REVIEW_REQUIRES_VERIFIED_HUMAN` for an agent or anonymous
caller. **409** `EXCEPTION_REVIEW_IMMUTABLE` after the first review.

### `POST /api/projects/:name/tasks/:id/reject`

Review/admin action — send a reviewed task back to actionable work with a required reason.

**Body:** `{"actor"?: "<id>", "reason": "<text>", "target"?: "in-progress" | "blocked"}`
- Default target is `in-progress`.
- `target: "blocked"` lands the task in `in-progress` with `workState="blocked"` so the reviewer can request changes without leaving the task adrift in review.

**Response 200:** `{"ok": true, "task": {<task back in actionable state>}}`
**400** `REASON_REQUIRED` — `reason` was missing or whitespace-only.
**409** `NOT_IN_REVIEW` — task is not in `review`.
**404** task not found.

The rejection is recorded as a comment (`Rejected by <actor> (review -> in-progress) — Reason: <text>`).

> **Note on `reopen`.** A `/reopen` endpoint (`done -> backlog|in-progress|review`) is intentionally **not** included in T-186. The same effect can be achieved via the generic `PUT` with `adminOverride: true` and a `reason`. Promote to a first-class endpoint later if usage patterns warrant.

### `POST /api/projects/:name/tasks/:id/checkpoint`

Add a progress checkpoint. Resets the lease timer.

**Body:** `{"agent": "<id>", "message": "<text>", "progress"?: <0-100>}`
**Response 200:** `{"ok": true, "checkpoint": {<entry>}}`
**403** `NOT_OWNER`. **404** task not found.

### `GET /api/projects/:name/tasks/:id/checkpoints`

List checkpoints for a task.

**Response 200:** `{"ok": true, "checkpoints": [{<entry>}, ...]}`

### `POST /api/projects/:name/tasks/:id/comment`

Add a comment. Author may differ from current claimant — comments are not lease-gated.

**Body:** `{"author": "<id>", "message": "<text>"}`
**Response 200:** `{"ok": true, "comment": {<entry>}}`

### `GET /api/projects/:name/tasks/:id/comments`

**Response 200:** `{"ok": true, "comments": [{<entry>}, ...]}`

### `GET /api/projects/:name/tasks/:id/events`

Status-change event stream sourced from the HZL event store. Includes block/unblock/route/status-change events visible to all agents, not just the actor.

**Response 200:** `{"ok": true, "events": [{<event>}, ...]}`

### `POST /api/projects/:name/tasks/:id/stuck-indicator/retry`

Re-evaluate exactly this task's transient `stuckIndicator` immediately. The
action is non-destructive: it never changes lifecycle status, `workState`, or
`workStateDetails`, consumes notification/backoff state, wakes an agent, or
adds a comment. If the task is still stuck, the current indicator is returned;
if the condition has cleared, the indicator and its notification/backoff state
are cleared.

**Response 200:** `{"ok": true, "task": <canonical task>, "indicator": <object|null>}`

### `POST /api/projects/:name/tasks/:id/stuck-indicator/clear`

Clear only this task's transient `stuckIndicator` and reset its persisted
stuck-notification/backoff metadata. Lifecycle status, canonical work state,
and work-state details are preserved exactly. The endpoint is idempotent and
does not add a comment or wake an agent.

**Response 200:** `{"ok": true, "task": <canonical task>, "indicator": null}`

Both actions require the normal authenticated API session and validate the
project/task binding; an unknown task returns HTTP 404. Indicators expose
project- and task-bound action descriptors in this exact shape:

```json
{
  "retry": {
    "action": "retry",
    "method": "POST",
    "path": "/api/projects/<encoded-project>/tasks/<encoded-task>/stuck-indicator/retry"
  },
  "clear": {
    "action": "clear",
    "method": "POST",
    "path": "/api/projects/<encoded-project>/tasks/<encoded-task>/stuck-indicator/clear"
  }
}
```

When no explicit threshold is supplied by an internal caller, manual retry uses
the scheduler's `STALE_THRESHOLD_MINUTES` value, with the same default of `30`
minutes. It intentionally does not use the legacy `GET /api/tasks/stuck`
read-default of `10` minutes.

## Cross-cutting

### `GET /api/tasks/stuck`

Cross-project list of tasks with stale claims or expired leases.

**Query:** `staleThreshold` — minutes (default `10`).
**Response 200:** `{"ok": true, "stuck": {"stale": [...], "expired": [...], "routedUnclaimed": [...], "workState": [...], "combined": [...]}}`

Each task may additionally expose one transient `stuckIndicator` object.  The
monitor updates this object in place and clears it on checkpoint, recovery,
release, review, or completion; clearing also resets notification/backoff state
so a new incident is immediately eligible. It does not create reminder
comments. A due `paused.checkAgainAt` only nudges re-evaluation. Notification
ownership comes from an active claim (`agent` plus `claimedAt`); a historical
soft-chip after release is unowned and escalates to the operator.

### `GET /api/tasks/notifiable-stuck`

Cross-project list of stuck tasks that should notify now. Applies the same stale/expired detection as `/api/tasks/stuck`, then suppresses repeat notifications within the configured notification window.

**Query:** `staleThreshold` — minutes (default `30`); `notificationWindow` — minutes between repeat notifications for the same stuck task (default `60`).
**Response 200:** `{"ok": true, "notifiable": {"stale": [...], "expired": [...], "routedUnclaimed": [...], "workState": [...], "combined": [...]}, "appliedThresholds": {...}}`

### `POST /api/workflows/start`

Resume the agent's in-progress task in a project, or claim the next eligible open/backlog task.

**Body:** `{"agent":"<id>","project":"<name>","lease":120,"resumePolicy":"priority"}`
**Response 200:** `{"ok": true, "workflow":"start", "mode":"resume|claim_next|none", "resumed": {...}, "claimed": {...}, "alternates": [...]}`

### `POST /api/workflows/handoff`

Complete an in-progress source task into review and create a follow-on task with carried checkpoint context.

**Body:** `{"project":"<name>","fromTaskId":"T-001","title":"Follow-up","agent":"<optional-routed-agent>"}`
**Response 200:** `{"ok": true, "workflow":"handoff", "completedTask": {...}, "followOnTask": {...}}`

### `POST /api/workflows/delegate`

Create delegated child work from a source task, optionally route it, checkpoint the parent, and pause the parent.

**Body:** `{"project":"<name>","fromTaskId":"T-001","title":"Sub-work","agent":"<optional-routed-agent>","pauseParent":true}`
**Response 200:** `{"ok": true, "workflow":"delegate", "sourceTask": {...}, "delegatedTask": {...}}`

### `GET /api/projects/:name/tasks/:id/handoff`

Handoff context — bundle of task, recent checkpoints, comments, status events — for spawning a sub-agent or transferring claim ownership.

**Response 200:** `{"ok": true, "task": {...}, "checkpoints": [...], "comments": [...], "events": [...]}`

### `POST /api/projects/:name/tasks/:id/route`

Pre-route a task to a specific agent. The routed agent has exclusive claim rights until rerouted.

**Body:** `{"agent": "<id>"}`
**Response 200:** `{"ok": true, "task": {<task with routedAgent>}}`

## Auth & error model

All task endpoints require user-level auth (Telegram-init-data or JWT cookie when auth is configured; loopback bypass in non-production unless `AUTH_ALWAYS=true`). The `agent` field in request bodies is *attribution*, not authentication — the server trusts it on write inside the single-operator local deployment model. Do not treat body `agent` as a cryptographic identity or authorization boundary; remote or multi-user deployments should use `AUTH_ALWAYS=true`, keep the server loopback-bound behind an authenticated tunnel, and treat stronger actor binding as future hardening. ADR-0003 documents this trade-off.

Error codes are surfaced as HTTP status:

| Code | Status | Meaning |
|---|---|---|
| `ALREADY_CLAIMED`       | 409 | Active lease by another agent |
| `PARENT_NOT_CLAIMABLE`  | 409 | Parent task is in a state that blocks subtask claim |
| `ROUTING_MISMATCH`      | 403 | Task is routed to a different agent |
| `NOT_OWNER`             | 403 | Caller does not hold the lease |
| `AGENT_REQUIRED`        | 403 | Operation needs an `agent` field |
| `NOT_IN_REVIEW`         | 409 | `/approve` or `/reject` called on a task not in `review` |
| `REASON_REQUIRED`       | 400 | `/reject` body lacked a non-empty `reason` |
| `not found` (substring) | 404 | Task does not exist |

## See also

- [Multi-Agent Model concept](../../concepts/multi-agent-model.md)
- [ADR-0003](../../adr/0003-dashboard-has-no-agent-identity.md)

## GET /api/search

Unified cross-project search (T-301, T-349) over three kinds:
- **tasks** — FTS5 over title, description and tags (prefix matching);
  trashed and archived excluded.
- **notes** — canvas notes matched by text (LIKE), newest-edited first.
- **projects** — live (non-archived) projects matched by name / display name.

Query params: `q` (required), `project?` (scopes tasks + notes), `limit?`
(tasks, default 20, max 50), `offset?`.

**200** `{ ok, query, tasks: [task & { project, rank }], total,
notes: [{ project, id, text, color }], projects: [{ name, displayName }] }`
**400** `q` missing.

## POST /api/projects/:name/tasks/:id/move

Move a top-level task and its subtasks to another project (T-302). FlowBoard
ids are project-scoped — the task and its subtasks receive fresh ids; the old
reference is kept in `metadata.flowboard.movedFrom` and as an audit comment.
The spec file is not moved.

Body: `{ toProject }`.
**200** `{ ok, task }` — **400** subtask/invalid target — **404** task or target project not found.

## POST /api/projects/:name/tasks/:id/parent

Re-parent a task within its project (T-302): make it a subtask (`parentId`)
or promote it to top-level (`parentId: null`). Max nesting depth stays 1;
the task receives a fresh id matching its new position, old and new parent
statuses are recalculated (ADR-0022).

Body: `{ parentId: string | null }`.
**200** `{ ok, task }` — **404** task or parent not found — **409** `HAS_SUBTASKS`.
