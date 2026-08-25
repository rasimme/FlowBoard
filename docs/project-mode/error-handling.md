# Error Handling

## Purpose

Graceful-degradation rules when FlowBoard state is partial, stale, or inconsistent. Prefer canonical DB/runtime state over local files; surface problems rather than guessing.

## Rules

- **Missing active project** → projectless mode. No special context injected; act as a normal agent without project scoping.
- **Missing project folder** → surface clearly. Do not silently create it. The canonical creation path is `POST /api/projects`.
- **Missing spec or capability doc** → report and continue. Use the rules manifest in `BOOTSTRAP.md` as the coarse-grained fallback.
- **Corrupt or unreadable state file** → prefer the DB-backed canonical source. FlowBoard runtime owns project registry (`flowboard_projects`) and per-agent active-project state (`flowboard_agents`).
- **Migration leftovers** → when a legacy file (`ACTIVE-PROJECT.md`, `_index.md`, `tasks.json`) disagrees with the DB, the DB is authoritative. File state is transitional and not a valid instruction source.
- **API unreachable during bootstrap** → emit projectless context and surface the connection failure. `ACTIVE-PROJECT.md` fallback is disabled by default and only available for explicit migration recovery via `FLOWBOARD_ALLOW_ACTIVE_PROJECT_FILE_FALLBACK=true`.
- **Claim conflicts (409)** → another agent holds the claim. Read recent checkpoints/comments, then either wait, coordinate, or (if the lease has expired) steal.
- **Project context not ready** → poll status with maximum 3 attempts total, 500 ms between attempts, then report blocker and stop.
- **Failed project/context/rules API call** → report the endpoint, expected vs actual state, agentId used, and next safe action. Do not infer active project, task state, or readiness from memory or project Markdown.

## Related

- `key-principles` — why DB is canonical
- `api-access` — claim/lease semantics and the full endpoint reference
# Rate limits (429)

API clients, including remote agents, must treat `429 RATE_LIMIT_EXCEEDED` as a
controlled retry signal. Read the `Retry-After` response header; if it is not
available, use the JSON `retryAfter` value (seconds). Wait at least that long,
then add a small random jitter, and retry the same request exactly once. Do not
immediately repeat the request, retry more than once, or spin in a loop. If the
single retry fails, report the endpoint and stop.

The server's lane bucket is keyed by a verified session principal when one is
available, otherwise by the transport IP. Consequently, remote agents without
a verified session share the bucket for their source IP; a client-supplied
`agentId`/`agent` in a query, header, or request body never selects or creates a
limiter bucket. The existing local-first exception remains: direct loopback
requests (`127.0.0.1` or `::1`, without a trusted tunnel marker) skip the lane
limiter. This is a rate-limit exception, not a remote-agent identity or
authorization mechanism.
