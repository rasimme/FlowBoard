# ADR-0003: The dashboard service has no agent identity

## Status
Accepted

## Date
2026-04-30

## Source
- private spec `specs/T-177-server-per-agent-hardening.md` (Phase 4) in operator's local FlowBoard project
- public commit `9c4ded1` — `refactor(server): remove AGENT_ID concept, route outbound by action context (T-177-3)`

## Context

After ADR-0002 removed the silent default on `/api/status`, the `AGENT_ID` constant was still referenced by outbound code paths: `sendWakeEvent`, the initial `flowboard_agents` row on first activation, and the response base for some endpoints. Conceptually the dashboard is a service — a routing layer over `flowboard_agents` and `flowboard_projects` — not an agent. Giving the service its own agent identity meant outbound side-effects could wear an arbitrary agent's name, defeating ADR-0002's hardening from the other end.

Three options were considered:
- **A** — remove the constant only, accept that outbound paths might break. Rejected: too risky without a clear routing strategy.
- **B** — rename to `OPERATOR_AGENT` from a dedicated env-var like `FLOWBOARD_OPERATOR_AGENT`. Rejected: still gives the service an identity it doesn't need; multi-operator setups would still pile up workarounds.
- **C** — route every outbound call by the agent that initiated the action. Selected.

## Decision

The `AGENT_ID` constant is removed entirely. `OPENCLAW_AGENT_ID` is no longer read by the server. Outbound paths take their target agent from the request or event context: `sendWakeEvent(targetAgentId, text)` is called with `req.body.agentId`; HZL `setOnComplete` payloads already carry `{project, taskId, title, agent}` — `agent` is the routing key; promote-webhook callers pass through the originating agent. No replacement env-var is introduced.

External agents (Codex, Cursor, Claude Code, cron scripts) become first-class citizens under this rule. They pick a stable `agentId` (e.g. `claude-code`, `cron-nightly`) and pass it on every API call; lazy registration into `flowboard_agents` happens on the first `PUT /api/status`.

## Consequences

- **Positive:** No path can spoof an agent identity from server-side defaults — the agent is supplied by the caller in every code path.
- **Positive:** Architectural alignment: the service stays a service. The two layers (OpenClaw workspace identity, FlowBoard `flowboard_agents` accounting) remain loosely coupled by the agent-id string alone, no foreign keys.
- **Positive:** External agents work without a workspace under `~/.openclaw/workspace-X` and without an `agent:bootstrap` hook — they fetch context via `GET /api/projects/<name>/bootstrap` on demand.
- **Negative:** Internal callers that lacked agent context (e.g. cron sweeps) need agent-id threaded through their job context. The current cron paths were audited and threaded during rollout.
