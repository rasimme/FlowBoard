# Discovery Endpoints

Public endpoints used to find FlowBoard and self-onboard external agents. No auth required.

## `GET /api/health`

Liveness probe. Returns `{"ok": true}` and nothing else — no version, no uptime, no auth state, no environment info.

**Response 200:** `{"ok": true}`

## `GET /api/health/integrity`

Boot-time integrity watermark plus the current state of the `events` table. Built for external monitoring tools that want to detect filesystem-level rollbacks of `flowboard.db` (see [ADR-0018](../../adr/0018-hzl-filesystem-rollback-detection.md) for the architecture rationale). No auth.

**Response 200:**

```json
{
  "stored": {
    "max_id": 4932,
    "count": 4889,
    "last_check_at": "2026-05-22T17:31:09.246Z"
  },
  "current": {
    "max_id": 4932,
    "count": 4889,
    "last_event_at": "2026-05-22T17:30:23.070Z"
  },
  "regression": null,
  "boot_check": {
    "stored": null,
    "current": { "max_id": 4932, "count": 4889, "last_event_at": "..." },
    "regression": null,
    "checked_at": "2026-05-22T17:31:09.245Z"
  },
  "strict_mode": false
}
```

- `stored` — watermark persisted on the most recent successful boot, or `null` on the first boot after upgrade.
- `current` — `MAX(id)`, `COUNT(*)`, and `MAX(timestamp)` from the `events` table right now.
- `regression` — `null` when the current values meet or exceed the stored watermark. When the table has shrunk, an object: `{ type: "max_id_regressed" | "count_regressed", before, after, detected_at }`.
- `boot_check` — the snapshot recorded at server startup. Useful for diagnosing whether a regression existed at boot vs developed later (the latter is impossible under normal SQL triggers, but the field is reported for transparency).
- `strict_mode` — `true` when `HZL_INTEGRITY_STRICT=true` is set. In strict mode the service `process.exit(1)`s on regression at boot, so a running service with `strict_mode: true` is by definition regression-free.

Operators wiring this into a monitoring tool: poll on whatever cadence makes sense (every minute is fine — the response is cheap), and alert on `regression !== null`. To reset the baseline after a deliberate restore: `DELETE FROM hzl_local_meta WHERE key LIKE 'integrity.%';` in `flowboard-cache.db`.

If you want a push notification at boot instead of polling, set `INTEGRITY_WEBHOOK_URL` (and optionally `INTEGRITY_WEBHOOK_TOKEN`). On regression the server `POST`s a JSON body to that URL with both a human-readable `text` field and the structured `regression` / `current` / `stored` / `host` fields. See [env-vars.md](../env-vars.md) and [ADR-0018](../../adr/0018-hzl-filesystem-rollback-detection.md) for the full contract.

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
