# ADR-0013: `x-openclaw-agent-id` header accepted as alternative to `?agentId=` on `/api/status`

## Status
Accepted

## Date
2026-04-30

## Source
- code at `dashboard/server.js:438`: `const agentId = req.query.agentId || req.headers['x-openclaw-agent-id'];`
- public commit `c5e5fc6` — `fix(api): /api/status requires explicit agentId (T-177-2 + T-177-5)`
- discovered during T-197-7 reference-doc writing (the API was undocumented at that point)

## Context

ADR-0002 made `agentId` mandatory on `GET /api/status`. The original implementation accepted only the query parameter `?agentId=<id>`. During the same change set (T-177-2), the server was extended to also accept the value in an `x-openclaw-agent-id` HTTP header — a small dual-acceptance for ergonomic reasons.

The header path was undocumented anywhere outside the source code until T-197-7 wrote the API reference docs. At that point the dual acceptance surfaced as an implicit convention: the API has two equivalent ways to pass agent identity on this one endpoint, and only this endpoint.

The motivation for the header path was OpenClaw's gateway routing convention — internal callers (the bundled boot-md hook, gateway-side instrumentation) prefer headers over query parameters because headers survive through proxy layers more cleanly. Query parameters are visible in URL logs; headers are easier to filter or redact. For internal callers under operator control, the header path is more ergonomic.

External agents and the project-context hook continued to use `?agentId=`. The header path was effectively for OpenClaw-internal use, but was never marked as such.

## Decision

`GET /api/status` accepts the agent-id from either source, with this precedence:

1. `?agentId=<id>` query parameter — checked first
2. `x-openclaw-agent-id: <id>` HTTP header — checked second

If both are present and they disagree, the query parameter wins. If neither is present, the endpoint returns 400 (per ADR-0002).

The dual acceptance is intentional. It is **not** extended to other endpoints — `PUT /api/status` requires `agentId` in the request body only; per-task endpoints (claim, release, complete, checkpoint, comment) require `agent` in the body only. The `/api/status` GET is the only place this dual path exists, by design.

The convention is now documented in the API reference (`docs/reference/api/agents.md`).

## Consequences

- **Internal OpenClaw callers can use headers.** Bundled hooks, gateway middleware, and any other internal caller that already manipulates headers can pass `x-openclaw-agent-id` without rewriting URLs. Cleaner for header-oriented code paths.
- **No silent header bleed across other endpoints.** Adding `x-openclaw-agent-id` to a request that hits `PUT /api/status` or any task endpoint has no effect — those endpoints read body fields. A caller that mistakenly believes the header is universal will get 400 errors quickly, not silent misrouting.
- **Documented as convention, not as architectural shape.** The dual path exists because it's useful for one set of callers; future endpoints should not duplicate the pattern unless they have the same justification. The reference doc explicitly notes the GET-only scope.
- **Dropping the header path would be a breaking change.** Any internal caller that uses headers today would need to switch back to query parameters. The cost of removal is moderate (small number of internal callers, all under operator control), but not zero. Preferred direction: keep both, document both, do not extend further.
- **Drift detection covers it.** The reference doc mentions the header path; the drift test (T-197-8) ensures the API manifest stays in sync. A future server-side change that removes the header path would also need to remove it from `docs/reference/api/agents.md` for consistency, which makes accidental removal unlikely.
