# Agents & Status Endpoints

Per-agent state: who exists, what each is currently working on. HZL is always enabled in current FlowBoard releases.

## `GET /api/agents`

Lists every row in `flowboard_agents`. Used by the UI's active-agents bar.

**Response 200:**

```json
{
  "ok": true,
  "agents": [
    { "agent_id": "alpha-agent","active_project": "flowboard", "activated_at": "2026-04-29T20:09:26.222Z" },
    { "agent_id": "main",       "active_project": null,         "activated_at": "2026-04-15T08:00:00.000Z" },
    { "agent_id": "claude-code","active_project": "flowboard",  "activated_at": "2026-05-02T22:23:09.339Z" }
  ]
}
```

## `DELETE /api/agents/:id`

Removes an agent row. Conflict-checked against active claims by default.

**Query:** `force` — if `true`, releases any active claims (status preserved, lease dropped) before deletion.

**Response 200:** `{"ok": true, "agent_id": "<id>", "deleted": true, "releasedClaims": <n>}`

**404** if the agent doesn't exist.
**409** if the agent has active claims and `?force=true` is not set:

```json
{
  "error": "Agent has 3 active claim(s)",
  "claimCount": 3,
  "claims": [{"project": "flowboard", "id": "T-197-7", "title": "..."}],
  "hint": "Pass ?force=true to release claims and delete, or release them manually first"
}
```

Historical attribution on completed tasks (`tasks_current.agent`, comments, checkpoints) is unaffected — `agent_id` is a string, not a foreign key.

## `GET /api/status`

Returns one agent's row. **`agentId` is required** — there is no server-side default (ADR-0002).

**Query / Header:** `?agentId=<id>` *or* `x-openclaw-agent-id: <id>`.

**Response 200:** `{"activeProject": "<name>" | null, "agentId": "<id>"}`

**400** if `agentId` is missing in both the query and the header.

For an unknown agent (no row in `flowboard_agents`), the response is `{"activeProject": null, "agentId": "<id>"}`. The agent is *not* registered as a side effect of GET — only `PUT /api/status` registers.

## `PUT /api/status`

Set or clear the agent's active project. Lazy-registers the agent on first call.

**Body:**

```json
{
  "agentId": "claude-code",
  "project": "flowboard"
}
```

`agentId` is required. `project` may be `null` or the string `"none"` to clear. Display names (e.g. `"FlowBoard"`) are accepted and resolved to the canonical name (`"flowboard"`).

`agentId` must be a stable lowercase kebab-case identity. Known OpenClaw ids, configured managed ids (`FLOWBOARD_MANAGED_AGENT_IDS`), and stable external ids are accepted. OpenClaw-managed agents normally use the bootstrap `## Identity` value; if it is absent, `~/.openclaw/workspace` maps to `main` and `~/.openclaw/workspace-<id>` maps to `<id>`. Placeholders and generated names such as `default`, `<agentId>`, `workspace-*`, `*-workspace`, `codex-workspace`, or replay/timestamp ids are rejected with `400`. Variants of configured managed ids, such as `<id>-main`, are also rejected so managed agents keep their canonical identity.

For short-lived delegated task agents, clear the active project after the task is completed/reviewed:

```json
{
  "agentId": "claude-task-agent",
  "project": null
}
```

This deactivates project context without deleting the agent row, so task attribution and history remain intact.

**Response 200:** `{"ok": true, "activeProject": "<canonical-name>" | null, "agentId": "<id>"}`

**400** if `agentId` is missing or the project name doesn't resolve.
**500** on internal error.

**Side effects:**
- The agent's row in `flowboard_agents` is created if absent and updated otherwise.
- A wake event is sent to the gateway (Telegram bot or equivalent) for the affected agent. The text is German operational hint pointing at `/api/projects/<name>/bootstrap` and `/api/projects/<name>/rules/<section>`.

## See also

- [Agent Identity concept](../../concepts/agent-identity.md)
- [Multi-Agent Model concept](../../concepts/multi-agent-model.md)
- [ADR-0002](../../adr/0002-api-status-requires-agent-id.md)
- [ADR-0003](../../adr/0003-dashboard-has-no-agent-identity.md)
