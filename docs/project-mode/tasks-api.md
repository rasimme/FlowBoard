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
| `title` | string | Max 128 chars |
| `project` | string | Project name |
| `status` | enum | `backlog`, `ready`, `in_progress`, `blocked`, `done`, `archived` |
| `priority` | 0–3 | 0=none, 3=critical |
| `agent` | string? | Claimed-by agent identifier |
| `parent_id` | string? | Subtask relationship |
| `description` | string? | Max 16KB |
| `tags` | string[] | Filterable, max 100 |
| `links` | string[] | URLs, references |
| `depends_on` | string[] | Task dependency edges |
| `due_at` | ISO timestamp? | Optional deadline |
| `metadata` | object? | Max 64KB, arbitrary JSON |
| `progress` | 0–100? | Set via checkpoints |
| `lease_until` | ISO timestamp? | Claim expiry |

### FlowBoard ID Mapping

FlowBoard assigns human-readable IDs (e.g. `T-042`) stored in `metadata.flowboard.id`. The API accepts both FlowBoard IDs and ULIDs.

## Endpoints

Base: `http://localhost:18790/api`

### Project-Scoped Task CRUD

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/projects/:name/tasks` | List tasks. Query: `?status=`, `?sinceDays=`, `?tag=` |
| `POST` | `/projects/:name/tasks` | Create task. Body: see below |
| `PUT` | `/projects/:name/tasks/:id` | Update task fields or status |
| `DELETE` | `/projects/:name/tasks/:id` | Archive/delete task |

### Create Task — Full Body Reference

```
POST /projects/:name/tasks
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `title` | string | **yes** | Max 128 chars |
| `priority` | string | no | `low`, `medium`, `high`, `critical`. Default: `medium`. Subtasks inherit parent priority. |
| `parentId` | string | no | FlowBoard ID of parent task (e.g. `T-042`). Creates a subtask with auto-incremented ID (`T-042-1`). Max 1 nesting level. |
| `status` | string | no | Initial status: `backlog` (default), `open`, `in-progress`, `review`, `done`, `archived`. |
| `description` | string | no | Max 16KB |
| `tags` | string[] | no | Filterable tags, max 100 |
| `forceId` | string | no | Migration mode: use exact ID instead of auto-generated. Throws on duplicate. |

**Subtask behavior:**
- Setting `parentId` creates a subtask. The ID is auto-generated as `{parentId}-{N}` (e.g. `T-042-1`, `T-042-2`).
- Subtasks inherit the parent's priority unless explicitly overridden.
- Parent tasks (with existing subtasks) cannot be claimed — claim subtasks instead.
- Max 1 nesting level: a subtask cannot have its own subtasks.
- Completing a subtask triggers parent status recalculation.

### Update Task — Full Body Reference

```
PUT /projects/:name/tasks/:id
```

| Field | Type | Notes |
|-------|------|-------|
| `title` | string | Max 128 chars |
| `status` | string | `backlog`, `open`, `in-progress`, `review`, `done`, `archived` |
| `priority` | string | `low`, `medium`, `high`, `critical` |
| `completed` | string | ISO date, auto-set on `done` |
| `specFile` | string | Link a spec file to the task |
| `blocked` | boolean | Set/clear blocked flag |

Note: `parentId` cannot be changed via PUT after creation.

### Coordination Primitives

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/projects/:name/tasks/:id/claim` | Claim task. Body: `{ agent, lease? }` |
| `POST` | `/projects/:name/tasks/:id/release` | Release claim. Body: `{ agent, force? }` |
| `POST` | `/projects/:name/tasks/:id/complete` | Mark done. Body: `{ agent }` |
| `POST` | `/projects/:name/tasks/:id/checkpoint` | Progress update. Body: `{ message, agent, progress? }` |
| `POST` | `/projects/:name/tasks/:id/comment` | Steering comment. Body: `{ message, author }` |
| `POST` | `/projects/:name/tasks/:id/route` | Route to agent. Body: `{ agent }` |
| `GET` | `/projects/:name/tasks/:id/checkpoints` | List checkpoints |
| `GET` | `/projects/:name/tasks/:id/comments` | List comments |
| `GET` | `/projects/:name/tasks/:id/handoff` | Get handoff context for agent spawning |

### Cross-Project

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/tasks/stuck` | Stale/expired tasks across all projects. Query: `?staleThreshold=` |

## Task Lifecycle Protocol

The soft/global protocol for agent task execution:

1. **Claim** — Agent takes ownership with optional lease duration
2. **Checkpoint** — Periodic progress updates (message + optional progress %)
3. **Complete** — Agent marks task done
4. **Release** — Agent relinquishes without completing (e.g. blocked, reassign)

Rules:
- Only the claiming agent can checkpoint/complete/release (unless `force: true`)
- Expired leases allow steal by other agents
- Completing a subtask triggers parent status recalculation
- Task dependencies block claiming until all deps are `done`

## Project & Agent State

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/projects` | Canonical project creation path. Creates HZL project + FlowBoard metadata + post-m005 filesystem scaffold |
| `GET` | `/projects` | List all projects with task counts |
| `GET` | `/status` | Active project for agent. Query: `?agentId=` |
| `PUT` | `/status` | Set active project. Body: `{ project, agentId? }` |
| `GET` | `/agents` | List all agents and their active projects |

Canonical project registry and per-agent active-project state are DB-backed (`flowboard_projects`, `flowboard_agents`). Active project = context loading, not access control.

### Project creation semantics
- Project creation is API-first: use `POST /api/projects`
- Project creation and project activation are separate actions
- New projects are scaffolded directly in the post-m005 structure: `PROJECT.md`, `SESSIONS.md`, `DECISIONS.md`, plus default `context/`, `specs/`, `canvas.json`
- Chat flows and future dashboard UI should call this API rather than manually creating directories/files
- Planned UI direction: modal/form-first create flow; richer conversational setup remains future work
