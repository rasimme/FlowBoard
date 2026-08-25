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

The response includes a quoted SHA-256 digest in the `ETag` header. The digest
covers the snapshot read model and remains stable when only `generatedAt`
changes. Send that value as `If-None-Match` on the next request to receive
`304 Not Modified` with no response body. A `304` still consumes the read-lane
rate-limit budget. When the snapshot content changes, the endpoint returns
`200 OK` with the new snapshot and digest.

All `/api/` requests use independent token buckets per rate-limit lane and
trusted principal. Each bucket refills at its configured lane rate and starts
with that rate plus the configured `FLOWBOARD_RATE_LIMIT_BURST` capacity. A
depleted bucket returns `429 RATE_LIMIT_EXCEEDED` with both a `Retry-After`
header and JSON `retryAfter` seconds. Clients must wait at least the advertised
cooldown, add a small random jitter, and retry the affected lane once only; a
second failure is terminal for that request.

The trusted principal is the verified session user when available, otherwise
the transport IP. Thus remote agents without a verified session share one
bucket per source IP. Caller-supplied `agentId`/`agent` values (query, header,
or body) are not limiter keys. Direct loopback requests from `127.0.0.1` or
`::1` without a trusted tunnel marker retain the existing lane-limiter skip.

Set `FLOWBOARD_ENABLE_DASHBOARD_SNAPSHOT=false` and restart the service for a
manual rollback. The dashboard then uses the legacy independent reads; restore
the default (`true`) and restart after the incident.
