# Frontend Runtime

## What

The frontend runtime is the client-side contract for keeping FlowBoard's task UI consistent after local actions.

It sits between React views, the legacy `window.appState` shell bridge, and the Express/HZL API. Its job is not to own canonical task truth. Its job is to make local UI state converge quickly and predictably with canonical server responses.

The current implementation is still in transition. Historically, `dashboard/js/app.js` owns `window.appState`, while React views read it through `AppStateContext`. Some task actions mutate the global task list directly, while others update local component state and wait for a later refresh. T-215 changes that by introducing an explicit runtime foundation.

## Why

FlowBoard has a clean server-side ownership model:

- Express 5 is the HTTP/API boundary.
- HZL/SQLite is the canonical task event store and projection layer.
- React is the primary dashboard UI path.
- Vanilla JS remains for shell compatibility and the deferred Idea Canvas runtime.

The weak point is what happens after a user changes task state in the UI.

Without a single client mutation path, the same task can be represented differently in different places for a few seconds. A drag/drop action might patch the Kanban card but not the detail panel. A detail-panel claim might update local panel state but leave the card stale until polling. A subtask update might need to merge `parentUpdated`, but the local code path might only patch the child.

The frontend runtime exists to make those actions boring:

1. patch locally for immediate feedback
2. call the API
3. merge the canonical response
4. roll back if the request fails
5. notify every React surface through one bridge

## Responsibility Split

### Express 5

Express remains the backend boundary:

- validates requests
- resolves authentication/session context
- calls HZL services
- returns canonical JSON responses
- does not manage browser UI state

### HZL / SQLite

HZL remains the canonical task model:

- event log
- `tasks_current` projection
- task lifecycle
- claims, leases, releases
- parent/subtask recalculation
- checkpoint/comment history

### React

React owns interactive dashboard UI state:

- render task/project views
- call runtime task actions
- receive immediate optimistic updates
- receive canonical server response merges
- display rollback/error feedback

### Legacy Vanilla JS

Legacy JS remains compatibility infrastructure while migration is incomplete:

- bootstrap shell state
- maintain tab/project shell behavior where still needed
- host the vanilla Idea Canvas runtime
- expose bridge entry points for React

Legacy JS should not gain new task mutation semantics.

## Runtime Contract

Every task mutation should follow the same sequence:

1. Read the current task snapshot from the runtime bridge.
2. Apply an optimistic patch to the shared local task list.
3. Notify React immediately.
4. Send the API request.
5. Merge the canonical server response into shared state.
6. Merge related records such as `parentUpdated`.
7. Roll back the snapshot if the request fails.
8. Let background polling reconcile later as a safety net.

Polling is reconciliation. It is not the primary state propagation mechanism for a local action.

## Target Modules

The intended module boundary is:

- `dashboard/src/state/appStateBridge.*`
  - reads and writes `window.appState` while it still exists
  - emits the React notification event
  - owns refresh bridge functions
- `dashboard/src/state/taskState.*`
  - pure operations for patch, merge, rollback, snapshots, and parent updates
- `dashboard/src/state/taskMutations.*`
  - API-backed mutation wrappers for task actions
  - applies optimistic patch first, then merges or rolls back
- `dashboard/src/hooks/useTaskActions.*`
  - React-facing API used by `TasksView`, `DetailPanel`, and later React-owned task surfaces

## Rules For New UI Code

New task UI code must use the runtime helpers once they exist.

Do not:

- mutate `window.appState.tasks` directly outside the bridge
- add another detail-panel-only task state path
- rely on the 5 second poll for visible local feedback
- add a second refresh bridge for one component
- start a Canvas task-state migration with a custom global store

Do:

- apply an optimistic patch through the runtime
- merge the server response after every mutation
- handle `parentUpdated` and future related records explicitly
- roll back on failed requests
- keep HZL/API canonical
- add tests for new mutation behavior

## Current Migration Order

T-215 splits the foundation into small steps:

1. document the ADR and concept contract
2. add the app-state bridge and test harness
3. add pure task merge helpers and mutation wrappers
4. migrate `TasksView`
5. migrate `DetailPanel`
6. add guardrails and smoke tests

This order is intentional. It lets FlowBoard improve convergence without a large rewrite and without blocking the deferred Canvas migration.

## Consequences

- Local actions should feel immediate even though the server remains canonical.
- Kanban cards, DetailPanel, active-agent surfaces, and counters should converge through one task list.
- Future React views get one documented state path instead of copying old global writes.
- Canvas can remain vanilla for now, but future task-facing Canvas work must use the same runtime foundation.
- WebSocket/SSE and larger state libraries remain later options, not prerequisites.

## Code

Current relevant files:

- `dashboard/js/app.js` - legacy shell state, project refresh, and `window.appState`
- `dashboard/src/context/AppStateContext.jsx` - React bridge over global app state
- `dashboard/src/pages/TasksView.jsx` - Kanban task UI
- `dashboard/src/components/DetailPanel.jsx` - task detail drawer and task actions
- `dashboard/src/utils/apiFetch.js` - React API helper

Planned files:

- `dashboard/src/state/appStateBridge.*`
- `dashboard/src/state/taskState.*`
- `dashboard/src/state/taskMutations.*`
- `dashboard/src/hooks/useTaskActions.*`

## See also

- [Kanban](kanban.md)
- [Idea Canvas](idea-canvas.md)
- [HZL Event Sourcing](hzl-event-sourcing.md)
- [ADR-0019](../adr/0019-frontend-runtime-foundation.md)
