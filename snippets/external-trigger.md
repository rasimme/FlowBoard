## FlowBoard Project Workspace (external agent)
<!-- flowboard-snippet-contract: v3-command-startup-response -->

This repository uses [FlowBoard](https://github.com/rasimme/FlowBoard) for project / task coordination. The dashboard runs at `http://localhost:18790`.
Use a local-capable tool for this localhost API (exec/curl/node or an internal API tool), never external web-fetch/browser. If an API call fails, do not infer state; report the blocker.

### Minimal trigger

1. **Check your status:**
   `GET /api/status?agentId=<your-id>`

2. **If `activeProject === null`:** no project active. Work normally, and do not infer state.

3. **If `activeProject !== null`:**
   - Wait for `contextReady` to be true; details live in `rules/error-handling`.
   - Fetch full project context: `GET /api/projects/<activeProject>/bootstrap`
   - Load rules on demand: `GET /api/projects/<activeProject>/rules/<section>`
   - Sections: `commands`, `api-access`, `hzl`, `canvas`, `files`, `specify`, `agent-bridge`, `compliance`, `error-handling`, `key-principles`, `overview`

### Where details live

This file is only the trigger. Do not add workflow/API detail here.
Identity and project commands: load `rules/commands`.
Task execution: load `rules/agent-bridge` and `rules/api-access`.
