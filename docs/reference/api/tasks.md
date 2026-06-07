# Tasks Endpoints

Task CRUD + lifecycle (claim, release, complete, checkpoint, comment, route, handoff). HZL is always enabled in current FlowBoard releases.

## CRUD

### `GET /api/projects/:name/tasks`

List tasks for a project.

**Response 200:** `{"tasks": [{"id": "T-197-7", "title": "...", "status": "review", "agent": "claude-code", "claimedAt": "...", "leaseUntil": "...", "lastCheckpointAt": "...", ...}, ...]}`

### `POST /api/projects/:name/tasks`

Create a task.

**Body:** `{"title": "...", "priority": "high|medium|low", "parentId"?, "specFile"?, ...}`
**Response 201:** `{"ok": true, "task": {<created>}}`

### `PUT /api/projects/:name/tasks/:id`

Update a task. Property whitelist enforced server-side.

**Body:** any whitelisted subset (`title`, `priority`, `status`, `blocked`, `parentId`, `routedAgent`, ...).
**Response 200:** `{"ok": true, "task": {<updated>}}`

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

Claim a task. Optimistic-concurrency via lease.

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

### `POST /api/projects/:name/tasks/:id/reject`

Review/admin action — send a reviewed task back to actionable work with a required reason.

**Body:** `{"actor"?: "<id>", "reason": "<text>", "target"?: "in-progress" | "blocked"}`
- Default target is `in-progress`.
- `target: "blocked"` lands the task in `in-progress` with `blocked=true` so the reviewer can request changes without leaving the task adrift in review.

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

## Cross-cutting

### `GET /api/tasks/stuck`

Cross-project list of tasks with stale claims or expired leases.

**Query:** `staleThreshold` — minutes (default `10`).
**Response 200:** `{"ok": true, "stuck": {"stale": [...], "expired": [...], "combined": [...]}}`

### `GET /api/tasks/notifiable-stuck`

Cross-project list of stuck tasks that should notify now. Applies the same stale/expired detection as `/api/tasks/stuck`, then suppresses repeat notifications within the configured notification window.

**Query:** `staleThreshold` — minutes (default `30`); `notificationWindow` — minutes between repeat notifications for the same stuck task (default `60`).
**Response 200:** `{"ok": true, "notifiable": {"stale": [...], "expired": [...], "combined": [...]}, "appliedThresholds": {...}}`

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

All task endpoints require user-level auth (Telegram-init-data or JWT cookie when auth is configured; loopback bypass in non-production unless `AUTH_ALWAYS=true`). The `agent` field in request bodies is *attribution*, not authentication — the server trusts it on write. ADR-0003 documents this trade-off.

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
