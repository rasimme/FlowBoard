## FlowBoard Project Workspace (external agent)

This repository uses [FlowBoard](https://github.com/rasimme/FlowBoard) for
project / task coordination. The dashboard runs at `http://localhost:18790`.

### Identity

Pick a stable agent-id (e.g. `claude`, `cursor`, `codex`) and use it on every API call.
The id auto-registers on first `PUT /api/status`.

### On every session start (or before project-related work)

1. **Check your status:**
   `GET /api/status?agentId=<your-id>`

2. **If `activeProject === null`:** no project active. Work normally.

3. **If `activeProject !== null`:**
   - Fetch full context: `GET /api/projects/<activeProject>/bootstrap`
   - Load rules on demand: `GET /api/projects/<activeProject>/rules/<section>`
   - Sections: `commands`, `api-access`, `hzl`, `canvas`, `files`, `specify`, `agent-bridge`, `error-handling`, `key-principles`

### Project commands

- Activate: `PUT /api/status` → `{ agentId, project }`
- Deactivate: `PUT /api/status` → `{ agentId, project: null }`
- List: `GET /api/projects`
- Create: `POST /api/projects` → `{ name }`

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
