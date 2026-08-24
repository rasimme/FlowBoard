# Governance Trust Contract

The small, server-authoritative trust foundation behind task creation, Specify
confirmation, and governance-mode changes. Introduced by
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
3. **May this actor change governance mode?** `setGovernanceMode(...)`
   requires a verified human and returns an audit record (actor + timestamp).

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

Loopback and LAN bypasses are **transport admission**, not proof of a human
principal. A request that reaches the API through an anonymous local bypass is
still an agent principal for policy mutations, including Specify confirmation
and governance-mode changes. There is no local-operator exception here:
confirmation requires a server-verified authenticated session (`req.user`) from
Telegram init-data or a server-issued session cookie.

**Descriptive-only (never authoritative):** everything the client puts in the
request body or custom headers — `body.agent`, `body.agentId`, `body.human`,
`body.approved` / `body.userApproval`, `body.origin`, `body.principal`, and the
Specify `session.agentId` (`'human'` for the dashboard stepper is a *routing
hint* set at session creation, not proof of a human).

Trust boundary in one line: **"did the FlowBoard server verify a human for THIS
request?"** — only a Telegram/JWT-backed `req.user`. Everything else is an
`agent` principal.

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

## 5. Governance mode and rollout

- **Governance mode** (`compat` \| `enforce`, default `compat`) persists in
  project-scoped `flowboard_settings` keys via `fbMeta.getSetting/setSetting`.
  `GET/PUT /api/projects/:name/governance/mode` is the supported surface. The
  former instance-wide setting is not an automatic fallback; migration is an
  explicit, verified-human switch for each project. Unscoped reads remain
  `compat` and have no audit record.
- `GET` is readable by normal callers and exposes `canChange` as a UI hint.
  `PUT` requires a server-verified Telegram/JWT human and writes
  `{ actor, humanId, changedAt, mode }`; body identity claims never authorize.
  The same endpoint with `{ "mode": "compat" }` is the manual rollback.
- In `compat`, a `would_block` decision is allowed and written to the
  append-only policy ledger. In `enforce`, it is written to the ledger and
  rejected before task creation with `409 SPECIFY_REQUIRED` and a reusable
  Specify request. Ledger records include `governanceMode` for observation.

In `enforce`, a non-exempt direct agent task request returns HTTP 409 with
`code: SPECIFY_REQUIRED` and a reusable `specifyRequest`; no Specify session
is created implicitly and no task is written. A Dashboard or chat caller can
POST that request unchanged to `/api/specify/sessions`, let the worker use its
`structuredDecisions`, and complete the normal proposal → verified-human
confirmation flow. Fields already covered by those decisions are not asked
again. Exception-created tasks are visible through the exception inbox/filter;
only the authenticated human principal can perform its immutable
`pending → reviewed` action.

## 6. Migration guidance

Legacy task imports use the explicit `migration` origin and are not blocked.
Keep imported projects in `compat`, review the ledger, then switch to
`enforce` manually. Never copy settings or ledger files between projects and
never edit either file/table by hand; rollback is the verified-human `PUT`
with `mode: compat`.

## 7. Scope boundary (what T-447-1 does NOT do)

The task-creation policy remains deliberately narrow: it is not a generic
roles matrix, allowlist, or persistent per-project configuration surface.

## Where the code lives

- `dashboard/governance.js` — resolver + confirmation/mode contract.
- `dashboard/server.js` — `/specify/.../confirm` and `/governance/mode`.
- `dashboard/hzl-service.js` — durable `specifyConfirmation` task metadata.
- `dashboard/flowboard-metadata.js` — `getSetting`/`setSetting` for mode.
- `dashboard/policy-ledger.js` — append-only decision telemetry, including
  the evaluated rollout mode.
- `dashboard/src/components/GovernanceModeControl.jsx` — Overview read/control
  surface; the server remains the authorization boundary.
- Tests: `dashboard/test-t447-1-governance.js` and
  `dashboard/test-t447-1-governance-endpoints.js` (trust contract),
  `dashboard/test-t447-5-governance-rollout.js` (unit),
  `dashboard/test-t447-5-governance-api.js` (API), and
  `dashboard/test-t447-5-governance-e2e.js` (browser).
