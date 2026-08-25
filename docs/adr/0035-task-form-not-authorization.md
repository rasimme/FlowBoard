# ADR-0035: Task form, not authorization

## Status

Accepted (2026-08-25, T-449-6)

## Source

- T-449 end-state specification and checkpoints T-449-2, T-449-3, and T-449-4.
- `dashboard/task-discipline.js` and task routes in `dashboard/server.js`.
- Contract tests `test-t449-2-migration.js`, `test-t449-3-structure-review.js`,
  and `test-t449-4-batch-create.js`.
- Supersedes the task-creation enforcement part of [ADR-0034](0034-project-scoped-governance-rollout.md).

## Context

FlowBoard is local-first and does not observe a separate human authorization
decision for an agent's task form. A staged `compat`/`enforce` rollout added
more policy state than the task API needs and made an optional Specify workflow
look like a creation gate.

## Decision

- Each project has a `taskDiscipline`: `list`, `standard`, or `development`.
  Existing projects derive and persist this value from project signals; invalid
  values normalize to `list`.
- Direct task creation remains allowed for agents and the local dashboard.
  Discipline checks inspect server-visible shape and, when applicable, attach a
  `structureReview` marker with machine-readable reasons. They never reject a
  task because Specify was not used or a human approval was not observed.
- `POST /api/projects/:name/tasks` accepts either one task or an explicit
  `{ parent, subtasks }` unit. Batch input is fully validated before the first
  write; children receive server IDs and `parentId`, inherit the parent's
  priority unless overridden, and a later write failure purges the whole batch.
- `POST .../:id/structure-review` is a one-way acknowledgement. The server
  records the resolved principal's actor and its own timestamp. Request-body
  `agent`/`actor` claims do not authorize or replace that attribution. An
  anonymous local request is attributed to `local:operator`; authenticated
  requests may be attributed to `session:<id>`.
- Specify is an optional clarification/proposal workflow. Its Dashboard-human
  confirmation remains a separate verified-session contract; it is not a
  prerequisite for direct task creation.

The old governance-mode endpoint may remain available for compatibility and
its separate configuration/audit surface, but `compat`/`enforce` is not the
task-creation contract. ADR-0034 is therefore retained as a historical,
superseded rollout record and must not be used to describe current task
creation behavior.

## Consequences

Task shape problems are visible and reviewable without blocking useful work.
Task provenance remains auditable, while actor attribution is not presented as
proof of human approval. Structured work has an atomic API contract, and
Specify can improve requirements quality without becoming an authorization
gate.
