## FlowBoard (API-First)

Project coordination via FlowBoard dashboard at `http://127.0.0.1:18790`.

### On every session start (or before any project-related work)

1. **Check your status:**
   `GET /api/status?agentId=<your-agentId-from-BOOTSTRAP>`

2. **If `activeProject === null`:** no project active. Work normally, do not ask.

3. **If `activeProject !== null`:**
   - Fetch context: `GET /api/projects/<activeProject>/bootstrap`
   - Load rules on demand: `GET /api/projects/<activeProject>/rules/<section>`
   - Sections: `commands`, `api-access`, `hzl`, `canvas`, `files`, `specify`, `agent-bridge`, `error-handling`, `key-principles`

### Project commands (execute immediately, do not ask)

- Activate: `PUT /api/status` → `{ project, agentId }`
- Deactivate: `PUT /api/status` → `{ project: null, agentId }`
- List: `GET /api/projects`
- Create: `POST /api/projects` → `{ name }`

### Task workflow (API-first)

Claim before work, update while working, complete when done.
Endpoints: `GET /api/projects/<project>/rules/api-access` for full schema.
