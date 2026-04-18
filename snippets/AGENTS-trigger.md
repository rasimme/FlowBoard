## Projects (MANDATORY)

FlowBoard delivers project context automatically as `BOOTSTRAP.md` in the
workspace. The `project-context` hook regenerates it on session start
(`/new`, `/reset`), gateway startup, and after session compaction.

### At session start
1. Read `BOOTSTRAP.md` — that is your project context.
2. When an active project is set, `BOOTSTRAP.md` contains a rules manifest.
   Fetch individual sections on demand from the FlowBoard API:
   `GET http://127.0.0.1:18790/api/projects/{project}/rules/{section}`
   Sections listed in the manifest include `commands`, `api-access`, `hzl`,
   `canvas`, `files`, `specify`, `agent-bridge`, `error-handling`, `key-principles`.
3. When no active project is set, work normally without project context.

### Commands (only on explicit user request)
- `Project: [Name]`     → `PUT /api/status` with `{ project, agentId }`
- `End project`         → `PUT /api/status` with `{ project: null, agentId }`
- `Projects`            → `GET /api/projects`
- `New project: [Name]` → `POST /api/projects`

### Agent identity
Use your assigned `agentId` — the `OPENCLAW_AGENT_ID` environment variable
(defaults to `main`). Each agent has its own active-project row in the
`flowboard_agents` table; activating a project for one agent does not
affect others.

### Fallback
If the API is unreachable, fall back to `ACTIVE-PROJECT.md` in the workspace
(legacy path). The database is canonical — if API and file disagree, trust
the API.

### Rules
- Never modify `ACTIVE-PROJECT.md` or call activation endpoints automatically.
  Only explicit user commands may change project state.
- Prefer lazy-loading individual rule sections from the API over reading the
  full `PROJECT-RULES.md` file — smaller token footprint per interaction.
