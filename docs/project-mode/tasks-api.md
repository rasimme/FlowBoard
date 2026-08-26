# Tasks API

## Purpose

Reference for FlowBoard's task management API. All task mutations go through this API — never write HZL state directly.

## Architecture

- **HZL (event-sourced SQLite)** is the canonical store for all task and runtime state
- **FlowBoard API** (Express, port 18790) owns all mutations and exposes a REST interface
- Tasks live in HZL projects, not in per-project JSON files (legacy `tasks.json` is deprecated)
- The `flowboard_projects` DB table is the canonical project registry (replaces `_index.md`)

## Task Model

| Field | Type | Notes |
|-------|------|-------|
| `task_id` | ULID | Immutable, auto-generated |
| `title` | string | Max 500 chars |
| `project` | string | Project name |
| `status` | enum | `backlog`, `open`, `in-progress`, `review`, `done`, `archived` (see [Kanban concept](../concepts/kanban.md) for semantics) |
| `priority` | integer | 0–2 stored (legacy 3 reads as `high`). UI vocabulary: `low`, `medium`, `high` |
| `agent` | string? | Claimed-by agent identifier |
| `parent_id` | string? | Subtask relationship |
| `description` | string? | Max 16KB |
| `tags` | string[] | Filterable, max 100 |
| `links` | string[] | URLs, references |
| `depends_on` | string[] | Task dependency edges (HZL-level; not yet settable or enforced through the FlowBoard API — see T-154-4) |
| `due_at` | ISO timestamp? | Optional deadline |
| `metadata` | object? | Max 64KB, arbitrary JSON |
| `workState` | enum | Canonical execution context: `working`, `waiting`, `blocked`, `paused` |
| `workStateDetails` | object | Normalized keys: `reason`, `waitingFor`, `responsible`, `checkAgainAt`, `setAt`; absent values read as `null`; `checkAgainAt` must be an ISO-8601 date-time with timezone on writes (offsets no larger than ±14:00, with minute `00` at the boundary); `setAt` is server-owned and client values are ignored |
| `stuckIndicator` | object? | One transient update-in-place monitor signal; `null` when clear |
| `progress` | object? | Parent-only subtask summary exactly `{ done, inProgress, total }`; all values are non-negative integers. It is never a numeric task field. Checkpoint events may separately carry numeric progress 0–100. |
| `lease_until` | ISO timestamp? | Claim expiry |
| `staleAfterMinutes` | positive int? | Per-task stale threshold for stuck detection; overrides the global `STALE_THRESHOLD_MINUTES` (T-300); `null` clears the override |

### FlowBoard ID Mapping

FlowBoard assigns human-readable IDs (e.g. `T-042`) stored in `metadata.flowboard.id`. The API accepts both FlowBoard IDs and ULIDs.

### Human-Readable Text Encoding

Task titles and descriptions are user-facing UTF-8 content. Preserve Unicode
characters supplied by the user, project or source material; do not transliterate
natural language to ASCII just because an agent default prefers ASCII. FlowBoard
does not enforce German, English or any other language.

Keep ASCII where it is a technical identifier: FlowBoard IDs, slugs, filenames,
URLs, JSON keys, environment variables, code and shell commands. Suspicious
legacy transliteration or mojibake belongs in a content-hygiene report, not in a
blind mass rewrite.

## Endpoints

Base: `http://localhost:18790/api`

### Project-Scoped Task CRUD

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/projects/:name/tasks` | List tasks. Query: `?status=` (one of the task statuses; an unknown value is rejected with 400), `?tag=`, `?includeArchived=true`, `?exceptionReview=`, `?structureReview=`. Filters combine. |
| `GET` | `/projects/:name/tasks/:id` | Get one canonical task; returns 404 when unknown |
| `POST` | `/projects/:name/tasks` | Create task. Body: see below |
| `PUT` | `/projects/:name/tasks/:id` | Update task fields or status |
| `DELETE` | `/projects/:name/tasks/:id` | Archive/delete task |

`GET /projects/:name/tasks?structureReview=pending` (or `reviewed`) filters the
list to the requested structure-review status. Tasks expose the exact
`structureReview` shape `{ status, reviewer, reviewedAt, reasons }`, or `null`
when no review is required. Pending reviews use `reviewer: null` and
`reviewedAt: null`; `reasons` is an array of machine-readable criteria. A
review is acknowledged with `POST /projects/:name/tasks/:id/structure-review`
and needs no human credential: creation remains allowed, and the action
records the local operator as reviewer with a server-generated ISO-8601
timestamp. The transition is one-way; a second acknowledgement returns `409`.

### Create Task — Full Body Reference

Direct task creation is available to agents. Specify is an optional clarification
workflow, not a human-authorization gate. Structured development work may use
one request with `{ "parent": { ... }, "subtasks": [{ ... }] }`.

```
POST /projects/:name/tasks
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `title` | string | **yes** | Max 500 chars |
| `priority` | string | no | `low`, `medium`, `high`. Default: `medium`. Legacy `critical` is normalized to `high`; other values are rejected. Subtasks inherit parent priority. |
| `parentId` | string | no | FlowBoard ID of parent task (e.g. `T-042`). Creates a subtask with auto-incremented ID (`T-042-1`). Max 1 nesting level. |
| `status` | string | no | Initial status: `backlog` (default), `open`, `in-progress`, `review`, `done`, `archived`. |
| `workState` | string | no | Optional canonical state: `working`, `waiting`, `blocked`, or `paused`. |
| `workStateDetails` | object | no | Optional contextual details; reads normalize all known keys to present-or-null. |
| `description` | string | no | Short inline context, max 16KB. See **Description vs spec** below — most tasks should have one. |
| `spec` | string | no | Spec markdown, written as `specs/<taskId>-*.md` **in this same call** — a task and its spec cost one request instead of two. All or nothing: if the spec cannot be written, the task is rolled back. Prefer this over putting spec-shaped content into `description`. |
| `tags` | string[] | no | Filterable tags, max 100 |
| `forceId` | string | no | Migration mode: use exact ID instead of auto-generated. Throws on duplicate. |
| `staleAfterMinutes` | positive int | no | Per-task stale threshold (minutes) for stuck detection; also updatable via `PUT`. `null` clears the override; zero/negative values are rejected. |

