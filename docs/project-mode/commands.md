# Project Commands

## Purpose

Full agent-side contract for FlowBoard interaction: identity resolution, HTTP parsing, project commands, passive startup, and blocker behavior. This section is embedded in the bootstrap document and applies when a project is active.

## Identity

Resolve one stable `agentId` before any FlowBoard API call and reuse it for status, claims, checkpoints, and task updates:

1. Prefer the `## Identity` section from the live bootstrap/OpenClaw context.
2. If that identity block is absent but the run is clearly inside an OpenClaw-managed workspace, derive it from the workspace convention:
   - `~/.openclaw/workspace` → `main`
   - `~/.openclaw/workspace-<id>` → `<id>`
3. **Do not invent** cwd/runtime hybrids such as `codex-workspace`, `main-workspace`, or `<runtime>-<workspace-slug>`.
4. If neither bootstrap identity nor OpenClaw workspace convention is available, stop and report the blocker.
5. If a status response echoes a different `agentId`, stop and report the blocker.

## HTTP parsing contract

Branch by HTTP status and `Content-Type` before parsing:
- 2xx + `application/json` → parse JSON.
- 2xx + `text/markdown` or `text/plain` → read text; never JSON.parse this body.
- non-2xx + JSON/text → read the error body and report the blocker.

Status endpoints return JSON. Project context and rules endpoints return Markdown/plain text on success.

## Passive startup / before project-related work

Use this only when the user did not issue an explicit FlowBoard command.

1. **Check your status:**
   `GET /api/status?agentId=<resolved-agentId>`

2. **If `activeProject === null`:** no project active. Work normally, do not ask, and do not infer state.

3. **If `activeProject !== null`:**
   - Wait until `contextReady === true` with **maximum 3 attempts total, 500 ms between attempts, then report blocker and stop**.
   - Then immediately fetch project context as Markdown/plain text: `GET /api/projects/<activeProject>/bootstrap`
   - Do this before answering project questions; do not rely on memory or generic knowledge.
   - Load rules on demand: `GET /api/projects/<activeProject>/rules/<section>`
   - Sections: `commands`, `api-access`, `hzl`, `canvas`, `files`, `specify`, `agent-bridge`, `error-handling`, `key-principles`

## Project commands (explicit command wins over passive startup)

If the user says `Projekt: X`, `activate project X`, `set project to X`, `Projekt beenden`, `Projekte`, or `Neues Projekt: X`, execute the command immediately. Do not let a passive `activeProject === null` startup check swallow the explicit command.

- **Activate:** `PUT /api/status` → `{ project, agentId }`, then verify with `GET /api/status?agentId=...` using the same agentId. If `activeProject` matches and `contextReady === true`, fetch project context as Markdown/plain text before announcing success. If readiness is false, poll with **maximum 3 attempts total, 500 ms between attempts, then report blocker and stop**.
- **Deactivate:** `PUT /api/status` → `{ project: null, agentId }`, then verify with `GET /api/status?agentId=...`
- **List:** `GET /api/projects` plus `GET /api/status?agentId=...`
- **Create:** `POST /api/projects` → `{ name }` (does not auto-activate)

### Semantics

- **Active project = context loading, not access control.** Cross-project reads and quick task creation are allowed without switching. Only switch when the main focus of work changes.
- **Creation and activation are separate actions.** After `Neues Projekt:`, the caller must activate explicitly if that's the intended follow-on.
- **Per-agent activation.** Each agent has its own `active_project` row in `flowboard_agents`. Activating a project for one agent does not affect others.

## Blocker behavior

When reporting a blocker, stop the activation/context-loading flow and do not retry activation again unless the user explicitly asks. Include:
- Endpoint URL
- Expected vs actual state
- agentId used
- Next safe action

## Task workflow (API-first)

Claim before work, update while working, complete when done.
See `tasks-api` section for full schema and endpoint reference.

## Related

- `api-access` — full task & project API reference
- `tasks-api` — task CRUD, status flow, claim/release/complete
- `key-principles` — API-first rule and canonical-state semantics
- `error-handling` — graceful degradation and fallback rules
