# ADR-0019: Frontend runtime foundation owns task UI state convergence

## Status
Accepted

## Date
2026-05-29

## Source
- private spec `specs/T-215-ui-state-convergence.md`
- runtime audit of `dashboard/js/app.js`, `dashboard/src/context/AppStateContext.jsx`, `dashboard/src/pages/TasksView.jsx`, and `dashboard/src/components/DetailPanel.jsx` during T-215-1

## Context

FlowBoard's backend architecture is already clear enough for current scale:

- Express 5 owns authentication, request validation, endpoint routing, and HTTP response shapes.
- HZL/SQLite owns canonical task state through an event log and materialized projections.
- React owns most dashboard views.
- Vanilla JS still owns the app shell bridge, parts of global state, and the Idea Canvas runtime.

The weak point is not the server model. The weak point is client-side state convergence after task mutations.

The dashboard grew from vanilla JS into React over time. `dashboard/js/app.js` still creates `window.appState`, runs project/task refreshes, and exposes shell behavior. React consumes that global state through `AppStateContext`. `TasksView` directly mutates `window.appState.tasks` for several actions. `DetailPanel` keeps local task state and then calls `refreshKanban()`, which expects `window.appState._refreshBoard`; the current shell does not define that bridge.

The visible symptoms are delayed or inconsistent task updates:

- drag/drop may move a card only after polling or may briefly disagree with server truth
- claiming or releasing a task from the detail panel may not update the board immediately
- DetailPanel and Kanban can disagree because they use different local update paths
- the 5 second poll can become the first visible update instead of a reconciliation safety net

Adding WebSocket/SSE or a global state library would not fix the root issue by itself. The first missing piece is a small, explicit frontend runtime contract.

## Decision

FlowBoard will introduce a small frontend runtime foundation for task UI state convergence.

The runtime foundation is the only supported path for new task UI mutations. It must:

- keep HZL/API responses as canonical truth
- apply optimistic local patches for immediate UI feedback
- merge canonical server responses into the shared client task list
- roll back local optimistic patches on failed requests
- notify React consumers consistently
- isolate `window.appState` behind a compatibility bridge while legacy code remains
- keep polling as background reconciliation only

The target module split is:

- `dashboard/src/state/appStateBridge.*` - the only adapter allowed to read/write `window.appState.tasks`
- `dashboard/src/state/taskState.*` - pure helpers for task patching, response merging, snapshots, parent updates, and rollback
- `dashboard/src/state/taskMutations.*` - mutation wrappers for claim, release, status, priority, trash/restore, create, and related task actions
- `dashboard/src/hooks/useTaskActions.*` - React-facing action API for `TasksView`, `DetailPanel`, and future React task surfaces

Until the bridge exists, existing direct writes remain legacy debt. After the bridge lands, new code must not mutate `window.appState.tasks` directly outside the bridge.

The Idea Canvas remains vanilla under ADR-0012 for now. Future Canvas migration work must use this runtime foundation for task-related state instead of inventing a second bridge.

## Consequences

- **Server remains canonical.** The frontend runtime may optimistically patch local state, but it must merge the server response after every mutation. It is not a second source of truth.
- **React becomes the task UI runtime owner.** React views should call runtime helpers or hooks rather than global shell functions.
- **Vanilla JS becomes compatibility infrastructure.** Legacy JS may bootstrap the shell and host Canvas, but new task mutation semantics belong in the runtime layer.
- **Polling changes role.** Polling remains useful for recovery from missed updates, other clients, and stale sessions. It must not be the primary visible update path for local user actions.
- **Direct global writes become a guarded anti-pattern.** Tests or static checks should fail future direct writes to `window.appState.tasks` outside the bridge once the migration is complete.
- **No realtime transport is introduced yet.** WebSocket/SSE may be revisited later for multi-client live updates, but the mutation contract is required first.
- **No large state-library migration is required now.** TanStack Query or Zustand may be evaluated later, after the local runtime contract is stable and the remaining pain is concrete.

## See also

- [Frontend Runtime concept](../concepts/frontend-runtime.md)
- [Kanban concept](../concepts/kanban.md)
- [Idea Canvas concept](../concepts/idea-canvas.md)
- ADR-0012 - Canvas migration deferred
- ADR-0014 - Canvas state in `canvas.json`
