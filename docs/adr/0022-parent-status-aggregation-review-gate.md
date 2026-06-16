# ADR-0022: Parent status aggregation — one rule, review-gated

## Status

Accepted (2026-06-11, T-299)

## Context

Two competing parent-aggregation rules coexisted:

1. `recalcParentStatus()` (called by the PUT/complete/approve handlers):
   all subtasks `done` → parent `review` — the documented Kanban contract.
2. An inline block inside `hzl-service.updateTask()` (introduced with the
   v5 dev-preview wave, asserted by T-250's race test): any subtask
   `review` → parent `review`; all subtasks `done` → parent **`done`**.

Because the inline block ran first, rule 2 won on the common PUT path: a
parent could reach `done` without ever passing the review gate, bypassing
the approve action introduced in T-186 (`review → done` is a human/admin
decision). Depending on the code path, the same board state produced
different parent statuses.

## Decision

One aggregation rule, owned by `recalcParentStatus()`; `updateTask()`
delegates to it instead of carrying its own logic.

The rule:

- While **any** subtask still has work left (`open`/`backlog`/`in-progress`),
  the parent is `in-progress` — promoted from `open`/`backlog` as soon as
  one subtask starts, pulled back from `review` if a subtask reopens.
- Once **every** subtask is `review` or `done`, the parent moves to `review`.
  A single subtask in review does *not* lift the parent — a parent in the
  Review column means "nothing left to work, only to accept".
- The parent **never auto-completes**. `review → done` is the approve
  action (T-186), also for parents whose subtasks were each approved
  individually.
- If no subtask has started, an active parent demotes to `open` (or
  `backlog` when every subtask is backlog).
- `done` parents are never demoted automatically.

The subtask-update response (`PUT /tasks/:id`) reports the resulting parent
transition as `parentUpdated`, computed by comparing the parent's status
before and after the update — the frontend runtime (ADR-0019) consumes it.

## Consequences

- The review lane is trustworthy: nothing reaches `done` without passing it.
- Epics cost one extra approve click even when every subtask was approved
  individually. Accepted: the parent approve confirms the whole.
- T-250's "child in review lifts the parent" visibility is narrowed to the
  all-settled case; in-flight review subtasks are visible on the parent
  card's subtask list instead.
- `test-hzl-race-recovery.js` (race test 4) and `test-hzl-integration.js`
  encode this contract.
