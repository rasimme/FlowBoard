# FlowBoard — agent entry point

FlowBoard coordinates work through the dashboard API at
`http://127.0.0.1:18790`. Use a local-capable tool (exec / curl / node) for
this localhost API — never an external web-fetch/browser. If an API call
fails, report the blocker; do not infer state.

This file is **only the trigger**. Everything else is fetched on demand.

## Start here

1. **Check your status:** `GET /api/status?agentId=<your-id>`
2. **If `activeProject === null`:** no project is active — work normally, don't infer state.
3. **If `activeProject !== null`:**
   - Wait for `contextReady` (details in `rules/error-handling`).
   - **Fetch context:** `GET /api/projects/<activeProject>/bootstrap`. This includes the
     project's `PROJECT.md`, which carries project knowledge **and the
     project-specific development rules — read them before changing code.**
   - Treat `GET /api/projects/<activeProject>/tasks` (the Operational Task State) as the
     only current-task truth — not `PROJECT.md`.
   - Load rule sections on demand: `GET /api/projects/<activeProject>/rules/<section>` —
     `commands`, `api-access`, `hzl`, `canvas`, `files`, `specify`, `agent-bridge`,
     `error-handling`, `key-principles`, `overview`.

## Where things live

- **Project-specific development rules** (how to develop *this* project): the project's
  `PROJECT.md`, served via `bootstrap`.
- **Repo / product conventions** (commit style, English-only UI strings): `CONTRIBUTING.md`.
- **Task execution & delegation:** `rules/agent-bridge` + `rules/api-access`. Build spawn
  prompts with `dashboard/hzl-service.js:buildSpawnPrompt()` — do not hand-write them.
- **External agents** (Codex, Cursor, Claude Code, …): see README §
  "Using FlowBoard with external agents" and `node dashboard/install-trigger.mjs`.
