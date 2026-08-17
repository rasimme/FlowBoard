# ADR-0031: Canonical work state and transient stuck indicator

## Status
Accepted — supersedes the execution-context portion of ADR-0009

## Date
2026-08-17

## Source
- private spec `specs/T-443-implement-canonical-work-state-and-trans.md`
- public commit `ddfdac6` — `feat(T-443): add canonical work-state and transient stuck monitoring`
- frontend review task T-443-4 and its regression coverage

## Context

ADR-0009 correctly made `blocked` orthogonal to the lifecycle column, but a
boolean cannot express the other current execution contexts (`waiting` and
`paused`) or their actionable details. The stuck monitor also needs a living
signal without appending reminder comments or allowing a stale client response
to erase newer state.

## Decision

1. `workState` is canonical and orthogonal to lifecycle status. Its values are
   `working`, `waiting`, `blocked`, and `paused`.
2. `workStateDetails` is a normalized object with `reason`, `waitingFor`,
   `responsible`, `checkAgainAt`, and server-owned `setAt`. The legacy
   `blocked` field is computed as `workState === "blocked"` and remains a
   compatibility read/write projection (`blocked: false` maps to `working`).
3. A task exposes at most one transient `stuckIndicator` object or `null`.
   `detectedAt` is retained for the incident lifetime and is not replaced by
   every evaluation; re-evaluation updates the existing object in place.
4. Retry/Clear are explicit, same-origin `POST` action descriptors supplied by
   the backend, represented as `actions.retry` / `actions.clear` entries with
   an explicit `action` field, `method: "POST"`, and the exact project/task
   route `/api/projects/{project}/tasks/{id}/stuck-indicator/{clear|retry}`.
   The route suffix must match the action and the descriptor body may carry
   only the indicator action's own token/revision; it must not carry lifecycle
   or work-state writes (`status`, `blocked`, `workState`, or
   `workStateDetails`). They are non-destructive indicator actions and must
   return a complete canonical task. The frontend never synthesizes a task
   PUT, clears the indicator only in local state, follows arbitrary `/api/`
   paths, or accepts an indicator array. If the endpoint/action descriptor is
   not integrated, the controls stay hidden and the UI fails closed.
5. Ordinary optimistic task errors roll back only fields that still equal the
   mutation's optimistic values. Canonical work-state PUTs are the deliberate
   exception: they do not patch shared task state optimistically. This removes
   the same-value race where an external `waiting` update with newer details
   could be mistaken for the client's optimistic value and erased after a
   `409`; canonical task responses are schema-validated before publication.

## Consequences

- Existing cards and API consumers can continue reading `blocked` while new
  surfaces use the richer canonical state.
- The UI can display an accurate incident detection time and one living
  attention signal without creating history noise.
- Backend and frontend rollout is atomic at the task-response boundary: a
  missing canonical field or malformed indicator rejects the whole task
  snapshot rather than inventing a local success.
- The transient action HTTP endpoints are an integration dependency. Until the
  backend emits explicit descriptors and full canonical responses, no Retry or
  Clear control is rendered.

## Integration status

The backend registers both exact project/task-bound `POST` routes and returns
the complete canonical task, so integrated responses can advertise executable
Retry and Clear controls. The frontend still validates descriptors and remains
fail-closed for missing, generic, or malformed action payloads. The integrated
contract is covered by the service, API, and browser regression suites.

## See also

- [ADR-0009](0009-blocked-as-flag-not-status.md) — historical blocked-as-flag decision
- [Kanban concept](../concepts/kanban.md)
- [Frontend Runtime concept](../concepts/frontend-runtime.md)