**Subtask behavior:**
- Setting `parentId` creates a subtask. The ID is auto-generated as `{parentId}-{N}` (e.g. `T-042-1`, `T-042-2`).
- Subtasks inherit the parent's priority unless explicitly overridden.
- Parent tasks (with existing subtasks) cannot be claimed — claim subtasks instead.
- Max 1 nesting level: a subtask cannot have its own subtasks.
- Completing a subtask triggers parent status recalculation.

### Task discipline and structure review

Project metadata exposes `taskDiscipline` as `list`, `standard`, or
`development`. Direct task creation remains allowed for agents and the local
dashboard. Shape checks may attach `structureReview` with machine-readable
reasons; they never make Specify a prerequisite or reject a task because a
human approval was not observed.

Filter pending or completed markers with
`GET /projects/:name/tasks?structureReview=pending|reviewed`. A pending marker
is acknowledged once with
`POST /projects/:name/tasks/:id/structure-review` (no human credential is
required). The server resolves the reviewer and timestamp: request-body
`agent`/`actor` claims are attribution hints only. Anonymous local requests use
`local:operator`; authenticated requests use the resolved session actor.

For structured development work, use one atomic
`POST /projects/:name/tasks` request with `{ parent, subtasks }`. The server
validates all items before writing, allocates child IDs and `parentId`, applies
priority inheritance, and purges the request's tasks if a later write fails.

Specify remains an optional clarification/proposal workflow. The old
`governance/mode` route is a separate compatibility surface, not task-creation
authorization; agents must not describe `compat`/`enforce` as a current task
gate.

### Update Task — Full Body Reference

```
PUT /projects/:name/tasks/:id
```

| Field | Type | Notes |
|-------|------|-------|
| `title` | string | Max 500 chars |
| `status` | string | `backlog`, `open`, `in-progress`, `review`, `done`, `archived` |
| `priority` | string | `low`, `medium`, `high` (legacy `critical` → `high`) |
| `completed` | string | ISO date, auto-set on `done` |
| `specFile` | string | Link a spec file to the task |
| `description` | string | Short inline context, max 16KB (see **Description vs spec**). |
| `workState` | string | Canonical execution context; lifecycle remains independent |
| `workStateDetails` | object | Replaces normalized contextual details; `checkAgainAt` schedules reevaluation only and accepts strict ISO-8601 date-times with timezone, bounded to ±14:00 (±14 requires minute `00`) |
| `tags` | string[] | Replaces the full tag list (max 100). `milestone:<name>` tags feed the overview milestones widget. |

Note: `parentId` cannot be changed via PUT after creation.

The complete PUT payload is validated before any task or spec-link mutation.
The retired top-level `blocked` Boolean is neither accepted nor returned.

### Description vs spec

A task can carry two kinds of detail — use both deliberately:

- **`description`** — a short inline paragraph stored on the task itself: what it is, why, key context. Always visible in the detail panel and full-text searchable. **Most non-trivial tasks should have one.** Set it on create (`POST`) or edit it later (`PUT`).
- **`specFile`** — a detailed `specs/<taskId>-*.md` document (Goal, Done-When checklist, approach) for substantial or complex work only. Pass `spec` to the create call to write it in the same request, or `POST /projects/:name/specs/:taskId` afterwards. Never written by hand. See [Project files](project-files.md).

Rule of thumb: every non-trivial task gets a one-paragraph `description`; only complex or multi-step tasks additionally get a spec. The description is the quick "what is this", the spec is the detailed plan.

**If you are about to write more than a paragraph into `description`, you are writing a spec.** Put it in `spec` instead — it is the same one request, and the description stays what a board column can show. In a `development` project the server flags the task `missing_spec_link` and the create response tells you the call that fixes it; writing the spec later retires that flag on its own, no acknowledgement needed.

### Coordination Workflows

