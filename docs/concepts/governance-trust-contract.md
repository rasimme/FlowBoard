# Governance Trust Contract

The small, server-authoritative trust foundation behind task creation, Specify
confirmation, exception review, and governance-mode changes. Introduced by
**T-447-1** as the base layer of the larger "govern agent-originated task
creation" epic (**T-447**).

## 1. What is this concept?

A single place — `dashboard/governance.js` — that answers three questions on the
server, from verified context only:

1. **Who is acting?** `resolvePrincipal(req)` returns a `human` or `agent`
   principal derived from *authenticated / session / transport* context.
2. **May this human confirm a Specify proposal?**
   `verifyHumanConfirmation(...)` gates the Specify `/confirm` mutation and
   produces the record to persist.
3. **May this actor change governance mode / mark an exception reviewed?**
   `setGovernanceMode(...)` and `authorizeExceptionReview(...)` require a
   verified human and return an audit record (actor + timestamp).

It is deliberately **not** a policy engine, roles matrix, or allowlist. Those
are explicitly out of scope for T-447 (see the parent spec and
[ADR-0029](../adr/0029-local-first-single-operator-security-boundary.md)).

## 2. Why does it exist?

Agents can call the FlowBoard API. Without a trust boundary, an agent could
originate work and *self-certify* it as human-approved by putting
`{ "human": "...", "approved": true }` in a request body. The governance trust
contract makes that impossible: **the effective principal is resolved on the
server; caller-supplied fields are descriptive only.**

## 3. Exact principal sources — the trust boundary

The single authoritative signal for a **verified human** is `req.user`,
populated by the `/api/` auth middleware
([Auth Model](auth-model.md), `dashboard/server.js` →
`telegramAuthMiddleware` → `authenticateOrChallenge`) from either:

- **(a)** fresh, HMAC-verified Telegram Mini App init-data, or
- **(b)** a server-signed session cookie (`flowboard_session`) whose JWT was
  minted from a prior (a).

In both cases the FlowBoard server itself verified the identity; the client
cannot forge it. `req.user.id` is the Telegram user id; `req.user.agentId` is
the *bot mapping* (attribution, **not** an authorization claim —
[ADR-0003](../adr/0003-dashboard-has-no-agent-identity.md)).

**One narrow, deployment-scoped exception.** On an install where Telegram auth
is **not configured** (`AUTH_ENABLED === false`), FlowBoard is a single-operator
localhost tool and the auth middleware already grants a direct loopback caller
full access ([ADR-0029](../adr/0029-local-first-single-operator-security-boundary.md)).
For exactly that request the middleware stamps `req.localOperator = true`
(**never** for cf-ray/tunnel requests or the LAN-hostname bypass), and the
resolver treats that trusted loopback operator as the verified human — the same
actor the loopback bypass already trusts for every other mutation. When
Telegram auth **is** configured, this flag is never set and only a real
`req.user` qualifies as human.

**Descriptive-only (never authoritative):** everything the client puts in the
request body or custom headers — `body.agent`, `body.agentId`, `body.human`,
`body.approved` / `body.userApproval`, `body.origin`, `body.principal`, and the
Specify `session.agentId` (`'human'` for the dashboard stepper is a *routing
hint* set at session creation, not proof of a human).

Trust boundary in one line: **"did the FlowBoard server verify a human for THIS
request?"** — a Telegram `req.user`, or (auth-disabled only) the trusted
loopback operator. Everything else is an `agent` principal.

## 4. Verified human Specify confirmation

`POST /api/specify/sessions/:id/confirm` resolves the principal and calls
`verifyHumanConfirmation({ principal, session, expectedSessionId })`. On success
it persists a confirmation record on the session:

```
{ actor, humanId, authSessionId, confirmedAt, specifySessionId, proposalIdentity }
```

`proposalIdentity` fingerprints the confirmed draft (summary + task count +
titles) so the record names *what* was confirmed, not just *that* something was.

Rejections (HTTP 403 with a stable `code`):

| Code | When |
|------|------|
| `confirmation_requires_verified_human` | principal is not a verified human |
| `agent_self_confirmation_forbidden` | the session is agent-originated (transport ≠ `dashboard` or agentId ≠ `human`); an agent cannot confirm its own proposal, and even a verified human confirms via the Dashboard stepper, not an agent's chat session |
| `no_proposal_to_confirm` | session has no draft proposal |
| `session_binding_mismatch` | route `:id` ≠ the bound session, or no session |
| `confirmation_binding_stale` | proposal older than `FLOWBOARD_CONFIRM_MAX_AGE_MIN` (default 30 min) |

## 5. Governance mode & exception review

- **Governance mode** (`compat` \| `enforce`, default `compat`) persists in
  `flowboard_settings` via `fbMeta.getSetting/setSetting`. `GET/PUT
  /api/projects/:name/governance/mode`. The `PUT` requires a verified human and
  writes an audit record (`{ actor, humanId, changedAt, mode }`). `compat` and
  `enforce` semantics for the creation wrapper arrive in later subtasks; T-447-1
  only owns the persisted, human-gated switch + rollback.
- **Exception review** — `POST /api/projects/:name/tasks/:id/exception-review`
  requires a verified human and stamps `metadata.flowboard.exceptionReview =
  { state: 'reviewed', reviewer, reviewerHumanId, reviewedAt }`, surfaced as the
  first-class `task.exceptionReview` field.

## 6. Scope boundary (what T-447-1 does NOT do)

The `createTaskWithPolicy()` boundary, the four server-validated operational
exceptions and their predicates, the append-only policy ledger, and the
`SPECIFY_REQUIRED` 409 recovery flow are **later** subtasks (T-447-2..5). This
concept is only the trust primitives those tasks consume.

## Where the code lives

- `dashboard/governance.js` — resolver + confirmation/mode/review contract.
- `dashboard/server.js` — `/specify/.../confirm`, `/governance/mode`,
  `/tasks/:id/exception-review`; `req.localOperator` stamp in
  `telegramAuthMiddleware`.
- `dashboard/hzl-service.js` — `setExceptionReview()` + `exceptionReview` field.
- `dashboard/flowboard-metadata.js` — `getSetting`/`setSetting` for mode.
- Tests: `dashboard/test-t447-1-principal.js` (unit),
  `dashboard/test-t447-1-governance-endpoints.js` (integration),
  updated `dashboard/test-specify-api-confirm.js` and the Specify E2E suite.
