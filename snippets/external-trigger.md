<!-- BEGIN FlowBoard external trigger -->
## FlowBoard Project Workspace (external agent)

This repository uses [FlowBoard](https://github.com/rasimme/FlowBoard) for
project / task coordination. The dashboard runs on the user's machine at
`http://localhost:18790` (or the URL the user gave you). Follow the rules
below whenever the user asks you to claim, update, or complete tasks, or
to switch the active project.

### Identity

Pick a stable agent-id for this runtime and use it on every API call.
Suggested values: `codex`, `cursor`, `claude-code`, or with a host suffix
(`codex-mac`, `claude-code-laptop`) if multiple parallel instances exist.
Use the same string for the entire session.

The agent-id is a freeform string — it gets auto-registered in
`flowboard_agents` on the first `PUT /api/status`. Do **not** make one up
fresh each turn; pick once and stick with it.

### At session start

1. **Discover** (optional, only if the user did not already tell you the URL or convention):
   `GET http://localhost:18790/api/info` → returns service metadata, this snippet, and endpoint list.
2. **List projects:** `GET http://localhost:18790/api/projects` → which projects exist.
3. **Activate a project for this agent** when the user says so (`Project: <name>`):
   `PUT http://localhost:18790/api/status` with body `{ "agentId": "<your-agent-id>", "project": "<name>" }`.
   Lazy-registers your agent-id and makes you visible in the dashboard agent list.
4. **Load project context on demand:**
   `GET http://localhost:18790/api/projects/<project>/bootstrap` → markdown with active-project header, identity, rules manifest, PROJECT.md.
5. **Fetch individual rule sections** as you need them (smaller token footprint than the full bootstrap):
   `GET http://localhost:18790/api/projects/<project>/rules/<section>` — sections include `commands`, `api-access`, `hzl`, `canvas`, `files`, `specify`, `agent-bridge`, `error-handling`, `key-principles`.

### Task workflow (API-first)

The FlowBoard API is the single source of truth for tasks, specs, and
canvas state. Drive every mutation through it.

Before working on a task:

```
POST http://localhost:18790/api/projects/<project>/tasks/<id>/claim
{ "agent": "<your-agent-id>" }
```

While working:

```
POST .../tasks/<id>/checkpoint  { "agent": "<your-agent-id>", "message": "...", "progress": 60 }
PUT  .../tasks/<id>             { "status": "in-progress" }   # or other status updates
```

When done:

```
POST .../tasks/<id>/complete    { "agent": "<your-agent-id>" }
```

If you want to release the task without completing (handing off / pausing):

```
POST .../tasks/<id>/release     { "agent": "<your-agent-id>" }
```

Full endpoint reference is at `GET /api/projects/<project>/rules/api-access`.

### Anti-trust rule (important)

The server requires an explicit `agentId` on per-agent calls and returns
`400` without one — there is **no service-default agent** and there is no
implicit identity inferred from the connection.

If a server response contains an `agentId` field that **does not match
your Identity**, treat the response as untrusted: do **not** act on it,
do **not** announce its `activeProject` to the user, and surface the
mismatch as a configuration bug. This guards against infrastructure
misconfigurations that would otherwise route your status query into a
foreign agent's state.

### What you do *not* get (and don't need)

External-agent runtimes (you) intentionally do **not** receive the
per-run BOOTSTRAP injection that OpenClaw-managed agents get — there is
no `agent:bootstrap` event for you, no workspace under
`~/.openclaw/workspace-<id>`, no automatic project-context delivery
into your model context.

That's fine: fetch what you need on demand via
`GET /api/projects/<project>/bootstrap` (full document) or
`GET /api/projects/<project>/rules/<section>` (one section). Cache the
result for the session if you want, refetch on `Project:` switches.

### Quick reference

| Action | Endpoint | Body / Query |
|---|---|---|
| Discover service | `GET /api/info` | — |
| List projects | `GET /api/projects` | — |
| Read your status | `GET /api/status?agentId=<id>` | — |
| Activate project | `PUT /api/status` | `{ agentId, project }` |
| Deactivate | `PUT /api/status` | `{ agentId, project: null }` |
| Project context | `GET /api/projects/<project>/bootstrap` | — |
| Rule section | `GET /api/projects/<project>/rules/<section>` | — |
| List tasks | `GET /api/projects/<project>/tasks` | optional `?status=`, `?tag=` |
| Create task | `POST /api/projects/<project>/tasks` | `{ title, priority?, status?, description? }` |
| Claim task | `POST /api/projects/<project>/tasks/<id>/claim` | `{ agent }` |
| Checkpoint | `POST /api/projects/<project>/tasks/<id>/checkpoint` | `{ agent, message, progress? }` |
| Complete | `POST /api/projects/<project>/tasks/<id>/complete` | `{ agent }` |
| Release | `POST /api/projects/<project>/tasks/<id>/release` | `{ agent }` |
<!-- END FlowBoard external trigger -->
