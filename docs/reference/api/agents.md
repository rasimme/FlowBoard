# Agents & Status Endpoints

Per-agent state: who exists, what each is currently working on. HZL is always enabled in current FlowBoard releases.

## `GET /api/agents`

Lists every row in `flowboard_agents`. Used by the UI's active-agents bar.

**Response 200:**

```json
{
  "ok": true,
  "agents": [
    { "agent_id": "alpha-agent","active_project": "flowboard", "activated_at": "2026-04-29T20:09:26.222Z", "sessions": [] },
    { "agent_id": "main",       "active_project": null,         "activated_at": "2026-04-15T08:00:00.000Z", "sessions": [] },
    {
      "agent_id": "claude-code",
      "active_project": "flowboard",
      "activated_at": "2026-05-02T22:23:09.339Z",
      "sessions": [
        { "sessionKey": "agent:claude-code:telegram:4711", "activeProject": "creon", "activatedAt": "2026-09-20T09:12:00.000Z", "lastSeen": "2026-09-20T09:40:00.000Z" }
      ]
    }
  ]
}
```

`sessions` (ADR-0039) is additive and may be empty: one entry per session-scoped
project binding of that agent. The legacy `agent_id` / `active_project` fields
are unchanged.

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

**Query / Header:** `?agentId=<id>` *or* `x-openclaw-agent-id: <id>`, plus the optional `?sessionKey=<key>` (ADR-0039).

**Response 200:** `{"activeProject": "<name>" | null, "agentId": "<id>", "binding": "session" | "agent" | null, "contextReady": <bool>, "agentIdentity": {...}}` — plus `sessionKey` (echoed when supplied), `rules` (the lazy-load rules pointer, T-296) when a project is active, and `attention` when the agent has stuck work:

```json
"attention": { "stuckTasks": [ { "project": "...", "id": "T-1", "title": "...", "reason": "stale|expired|routed-unclaimed", "agent": "...", "staleSinceMinutes": 45 } ] }
```

`attention.stuckTasks` (T-434) lists this agent's own stale claims, expired leases, and tasks routed to it but never claimed. It is the pull channel for stuck reminders: the bootstrap hook calls `GET /api/status` before every run, and external agents (e.g. Claude Code) see their stuck work here on the next FlowBoard touch. Reads are side-effect free.

**400** if `agentId` is missing in both the query and the header, or if `sessionKey` is present but not a non-empty string of at most 256 characters without control characters.

For an unknown agent (no row in `flowboard_agents`), the response is `{"activeProject": null, "agentId": "<id>", "binding": null}`. The agent is *not* registered as a side effect of GET — only `PUT /api/status` registers.

**Session scope.** With `sessionKey`, resolution is **session → agent → null**:
a session-scoped binding for (agentId, sessionKey) answers first (`binding: "session"`),
otherwise the agent-level row answers (`binding: "agent"`), otherwise
`activeProject` is `null` and `binding` is `null`. Without `sessionKey` the
result is exactly the pre-ADR-0039 lookup plus the `binding` field. The read
heartbeats whichever row answered (ADR-0020). `sessionKey` is **context, never
authorization** — it selects a binding, it does not authenticate the caller.

```
GET /api/status?agentId=claude-code&sessionKey=agent%3Aclaude-code%3Atelegram%3A4711
→ 200 {"activeProject":"creon","agentId":"claude-code","binding":"session",
       "sessionKey":"agent:claude-code:telegram:4711","contextReady":true, ...}
```

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

`sessionKey` is optional (ADR-0039). With a project it upserts that session's
binding and leaves the agent-level `active_project` untouched; with
`project: null` it **deletes** that session's binding, so the agent-level
binding applies again (it does *not* clear the agent-level activation — omit
`sessionKey` for that). Same validation as on `GET`; `400` otherwise.

```
PUT /api/status {"agentId":"claude-code","project":"creon","sessionKey":"agent:claude-code:telegram:4711"}
→ 200 {"ok":true,"activeProject":"creon","agentId":"claude-code","binding":"session",
       "sessionKey":"agent:claude-code:telegram:4711","contextReady":true, ...}

PUT /api/status {"agentId":"claude-code","project":null,"sessionKey":"agent:claude-code:telegram:4711"}
→ 200 {"ok":true,"activeProject":"flowboard","agentId":"claude-code","binding":"agent", ...}
```

`agentId` must be a stable lowercase kebab-case identity. Known OpenClaw ids, configured managed ids (`FLOWBOARD_MANAGED_AGENT_IDS`), and stable external ids are accepted. OpenClaw-managed agents normally use the bootstrap `## Identity` value; if it is absent, `~/.openclaw/workspace` maps to `main` and `~/.openclaw/workspace-<id>` maps to `<id>`. Placeholders and generated names such as `default`, `<agentId>`, `workspace-*`, `*-workspace`, `codex-workspace`, or replay/timestamp ids are rejected with `400`. Variants of configured managed ids, such as `<id>-main`, are also rejected so managed agents keep their canonical identity.

For short-lived delegated task agents, clear the active project after the task is completed/reviewed:

```json
{
  "agentId": "claude-task-agent",
  "project": null
}
```

This deactivates project context without deleting the agent row, so task attribution and history remain intact.

**Response 200:** `{"ok": true, "activeProject": "<canonical-name>" | null, "agentId": "<id>", "binding": "session" | "agent" | null}` — `activeProject` is the *effective* project after the write, so a session deactivation reports the agent-level fallback. `sessionKey` is echoed when supplied.

**400** if `agentId` is missing, the project name doesn't resolve, or `sessionKey` is invalid.
**500** on internal error.

**Side effects:**
- Without `sessionKey`: the agent's row in `flowboard_agents` is created if absent and updated otherwise.
- With `sessionKey`: the row in `flowboard_session_projects` is created/updated (or deleted for `project: null`); the agent row is lazy-registered for visibility but its `active_project` is never changed.
- A wake event is sent to the gateway (Telegram bot or equivalent) for the affected agent. The text is German operational hint pointing at `/api/projects/<name>/bootstrap` and `/api/projects/<name>/rules/<section>`.

## See also

- [Agent Identity concept](../../concepts/agent-identity.md)
- [Multi-Agent Model concept](../../concepts/multi-agent-model.md)
- [ADR-0002](../../adr/0002-api-status-requires-agent-id.md)
- [ADR-0003](../../adr/0003-dashboard-has-no-agent-identity.md)
