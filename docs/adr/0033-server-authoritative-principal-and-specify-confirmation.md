# ADR-0033: Server-authoritative principal resolution and verified-human Specify confirmation

## Status
Accepted (2026-08-24, T-447-1)

## Date
2026-08-24

## Source
- Spec: `specs/T-447-1-map-task-creation-entry-points-and-defin.md` (subtask of epic **T-447**, "Govern agent-originated task creation through Specify").
- Code: `dashboard/governance.js`, the confirm / governance-mode / exception-review endpoints in `dashboard/server.js`, `hzl-service.setExceptionReview()`, `flowboard-metadata.get/setSetting`.
- Builds on [ADR-0028](0028-auth-model-middleware.md) (auth model), [ADR-0029](0029-local-first-single-operator-security-boundary.md) (local-first single operator), and [ADR-0003](0003-dashboard-has-no-agent-identity.md) (`agentId` is attribution, not identity).
- Concept: [Governance Trust Contract](../concepts/governance-trust-contract.md).

## Context
FlowBoard's API is callable by agents. The T-447 epic makes agent-originated
work server-governed: non-exempt work must go through Specify plus a verified
human confirmation. That is only sound if the server — not the caller — decides
**who** is acting. An agent must not be able to self-certify by sending
`{ "human": "...", "approved": true }` or by naming a Specify session
`agentId: "human"`.

FlowBoard already has exactly one cryptographically verified human signal:
`req.user`, set by the `/api/` auth middleware from HMAC-verified Telegram
init-data or a server-signed session cookie ([ADR-0028](0028-auth-model-middleware.md)).
And per [ADR-0029](0029-local-first-single-operator-security-boundary.md), on a
no-auth install a direct loopback caller *is* the single trusted operator.

## Decision
Resolve the effective principal on the server and treat all caller-supplied
identity/approval fields as descriptive only.

- **`resolvePrincipal(req)`** returns `human` iff the FlowBoard server verified
  the human for *this* request: a real `req.user`, or — only when Telegram auth
  is not configured — the trusted loopback operator, marked by a
  middleware-set `req.localOperator` flag (never set for cf-ray/tunnel or the
  LAN-hostname bypass, and never settable from the request body). Everything
  else is an `agent` principal.
- **Body/header claims never authorize.** `agent`, `agentId`, `human`,
  `approved`/`userApproval`, `origin`, `principal`, and the Specify
  `session.agentId` are echoed as descriptive context and ignored for the kind
  decision.
- **Specify confirmation requires a verified human** confirming a
  Dashboard-human session (`transport: 'dashboard'`, `agentId: 'human'`). The
  server persists `{ actor, humanId, authSessionId, confirmedAt,
  specifySessionId, proposalIdentity }`. It rejects (403, stable `code`):
  non-human principals, agent-originated sessions (agent self-confirmation),
  missing proposal, session-binding mismatch, and stale proposals
  (> `FLOWBOARD_CONFIRM_MAX_AGE_MIN`, default 30 min).
- **Governance mode** (`compat` | `enforce`, default `compat`) is persisted in
  `flowboard_settings` and switched only by a verified human, with an audit
  record and rollback. **Exception review** is likewise verified-human-only and
  stamps reviewer + review timestamp on the task.

## Consequences
- An agent can no longer confirm its own Specify proposal, change governance
  mode, or mark its own exception reviewed. The chat-origin Specify pipeline
  still runs (next/answer/proposal), but confirmation moves to the human via the
  Dashboard stepper — the E2E chat-origin test now asserts the 403.
- No new identity system is introduced: this reuses the existing Telegram/JWT
  human signal and the loopback-operator trust, consistent with the single-user
  security model of [ADR-0029](0029-local-first-single-operator-security-boundary.md).
- **Scope is deliberately narrow.** This ADR covers only the trust primitives.
  The `createTaskWithPolicy()` boundary, the four validated operational
  exceptions and predicates, the append-only policy ledger, and the
  `SPECIFY_REQUIRED` 409 recovery are decided/implemented in later T-447
  subtasks. This is not a generic policy engine, roles matrix, or allowlist.
