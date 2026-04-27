## Projects (MANDATORY)

FlowBoard delivers project context automatically as `BOOTSTRAP.md` in the
workspace. The `project-context` hook regenerates it on session start
(`/new`, `/reset`), gateway startup, and after session compaction.

### At session start
1. Read `BOOTSTRAP.md` — that is your project context.
2. When an active project is set, `BOOTSTRAP.md` contains a rules manifest.
   Fetch individual sections on demand from the FlowBoard API:
   `GET http://127.0.0.1:18790/api/projects/{project}/rules/{section}?agentId={agentId}`
   Sections listed in the manifest include `commands`, `api-access`, `hzl`,
   `canvas`, `files`, `specify`, `agent-bridge`, `error-handling`, `key-principles`.
3. When no active project is set, work normally without project context.

### Project commands

Recognize project commands in either language and any natural phrasing
(e.g. `Project: [Name]`, `Projekt: [Name]`, `aktiviere Projekt [Name]`,
`switch to [Name]`, `Projekt beenden`). On recognition, **execute** the
matching API call — never just echo the trigger back as if confirmed.

- **Activate** → `PUT /api/status` with `{ project, agentId }`. Confirm
  to the user only after the call returns OK.
- **Deactivate** (`End project`, `Projekt beenden`) → `PUT /api/status`
  with `{ project: null, agentId }`.
- **List** (`Projects`, `Projekte`) → `GET /api/projects`.
- **Create** (`New project: [Name]`, `Neues Projekt: [Name]`) →
  `POST /api/projects` with `{ name }`.

Run only on explicit user intent — do not infer or auto-activate.

### Tasks, specs, canvas (API-first)

The FlowBoard API is the single source of truth for tasks, specs, and canvas
state. Drive every mutation through it — that's how the dashboard, the agent
status, and the underlying HZL store stay in sync. Standard task flow:

1. **Create:** `POST /api/projects/{project}/tasks` with
   `{title, priority?, status?, description?}` → returns `{id: "T-NNN", ...}`.
2. **Claim** before you start working on a task:
   `POST /api/projects/{project}/tasks/{id}/claim` with `{agent: "<your-agentId-from-BOOTSTRAP>"}`.
   Surfaces "{agent} is working on this" in the UI and acquires a lease.
3. **Update** while you work: `PUT /api/projects/{project}/tasks/{id}` with
   the changed fields (status, progress, priority, description, …).
4. **Complete** when done: `POST /api/projects/{project}/tasks/{id}/complete`
   with `{agent: "<your-agentId-from-BOOTSTRAP>"}`. Auto-releases the claim and sets status=done.
5. **Release** without completing (handing off / pausing):
   `POST /api/projects/{project}/tasks/{id}/release` with `{agent: "<your-agentId-from-BOOTSTRAP>"}`.

Full endpoint reference (request bodies, status enum, lease semantics, subtasks,
error codes): `GET /api/projects/{project}/rules/api-access`.

### Agent identity

Read `BOOTSTRAP.md` at session start — it contains an `## Identity` section
with your canonical `agentId`. Use that exact value in every project / task
API call's `agent` / `agentId` field. Never substitute a placeholder or
guess a default like `"main"` — that silently routes your work into
another agent's row in `flowboard_agents` and breaks attribution.

If the Identity section is missing (BOOTSTRAP.md hasn't been regenerated
yet), ask the user to confirm your identity before any project / task
mutation, or wait for the next `/new` / `/reset` to refresh the file.

Each agent has its own active-project row; activating a project for one
agent does not affect others.

### Rules
- Fetch individual rule sections on demand rather than bulk-loading the
  manifest — smaller token footprint per interaction.
