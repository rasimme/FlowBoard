# Review task discipline

The former `compat`/`enforce` task-creation rollout is superseded by
[ADR-0035](../../adr/0035-task-form-not-authorization.md). Direct task
creation remains allowed; Specify is optional.

Projects use `taskDiscipline` (`list`, `standard`, or `development`) to identify
shape issues. A task with an issue gets a non-blocking `structureReview` marker.
Use `GET /api/projects/:name/tasks?structureReview=pending` to find pending
items and acknowledge one with
`POST /api/projects/:name/tasks/:id/structure-review`. The server records the
resolved actor and timestamp; request-body identity claims do not authorize or
replace that attribution.

The `/governance/mode` endpoint may still exist as a legacy compatibility and
configuration surface, but it is not a current task-creation gate. See the
[legacy API reference](../../reference/api/governance.md) only when maintaining
that surface.
