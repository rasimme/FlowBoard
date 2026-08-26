# Legacy governance mode API

This endpoint remains exposed for compatibility with a separate project
settings/audit surface. It is not the current task-creation policy: tasks use
`taskDiscipline` and non-blocking `structureReview` checks; Specify is optional.

The legacy mode is stored per project in the FlowBoard settings table. New
projects and projects without an explicit setting start in
`compat`. The former instance-wide `governance_mode` and audit keys are not
read as fallbacks: a legacy `enforce` value must not leak into a new or
unscoped project, and its actor/timestamp must not appear as that project's
audit. Migration is explicit and project-scoped: the endpoint is called
per project.

## `PUT /api/projects/:name/governance/mode`

Switch the project immediately:

```json
{ "mode": "enforce" }
```

Any caller may mutate this legacy surface — it is not gated on a verified
human (that requirement was walked back with the rest of the T-447
authorization layer; see [ADR-0035](../../adr/0035-task-form-not-authorization.md)).
`resolvePrincipal()` resolves `actor`/`humanId` from server-owned session
state (or `local:operator` for a trusted loopback caller, or
`agent:unverified` otherwise) purely for the audit record below — body
fields such as `human`, `agent`, `agentId`, or `approved` are descriptive
claims and cannot grant or block authority. Only an invalid `mode` value is
rejected, with `400`.

Use the same endpoint for manual rollback:

```json
{ "mode": "compat" }
```

Rollback is immediate and leaves the audit record showing who performed it
and when. No automatic rollout, timer, or environment-variable override is
used.

## Task-creation boundary

The `compat`/`enforce` setting is not a task-creation gate in the current
contract. Direct task creation remains allowed; project `taskDiscipline` may
attach a `structureReview` marker without rejecting the task. Specify is an
optional clarification workflow. Older ledger records may contain historical
`would_block` observations; do not use them as current task-policy behavior.

## Migration/import guidance

Task imports and explicit migration paths use the `migration` origin and should
preserve their source metadata. Do not edit the settings table or ledger file
by hand. If an older install contains a global `governance_mode` value, do not
use it as current task-policy state. See [ADR-0035](../../adr/0035-task-form-not-authorization.md).
