# Dashboard Endpoints

## `GET /api/dashboard/snapshot/v1`

Returns one versioned, in-process read snapshot for the dashboard shell. The
optional `agentId` selects the caller's active-project status, and `project`
selects the currently viewed project's tasks. When `project` is omitted, the
active project is used.

```json
{
  "ok": true,
  "version": 1,
  "generatedAt": "2026-08-24T08:00:00.000Z",
  "projects": [],
  "agents": [],
  "status": { "agentId": "codex", "activeProject": null, "contextReady": false },
  "activeProject": null,
  "viewedProject": null,
  "tasks": [],
  "sections": {
    "projects": { "ok": true, "data": [] },
    "agents": { "ok": true, "data": [] },
    "status": { "ok": true, "data": {} },
    "tasks": { "ok": true, "data": [] }
  }
}
```

The `sections` map is the failure boundary. A section with `ok: false` has a
safe `error.code` and must not be interpreted as an empty successful section.
Successful sections always include typed `data`: arrays for `projects`,
`agents`, and `tasks`, and the status object for `status`. The top-level fields
are the compatibility read model; there is no second nested `snapshot` envelope.
The existing project, agent, status, and task endpoints remain the canonical
compatibility surface for agents and other clients.

Set `FLOWBOARD_ENABLE_DASHBOARD_SNAPSHOT=false` and restart the service for a
manual rollback. The dashboard then uses the legacy independent reads; restore
the default (`true`) and restart after the incident.
