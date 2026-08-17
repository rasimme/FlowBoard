# Frontend Runtime

## What

The frontend runtime is the client-side contract for keeping FlowBoard's task UI consistent after local actions and for representing dashboard API availability without inventing empty data.

It sits between React views, the legacy `window.appState` shell bridge, and the Express/HZL API. Its job is not to own canonical task truth. Its job is to make local UI state converge quickly and predictably with canonical server responses.

The ownership boundary is explicit. `dashboard/src/bootstrap.js` is bootstrap-only: it creates the initial `window.appState` shape and resolves Telegram auth/agent identity. React's `DashboardContext` owns shell refresh, project actions, tab switching, and the remaining compatibility bridge. Task-list reads and writes go through `appStateBridge`, and mutation wrappers live under `src/state/`.

`appStore` also carries one connection state for the shell: `loading`, `ready`, `empty`, `auth-error`, `offline`, `timeout`, or `server-error`. `empty` is produced only by a successful, schema-valid projects response. Initial failures block the shell with remediation; failures after a valid snapshot leave that snapshot intact and surface a persistent retry banner.

## Why

FlowBoard has a clean server-side ownership model:

- Express 5 is the HTTP/API boundary.
- HZL/SQLite is the canonical task event store and projection layer.
- React is the primary dashboard UI path.
- Vanilla JS remains for shell compatibility and the deferred Idea Canvas runtime.

The weak point is what happens after a user changes task state in the UI.

Without a single client mutation path, the same task can be represented differently in different places for a few seconds. A drag/drop action might patch the Kanban card but not the detail panel. A detail-panel claim might update local panel state but leave the card stale until polling. A subtask update might need to merge `parentUpdated`, but the local code path might only patch the child.

The frontend runtime exists to make those actions boring:

1. patch locally for immediate feedback where the mutation has a safe
   optimistic representation
2. call the API
3. merge the canonical response
4. roll back only fields that still carry this mutation's optimistic values if
   the request fails; newer external fields win
5. notify every React surface through one bridge

Canonical work-state updates are the explicit exception: they do not patch the
shared task list optimistically. This prevents a rejected request from erasing
an external update that happens to use the same work-state value but newer
details; the canonical response or the next authoritative refresh converges
the UI instead.

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
- render fatal bootstrap errors and degraded polling without clearing valid data

### Bootstrap Module

Since the canvas migration (T-340, ADR-0024) no vanilla runtime remains. The
former `js/app.js` bootstrap lives on as `src/bootstrap.js` — the first import
of `main.jsx`. It still owns:

- the initial `window.appState` shape
- Telegram WebApp auth + agentId resolution
- the `window.__flowboardBootstrap` promise the shell awaits before its first API call

The bootstrap module should not gain task mutation semantics.

## Runtime Contract

Every task mutation should follow the same sequence:

1. Read the current task snapshot from the runtime bridge.
2. Apply an optimistic patch to the shared local task list when the mutation
   contract allows it. Work-state PUTs deliberately skip this step.
3. Notify React immediately.
4. Send the API request.
5. Merge the canonical server response into shared state.
6. Merge related records such as `parentUpdated`.
7. On failure, roll back only unchanged optimistic fields (or perform an authoritative refresh); never restore a whole stale snapshot over a newer external task update. Work-state failures leave the shared task list untouched by the failed mutation.
8. Let background polling reconcile later as a safety net.

Polling is reconciliation. It is not the primary state propagation mechanism for a local action.

Polling is also transactional at the shell-snapshot boundary: projects, agents,
active project, and tasks are schema-validated before updates are committed.
Parallel core requests form one abort group, so one failure cancels its still-
running siblings. Polls and manual retries share one network-serial generation/
abort coordinator: replacement work starts only after the aborted request has
settled. Project navigation invalidates that coordinator and uses a separate
latest-wins task lane, so an older poll or task response cannot reset the viewed
project. Any failed request changes only the connection state; it cannot turn
the last successful project/task snapshot into an empty array. Bootstrap auth
failures outrank successful core responses until `/api/auth` itself recovers;
core failures are cleared only by a complete successful core snapshot, and a
task-only refresh cannot hide them.

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
- `dashboard/src/state/connectionState.mjs`
  - classifies auth, network, timeout, protocol, and server failures
  - derives loading/ready/empty/degraded shell states without mutating data
- `dashboard/src/utils/dashboardApi.js`
  - owns schema-validated projects, agents, status, tasks, and auth loaders
  - applies the shared API deadline and caller abort contract to every loader
  - rejects task responses missing canonical work-state fields or returning an indicator array before publication
- `dashboard/src/state/taskState.*`
  - pure operations for patch, merge, rollback, snapshots, and parent updates
- `dashboard/src/state/taskMutations.*`
  - API-backed mutation wrappers for task actions
  - applies optimistic patch first, then merges canonical responses or performs field-aware rollback
  - executes only explicit backend-provided transient-indicator POST actions; it never falls back to a work-state PUT
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

This order is intentional. It lets FlowBoard improve convergence without a large rewrite.

## Consequences

- Local actions should feel immediate even though the server remains canonical.
- Kanban cards, DetailPanel, active-agent surfaces, and counters should converge through one task list.
- Future React views get one documented state path instead of copying old global writes.
- The Canvas is React since T-340 (ADR-0024); its note/connection state is view-local by design, while task-facing Canvas work uses the same runtime foundation.
- WebSocket/SSE and larger state libraries remain later options, not prerequisites.

## Code

Current relevant files:

- `dashboard/src/bootstrap.js` - bootstrap-only state shape, Telegram auth, agent id resolution
- `dashboard/src/context/AppStateContext.jsx` - React bridge over global app state
- `dashboard/src/context/DashboardContext.jsx` - React-owned shell runtime and compatibility bridge
- `dashboard/src/components/DashboardConnectionState.jsx` - blocking initial state and degraded retry banner
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
