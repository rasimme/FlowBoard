# Review task discipline

The former `compat`/`enforce` task-creation rollout is superseded by
[ADR-0035](../../adr/0035-task-form-not-authorization.md). Direct task
creation remains allowed; Specify is optional.

Projects use `taskDiscipline` (`list`, `standard`, or `development`) to identify
shape issues: a missing description, or a title that reads as a bare verb stub
("Fix API"). A task with either gets a non-blocking `structureReview` marker,
attached only when the task is created.
Use `GET /api/projects/:name/tasks?structureReview=pending` to find pending
items and acknowledge one with
`POST /api/projects/:name/tasks/:id/structure-review`. The server records the
resolved actor and timestamp; request-body identity claims do not authorize or
replace that attribution.

A pending item does not always need an acknowledgement — editing the task to
fix the flagged issue (adding a description, renaming the title) clears that
reason on its own, and the marker disappears once nothing is left to flag. So
an item you see in the pending list one day may simply be gone the next
without anyone having acknowledged it; that is the fix taking effect, not a
bug. Acknowledging is only for a review you want to accept as-is — once
acknowledged, it stays as a record and does not change again.

The `/governance/mode` endpoint may still exist as a legacy compatibility and
configuration surface, but it is not a current task-creation gate. See the
[legacy API reference](../../reference/api/governance.md) only when maintaining
that surface.
