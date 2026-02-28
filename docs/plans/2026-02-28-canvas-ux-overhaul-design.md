# Canvas UX Overhaul — Design Document

**Goal:** Comprehensive UX improvements to the Idea Canvas — responsive dot-pattern, cleaner card layout, improved connections, color cascading, multi-select drag, card sizing, and overflow sidebar.
**Date:** 2026-02-28
**Architecture:** All changes in `dashboard/js/idea-canvas.js` + `dashboard/styles/canvas.css`. Vanilla JS, SVG, CSS only. No new dependencies.
**Tech Stack:** Vanilla JS, SVG (underlay/overlay pattern), CSS custom properties.

## Problem

The current canvas has several UX issues:
1. Dot-pattern is a static CSS background — doesn't scale/pan with canvas, provides no spatial orientation
2. Cards are slightly transparent (0.85 alpha) — content bleeds through on overlap
3. Single click enters edit mode — conflicts with drag, makes moving cards difficult
4. No multi-select drag — can't move groups of cards together
5. Connection ports are always red — don't match card colors
6. Connection preview highlights all target dots green — visually noisy
7. Preview line snaps to a fixed port instead of nearest port
8. Color inheritance only works when target is default yellow — no cascade through chains
9. All cards are 160px wide — long content makes cards extremely tall
10. No overflow handling — no way to view full text of long cards without scrolling the card itself

## Lösung

Ten improvements grouped into four areas: Canvas Background, Card Layout, Connections, and Content Overflow.

## Komponenten

### 1. SVG Dot-Pattern (replaces CSS background)

**Current:** CSS `background-image: radial-gradient(...)` on `.canvas-wrap` — static.

**New:** SVG `<pattern>` element inside `#canvasSvg` (underlay), covered by a `<rect>` with `fill="url(#dotPattern)"`. The pattern is defined in canvas-space coordinates, so it automatically transforms with the viewport (`translate + scale`).

```
<defs>
  <pattern id="dotPattern" width="24" height="24" patternUnits="userSpaceOnUse">
    <circle cx="12" cy="12" r="1" fill="#3a3a45"/>
  </pattern>
</defs>
<rect width="10000" height="10000" x="-5000" y="-5000" fill="url(#dotPattern)"/>
```

The oversized rect ensures dots cover the canvas even when panned far. The pattern scales naturally because the SVG viewport has `transform-origin: 0 0` and inherits the same `translate/scale` as note cards.

**Remove:** CSS `background-image` from `.canvas-wrap`.

### 2. Card Layout Redesign

#### 2a. Opaque Background
- Change `rgba(18, 20, 26, 0.85)` → `#12141a` (fully opaque) in all `.note.color-*` rules

#### 2b. Selection = White Border
- Replace red selection glow with `outline: 2px solid #fff; outline-offset: 2px`
- Remove `box-shadow` rgba red glow from `.note.selected`

#### 2c. ⋮ Menu (replaces color-dot + delete button)
- Remove `.note-color-dot` and `renderDeleteBtn()` from `noteHTML()`
- Add single `⋮` button top-right of `.note-header`
- On click: dropdown menu with:
  1. **Color** → color swatch row (reuse existing `NOTE_COLORS` + `color-swatch` pattern)
  2. **Size** → Small / Medium toggle
  3. **Delete** → triggers existing `startDeleteNote()`
- Menu closes on outside click or Escape
- Menu positioned absolutely below the ⋮ button

#### 2d. Click Behavior Refactor

**Current flow:**
- Click on `.note-header` → drag
- Click on `.note-body` → edit
- Shift+click → multi-select

**New flow:**
- **Single click** anywhere on note → select (white border)
- **Click + drag** anywhere on note → move card
- **Double-click** on note → enter edit mode (see Section 6 for truncation behavior)
- **Shift + click** → add/remove from multi-selection
- **Touch: long-press** (500ms) on note → enter edit mode (alternative to double-tap)
- **Double-tap** on note → also enters edit mode (both patterns supported)

