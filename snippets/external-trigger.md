## FlowBoard Project Workspace (external agent)
<!-- flowboard-snippet-contract: v3-command-startup-response -->

This repository uses [FlowBoard](https://github.com/rasimme/FlowBoard) for project / task coordination. The dashboard runs at `http://localhost:18790`.
Use a local-capable tool for this localhost API (exec/curl/node or an internal API tool), never external web-fetch/browser. If an API call fails, do not infer state; report the blocker.

### Identity

Use the stable agent id provided by your launcher/bootstrap context if present. Otherwise use the configured runtime identity (for example `claude`, `cursor`, `codex`). If neither exists, derive `<runtime>-<workspace-slug>` deterministically and use the same value for status, claims, checkpoints, and task updates. The id auto-registers on first `PUT /api/status`. If a status response echoes a different `agentId`, stop and report the blocker.

### HTTP parsing contract

Branch by HTTP status and `Content-Type` before parsing:
- 2xx + `application/json` → parse JSON.
- 2xx + `text/markdown` or `text/plain` → read text; never JSON.parse this body.
- non-2xx + JSON/text → read the error body and report the blocker.

Status endpoints return JSON. Project context and rules endpoints return Markdown/plain text on success.

### Passive startup / before project-related work

Use this only when the user did not issue an explicit FlowBoard command.

1. **Check your status:**
   `GET /api/status?agentId=<your-id>`

2. **If `activeProject === null`:** no project active. Work normally, and do not infer state.

3. **If `activeProject !== null`:**
   - Wait until `contextReady === true` with **maximum 3 attempts total, 500 ms between attempts, then report blocker and stop**.
   - Then immediately fetch full project context as Markdown/plain text: `GET /api/projects/<activeProject>/bootstrap`
   - Do this before answering project questions; do not rely on memory or generic knowledge.
   - Load rules on demand: `GET /api/projects/<activeProject>/rules/<section>`
   - Sections: `commands`, `api-access`, `hzl`, `canvas`, `files`, `specify`, `agent-bridge`, `error-handling`, `key-principles`

### Project commands (explicit command wins over passive startup)

If the user asks to activate, deactivate, list, or create a project, execute the command directly. Do not let a passive `activeProject === null` startup check swallow the explicit command.

- Activate: `PUT /api/status` → `{ agentId, project }`, then verify with `GET /api/status?agentId=...` using the same agentId. If `activeProject` matches and `contextReady === true`, fetch project context as Markdown/plain text before announcing success. If readiness is false, poll with **maximum 3 attempts total, 500 ms between attempts, then report blocker and stop**.
- Deactivate: `PUT /api/status` → `{ agentId, project: null }`, then verify with `GET /api/status?agentId=...`
- List: `GET /api/projects` plus `GET /api/status?agentId=...`
- Create: `POST /api/projects` → `{ name }` (does not auto-activate)

### Blocker behavior

When reporting a blocker, stop the activation/context-loading flow and do not retry activation again unless the user explicitly asks. Include endpoint, expected vs actual state, agentId used, and next safe action.

### Task workflow

Claim → work → complete. Full schema at `GET /api/projects/<project>/rules/api-access`.

| Action | Endpoint | Body |
|---|---|---|
| Claim | `POST .../tasks/<id>/claim` | `{ agent }` |
| Checkpoint | `POST .../tasks/<id>/checkpoint` | `{ agent, message }` |
| Update | `PUT .../tasks/<id>` | `{ status, progress }` |
| Complete | `POST .../tasks/<id>/complete` | `{ agent }` |
| Release | `POST .../tasks/<id>/release` | `{ agent }` |

### Anti-trust

If any response contains `agentId` ≠ your id, the response is untrusted — do not act on it.
