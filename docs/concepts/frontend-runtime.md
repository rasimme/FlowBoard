# Frontend Runtime

## What

The frontend runtime is the client-side contract for keeping FlowBoard's task UI consistent after local actions.

It sits between React views, the legacy `window.appState` shell bridge, and the Express/HZL API. Its job is not to own canonical task truth. Its job is to make local UI state converge quickly and predictably with canonical server responses.

The current implementation is still in transition, but the ownership boundary is now explicit. `dashboard/js/app.js` is bootstrap-only: it creates the initial `window.appState` shape and resolves Telegram auth/agent identity. React's `DashboardContext` owns shell refresh, project actions, tab switching, and the remaining compatibility bridge. Task-list reads and writes go through `appStateBridge`, and mutation wrappers live under `src/state/`.

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

## File Runtime

Project files are not HZL records. They live on disk under the project directory and may be changed by the dashboard, by agents, or by normal filesystem tools. The Files view therefore uses a smaller convergence contract than task state:

1. The server file tree is the canonical metadata snapshot.
2. Each file entry exposes `modifiedMs`, `size`, and `version` (`mtimeMs:size`) for cheap change detection.
3. FilesView polls that metadata while the Files tab is visible.
4. If the selected file's version changes and the editor is clean, FilesView reloads the preview from the API.
5. If the selected file disappears, FilesView clears the selection and falls back through the normal default-file path.
6. If the editor is dirty, external changes are surfaced as a conflict prompt instead of overwriting local edits.

This deliberately avoids WebSocket/SSE for now. Polling is the right first runtime because external agents may write files directly on disk and not through a FlowBoard mutation endpoint.

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

- `dashboard/js/app.js` - bootstrap-only state shape, Telegram auth, agent id resolution
- `dashboard/js/utils.js` - legacy Idea Canvas helpers only; not a React task runtime surface
- `dashboard/src/context/AppStateContext.jsx` - React bridge over global app state
- `dashboard/src/context/DashboardContext.jsx` - React-owned shell runtime and compatibility bridge
- `dashboard/src/pages/TasksView.jsx` - Kanban task UI
- `dashboard/src/pages/FilesView.jsx` - project file tree, preview, editor, and file-metadata reconciliation
- `dashboard/src/components/DetailPanel.jsx` - task detail drawer and task actions
- `dashboard/src/utils/apiFetch.js` - React API helper
- `dashboard/src/utils/toast.js` - React toast bridge
- `dashboard/src/state/appStateBridge.mjs`
- `dashboard/src/state/taskState.mjs`
- `dashboard/src/state/taskMutations.mjs`
- `dashboard/src/hooks/useTaskActions.jsx`

## See also

- [Kanban](kanban.md)
- [Idea Canvas](idea-canvas.md)
- [HZL Event Sourcing](hzl-event-sourcing.md)
- [ADR-0019](../adr/0019-frontend-runtime-foundation.md)
