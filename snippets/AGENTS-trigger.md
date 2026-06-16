## FlowBoard (API-First)
<!-- flowboard-snippet-contract: v3-command-startup-response -->

Project coordination via FlowBoard dashboard at `http://127.0.0.1:18790`.
Use a local-capable tool for this localhost API (exec/curl/node or an internal API tool), never external web-fetch/browser. If an API call fails, do not infer state; report the blocker.

### Minimal trigger

1. **Check your status:**
   `GET /api/status?agentId=<resolved-agentId>`

2. **If `activeProject === null`:** no project active. Work normally, do not ask, and do not infer state.

3. **If `activeProject !== null`:**
   - Wait for `contextReady` to be true; details live in `rules/error-handling`.
   - Fetch project context: `GET /api/projects/<activeProject>/bootstrap`
   - Treat `Operational Task State` / `GET /api/projects/<activeProject>/tasks` as the only current task truth. `PROJECT.md` content in bootstrap is stable project knowledge, not current work.
   - Load rules on demand: `GET /api/projects/<activeProject>/rules/<section>`
   - Sections: `commands`, `api-access`, `hzl`, `canvas`, `files`, `specify`, `agent-bridge`, `error-handling`, `key-principles`, `overview`

### Where details live

This file is only the trigger. Do not add workflow/API detail here.
Project commands: load `rules/commands`.
Task execution: load `rules/agent-bridge` and `rules/api-access`.