Use these endpoints as the default agent execution protocol.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/workflows/start` | Resume agent work or claim next eligible task atomically. Body: `{ agent, project, lease?, resumePolicy? }` |
| `POST` | `/workflows/handoff` | Complete source task and create follow-on work. Body: `{ project, fromTaskId, title, agent? }` |
| `POST` | `/workflows/delegate` | Create delegated child work. Body: `{ project, fromTaskId, title, agent?, pauseParent?, checkpoint? }` |

### Coordination Primitives

Primitive endpoints are used by the dashboard UI and for explicit edge cases. Agents should prefer the workflow endpoints above for normal task execution.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/projects/:name/tasks/:id/claim` | Claim task; successful claims automatically set status to `in-progress`. Body: `{ agent, lease? }` |
| `POST` | `/projects/:name/tasks/:id/release` | Release claim. Body: `{ agent, force? }` |
| `POST` | `/projects/:name/tasks/:id/complete` | Mark done. Body: `{ agent }` |
| `POST` | `/projects/:name/tasks/:id/checkpoint` | Progress update. Body: `{ message, agent, progress? }` |
| `POST` | `/projects/:name/tasks/:id/comment` | Steering comment. Body: `{ message, author }` |
| `POST` | `/projects/:name/tasks/:id/route` | Route to agent. Body: `{ agent }` |
| `POST` | `/projects/:name/tasks/:id/approve` | Approve a `review` task → `done`. Body: `{ actor?, reason? }`. This is the review→done gate; the approver need not be the claimant. |
| `POST` | `/projects/:name/tasks/:id/reject` | Send a `review` task back. Body: `{ actor?, reason, target? }` — `reason` is **required** (non-empty); `target` is `in-progress` (default) or `blocked`. |
| `POST` | `/projects/:name/tasks/:id/move` | Move the task (and its subtasks) to another project. Body: `{ toProject }`. |
| `POST` | `/projects/:name/tasks/:id/parent` | Re-parent within the project. Body: `{ parentId }` — `null` detaches to top level. |
| `GET` | `/projects/:name/tasks/:id/checkpoints` | List checkpoints |
| `GET` | `/projects/:name/tasks/:id/comments` | List comments |
| `GET` | `/projects/:name/tasks/:id/handoff` | Get handoff context for agent spawning |
| `POST` | `/projects/:name/tasks/:id/stuck-indicator/retry` | Re-evaluate this task's transient indicator without changing lifecycle, work state, details, comments, or notification backoff |
| `POST` | `/projects/:name/tasks/:id/stuck-indicator/clear` | Clear this task's transient indicator and reset notification/backoff metadata without changing lifecycle or work-state details |

### Cross-Project

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/tasks/stuck` | Stale/expired tasks across all projects. Query: `?staleThreshold=` |

## Task Lifecycle Protocol

The soft/global protocol for agent task execution:

1. **Start** — Agent calls `/workflows/start` to resume or claim work atomically
2. **Checkpoint** — Periodic progress updates (message + optional progress %)
3. **Complete / Handoff / Delegate** — Agent marks work ready for review or creates follow-on/delegated work
4. **Release** — Agent relinquishes without completing (e.g. blocked, reassign)

Rules:
- Only the claiming agent can checkpoint/complete/release (unless `force: true`)
- Expired leases allow steal by other agents
- Completing a subtask triggers parent status recalculation

The canonical `workState` is returned directly. Stuck monitoring persists one transient indicator
per task, deduplicates delivery with backoff, and clears it after checkpoints,
recovery/work-state edits, release, review, or completion; it never changes a
task's lifecycle or work state automatically.

The indicator actions above are non-destructive and return a complete canonical
task. They require the exact project/task binding; clients must use the backend
action descriptors rather than inventing a generic PUT fallback. `setAt` is
server-owned: client values (including malformed ones) are ignored on create
and update, and reads expose the server timestamp or `null`.

## Project & Agent State

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/projects` | Canonical project creation path. Creates HZL project + FlowBoard metadata + post-m005 filesystem scaffold |
| `GET` | `/projects` | List all projects with task counts |
| `GET` | `/status` | Active project for agent. Query: `?agentId=` |
| `PUT` | `/status` | Set active project. Body: `{ project, agentId }` |
| `GET` | `/agents` | List all agents and their active projects |

Canonical project registry and per-agent active-project state are DB-backed (`flowboard_projects`, `flowboard_agents`). Active project = context loading, not access control.

Agent ids are validated at API ingress. Known OpenClaw ids and stable external ids are allowed; placeholders or generated workspace/replay ids are rejected. Use the bootstrap-provided id for OpenClaw agents and one stable configured id for external agents.

### Project creation semantics
- Project creation is API-first: use `POST /api/projects`
- Project creation and project activation are separate actions
- New projects are scaffolded directly in the post-m005 structure: `PROJECT.md`, `SESSIONS.md`, `DECISIONS.md`, plus default `context/` and `specs/`. Canvas state is DB-native from creation — no `canvas.json` is scaffolded (ADR-0025)
- Chat flows and future dashboard UI should call this API rather than manually creating directories/files
- Planned UI direction: modal/form-first create flow; richer conversational setup remains future work
