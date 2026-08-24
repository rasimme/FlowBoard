# ADR-0034: Project-scoped governance rollout with compatibility observation

## Status
Accepted (2026-08-24, T-447-5)

## Date
2026-08-24

## Source
- Task: T-447-5, “Roll out safely and verify compatibility”.
- Code: `dashboard/governance.js`, `dashboard/hzl-service.js`, and the
  governance mode routes in `dashboard/server.js`.
- Concept: [Governance Trust Contract](../concepts/governance-trust-contract.md).

## Context

T-447 established a narrow task-creation policy and a verified-human trust
boundary. The final rollout needs to observe would-block traffic before
enforcement, retain compatibility for existing installations, and make a
manual rollback available without letting agents or request-body claims alter
the policy.

## Decision

- Persist `compat` and `enforce` per project in `flowboard_settings`; a missing
  project setting reads as `compat`.
- Do not read the former instance-wide mode or audit keys as automatic
  fallbacks. A legacy `enforce` value must not leak into new or unscoped
  projects. Migration is explicit: a verified human selects the desired mode
  for each project, which writes the scoped key and an audit record containing
  the server-derived actor, human id, timestamp, and resulting mode.
- Expose read and write through `/api/projects/:name/governance/mode`. Reads
  remain available to normal callers; writes require `req.user` resolved by
  the authenticated Telegram/JWT middleware. `{human, agent, agentId,
  approved}` and similar request claims are descriptive only.
- In `compat`, allow `would_block` creation and append the observation. In
  `enforce`, append the observation then reject before the HZL task event. Add
  the evaluated mode to each new ledger record.
- Provide a visible Overview control. It uses `canChange` only to guide the
  UI; the server remains the authorization boundary. Rollback is an explicit
  human switch back to `compat`.

## Consequences

Operators can stage enforcement project by project without allowing a legacy
global value to affect unrelated projects, and agents can inspect the rollout
state. The legacy keys may remain in storage for forensic/migration purposes,
but are inert; new writes are scoped and ledger files remain append-only audit
evidence.
