# ADR-0012: Canvas migration deferred — vanilla retained pending scope review

## Status
Superseded by [ADR-0024](0024-canvas-react-migration.md)

## Date
2026-05-03

## Source
- code-comment invariant in operator's local `CLAUDE.md`: *"Canvas stays vanilla — do not convert"*
- conversation context recorded during T-199-7 triage: the canvas was deliberately excluded from the React migration (T-135 / T-137) because of scope and current priorities, not because vanilla is the architecturally correct end state
- public commits in the React migration epic landed view-by-view (T-137-x); the canvas was visibly absent from the migration order

## Context

When the dashboard's React migration started (T-135 strategic spec, T-137 epic), most surfaces — sidebar, header, file explorer, kanban board, detail panel — were migrated incrementally view-by-view. The canvas was deliberately left out of the migration order. The reason is *scope*, not architectural preference:

- **Logic complexity.** The canvas's interaction model (drag, snap, port-routing, connection-drawing with Manhattan-with-rounded-corners paths, cluster derivation from connection topology, multi-select with marquee, edit-in-place) is significantly heavier than any other dashboard surface. A direct port would touch every module in `dashboard/js/canvas/` (notes, connections, clusters, events, state, toolbar) and likely the styling system as well.
- **Working code.** The vanilla canvas works. The interaction model has been refined across many tasks (T-080..T-092 series for UX hardening, T-105 for promote-to-task). Replacing it carries regression risk in interactions that took weeks to tune.
- **Other priorities.** The active workstream is project-mode hardening (T-168, T-177, T-181, T-188, T-196, T-197), documentation infrastructure (T-200, T-199), and operational drift detection (T-197-8). Each of these has higher current value than reproducing existing canvas behavior in a different framework.

This is a deferral, not a rejection. The canvas is *temporarily* retained as vanilla because the migration is a sizeable batch of work that competes with higher-priority items. A future update can revisit the decision when the scope is more affordable or the cost of staying split is more visible.

## Decision

The Idea Canvas (`dashboard/js/canvas/`) remains vanilla ES modules for now. The React migration epic (T-137) does not include canvas migration in its scope. The local instruction file `CLAUDE.md` carries the marker *"Canvas stays vanilla — do not convert"* to prevent contributors from beginning a partial migration without an explicit decision to revisit this ADR.

The decision is explicitly **revisitable**. Triggers that should prompt a revisit:

- A canvas feature request that would be substantially easier with React component decomposition (e.g. an inspector panel deeply integrated with the rest of the React UI).
- A bug class that recurs because of the vanilla module-level state pattern (circular imports, ES module live bindings) being incompatible with new dashboard features.
- A concrete migration scope estimate that fits inside a planned sprint with acceptable regression risk.
- Tooling pressure (e.g. the build system stops supporting mixed vanilla + React in a way that's worth working around).

When any of those triggers fire, this ADR should be superseded by a follow-up ADR (`Status: Superseded by ADR-NNNN`) that records the new decision.

## Consequences

- **Two interaction patterns coexist in the dashboard.** Most of the UI uses React + Tailwind; the canvas uses vanilla ES modules with `data-action` event delegation, module-level state, and `dashboard.css` + `canvas.css` separately. Contributors moving between the two surfaces must be aware they have different conventions.
- **Canvas-specific features that need React components are blocked.** Anything that would naturally render as React components inside the canvas (e.g. a sticky-note editor with rich text, a connection-detail popover with a complex form) cannot be added cleanly today. Workaround: implement in vanilla using the same patterns as the rest of `dashboard/js/canvas/`. If the workaround feels prohibitive, that's a revisit trigger.
- **Build stays simple but split.** The Vite build covers React; vanilla canvas modules are loaded via `<script type="module">`. There is no compile step for canvas code, no bundling. This is a feature for canvas-specific edits (no rebuild between changes) and a constraint for anything that needs JSX or TypeScript.
- **The decision is fragile to *partial* migration.** If a contributor migrates one canvas module to React without revisiting this ADR, the result is worse than either pure approach: the team carries vanilla + React + the bridge between them. The `CLAUDE.md` marker is the guard against that failure mode; superseding ADRs require an explicit decision to commit to a full migration.
- **CSS stays partitioned.** `dashboard/styles/canvas.css` is canvas-specific; `dashboard/styles/dashboard.css` is everything else. This boundary is documented in `CLAUDE.md` and reflects the runtime split — Tailwind classes used in React components, hand-written CSS variables used in canvas. Mixing is not forbidden but discouraged until the migration is decided.
- **Revisit cost is bounded.** Because the canvas data model is simple (notes / connections / clusters in `canvas.json`, see ADR-0008's sibling decision-set in [Idea Canvas concept](../concepts/idea-canvas.md)), a future migration would touch the rendering layer only. Data persistence, the promote pipeline, and the API surface stay unchanged.

## See also

- [Idea Canvas concept doc](../concepts/idea-canvas.md) — captures the current vanilla architecture
- ADR-0007 — establishes the React-vs-vanilla split for the rest of the dashboard via the brain/muscle separation; this ADR is the canvas-shaped exception