**Implementation:**
- Remove `.note-body` click → `startNoteEdit()` listener from `createNoteElement()`
- In `onCanvasMouseDown`: any click on a `.note` starts potential drag (store `startMouseX/Y`)
- In `onCanvasMouseUp`: if mouse moved < 5px from start → it was a click (select), not a drag
- Add `dblclick` listener on notes → `startNoteEdit()`
- For touch: track `touchstart` timestamp; if `touchend` within 500ms and < 5px movement → tap. Two taps within 300ms → double-tap → edit. Hold > 500ms → long-press → edit.

#### 2e. Multi-Select Drag
- When dragging a note that is in `selectedIds` (and `selectedIds.size > 1`):
  - On drag start: store `{ startX, startY }` for ALL selected notes in a Map
  - On mousemove: apply delta to ALL selected notes (maintain relative positions)
  - On mouseup: `saveNotePosition()` for ALL moved notes
- Existing lasso selection (Shift+drag on empty space) already populates `selectedIds`

### 3. Connection Ports

#### 3a. Port Color = Card Color
- Add per-color port rules in CSS: `.note.color-yellow .conn-dot { background: var(--warn); }` etc.
- Remove any hardcoded port colors

#### 3b. Connected Ports Stay Visible
- After `renderConnections()`: for each connection, find the DOM port elements on source and target notes that correspond to the assigned sides, and add class `.conn-dot-connected`
- CSS: `.conn-dot-connected { opacity: 1; }` (always visible, in card color)
- Unconnected ports: remain hidden until hover (existing behavior)

#### 3c. Color Cascade on Connection
When `saveConnection(fromId, toId)` succeeds:
1. Get target note's color (`toNote.color`)
2. Call `getConnectedComponent(fromId)` — returns all note IDs in the chain
3. For each note in the component: `setNoteColor(noteId, toNote.color)`
4. This cascades through the entire connected graph

**No undo.** Deliberate design choice — keep it simple.

### 4. Connection Preview Improvements

#### 4a. Preview Line in Source Card Color
- In `startConnectionDrag()`: read source note's color, set `stroke` on `#conn-preview` to `COLOR_STROKE[sourceNote.color]`

#### 4b. No Green Highlight
- Remove `conn-dot-target-highlight` class addition from `startConnectionDrag()`
- Instead: show all 4 ports on nearby notes in their **card color** at small size (reuse hover state)

#### 4c. Nearest Port Grows Large
- In `onCanvasMouseMove` (connecting state): for each nearby note, compute distance from cursor to each of the 4 port positions
- The nearest port gets class `.conn-dot-snap` (scaled up, e.g. `scale(1.5)`)
- Other ports stay small
- Update on every mousemove during connection drag

#### 4d. Preview Line Snaps to Nearest Port
- Replace current side-center heuristic with: compute all 4 port positions for target note, find the one closest to cursor, snap preview line endpoint to that port

### 5. Card Sizes

#### 5a. Two Widths: Small (160px) and Medium (280px)
- Add `size` field to note data model: `"small"` (default) | `"medium"`
- `NOTE_WIDTH` becomes dynamic: read from `note.size`
- In `createNoteElement()`: set `style.width` based on `note.size`

#### 5b. Size Selection via ⋮ Menu
- Menu item "Size" with two options: "Small" / "Medium" (radio-style, current highlighted)
- On selection: `PUT /canvas/notes/:id` with `{ size: "small"|"medium" }`

#### 5c. API Change
- `PUT /canvas/notes/:id`: accept `size` field, persist to `canvas.json`
- `POST /canvas/notes`: accept optional `size` field (default: `"small"`)
- Missing `size` in old data → default to `"small"` (backward compatible)

### 6. Max-Height + Overflow Sidebar

#### 6a. Max-Height with Fade
- CSS: `.note-body { max-height: 200px; overflow: hidden; position: relative; }`
- CSS: `.note.size-medium .note-body { max-height: 300px; }`
- Fade gradient at bottom when truncated:
  ```css
  .note-body.truncated::after {
    content: '';
    position: absolute;
    bottom: 0; left: 0; right: 0;
    height: 40px;
    background: linear-gradient(transparent, #12141a);
    pointer-events: none;
  }
  ```
