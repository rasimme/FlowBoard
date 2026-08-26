# Task Creation Trust Contract

## Provenance, not authorization

FlowBoard records origin, actor, timestamp, and creation audit data server-side.
These fields explain where a task came from; they do not prove an unobservable
human approval. Task-form checks are project-scoped and create a review marker
instead of blocking task creation. This is the current T-449 end state and is
recorded in [ADR-0035](../adr/0035-task-form-not-authorization.md).

## Task discipline

Project metadata stores `taskDiscipline` as `list`, `standard`, or
`development`. The dashboard exposes this same setting as **Project type** on
the Overview page; the user-facing name is deliberately broader than the API
field name. New-project creation and existing-project migration both fall
back to the same signal-derived suggestion (`dashboard/task-discipline.js`
`suggest()`: GitHub-repo binding or coding-shaped keywords suggest
`development`, docs/coordination-shaped keywords suggest `standard`) when no
explicit value is given, and invalid values normalize to `list`. On direct or
batch task creation, `dashboard/task-discipline.js` evaluates server-visible
shape. A violation produces:

```json
{
  "status": "pending",
  "reviewer": null,
  "reviewedAt": null,
  "reasons": ["missing_description"]
}
```

The marker is exposed as `structureReview`; it is not an authorization gate.
Specify is optional and direct agent creation remains allowed. Two reasons
exist: `missing_description` (the task has no `description`) and
`title_pattern` (the title reads as a bare verb stub, e.g. "Fix API"). Both
apply to `standard` and `development` tasks; a `list` project is never
evaluated. Both are checks on the request's own content, not a judgment about
scope or future work.

A marker is attached only at creation — a later `PUT` never adds one. A
still-`pending` marker can lose reasons afterwards: fixing the underlying
form (adding the missing `description`, renaming a stub title) drops that one
reason on the next `PUT`, and once the last reason is gone the marker itself
is cleared. This is separate from acknowledgement below: acknowledging is a
human saying the review is fine as it stands, and once a marker is
`reviewed` it is history and is never rewritten or self-retired.

`GET /api/projects/:name/tasks?structureReview=pending|reviewed` filters the
inbox. `POST /api/projects/:name/tasks/:id/structure-review` performs the
one-way acknowledgement. The server resolves the reviewer and timestamp from
the request principal. Body-supplied `agent` or `actor` values cannot replace
that attribution. Anonymous local requests use `local:operator`; authenticated
requests use the resolved session actor.

## Atomic structured creation

`POST /api/projects/:name/tasks` also accepts one explicit
`{ parent, subtasks }` unit. The server validates every item before the first
write, allocates child IDs and `parentId`, inherits the parent's priority when
needed, and purges all tasks from the request if a later write fails. Each
item receives its own discipline evaluation.

## Specify confirmation

Specify remains a clarification and proposal workflow. Dashboard-human
confirmation is required for the Specify confirmation action itself and is
bound to the server-owned session and proposal identity. It does not authorize
unrelated direct task creation. Caller-supplied identity or approval fields
are descriptive only.

## Legacy governance endpoint

`GET/PUT /api/projects/:name/governance/mode` may remain available as a legacy
compatibility/configuration and audit surface. Its `compat`/`enforce` value does
not define current task-creation behavior and must not be documented as a
Specify release gate. [ADR-0034](../adr/0034-project-scoped-governance-rollout.md)
is retained as a historical record and explicitly superseded by ADR-0035.

## Where the code lives

- `dashboard/task-discipline.js` — discipline values and review reasons.
- `dashboard/server.js` — task, batch, filter, and structure-review routes.
- `dashboard/governance.js` — principal resolution and Specify confirmation.
- `dashboard/hzl-service.js` — durable task metadata and review acknowledgement.
- `dashboard/test-t449-2-migration.js`, `test-t449-3-structure-review.js`, and
  `test-t449-4-batch-create.js` — focused T-449 contract tests.
