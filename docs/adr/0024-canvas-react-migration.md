# ADR-0024: Canvas migrated to React — logic-preserving port, no vanilla runtime left

## Status
Accepted

## Date
2026-06-12

## Source
- ADR-0012 revisit triggers: "a concrete migration scope estimate that fits inside a planned sprint" and the v5 goal of a single rendering stack
- epic T-340 (private workspace specs T-340 / T-340-1..-9) — migration plan, parity checklist, per-subtask specs
- code: `dashboard/src/pages/CanvasView.jsx`, `dashboard/src/components/canvas/`, `dashboard/src/utils/canvas*.mjs`, `dashboard/src/state/canvasStore.mjs` + `canvasMutations.mjs`

## Context

ADR-0012 deferred the canvas React migration on scope grounds and listed explicit revisit triggers. With the rest of the dashboard fully React (T-137 epic complete) the canvas was the last vanilla surface, and the split carried real costs: two interaction patterns, a `window.__showSpecifyStepper` bridge, an `owner: 'legacy'` special case in the view registry, and canvas features that needed React components staying blocked.

The interaction model (Manhattan routing with rounded corners, port stacking, snap-to-port, lasso, pinch zoom, list-continuation editing) had been tuned over many tasks (T-080..T-092, T-105). A from-scratch rewrite would have put weeks of tuning at risk — that risk was the original reason for the deferral.

## Decision

The canvas was ported to React as a **logic-preserving migration** (T-340):

- **Pure logic extracted verbatim.** Routing geometry, port stacking, cluster derivation, the note-markdown subset and the textarea formatting commands moved unchanged into parameterized modules (`src/utils/canvasGeometry.mjs`, `canvasGraph.mjs`, `canvasMarkdown.mjs`, `canvasTextFormat.mjs`, `canvasConstants.mjs`), each covered by unit tests written against the vanilla behavior first (red → green).
- **React owns rendering, state and events.** `CanvasView.jsx` + `components/canvas/` (NoteCard, ConnectionLayer, CanvasToolbar, NoteSidebar) render from a view-local reducer (`canvasStore.mjs`); API writes live in `canvasMutations.mjs` with the vanilla ordering (server-first create, optimistic-silent updates).
- **Interaction transients stay out of React state.** Pan/zoom/drag/connect write transforms directly via refs; committed changes go through the reducer; the connection drag preview is an imperative SVG path — re-renders are rAF-throttled. This mirrors the vanilla `applyTransform` pattern and keeps drag performance identical.
- **The server stayed untouched.** Canvas API, `canvas.json` persistence (ADR-0014) and the promote/Specify pipeline (ADR-0015/0016) are unchanged; only the trigger moved into React (`useSpecify()` instead of the window bridge).
- **All vanilla runtime files were removed** in one flip commit: `dashboard/js/` (canvas modules, `utils.js`), the `<script>` bootstrap (`js/app.js` → `src/bootstrap.js`, imported first by `main.jsx`), `js/project-selection.mjs` → `src/utils/projectSelection.mjs`, the dead `src/pages/IdeasView.jsx` experiment, the ViewShell legacy handoff and the `owner` field in the view registry.

**Deliberate deviation:** `styles/canvas.css` and the canvas section of `dashboard.css` remain. They are token-based (CSS custom properties) and now style the React components — the migration goal was a single *runtime*, not zero CSS files. Translating 400 working lines of tuned CSS into utility classes would have been parity risk without benefit.

This ADR supersedes ADR-0012.

## Consequences

- **One rendering stack.** Every dashboard view is a React component in `src/config/views.js`; ViewShell no longer special-cases an owner. Canvas features that need React composition (inspector panels, rich editors) are unblocked.
- **No more window bridges for the canvas.** `window.__showSpecifyStepper`, `window.appState.canvasNotes/canvasConnections` are gone; promote opens the stepper through `SpecifyContext`, and the stepper's PERSIST completion notifies the canvas via a `flowboard:canvas-reload` event.
- **Bootstrap is part of the bundle.** `src/bootstrap.js` (appState shape, Telegram auth, agentId resolution, `__flowboardBootstrap` promise) is the first import of `main.jsx` instead of a separate script tag; behavior and ordering guarantees are unchanged.
- **Parity is test-backed.** ~160 unit assertions pin the extracted logic to the vanilla behavior; a headless browser smoke (`test-canvas-browser-smoke.js`, Edge via puppeteer-core) covers create/edit/connect/cluster/lasso/promote/zoom end-to-end; the three pre-existing canvas promote tests pass unchanged.
- **Known canvas bugs were ported, not fixed.** Parity means same behavior; the open connection-routing issues in the backlog remain separate tasks.
- **The interaction code is intentionally less idiomatic in places** (imperative preview path, direct style writes during gestures). This is the price of keeping the tuned feel; the pattern is documented in `CanvasView.jsx`.

## See also

- ADR-0012 — the deferral this ADR supersedes
- ADR-0014 — canvas persistence (unchanged)
- ADR-0019 — frontend runtime foundation; the appStateBridge contract still covers tasks only
- [Idea Canvas concept](../concepts/idea-canvas.md)
