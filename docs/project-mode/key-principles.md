# Key Principles

## Purpose

The load-bearing invariants behind Project Mode. If a behavior contradicts one of these, the behavior is wrong.

## Principles

### 1. Active project = context loading, not access control

Activating a project determines what context the agent fetches from the bootstrap endpoint or receives via runtime injection. It does **not** restrict:
- reading files in other projects
- creating tasks in other projects
- ad-hoc cross-project work

Only switch the active project when the main focus of work actually changes.

### 2. Canonical state is DB-backed

Project registry (`flowboard_projects`) and per-agent active-project state (`flowboard_agents`) live in FlowBoard's DB-backed runtime. Legacy files (`ACTIVE-PROJECT.md`, `_index.md`, `SESSION-STATE.md`) are stale compatibility artifacts when present and must not override API state.

### 3. API-first for mutations

FlowBoard server owns all operational project/task mutations. Use the API for:
- project creation, activation, deactivation
- task CRUD, claim, checkpoint, complete, release
- spec and canvas state changes

Never edit state files directly. `POST /api/projects` is the canonical creation path — never `mkdir` + hand-scaffolded files.

Operational task truth comes from HZL through the Tasks API. Do not derive current work, claims, review state, priorities, or next steps from project Markdown.

### 4. Lazy-load capability docs

The bootstrap endpoint carries the project rules index and compact current context. Detailed operational docs (`tasks-api.md`, `canvas-and-notes.md`, `agent-bridge.md`, `hzl.md`, `specify-workflow.md`, `project-files.md`) are requested on demand via `GET /api/projects/{project}/rules/{section}`. Read deeper detail only when the task actually needs it.

### 5. File roles do not bleed

| File | Role |
|------|------|
| `PROJECT.md` | Stable project map: goal, scope, background, repos/files, durable constraints |
| `SESSIONS.md` | Historical session log (append-only; not current truth) |
| `DECISIONS.md` | Architecture and design rationale (durable why-records) |
| `context/*.md` | Detailed operational docs, lazy-loaded on demand |
| `specs/*.md` | Task/feature specs, linked from tasks |

Keep these roles strict. See `files` for the full conventions.
