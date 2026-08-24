# Governance mode API

Task creation governance is stored per project in the FlowBoard settings
table. New projects and projects without an explicit setting start in
`compat`. The legacy instance-wide setting is read as a migration fallback so
an upgrade cannot silently relax an existing `enforce` rollout; the next
manual switch writes the project-scoped setting.

## `GET /api/projects/:name/governance/mode`

Read the current mode. This is a normal read surface and does not require a
verified human session.

```json
{
  "ok": true,
  "project": "example",
  "mode": "compat",
  "default": "compat",
  "modes": ["compat", "enforce"],
  "canChange": false,
  "lastChange": null
}
```

`canChange` is only a UI capability hint. The server repeats the authorization
check on every write. `lastChange`, when present, contains the server-derived
actor and timestamp:

```json
{
  "actor": "telegram:42",
  "humanId": "42",
  "changedAt": "2026-08-24T21:30:00.000Z",
  "mode": "enforce"
}
```

## `PUT /api/projects/:name/governance/mode`

Switch the project immediately:

```json
{ "mode": "enforce" }
```

Only the server-verified Telegram/JWT human principal may mutate this route.
Body fields such as `human`, `agent`, `agentId`, or `approved` are descriptive
claims and cannot grant authority. Unauthenticated, agent, ambiguous, or
spoofed callers receive `403` with
`mode_change_requires_verified_human`. Invalid modes receive `400`.

Use the same endpoint for manual rollback:

```json
{ "mode": "compat" }
```

Rollback is immediate and leaves the audit record showing who performed it
and when. No automatic rollout, timer, or environment-variable override is
used.

## Creation semantics

In `compat`, a policy decision of `would_block` is allowed to create the task
and the append-only policy ledger records the decision. In `enforce`, the same
decision is recorded and rejected before any task event is written with
`409 SPECIFY_REQUIRED`; the response includes a reusable `specifyRequest`.
Allowed Specify and validated exception paths continue to work in either mode.
New ledger records include `governanceMode` for observation and migration
verification; records from older versions may omit it.

## Migration/import guidance

Task imports and explicit migration paths use the `migration` origin and are
not blocked by this policy. Imports should preserve their source metadata and
be followed by a read of this endpoint plus a ledger review. Do not edit the
settings table or ledger file by hand. See
[Migrations](migrations.md#task-creation-governance-rollout) for the staged
rollout checklist.
