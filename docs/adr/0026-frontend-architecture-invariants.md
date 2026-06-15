# ADR-0026: Frontend architecture invariants (post-React-migration)

## Status
Accepted

## Date
2026-06-15

## Source
- epic T-356 (window.appState → React contexts) and the review-followup T-355
- code: `dashboard/src/context/AppStateContext.jsx`, `DashboardContext.jsx`,
  `NavigationContext.jsx`; `dashboard/src/state/appStateBridge.mjs`,
  `taskState.mjs`, `taskMutations.mjs`; `dashboard/src/utils/apiFetch.js`;
  `dashboard/src/bootstrap.js`
- enforcement: `dashboard/test-runtime-guardrails.mjs`,
  `dashboard/test-dashboard-shell.js`
- builds on ADR-0019 (frontend runtime foundation), ADR-0024 (canvas → React)

## Context
The dashboard began as vanilla JS driving a global `window.appState` object and a
web of `window._*` function pointers / flags. The React migration (ADR-0024,
ADR-0019) and the T-356 cleanup moved ownership into React. The vanilla `js/`
runtime is gone; what remains must not regress back toward implicit globals,
because that is what made the UI fragile (silent no-ops on a typo, up-to-5s-stale
state via a polling watchdog, "set a flag on a tab that never mounted" bugs) and
hard to scale.

## Decision — the invariants
These are the rules every future change (human or agent) must keep. They are
**enforced by `test-runtime-guardrails.mjs`** (the gate fails on a regression),
not just documented.

1. **State lives behind `AppStateContext`.** `window.appState` is the underlying
   store but is **written only** by `AppStateContext` (`dispatch` →
   `Object.assign` + notify; the initial agents fetch) and by `bootstrap.js`
   (pre-React auth/agentId). Everywhere else, change state via `dispatch(...)`.
   Consumers read the **immutable snapshot** `useAppState().state` (a fresh object
   per change — identity is meaningful, memo works). No polling watchdog.

2. **Cross-view commands go through `DashboardContext`** (`useDashboard()`):
   `viewProject`, `switchTab`, `activateProject`, `deactivateProject`,
   `toggleSidebar`, `refreshProjectsOnly`, `openSpec`. No `window._viewProject` /
   `window._switchTab` / `window._openSpec` / … bridges.

3. **Cross-view navigation intents go through `NavigationContext`**
   (`useNavigation()`): `goToTask`, `goToNote`, `goToColumn`, `requestNewTask`,
   `requestNewNote`, `requestNewFile`. An intent persists until the target surface
   consumes and clears it (this is why a search result fired before its tab
   mounted no longer gets lost). No `window._scrollTo*` / `window._pendingNew*`
   flags.

4. **All API calls go through `apiFetch`/`apiJson`** (`src/utils/apiFetch.js`),
   which carries auth (session cookie + Telegram init-data). A bare
   `fetch('/api…')` 403s under the Telegram/JWT tunnel deployment. The **only**
   allowed raw `/api` fetch is `bootstrap.js` (the auth bootstrap, which runs
   before React and sets up the very header apiFetch later relies on).

5. **Pure modules stay pure.** `taskState.mjs` has no `window`/fetch; task list
   read/write goes through `appStateBridge.mjs` (ADR-0019). `taskMutations.mjs`
   is the task-**coordination** primitive layer (claim/release/complete/route +
   status/priority) used by the DetailPanel; the Kanban board hand-rolls list
   CRUD with its own optimistic+rollback logic next to the drag-and-drop UI.

## Consequences
- React owns the data; it is visible in devtools, free of polling, and a typo'd
  command is a compile/lint error instead of a silent global no-op.
- New cross-view behavior must pick the right context (command vs intent vs
  state) — there is no "just set a window flag" shortcut.
- The guardrail test is the contract: if you genuinely need a new exception
  (e.g. another pre-React bootstrap call), update the allow-list in
  `test-runtime-guardrails.mjs` deliberately, with rationale.
- The dashboard-shell E2E (`test-dashboard-shell.js`) exercises the real
  cross-view flows (project/tab switch, search→reveal, quick-actions, detail
  panel, trash/restore) and must grow with each new flow.

## Not covered (deliberate, tracked)
- `window.appState` is still the store object that `dispatch` mutates (React reads
  an immutable snapshot of it). Moving the store fully into a React reducer /
  external store — making `window.appState` a pure read-mirror — is a possible
  future step; it is optional and lower-priority now that the watchdog is gone
  and the snapshot is immutable.
- `window._detailPanelOpen` (write-only) and `window._detailQueue` are small
  remaining globals outside this ADR's scope.