- Detect truncation: compare `scrollHeight > clientHeight` after render → add `.truncated` class + `⋯` indicator

#### 6b. Sidebar
- Slide-in panel from right edge of `.canvas-wrap`
- Width: 320px (or 40% on small screens, max 400px)
- Contains:
  - Header: color bar (top border in card color) + note ID + close button (✕)
  - Body: editable `<textarea>` with full note text
  - Footer: optional timestamp
- **Opens on:** double-click on truncated card (or long-press on touch)
- **Closes on:** close button, click outside, Escape, click on non-truncated card
- **Switches:** click on another truncated card → sidebar shows that card's content
- Edits save via existing `saveNoteText()` → `PUT /canvas/notes/:id`
- DOM: appended to `.canvas-wrap`, positioned `absolute; right: 0; top: 0; bottom: 0`

## Datenfluss

### Card Interaction
```
Single click → select (white border)
Click + drag (>5px) → move card(s)
Double-click → truncated? → sidebar edit : inline edit
Shift+click → toggle multi-select
Long-press (touch, 500ms) → same as double-click
```

### Connection
```
Mousedown on port → startConnectionDrag (preview in source color)
Mousemove → show 4 ports on nearby cards (small), nearest grows large
  → preview line snaps to nearest port
Mouseup on port → saveConnection → color cascade (target color to whole chain)
  → connected ports stay visible
```

### Multi-Select Drag
```
Drag selected card → store ALL selected start positions
Mousemove → apply delta to ALL selected
Mouseup → saveNotePosition for each
```

## Error Handling

| Fehler | Reaktion |
|--------|----------|
| Size field missing in old canvas.json | Default to `"small"` |
| Sidebar edit save fails | Toast warning, keep text in textarea |
| Color cascade API fails for one note | Continue for others, toast warning |
| Touch double-tap misdetected | 300ms threshold between taps |
| Truncation detection wrong after resize | Re-check on window resize + content change |

## Testing

Manual testing checklist:
1. Zoom in/out → dots scale with canvas
2. Pan → dots move with canvas
3. Overlap cards → no bleed-through
4. Select → white border
5. Single click → select only (no edit)
6. Drag → smooth movement
7. Double-click short card → inline edit
8. Double-click long card → sidebar opens
9. Shift+click → multi-select, drag → all move
10. ⋮ menu → color, size, delete
11. Connect A(red) → B(blue) → both blue, lines blue
12. Chain cascade: A-B-C connected, add D → all same color
13. Connection preview: source color line, nearest port grows
14. Connected ports visible, unconnected hidden on un-hover
15. Size toggle Small ↔ Medium via menu
16. Truncated card: fade gradient + ⋯ indicator
17. Sidebar: edit, save, close (button/outside/Escape)
18. Sidebar switches on clicking another truncated card
19. Touch: double-tap + long-press both work
20. Fire TV / Telegram WebApp compatibility

## Decisions

| Decision | Reasoning | Alternatives |
|----------|-----------|-------------|
| SVG pattern instead of CSS bg | Must transform with viewport | Canvas 2D, tiled divs |
| 2 sizes (160/280), not 3 | 400px too large for stickies | 3 sizes, free resize |
| Sidebar for overflow | Full text visible + editable | Collapse/accordion, modal |
| No undo for color cascade | YAGNI | Undo stack, confirmation |
| Double-click + long-press for edit | Standard canvas UX (Miro, FigJam) | Single-click edit |
| White selection border | Neutral with all card colors | Color-tinted glow |
| 300ms double-tap threshold | Standard mobile timing | 200ms, 500ms |
| Sidebar 320px | Enough for editing, doesn't dominate | Full-width, modal |
| Cascade via getConnectedComponent | Already exists for promote | Per-connection only |
