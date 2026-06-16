# Mobile & Touch

## What it is

FlowBoard's dashboard is a single responsive app that adapts to phones and touch input — the same URL, not a separate mobile build. It covers touch drag-and-drop, full-screen detail sheets, a master-detail Files view, and safe-area handling for notched devices.

## Why it exists

The dashboard is also reached as a [Telegram Mini App](auth-model.md) and from phones in general. Desktop interactions (hover affordances, mouse drag, side-by-side panels) don't translate to a small touchscreen, so the UI gates behavior on the input modality instead of shipping a parallel mobile codebase.

## How it works

- **Input gating** keys off `pointer:coarse` (not `hover:none`) so hybrid devices behave correctly, and touch targets meet a minimum size.
- **Drag-and-drop** is unified on **Pointer Events**: a press-and-hold grip starts a drag, and dragging near a viewport edge **auto-scrolls** the board or column so distant targets are reachable. The same code path serves mouse and touch.
- **Detail as a sheet:** on narrow screens the task detail and similar panels become full-screen sheets with an explicit back control, rather than cramped side panels.
- **Files master-detail:** the Files page shows the list first; tapping opens a full-screen preview with "← Files" to return. The breakpoint reacts to rotation/resize via `matchMedia`.
- **Canvas gestures:** one finger pans/drags, two fingers pinch-zoom, double-tap creates a note, long-press edits.
- **Safe area:** `viewport-fit=cover` plus `env(safe-area-inset-*)` keep content clear of notches and home indicators.

## Consequences

- New interactive UI should go through the shared Pointer-Events path and respect the coarse-pointer gating, not add a mouse-only handler.
- Behavior is documented for users in [Use FlowBoard on a phone or in Telegram](../guide/how-to/work-on-mobile.md).

## Where the code lives

- `dashboard/src/pages/TasksView.jsx` — pointer drag + edge auto-scroll, keyboard parity.
- `dashboard/src/pages/FilesView.jsx` — `matchMedia` master-detail.
- `dashboard/src/pages/CanvasView.jsx` — touch gestures.
- `dashboard/index.html` + `dashboard/styles/*.css` — viewport, safe-area, `pointer:coarse` gating.
