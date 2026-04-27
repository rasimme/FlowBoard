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

### Commands (only on explicit user request)
- `Project: [Name]`     → `PUT /api/status` with `{ project, agentId }`
- `End project`         → `PUT /api/status` with `{ project: null, agentId }`
- `Projects`            → `GET /api/projects`
- `New project: [Name]` → `POST /api/projects`

### Tasks, specs, canvas (API-first)

The FlowBoard API is the single source of truth for tasks, specs, and canvas
state. Drive every mutation through it — that's how the dashboard, the agent
status, and the underlying HZL store stay in sync. Standard task flow:

1. **Create:** `POST /api/projects/{project}/tasks` with
   `{title, priority?, status?, description?}` → returns `{id: "T-NNN", ...}`.
2. **Claim** before you start working on a task:
   `POST /api/projects/{project}/tasks/{id}/claim` with `{agent: <agentId>}`.
   Surfaces "{agent} is working on this" in the UI and acquires a lease.
3. **Update** while you work: `PUT /api/projects/{project}/tasks/{id}` with
   the changed fields (status, progress, priority, description, …).
4. **Complete** when done: `POST /api/projects/{project}/tasks/{id}/complete`
   with `{agent: <agentId>}`. Auto-releases the claim and sets status=done.
5. **Release** without completing (handing off / pausing):
   `POST /api/projects/{project}/tasks/{id}/release` with `{agent: <agentId>}`.

Full endpoint reference (request bodies, status enum, lease semantics, subtasks,
error codes): `GET /api/projects/{project}/rules/api-access`.

### Agent identity
Use your assigned `agentId` — the `OPENCLAW_AGENT_ID` environment variable
(defaults to `main`). Each agent has its own active-project row in the
`flowboard_agents` table; activating a project for one agent does not
affect others.

### Rules
- Project-activation commands run only on explicit user request — wait for
  `Project: [Name]` / `End project` from the user.
- Fetch individual rule sections on demand rather than bulk-loading the
  manifest — smaller token footprint per interaction.
