# Discovery Endpoints

Public endpoints used to find FlowBoard and self-onboard external agents. No auth required.

## `GET /api/health`

Liveness probe. Returns `{"ok": true}` and nothing else — no version, no uptime, no auth state, no environment info.

**Response 200:** `{"ok": true}`

## `GET /api/info`

Service metadata + the bundled `external-trigger.md` snippet so an external agent can self-onboard with a single curl. No auth.

**Response 200:**

```json
{
  "service": "FlowBoard",
  "version": "<package.json version>",
  "api_base": "http://localhost:18790",
  "endpoints": {
    "health":    "/api/health",
    "info":      "/api/info",
    "agents":    "/api/agents",
    "status":    "/api/status",
    "projects":  "/api/projects",
    "bootstrap": "/api/projects/:name/bootstrap",
    "rules":     "/api/projects/:name/rules/:section",
    "tasks":     "/api/projects/:name/tasks"
  },
  "agent_id_convention": "Pick a stable agent-id like 'codex', 'cursor', 'claude-code'. Auto-registered in flowboard_agents on first PUT /api/status.",
  "trigger_snippet": "<contents of snippets/external-trigger.md>"
}
```

The `trigger_snippet` field is read fresh from disk per request — editing `snippets/external-trigger.md` takes effect without dashboard restart.

## See also

- [Agent Identity concept](../../concepts/agent-identity.md) — the agent-id convention referenced by `/api/info`
- [ADR-0005](../../adr/0005-minimal-trigger-and-lazy-rules.md) — the snippet served by `/api/info`
