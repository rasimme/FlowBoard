# ADR-0002: /api/status requires an explicit agentId

## Status
Accepted

## Date
2026-04-30

## Source
- private spec `specs/T-177-server-per-agent-hardening.md` in operator's local FlowBoard project
- public commit `c5e5fc6` — `fix(api): /api/status requires explicit agentId (T-177-2 + T-177-5)`

## Context

The server held a constant `AGENT_ID = process.env.OPENCLAW_AGENT_ID || 'main'` and used it as a silent fallback in both `GET` and `PUT /api/status` when the caller omitted `agentId`. On the operator's Jetson the dashboard's systemd unit had `OPENCLAW_AGENT_ID=dev-botti`, so a no-arg `GET /api/status` returned `dev-botti`'s state to any caller. On 2026-04-29 `main` (whose `active_project` was `null`) called `/api/status` without `?agentId=main`, received `dev-botti`'s `{activeProject: 'flowboard', agentId: 'dev-botti'}`, trusted the response field-for-field, and posted to Telegram that `flowboard was active` — wrong by every canonical signal.

The bug was latent for as long as agents read project context from the on-disk `BOOTSTRAP.md`. Once ADR-0001 moved context to live-inject, agents that double-checked state via `/api/status` hit the silent fallback immediately.

## Decision

`GET /api/status` without an `agentId` query parameter returns `400 {"error": "agentId query parameter is required"}`. `PUT /api/status` without an `agentId` body field returns `400` analogously. `getCanonicalActiveProject(agentId)` accepts `agentId` as a required argument with no function-level default.

## Consequences

- **Positive:** Cross-agent state leakage is impossible by construction — there is no path where the server substitutes an agent identity.
- **Positive:** Snippet hardening (T-168-5 anti-inference, T-177-5 anti-trust) becomes meaningful — agents can now safely surface a `response.agentId !== caller.agentId` mismatch as a server-side failure rather than blame their own identity.
- **Negative:** Breaking for any external caller that previously omitted `agentId`. The known callers (frontend, project-context hook) already pass it. External tools must update.
- **Operational:** The local systemd unit's `OPENCLAW_AGENT_ID=dev-botti` line was removed during rollout — the env-var no longer has any effect on the server, but leaving it set is misleading.
