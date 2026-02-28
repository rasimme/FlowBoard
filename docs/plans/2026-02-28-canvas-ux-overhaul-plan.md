# Canvas UX Overhaul — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Comprehensive UX improvements to the Idea Canvas — responsive dot-pattern, cleaner card layout, improved connections, color cascading, multi-select drag, card sizing, and overflow sidebar.

**Architecture:** All changes in `dashboard/js/idea-canvas.js` + `dashboard/styles/canvas.css` + `dashboard/server.js` (one route change). Vanilla JS, SVG, CSS only. No new dependencies. No new files.

**Tech Stack:** Vanilla JS, SVG (`<pattern>` + `<defs>`), CSS custom properties, Express.

**Key existing code you must understand:**
- `canvasState` (line 32–45 of idea-canvas.js): central state object with notes, connections, pan, scale, selectedIds, editingId, dragging, connecting, panning, lassoState
- `noteHTML(note)` (line 195): generates inner HTML — header (color-dot + note-id + delete-btn), body, 4 conn-dots
- `createNoteElement(note)` (line 212): creates the `.note` div, attaches click listener on `.note-body` → `startNoteEdit()`
- `onCanvasMouseDown(e)` (line 494): routes to drag (header only), selection (body), deselect+pan/lasso (empty canvas)
- `onCanvasMouseMove(e)` (line 565): handles drag, connection preview, pan, lasso
- `onCanvasMouseUp(e)` (line 644): ends drag (saves position), connection, pan, lasso
- `startConnectionDrag(e, noteId, port)` (line 1017): creates preview path, highlights ALL target dots green
- `saveConnection(fromId, toId)` (line 1053): saves + color inheritance only when target is yellow
- `manhattanPath(x1,y1,x2,y2)` (line 829): always does H→V→H routing
- `renderConnections()` (line 969): uses `computePortPositions()` → `getBestSides()` for port assignment
- `getConnectedComponent(startId)` (line 1119): BFS to find all connected note IDs (already exists)
- `setNoteColor(noteId, color)` (line 456): changes one note's color + persists via API
- CSS: `canvas.css` overrides `dashboard.css` — canvas.css is injected at module load, uses `!important`

---

## Task 1: SVG Dot-Pattern (replaces CSS background)

**Files:**
- Modify: `dashboard/styles/canvas.css:12-18` (remove background-image)
- Modify: `dashboard/js/idea-canvas.js:144-154` (add SVG pattern to `#canvasSvg`)

**Step 1: Remove CSS background-image from `.canvas-wrap`**

In `dashboard/styles/canvas.css`, change the `.canvas-wrap` rule to remove `background-image` and `background-size`:

```css
/* Dot-pattern background + visible frame */
.canvas-wrap {
  background-color: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-sizing: border-box;
}
```

**Step 2: Add SVG `<defs>` + `<rect>` pattern inside `#canvasSvg`**

In `dashboard/js/idea-canvas.js`, in the `renderIdeaCanvas()` function, change the `#canvasSvg` element in the HTML template (line 150) to include an inline `<defs>` and background `<rect>`:

Replace:
```html
<svg id="canvasSvg" class="canvas-svg canvas-svg-underlay"></svg>
```
With:
```html
<svg id="canvasSvg" class="canvas-svg canvas-svg-underlay">
  <defs>
    <pattern id="dotPattern" width="24" height="24" patternUnits="userSpaceOnUse">
      <circle cx="12" cy="12" r="1" fill="#3a3a45"/>
    </pattern>
  </defs>
  <rect width="10000" height="10000" x="-5000" y="-5000" fill="url(#dotPattern)"/>
</svg>
```

Do the same for the fallback SVG in the no-project state (line 160):
```html
<svg id="canvasSvg" class="canvas-svg canvas-svg-underlay">
  <defs>
    <pattern id="dotPattern" width="24" height="24" patternUnits="userSpaceOnUse">
      <circle cx="12" cy="12" r="1" fill="#3a3a45"/>
    </pattern>
  </defs>
  <rect width="10000" height="10000" x="-5000" y="-5000" fill="url(#dotPattern)"/>
</svg>
```

**Step 3: Verify**

Open the Ideas tab. The dot pattern should pan and zoom with the canvas viewport. Ctrl+scroll to zoom — dots should scale. Pan — dots should move with notes.

**Step 4: Commit**

```bash
git add dashboard/styles/canvas.css dashboard/js/idea-canvas.js
git commit -m "feat: replace CSS dot-pattern with SVG pattern that transforms with viewport"
```

---

## Task 2: Opaque Backgrounds + White Selection Border

**Files:**
- Modify: `dashboard/styles/canvas.css:5-47` (all color rules + selected rule)

**Step 1: Change `.note.selected` to white border (replace red glow)**

In `dashboard/styles/canvas.css`, replace the `.note.selected` rule (lines 5-9):

```css
/* Selection state — white border, no red glow */
.note.selected {
  outline: 2px solid #fff;
  outline-offset: 2px;
}
```

**Step 2: Change all note backgrounds from rgba to opaque**

In the same file, replace all `rgba(18, 20, 26, 0.85)` with `#12141a`:

```css
/* Outline-only note cards — override dashboard.css color fills */
.note {
  background: #12141a !important;
  border-width: 1.5px !important;
  border-left-width: 1.5px !important;
  border-style: solid !important;
}
.note.color-yellow {
  background: #12141a !important;
  border-color: var(--warn) !important;
}
.note.color-blue {
  background: #12141a !important;
  border-color: var(--info) !important;
}
.note.color-green {
  background: #12141a !important;
  border-color: var(--ok) !important;
}
.note.color-red {
  background: #12141a !important;
  border-color: var(--danger) !important;
}
.note.color-teal {
  background: #12141a !important;
  border-color: var(--accent-2) !important;
}
```

**Step 3: Verify**

Overlap two cards. No content bleed-through. Select a note — border should be white, not red glow.

**Step 4: Commit**

```bash
git add dashboard/styles/canvas.css
git commit -m "feat: opaque note backgrounds + white selection border"
```

---

## Task 3: Port Colors Match Card Colors + Connected Ports Stay Visible

**Files:**
- Modify: `dashboard/styles/canvas.css` (add port color rules + connected port rule)
- Modify: `dashboard/js/idea-canvas.js:969` (add connected port class in `renderConnections()`)

**Step 1: Add port-color-per-card CSS rules**

Append to `dashboard/styles/canvas.css`:

```css
/* Port color matches card border color */
.note.color-yellow .conn-dot { background: var(--warn); }
.note.color-blue   .conn-dot { background: var(--info); }
.note.color-green  .conn-dot { background: var(--ok); }
.note.color-red    .conn-dot { background: var(--danger); }
.note.color-teal   .conn-dot { background: var(--accent-2); }

/* Connected ports stay visible even without hover */
.conn-dot-connected {
  opacity: 1 !important;
}
```

**Step 2: Mark connected ports in `renderConnections()`**

In `dashboard/js/idea-canvas.js`, at the **start** of `renderConnections()` (line 969), after the `svg.querySelectorAll('.conn-line-group').forEach(g => g.remove());` line, add:

```js
// Clear old connected-port markers
document.querySelectorAll('.conn-dot-connected').forEach(d => d.classList.remove('conn-dot-connected'));
```

At the **end** of `renderConnections()`, after the `for (const conn of ...)` loop (after line 1013), add:

```js
// Mark ports that have connections as always-visible
const connectedNotes = new Set();
for (const conn of canvasState.connections) {
  connectedNotes.add(conn.from);
  connectedNotes.add(conn.to);
}
for (const noteId of connectedNotes) {
  const el = document.getElementById('note-' + noteId);
  if (!el) continue;
  el.querySelectorAll('.conn-dot').forEach(d => d.classList.add('conn-dot-connected'));
}
```

**Step 3: Verify**

Create a yellow note and a blue note. Ports on yellow note should be amber, blue note should be blue. Connect them — both notes' ports should remain visible after deselecting/unhovering.

**Step 4: Commit**

```bash
git add dashboard/styles/canvas.css dashboard/js/idea-canvas.js
git commit -m "feat: port colors match card colors + connected ports stay visible"
```

---

## Task 4: ⋮ Menu (replaces color-dot + delete button)

**Files:**
- Modify: `dashboard/js/idea-canvas.js:195-210` (`noteHTML()`)
- Modify: `dashboard/js/idea-canvas.js:3` (remove `renderDeleteBtn` import)
- Add new function: `toggleNoteMenu(e, noteId)` in idea-canvas.js
- Modify: `dashboard/styles/canvas.css` (add menu CSS)

**Step 1: Update `noteHTML()` — replace color-dot + delete-btn with ⋮ button**

In `dashboard/js/idea-canvas.js`, replace the `noteHTML()` function (lines 195-210):

```js
function noteHTML(note) {
  const rendered = renderNoteMarkdown(note.text || '');
  const noteWidth = note.size === 'medium' ? 280 : 160;
  return `
    <div class="note-header" data-noteid="${note.id}">
      <span class="note-id">${note.id}</span>
      <button class="note-menu-btn" onclick="window.toggleNoteMenu(event, '${note.id}')" title="Menu">⋮</button>
    </div>
    <div class="note-body">
      <div class="note-text md-content">${rendered || '<span style="opacity:0.3;font-size:11px">Double-click to add text\u2026</span>'}</div>
    </div>
    <div class="conn-dot conn-dot-top"    onmousedown="window.startConnectionDrag(event,'${note.id}','top')"></div>
    <div class="conn-dot conn-dot-right"  onmousedown="window.startConnectionDrag(event,'${note.id}','right')"></div>
    <div class="conn-dot conn-dot-bottom" onmousedown="window.startConnectionDrag(event,'${note.id}','bottom')"></div>
    <div class="conn-dot conn-dot-left"   onmousedown="window.startConnectionDrag(event,'${note.id}','left')"></div>`;
}
```

Note: the placeholder text changed from "Click to add text…" to "Double-click to add text…" to match the new click behavior (Task 5).

**Step 2: Remove `renderDeleteBtn` from import**

In `dashboard/js/idea-canvas.js` line 3, change:

```js
import { api, toast, showModal, escHtml, renderDeleteBtn } from './utils.js?v=3';
```
to:
```js
import { api, toast, showModal, escHtml } from './utils.js?v=3';
```

**Step 3: Add `toggleNoteMenu()` function**

Add this function after `toggleColorPopover()` (after line 454) in `dashboard/js/idea-canvas.js`:

```js
export function toggleNoteMenu(e, noteId) {
  e.stopPropagation();
  // Close any existing menu
  document.querySelectorAll('.note-menu-dropdown').forEach(m => m.remove());

  const note = canvasState.notes.find(n => n.id === noteId);
  if (!note) return;

  const menu = document.createElement('div');
  menu.className = 'note-menu-dropdown';

  // Color row
  const colorRow = document.createElement('div');
  colorRow.className = 'note-menu-section';
  colorRow.innerHTML = '<span class="note-menu-label">Color</span>';
  const swatchRow = document.createElement('div');
  swatchRow.className = 'note-menu-swatches';
  NOTE_COLORS.forEach(color => {
    const swatch = document.createElement('span');
    swatch.className = `color-swatch color-swatch-${color}${color === note.color ? ' selected' : ''}`;
    swatch.title = color;
    swatch.addEventListener('click', ev => {
      ev.stopPropagation();
      setNoteColor(noteId, color);
      menu.remove();
    });
    swatchRow.appendChild(swatch);
  });
  colorRow.appendChild(swatchRow);
  menu.appendChild(colorRow);

  // Size row
  const sizeRow = document.createElement('div');
  sizeRow.className = 'note-menu-section';
  sizeRow.innerHTML = '<span class="note-menu-label">Size</span>';
  const sizeBtns = document.createElement('div');
  sizeBtns.className = 'note-menu-sizes';
  ['small', 'medium'].forEach(size => {
    const btn = document.createElement('button');
    btn.className = `note-menu-size-btn${(note.size || 'small') === size ? ' active' : ''}`;
    btn.textContent = size.charAt(0).toUpperCase() + size.slice(1);
    btn.addEventListener('click', ev => {
      ev.stopPropagation();
      setNoteSize(noteId, size);
      menu.remove();
    });
    sizeBtns.appendChild(btn);
  });
  sizeRow.appendChild(sizeBtns);
  menu.appendChild(sizeRow);

  // Delete option
  const delBtn = document.createElement('button');
  delBtn.className = 'note-menu-delete';
  delBtn.textContent = 'Delete';
  delBtn.addEventListener('click', ev => {
    ev.stopPropagation();
    menu.remove();
    startDeleteNote(noteId);
  });
  menu.appendChild(delBtn);

  // Position below the menu button
  e.currentTarget.closest('.note-header').appendChild(menu);

  // Close on outside click or Escape
  setTimeout(() => {
    const close = ev => {
      if (!menu.contains(ev.target) && !ev.target.closest('.note-menu-btn')) {
        menu.remove();
        document.removeEventListener('click', close);
        document.removeEventListener('keydown', escClose);
      }
    };
    const escClose = ev => {
      if (ev.key === 'Escape') {
        menu.remove();
        document.removeEventListener('click', close);
        document.removeEventListener('keydown', escClose);
      }
    };
    document.addEventListener('click', close);
    document.addEventListener('keydown', escClose);
  }, 0);
}
```

**Step 4: Add placeholder `setNoteSize()` function**

Add this stub right after `setNoteColor()` (after line 470). Full implementation comes in Task 9:

```js
async function setNoteSize(noteId, size) {
  const note = canvasState.notes.find(n => n.id === noteId);
  if (!note) return;
  note.size = size;
  const el = document.getElementById('note-' + noteId);
  if (el) {
    el.classList.toggle('size-medium', size === 'medium');
    el.style.width = size === 'medium' ? '280px' : '';
  }
  renderConnections();
  if (!canvasState._state?.viewedProject) return;
  try {
    await api(`/projects/${canvasState._state.viewedProject}/canvas/notes/${noteId}`, {
      method: 'PUT', body: { size }
    });
  } catch { /* silent */ }
}
```

**Step 5: Register `toggleNoteMenu` on window**

Find where the existing window exports are set (search for `window.toggleColorPopover`). Add:

```js
window.toggleNoteMenu = toggleNoteMenu;
```

**Step 6: Add menu CSS**

Append to `dashboard/styles/canvas.css`:

```css
/* ⋮ Menu button */
.note-menu-btn {
  background: none;
  border: none;
  color: var(--muted);
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  padding: 0 4px;
  opacity: 0;
  transition: opacity var(--duration-normal);
}
.note:hover .note-menu-btn,
.note.selected .note-menu-btn {
  opacity: 0.6;
}
.note-menu-btn:hover {
  opacity: 1 !important;
  color: var(--text);
}

/* Dropdown menu */
.note-menu-dropdown {
  position: absolute;
  top: 28px;
  right: 0;
  z-index: 200;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 8px;
  min-width: 140px;
  box-shadow: var(--shadow-lg);
  animation: popIn var(--duration-normal) var(--ease-out);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.note-menu-section {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.note-menu-label {
  font-size: 10px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.note-menu-swatches {
  display: flex;
  gap: 6px;
}

.note-menu-sizes {
  display: flex;
  gap: 4px;
}

.note-menu-size-btn {
  background: transparent;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text);
  font-size: 11px;
  padding: 2px 8px;
  cursor: pointer;
  font-family: inherit;
}
.note-menu-size-btn.active {
  background: var(--border);
  color: var(--text-strong);
}
.note-menu-size-btn:hover {
  border-color: var(--text);
}

.note-menu-delete {
  background: none;
  border: none;
  border-top: 1px solid var(--border);
  color: var(--danger);
  font-size: 12px;
  padding: 6px 0 2px;
  cursor: pointer;
  text-align: left;
  font-family: inherit;
}
.note-menu-delete:hover {
  color: #ff4040;
}
```

**Step 7: Verify**

Hover a note — ⋮ button appears top-right. Click it — dropdown with Color swatches, Size toggle, Delete. Click a color swatch — card color changes, menu closes. Click outside or press Escape — menu closes.

**Step 8: Commit**

```bash
git add dashboard/js/idea-canvas.js dashboard/styles/canvas.css
git commit -m "feat: ⋮ menu replaces color-dot and delete button on notes"
```

---

## Task 5: Click Behavior Refactor (single-click=select, double-click=edit)

**Files:**
- Modify: `dashboard/js/idea-canvas.js:212-226` (`createNoteElement()`)
- Modify: `dashboard/js/idea-canvas.js:494-563` (`onCanvasMouseDown()`)
- Modify: `dashboard/js/idea-canvas.js:565-580` (`onCanvasMouseMove()` drag section)
- Modify: `dashboard/js/idea-canvas.js:644-651` (`onCanvasMouseUp()` drag section)
- Modify: `dashboard/js/idea-canvas.js:487-492` (`onCanvasDblClick()`)
- Modify: `dashboard/js/idea-canvas.js:731-816` (touch handlers)

**Step 1: Remove `.note-body` click listener from `createNoteElement()`**

Replace `createNoteElement()` (lines 212-226):

```js
function createNoteElement(note) {
  const el = document.createElement('div');
  el.id = 'note-' + note.id;
  el.className = `note color-${note.color || 'yellow'}${note.size === 'medium' ? ' size-medium' : ''}`;
  if (note.size === 'medium') el.style.width = '280px';
  if (canvasState.selectedIds.has(note.id)) el.classList.add('selected');
  el.style.left = note.x + 'px';
  el.style.top  = note.y + 'px';
  el.innerHTML = noteHTML(note);
  return el;
}
```

Key changes:
- Removed the `.note-body` click → `startNoteEdit()` listener (editing now via double-click)
- Added `size-medium` class support (for Task 9)

**Step 2: Refactor `onCanvasMouseDown()` — any click on `.note` starts potential drag**

Replace `onCanvasMouseDown()` (lines 494-563):

```js
function onCanvasMouseDown(e) {
  if (e.button !== 0) return;

  const connDot = e.target.closest('.conn-dot');
  if (connDot) return; // handled by startConnectionDrag inline handler

  // Ignore clicks on menu elements
  if (e.target.closest('.note-menu-btn') || e.target.closest('.note-menu-dropdown')) return;

  const noteEl = e.target.closest('.note');

  if (noteEl) {
    e.stopPropagation();
    const noteId = noteEl.id.replace('note-', '');
    const note   = canvasState.notes.find(n => n.id === noteId);
    if (!note) return;

    // Close any active edit on another note
    if (canvasState.editingId && canvasState.editingId !== noteId) {
      const ta = document.getElementById('note-ta-' + canvasState.editingId);
      if (ta) saveNoteText(canvasState.editingId, ta.value);
    }

    // If clicking inside a textarea (editing), don't start drag
    if (e.target.closest('.note-textarea')) return;

    // Start potential drag from anywhere on the note
    canvasState.dragging = {
      noteId,
      startMouseX: e.clientX, startMouseY: e.clientY,
      startNoteX: note.x,     startNoteY: note.y,
      moved: false
    };
    return;
  }

  // Empty canvas: deselect + start pan or Shift+lasso
  canvasState.selectedIds.clear();
  document.querySelectorAll('.note.selected').forEach(el => el.classList.remove('selected'));
  renderPromoteButton();

  // Close any active edit
  if (canvasState.editingId) {
    const ta = document.getElementById('note-ta-' + canvasState.editingId);
    if (ta) saveNoteText(canvasState.editingId, ta.value);
  }

  if (e.shiftKey) {
    const wrap = document.getElementById('canvasWrap');
    const rect = wrap.getBoundingClientRect();
    canvasState.lassoState = {
      startX: e.clientX - rect.left,
      startY: e.clientY - rect.top
    };
  } else {
    canvasState.panning = {
      startX: e.clientX, startY: e.clientY,
      startPanX: canvasState.pan.x, startPanY: canvasState.pan.y
    };
  }
}
```

Key changes:
- Any click on `.note` starts potential drag (not just header)
- Added `moved: false` flag to `dragging` state
- Removed immediate selection on mousedown (moved to mouseup)
- Added textarea guard to prevent drag from starting when editing

**Step 3: Add drag threshold (5px) to `onCanvasMouseMove()`**

In the drag section of `onCanvasMouseMove()` (lines 567-580), add a threshold check:

```js
  // Note drag
  if (canvasState.dragging) {
    const d = canvasState.dragging;
    const dx = (e.clientX - d.startMouseX) / canvasState.scale;
    const dy = (e.clientY - d.startMouseY) / canvasState.scale;
    const dist = Math.abs(e.clientX - d.startMouseX) + Math.abs(e.clientY - d.startMouseY);

    // Don't start moving until threshold exceeded
    if (!d.moved && dist < 5) return;
    d.moved = true;

    const note = canvasState.notes.find(n => n.id === d.noteId);
    if (note) {
      note.x = d.startNoteX + dx;
      note.y = d.startNoteY + dy;
      const el = document.getElementById('note-' + d.noteId);
      if (el) { el.style.left = note.x + 'px'; el.style.top = note.y + 'px'; }
      renderConnections();
    }
    return;
  }
```

**Step 4: Update `onCanvasMouseUp()` — select on click (not drag)**

Replace the drag-end section (lines 644-651):

```js
  // End note drag or click-to-select
  if (canvasState.dragging) {
    const { noteId, moved } = canvasState.dragging;
    canvasState.dragging = null;

    if (moved) {
      // Actual drag happened — persist position
      saveNotePosition(noteId);
    } else {
      // Click without drag — select/toggle
      const noteEl = document.getElementById('note-' + noteId);
      if (e.shiftKey) {
        // Shift+click: toggle selection
        if (canvasState.selectedIds.has(noteId)) {
          canvasState.selectedIds.delete(noteId);
          noteEl?.classList.remove('selected');
        } else {
          canvasState.selectedIds.add(noteId);
          noteEl?.classList.add('selected');
        }
      } else {
        // Plain click: select only this
        canvasState.selectedIds.clear();
        document.querySelectorAll('.note.selected').forEach(el => el.classList.remove('selected'));
        canvasState.selectedIds.add(noteId);
        noteEl?.classList.add('selected');
      }
      renderPromoteButton();
    }
    return;
  }
```

**Step 5: Add double-click on notes → edit**

Modify `onCanvasDblClick()` (line 487):

```js
function onCanvasDblClick(e) {
  if (e.target.closest('.canvas-toolbar')) return;

  // Double-click on a note → enter edit mode
  const noteEl = e.target.closest('.note');
  if (noteEl) {
    const noteId = noteEl.id.replace('note-', '');
    startNoteEdit(noteId);
    return;
  }

  // Double-click on empty canvas → create note
  const pos = screenToCanvas(e.clientX, e.clientY);
  createNoteAt(pos.x - NOTE_WIDTH / 2, pos.y - 20);
}
```

**Step 6: Update touch handlers for long-press (500ms) and double-tap (300ms)**

In `onTouchStart()` (line 731), add long-press timer and double-tap detection. Replace the single-touch branch:

Add a module-level variable before `onTouchStart` (near `_pinchDist`):

```js
let _pinchDist = 0;
let _longPressTimer = null;
let _lastTapTime = 0;
let _lastTapTarget = null;
```

Replace `onTouchStart()`:

```js
function onTouchStart(e) {
  e.preventDefault();
  clearTimeout(_longPressTimer);

  if (e.touches.length === 1) {
    const t = e.touches[0];
    const noteEl = document.elementFromPoint(t.clientX, t.clientY)?.closest?.('.note');

    if (noteEl) {
      const noteId = noteEl.id.replace('note-', '');
      const note   = canvasState.notes.find(n => n.id === noteId);
      if (!note) return;

      // Double-tap detection (300ms)
      const now = Date.now();
      if (_lastTapTarget === noteId && now - _lastTapTime < 300) {
        _lastTapTime = 0;
        _lastTapTarget = null;
        startNoteEdit(noteId);
        return;
      }
      _lastTapTime = now;
      _lastTapTarget = noteId;

      // Long-press detection (500ms) → edit
      _longPressTimer = setTimeout(() => {
        if (canvasState.dragging && !canvasState.dragging.moved) {
          canvasState.dragging = null;
          startNoteEdit(noteId);
        }
      }, 500);

      // Start potential drag
      canvasState.dragging = {
        noteId,
        startMouseX: t.clientX, startMouseY: t.clientY,
        startNoteX: note.x,     startNoteY: note.y,
        moved: false
      };

      // Select this note
      canvasState.selectedIds.clear();
      document.querySelectorAll('.note.selected').forEach(el => el.classList.remove('selected'));
      canvasState.selectedIds.add(noteId);
      noteEl.classList.add('selected');
      renderPromoteButton();
      return;
    }

    _lastTapTime = 0;
    _lastTapTarget = null;

    // Canvas pan
    canvasState.panning = {
      startX: t.clientX, startY: t.clientY,
      startPanX: canvasState.pan.x, startPanY: canvasState.pan.y
    };
  } else if (e.touches.length === 2) {
    clearTimeout(_longPressTimer);
    canvasState.panning = null;
    canvasState.dragging = null;
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    _pinchDist = Math.hypot(dx, dy);
  }
}
```

Update `onTouchMove()` to mark drag as moved and cancel long-press:

In the single-touch + dragging branch (line 767-776), add:

```js
    if (canvasState.dragging) {
      const d = canvasState.dragging;
      const dist = Math.abs(t.clientX - d.startMouseX) + Math.abs(t.clientY - d.startMouseY);
      if (!d.moved && dist < 5) return;
      d.moved = true;
      clearTimeout(_longPressTimer);
      const note = canvasState.notes.find(n => n.id === d.noteId);
      if (note) {
        note.x = d.startNoteX + (t.clientX - d.startMouseX) / canvasState.scale;
        note.y = d.startNoteY + (t.clientY - d.startMouseY) / canvasState.scale;
        const el = document.getElementById('note-' + d.noteId);
        if (el) { el.style.left = note.x + 'px'; el.style.top = note.y + 'px'; }
        renderConnections();
      }
    }
```

Update `onTouchEnd()` to clear long-press timer:

```js
function onTouchEnd(e) {
  clearTimeout(_longPressTimer);
  if (e.touches.length === 0) {
    if (canvasState.dragging) {
      const { noteId, moved } = canvasState.dragging;
      if (moved) {
        clearTimeout(canvasState.posSaveTimers[noteId]);
        saveNotePosition(noteId);
      }
    }
    canvasState.dragging = null;
    canvasState.panning  = null;
    _pinchDist = 0;
  }
}
```

**Step 7: Verify**

Mouse: single-click selects (white border). Click + drag moves. Double-click opens editor. Shift+click toggles multi-select.
Touch: Tap selects. Drag moves. Long-press (500ms) edits. Double-tap edits.

**Step 8: Commit**

```bash
git add dashboard/js/idea-canvas.js
git commit -m "feat: refactor click behavior — single-click selects, double-click edits"
```

---

## Task 6: Multi-Select Drag

**Files:**
- Modify: `dashboard/js/idea-canvas.js` (mousedown, mousemove, mouseup in drag sections)

**Step 1: Store start positions for all selected notes on drag start**

In `onCanvasMouseDown()`, in the noteEl branch where `canvasState.dragging` is set, add start positions for all selected notes. After the `canvasState.dragging = { ... }` assignment, add:

```js
    // If dragging a selected note, store start positions for all selected
    // If dragging an unselected note, it becomes the only selection
    if (!canvasState.selectedIds.has(noteId)) {
      canvasState.selectedIds.clear();
      document.querySelectorAll('.note.selected').forEach(el => el.classList.remove('selected'));
      canvasState.selectedIds.add(noteId);
      noteEl.classList.add('selected');
      renderPromoteButton();
    }

    // Store start positions for all selected notes
    canvasState.dragging.startPositions = new Map();
    for (const selId of canvasState.selectedIds) {
      const selNote = canvasState.notes.find(n => n.id === selId);
      if (selNote) {
        canvasState.dragging.startPositions.set(selId, { x: selNote.x, y: selNote.y });
      }
    }
```

**Step 2: Move all selected notes in `onCanvasMouseMove()`**

Replace the drag section in `onCanvasMouseMove()` to move all selected notes:

```js
  if (canvasState.dragging) {
    const d = canvasState.dragging;
    const dx = (e.clientX - d.startMouseX) / canvasState.scale;
    const dy = (e.clientY - d.startMouseY) / canvasState.scale;
    const dist = Math.abs(e.clientX - d.startMouseX) + Math.abs(e.clientY - d.startMouseY);

    if (!d.moved && dist < 5) return;
    d.moved = true;

    // Move all selected notes (multi-select drag)
    if (d.startPositions) {
      for (const [selId, startPos] of d.startPositions) {
        const selNote = canvasState.notes.find(n => n.id === selId);
        if (selNote) {
          selNote.x = startPos.x + dx;
          selNote.y = startPos.y + dy;
          const el = document.getElementById('note-' + selId);
          if (el) { el.style.left = selNote.x + 'px'; el.style.top = selNote.y + 'px'; }
        }
      }
    }
    renderConnections();
    return;
  }
```

**Step 3: Save all moved note positions in `onCanvasMouseUp()`**

In the drag-end `moved` branch, save positions for all selected notes:

```js
    if (moved) {
      // Persist positions for all moved notes
      if (canvasState.dragging?.startPositions) {
        for (const selId of canvasState.dragging.startPositions.keys()) {
          saveNotePosition(selId);
        }
      } else {
        saveNotePosition(noteId);
      }
    }
```

Wait — the dragging is already set to `null` before this. Fix: capture `startPositions` before clearing:

```js
  if (canvasState.dragging) {
    const { noteId, moved, startPositions } = canvasState.dragging;
    canvasState.dragging = null;

    if (moved) {
      // Persist positions for all moved notes
      if (startPositions) {
        for (const selId of startPositions.keys()) {
          saveNotePosition(selId);
        }
      } else {
        saveNotePosition(noteId);
      }
    } else {
      // Click without drag — select/toggle
      // ... (same as Task 5 Step 4)
    }
    return;
  }
```

**Step 4: Update touch drag similarly**

In `onTouchMove()` single-touch + dragging branch, apply the same multi-select logic:

```js
    if (canvasState.dragging) {
      const d = canvasState.dragging;
      const dist = Math.abs(t.clientX - d.startMouseX) + Math.abs(t.clientY - d.startMouseY);
      if (!d.moved && dist < 5) return;
      d.moved = true;
      clearTimeout(_longPressTimer);

      const dx = (t.clientX - d.startMouseX) / canvasState.scale;
      const dy = (t.clientY - d.startMouseY) / canvasState.scale;
      if (d.startPositions) {
        for (const [selId, startPos] of d.startPositions) {
          const selNote = canvasState.notes.find(n => n.id === selId);
          if (selNote) {
            selNote.x = startPos.x + dx;
            selNote.y = startPos.y + dy;
            const el = document.getElementById('note-' + selId);
            if (el) { el.style.left = selNote.x + 'px'; el.style.top = selNote.y + 'px'; }
          }
        }
      }
      renderConnections();
    }
```

In `onTouchEnd()`, save all moved positions:

```js
  if (canvasState.dragging) {
    const { noteId, moved, startPositions } = canvasState.dragging;
    if (moved) {
      if (startPositions) {
        for (const selId of startPositions.keys()) {
          clearTimeout(canvasState.posSaveTimers[selId]);
          saveNotePosition(selId);
        }
      } else {
        clearTimeout(canvasState.posSaveTimers[noteId]);
        saveNotePosition(noteId);
      }
    }
  }
```

**Step 5: Verify**

Select two notes with Shift+click. Drag one — both move together. Release — both positions saved.

**Step 6: Commit**

```bash
git add dashboard/js/idea-canvas.js
git commit -m "feat: multi-select drag — move all selected notes together"
```

---

## Task 7: Connection Preview Improvements

**Files:**
- Modify: `dashboard/js/idea-canvas.js:1017-1050` (`startConnectionDrag()`)
- Modify: `dashboard/js/idea-canvas.js:582-616` (`onCanvasMouseMove()` connecting section)
- Modify: `dashboard/styles/canvas.css:95-99` (remove/replace target highlight)

**Step 1: Preview line in source card color**

In `startConnectionDrag()` (line 1017), after creating the preview path element, set its stroke to the source note color:

```js
export function startConnectionDrag(e, noteId, port) {
  e.stopPropagation();
  e.preventDefault();
  const pt = getNoteDotPosition(noteId, port);
  if (!pt) return;
  const note = canvasState.notes.find(n => n.id === noteId);
  canvasState.connecting = { fromId: noteId, fromPort: port, fromPt: { x: pt.x, y: pt.y } };

  // Draw preview path in overlay SVG (above cards)
  const overlay = document.getElementById('canvasSvgOverlay');
  if (overlay) {
    const prev = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    prev.id = 'conn-preview';
    prev.setAttribute('class', 'conn-preview-path');
    prev.setAttribute('d', `M ${pt.x} ${pt.y}`);
    // Color preview line to match source card
    prev.style.stroke = COLOR_STROKE[note?.color] || 'var(--muted)';
    overlay.appendChild(prev);
  }

  // Show all target ports at normal size (no green highlight)
  document.querySelectorAll('.note').forEach(el => {
    if (el.id === 'note-' + noteId) return;
    el.querySelectorAll('.conn-dot').forEach(d => {
      d.classList.add('conn-dot-target-active');
    });
  });
}
```

Key changes:
- Added source color to preview path
- Replaced `conn-dot-target-highlight` with `conn-dot-target-active` (just visible, not green/scaled)

**Step 2: Remove green highlight CSS, add target-active and snap classes**

In `dashboard/styles/canvas.css`, replace the `.conn-dot-target-highlight` rule (lines 95-99):

```css
/* Target ports visible during connection drag (not highlighted) */
.conn-dot-target-active {
  opacity: 1 !important;
}

/* Nearest port grows during connection drag */
.conn-dot-snap {
  transform: translate(-50%, -50%) scale(1.5) !important;
}
```

**Step 3: Nearest port calculation + snap in `onCanvasMouseMove()`**

Replace the connecting section in `onCanvasMouseMove()` (lines 582-616):

```js
  // Connection drag — update preview path + nearest port snap
  if (canvasState.connecting) {
    const pos     = screenToCanvas(e.clientX, e.clientY);
    const fromPt  = canvasState.connecting.fromPt;
    let tx = pos.x, ty = pos.y;

    // Remove previous snap highlight
    document.querySelectorAll('.conn-dot-snap').forEach(d => d.classList.remove('conn-dot-snap'));

    // Find nearest port on any target note
    let nearestDot = null;
    let nearestDist = Infinity;

    document.querySelectorAll('.note').forEach(noteEl => {
      if (noteEl.id === 'note-' + canvasState.connecting.fromId) return;
      const targetId   = noteEl.id.replace('note-', '');

      ['top', 'right', 'bottom', 'left'].forEach(port => {
        const portPos = getNoteDotPosition(targetId, port);
        if (!portPos) return;
        const d = Math.hypot(pos.x - portPos.x, pos.y - portPos.y);
        if (d < nearestDist) {
          nearestDist = d;
          nearestDot = noteEl.querySelector(`.conn-dot-${port}`);
          tx = portPos.x;
          ty = portPos.y;
        }
      });
    });

    // Snap threshold: 60px canvas-space (~close enough to a card)
    if (nearestDist < 60 && nearestDot) {
      nearestDot.classList.add('conn-dot-snap');
    } else {
      // Not near any port — follow cursor freely
      tx = pos.x;
      ty = pos.y;
    }

    const prev = document.getElementById('conn-preview');
    if (prev && fromPt) {
      prev.setAttribute('d', manhattanPath(fromPt.x, fromPt.y, tx, ty));
    }
    return;
  }
```

**Step 4: Update `removeTempConnectionLine()` to clean up new classes**

In `removeTempConnectionLine()` (line 1041), update the cleanup:

```js
function removeTempConnectionLine() {
  const line = document.getElementById('conn-temp');
  if (line) line.remove();
  const prev = document.getElementById('conn-preview');
  if (prev) prev.remove();
  // Remove target port markers
  document.querySelectorAll('.conn-dot-target-active')
    .forEach(d => d.classList.remove('conn-dot-target-active'));
  document.querySelectorAll('.conn-dot-snap')
    .forEach(d => d.classList.remove('conn-dot-snap'));
}
```

**Step 5: Verify**

Start dragging a connection from a blue note. Preview line should be blue. Target ports show at normal size (no green). Move near a port — it grows (scale 1.5). Preview line snaps to the nearest port.

**Step 6: Commit**

```bash
git add dashboard/js/idea-canvas.js dashboard/styles/canvas.css
git commit -m "feat: connection preview in source color, nearest port snap, no green highlight"
```

---

## Task 8: Color Cascade on Connection

**Files:**
- Modify: `dashboard/js/idea-canvas.js:1053-1075` (`saveConnection()`)

**Step 1: Replace yellow-only inheritance with full cascade**

Replace the color inheritance section in `saveConnection()` (lines 1062-1067):

```js
async function saveConnection(fromId, toId) {
  if (!canvasState._state?.viewedProject) return;
  try {
    const res = await api(`/projects/${canvasState._state.viewedProject}/canvas/connections`, {
      method: 'POST', body: { from: fromId, to: toId }
    });
    if (res.ok && !res.duplicate) {
      canvasState.connections.push({ from: fromId, to: toId });

      // Color cascade: get target's color, apply to entire connected component
      const toNote = canvasState.notes.find(n => n.id === toId);
      if (toNote?.color) {
        const component = getConnectedComponent(fromId);
        for (const nodeId of component) {
          const n = canvasState.notes.find(x => x.id === nodeId);
          if (n && n.color !== toNote.color) {
            setNoteColor(nodeId, toNote.color).catch(() => {
              toast('Color cascade failed for ' + nodeId, 'warn');
            });
          }
        }
      }

      renderConnections();
      renderPromoteButton();
    }
  } catch {
    toast('Failed to save connection', 'error');
  }
}
```

The logic: when a connection is created, the **target note's color** is adopted by the entire connected component (which now includes both the source and target chains). This means dragging from A → B makes everything A's-color adopt B's color.

**Step 2: Verify**

Create 3 notes: A (yellow), B (blue), C (green). Connect A→B — both become blue. Connect B→C — all three become green.

**Step 3: Commit**

```bash
git add dashboard/js/idea-canvas.js
git commit -m "feat: color cascade — entire connected component adopts target note color"
```

---

## Task 9: Card Sizes (Server)

**Files:**
- Modify: `dashboard/server.js:950` (PUT allowed fields)
- Modify: `dashboard/server.js:927` (POST destructuring)

**Step 1: Add 'size' to allowed fields in PUT route**

In `dashboard/server.js` line 950, change:

```js
  const allowed = ['text', 'x', 'y', 'color'];
```
to:
```js
  const allowed = ['text', 'x', 'y', 'color', 'size'];
```

**Step 2: Add 'size' to POST route**

In `dashboard/server.js` line 927, change:

```js
  const { text = '', x = 0, y = 0, color = 'yellow' } = req.body;
```
to:
```js
  const { text = '', x = 0, y = 0, color = 'yellow', size = 'small' } = req.body;
```

And in the note object (line 928-934), add `size`:

```js
  const note = {
    id: nextNoteId(data.notes),
    text,
    x,
    y,
    color,
    size,
    created: new Date().toISOString().slice(0, 10)
  };
```

**Step 3: Commit**

```bash
git add dashboard/server.js
git commit -m "feat: server accepts 'size' field for canvas notes (small/medium)"
```

---

## Task 10: Card Sizes (Client CSS)

**Files:**
- Modify: `dashboard/styles/canvas.css` (add `.size-medium` rule)

**Step 1: Add medium size CSS**

Append to `dashboard/styles/canvas.css`:

```css
/* Card sizes */
.note.size-medium {
  width: 280px;
}
```

Note: The JS for `setNoteSize()` was already added as a stub in Task 4. The `createNoteElement()` changes were added in Task 5. This task only adds the CSS rule.

**Step 2: Verify**

Create a note. Click ⋮ → Size → Medium. Card widens to 280px. Connections re-render correctly.

**Step 3: Commit**

```bash
git add dashboard/styles/canvas.css
git commit -m "feat: medium card size (280px) selectable from ⋮ menu"
```

---

## Task 11: Max-Height with Fade + Truncation Indicator

**Files:**
- Modify: `dashboard/styles/canvas.css` (max-height, fade, indicator)
- Modify: `dashboard/js/idea-canvas.js` (truncation detection)

**Step 1: Add max-height + fade CSS**

Append to `dashboard/styles/canvas.css`:

```css
/* Max-height with fade for overflow */
.note-body {
  max-height: 200px;
  overflow: hidden;
  position: relative;
}
.note.size-medium .note-body {
  max-height: 300px;
}

/* Fade gradient at bottom when truncated */
.note-body.truncated::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 40px;
  background: linear-gradient(transparent, #12141a);
  pointer-events: none;
}

/* Ellipsis indicator */
.note-body.truncated::before {
  content: '⋯';
  position: absolute;
  bottom: 2px;
  left: 50%;
  transform: translateX(-50%);
  color: var(--muted);
  font-size: 14px;
  z-index: 1;
  pointer-events: none;
}
```

**Step 2: Add truncation detection in JS**

In `dashboard/js/idea-canvas.js`, add a `checkTruncation()` helper after `renderNoteMarkdown()`:

```js
function checkTruncation(noteEl) {
  const body = noteEl?.querySelector('.note-body');
  if (!body) return;
  if (body.scrollHeight > body.clientHeight + 2) {
    body.classList.add('truncated');
  } else {
    body.classList.remove('truncated');
  }
}
```

Call `checkTruncation()` in these places:

1. **After rendering notes** — at the end of `renderNotes()` (after line 254), add:
```js
  // Check truncation after DOM layout
  requestAnimationFrame(() => {
    for (const note of canvasState.notes) {
      checkTruncation(document.getElementById('note-' + note.id));
    }
  });
```

2. **After saving note text** — in `saveNoteText()` (after body innerHTML is set, around line 378), add:
```js
    checkTruncation(el);
```

**Step 3: Verify**

Create a note with a lot of text (10+ lines). The card should cap at 200px with a fade gradient and ⋯ indicator. Medium cards cap at 300px.

**Step 4: Commit**

```bash
git add dashboard/styles/canvas.css dashboard/js/idea-canvas.js
git commit -m "feat: max-height with fade gradient for long notes"
```

---

## Task 12: Overflow Sidebar (view/edit full text of truncated notes)

**Files:**
- Modify: `dashboard/js/idea-canvas.js` (sidebar HTML, open/close/switch/save logic)
- Modify: `dashboard/styles/canvas.css` (sidebar styles)

**Step 1: Add sidebar HTML to `renderIdeaCanvas()`**

In `renderIdeaCanvas()` (line 144), add the sidebar element inside `.canvas-wrap`, after the lasso div:

```js
  content.innerHTML = `
    <div class="canvas-wrap" id="canvasWrap">
      <div class="canvas-toolbar">
        <button class="btn btn-primary btn-sm" onclick="window.addNote()">+ Note</button>
      </div>
      <div class="canvas-viewport" id="canvasViewport">
        <svg id="canvasSvg" class="canvas-svg canvas-svg-underlay">
          <defs>
            <pattern id="dotPattern" width="24" height="24" patternUnits="userSpaceOnUse">
              <circle cx="12" cy="12" r="1" fill="#3a3a45"/>
            </pattern>
          </defs>
          <rect width="10000" height="10000" x="-5000" y="-5000" fill="url(#dotPattern)"/>
        </svg>
        <svg id="canvasSvgOverlay" class="canvas-svg canvas-svg-overlay"></svg>
      </div>
      <div class="canvas-lasso" id="canvasLasso"></div>
      <div class="canvas-sidebar" id="canvasSidebar">
        <div class="canvas-sidebar-header">
          <span class="canvas-sidebar-color-bar" id="sidebarColorBar"></span>
          <span class="canvas-sidebar-id" id="sidebarNoteId"></span>
          <button class="canvas-sidebar-close" onclick="window.closeSidebar()">✕</button>
        </div>
        <div class="canvas-sidebar-body">
          <textarea class="canvas-sidebar-textarea" id="sidebarTextarea"></textarea>
        </div>
      </div>
    </div>`;
```

**Step 2: Add sidebar state + open/close functions**

Add to `canvasState` (line 32):

```js
  sidebarNoteId: null,
```

Add to `resetCanvasState()`:

```js
  canvasState.sidebarNoteId = null;
```

Add these functions after `saveNoteText()`:

```js
function openSidebar(noteId) {
  const note = canvasState.notes.find(n => n.id === noteId);
  if (!note) return;
  canvasState.sidebarNoteId = noteId;

  const sidebar = document.getElementById('canvasSidebar');
  const colorBar = document.getElementById('sidebarColorBar');
  const noteIdEl = document.getElementById('sidebarNoteId');
  const textarea = document.getElementById('sidebarTextarea');
  if (!sidebar || !textarea) return;

  sidebar.classList.add('open');
  colorBar.className = `canvas-sidebar-color-bar sidebar-color-${note.color || 'yellow'}`;
  noteIdEl.textContent = note.id;
  textarea.value = note.text || '';
  textarea.focus();
}

export function closeSidebar() {
  const sidebar = document.getElementById('canvasSidebar');
  if (!sidebar) return;

  // Save current text before closing
  if (canvasState.sidebarNoteId) {
    const textarea = document.getElementById('sidebarTextarea');
    if (textarea) {
      saveNoteText(canvasState.sidebarNoteId, textarea.value);
    }
  }

  sidebar.classList.remove('open');
  canvasState.sidebarNoteId = null;
}

window.closeSidebar = closeSidebar;
```

**Step 3: Wire sidebar into double-click/edit logic**

Modify `startNoteEdit()` — if note body is truncated, open sidebar instead of inline edit:

At the top of `startNoteEdit()`, add a truncation check:

```js
export function startNoteEdit(id) {
  const el = document.getElementById('note-' + id);
  if (!el) return;
  const body = el.querySelector('.note-body');

  // If truncated, open sidebar instead of inline edit
  if (body?.classList.contains('truncated')) {
    openSidebar(id);
    return;
  }

  // If sidebar is open for another note, close it
  if (canvasState.sidebarNoteId) closeSidebar();

  if (canvasState.editingId === id) return;
  // ... rest of existing startNoteEdit() code
```

**Step 4: Sidebar saves on textarea blur and on Escape**

In `renderIdeaCanvas()`, after `bindCanvasEvents()`, add sidebar event binding:

```js
  // Sidebar textarea events
  const sidebarTa = document.getElementById('sidebarTextarea');
  if (sidebarTa) {
    sidebarTa.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Escape') closeSidebar();
    });
    sidebarTa.addEventListener('blur', () => {
      if (canvasState.sidebarNoteId) {
        saveNoteText(canvasState.sidebarNoteId, sidebarTa.value);
      }
    });
  }
```

**Step 5: Close sidebar on outside click**

In `onCanvasMouseDown()`, at the start of the empty-canvas branch (where selectedIds are cleared), add:

```js
  // Close sidebar when clicking empty canvas
  if (canvasState.sidebarNoteId) closeSidebar();
```

Also, when clicking a non-truncated note (in the `onCanvasDblClick` note branch), if the note is NOT truncated and sidebar is open, close it:

```js
  // In onCanvasDblClick, note branch:
  if (noteEl) {
    const noteId = noteEl.id.replace('note-', '');
    const body = noteEl.querySelector('.note-body');
    if (body?.classList.contains('truncated')) {
      openSidebar(noteId);
    } else {
      if (canvasState.sidebarNoteId) closeSidebar();
      startNoteEdit(noteId);
    }
    return;
  }
```

**Step 6: Add sidebar CSS**

Append to `dashboard/styles/canvas.css`:

```css
/* Overflow sidebar */
.canvas-sidebar {
  position: absolute;
  top: 0;
  right: 0;
  width: 320px;
  height: 100%;
  background: var(--card);
  border-left: 1px solid var(--border);
  z-index: 20;
  display: flex;
  flex-direction: column;
  transform: translateX(100%);
  transition: transform 0.2s ease-out;
}
.canvas-sidebar.open {
  transform: translateX(0);
}

.canvas-sidebar-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.canvas-sidebar-color-bar {
  width: 4px;
  height: 20px;
  border-radius: 2px;
}
.sidebar-color-yellow { background: var(--warn); }
.sidebar-color-blue   { background: var(--info); }
.sidebar-color-green  { background: var(--ok); }
.sidebar-color-red    { background: var(--danger); }
.sidebar-color-teal   { background: var(--accent-2); }

.canvas-sidebar-id {
  font-size: 11px;
  color: var(--muted);
  font-family: "JetBrains Mono", monospace;
  flex: 1;
}

.canvas-sidebar-close {
  background: none;
  border: none;
  color: var(--muted);
  cursor: pointer;
  font-size: 16px;
  padding: 4px;
  line-height: 1;
}
.canvas-sidebar-close:hover {
  color: var(--text);
}

.canvas-sidebar-body {
  flex: 1;
  padding: 12px;
  overflow: hidden;
}

.canvas-sidebar-textarea {
  width: 100%;
  height: 100%;
  background: transparent;
  border: none;
  outline: none;
  color: var(--text);
  font-size: 13px;
  line-height: 1.6;
  font-family: inherit;
  resize: none;
}
```

**Step 7: Verify**

Create a note with very long text. Double-click it — sidebar slides in from right with full text in editable textarea. Color bar matches card color. Press Escape or ✕ — sidebar closes, text saved. Click another truncated card — sidebar switches to that card.

**Step 8: Commit**

```bash
git add dashboard/js/idea-canvas.js dashboard/styles/canvas.css
git commit -m "feat: overflow sidebar for viewing/editing full text of truncated notes"
```

---

## Task 13: Manhattan Routing Fix for Top/Bottom Ports

**Files:**
- Modify: `dashboard/js/idea-canvas.js:829-863` (`manhattanPath()`)
- Modify: `dashboard/js/idea-canvas.js:969-1013` (`renderConnections()`)
- Modify: `dashboard/js/idea-canvas.js:582-616` (`onCanvasMouseMove()` connecting section)

**Step 1: Add `orientation` parameter to `manhattanPath()`**

Replace `manhattanPath()` (lines 829-863):

```js
/**
 * Returns an SVG path `d` string for a 3-segment Manhattan route.
 *
 * @param {number} x1  Source port X (canvas space)
 * @param {number} y1  Source port Y
 * @param {number} x2  Target port X
 * @param {number} y2  Target port Y
 * @param {"horizontal"|"vertical"} orientation  Routing direction based on source port side
 * @returns {string}   SVG path `d` attribute value
 */
function manhattanPath(x1, y1, x2, y2, orientation = 'horizontal') {
  const r   = CORNER_RADIUS;
  const dx  = x2 - x1;
  const dy  = y2 - y1;
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);

  // Degenerate: essentially straight — no bending needed
  if (adx < 2 || ady < 2) return `M ${x1} ${y1} L ${x2} ${y2}`;

  if (orientation === 'vertical') {
    // V→H→V routing (for top/bottom ports)
    const my  = (y1 + y2) / 2;
    const sx  = dx >= 0 ? 1 : -1;
    const sy  = dy >= 0 ? 1 : -1;

    const rv = Math.max(0, Math.min(r, ady / 2 - 2));
    const rh = Math.max(0, Math.min(r, adx / 2 - 2));

    if (rv < 1 || rh < 1) {
      return `M ${x1} ${y1} L ${x1} ${my} L ${x2} ${my} L ${x2} ${y2}`;
    }

    return [
      `M ${x1} ${y1}`,
      `L ${x1} ${my - sy * rv}`,
      `Q ${x1} ${my} ${x1 + sx * rh} ${my}`,
      `L ${x2 - sx * rh} ${my}`,
      `Q ${x2} ${my} ${x2} ${my + sy * rv}`,
      `L ${x2} ${y2}`
    ].join(' ');
  }

  // H→V→H routing (for left/right ports — default)
  const mx  = (x1 + x2) / 2;
  const sx  = dx >= 0 ? 1 : -1;
  const sy  = dy >= 0 ? 1 : -1;

  const rh = Math.max(0, Math.min(r, adx / 2 - 2));
  const rv = Math.max(0, Math.min(r, ady / 2 - 2));

  if (rh < 1 || rv < 1) {
    return `M ${x1} ${y1} L ${mx} ${y1} L ${mx} ${y2} L ${x2} ${y2}`;
  }

  return [
    `M ${x1} ${y1}`,
    `L ${mx - sx * rh} ${y1}`,
    `Q ${mx} ${y1} ${mx} ${y1 + sy * rv}`,
    `L ${mx} ${y2 - sy * rv}`,
    `Q ${mx} ${y2} ${mx + sx * rh} ${y2}`,
    `L ${x2} ${y2}`
  ].join(' ');
}
```

**Step 2: Pass orientation in `renderConnections()`**

In `renderConnections()`, the `computePortPositions()` already tracks which side each port is on. We need to retrieve the source side to determine orientation.

First, update `computePortPositions()` to also return the source side. Change the return type to include side info. In the `portMap` entry assignment (around line 955), also store the source side:

```js
      if (a.conn.from === noteId) {
        entry.ax = px;
        entry.ay = py;
        entry.sideA = side;
      } else {
        entry.bx = px;
        entry.by = py;
      }
```

Then in `renderConnections()`, when building the path (around line 988), determine orientation from the source side:

```js
    const orientation = (ports.sideA === 'top' || ports.sideA === 'bottom') ? 'vertical' : 'horizontal';
    const pathD = manhattanPath(ax, ay, bx, by, orientation);
```

**Step 3: Pass orientation in connection preview**

In `onCanvasMouseMove()` connecting section, determine orientation from the source port stored in `canvasState.connecting.fromPort`:

```js
    const fromPort = canvasState.connecting.fromPort;
    const orientation = (fromPort === 'top' || fromPort === 'bottom') ? 'vertical' : 'horizontal';

    const prev = document.getElementById('conn-preview');
    if (prev && fromPt) {
      prev.setAttribute('d', manhattanPath(fromPt.x, fromPt.y, tx, ty, orientation));
    }
```

**Step 4: Verify**

Create two notes stacked vertically (one above the other). Connect bottom port of top note to top port of bottom note. The connection should route V→H→V (vertical first, then horizontal, then vertical) instead of going sideways first.

**Step 5: Commit**

```bash
git add dashboard/js/idea-canvas.js
git commit -m "feat: Manhattan routing V→H→V for top/bottom ports"
```

---

## Task 14: Bump CSS Version + Final Cleanup

**Files:**
- Modify: `dashboard/js/idea-canvas.js:9` (CSS version bump)
- Modify: `dashboard/js/idea-canvas.js` (remove dead `toggleColorPopover` export/window binding)

**Step 1: Bump canvas.css version**

In `dashboard/js/idea-canvas.js` line 9, change:

```js
  _l.href = './styles/canvas.css?v=2';
```
to:
```js
  _l.href = './styles/canvas.css?v=3';
```

**Step 2: Remove `toggleColorPopover` from window exports**

The `toggleColorPopover()` function and its `window.toggleColorPopover` binding are no longer referenced (replaced by the ⋮ menu). Remove:
- The `toggleColorPopover()` function (lines 419-454)
- The `window.toggleColorPopover = toggleColorPopover;` line

**Step 3: Verify**

Hard-refresh the page. All features work: SVG dots, opaque cards, white selection, ⋮ menu, click/dblclick, multi-drag, port colors, cascade, sizes, sidebar, correct routing.

**Step 4: Commit**

```bash
git add dashboard/js/idea-canvas.js
git commit -m "chore: bump canvas.css version, remove dead toggleColorPopover"
```

---

## Summary of All Files Modified

| File | Tasks |
|------|-------|
| `dashboard/styles/canvas.css` | 1, 2, 3, 4, 7, 10, 11, 12 |
| `dashboard/js/idea-canvas.js` | 1, 3, 4, 5, 6, 7, 8, 11, 12, 13, 14 |
| `dashboard/server.js` | 9 |

## Dependency Order

Tasks must be implemented in order 1→14. Key dependencies:
- Task 4 (⋮ menu) creates `setNoteSize()` stub used by Task 10
- Task 5 (click refactor) adds `size-medium` class to `createNoteElement()` used by Tasks 10-11
- Task 11 (max-height) adds `.truncated` class used by Task 12 (sidebar)
- Task 13 (Manhattan fix) depends on `computePortPositions()` returning `sideA`

## Window Exports Checklist

After all tasks, these must be on `window`:
- `window.addNote`
- `window.startDeleteNote`
- `window.startConnectionDrag`
- `window.toggleNoteMenu` ← NEW (Task 4)
- `window.closeSidebar` ← NEW (Task 12)
- `window.promotePriorityPick` (set dynamically in promote modal)

Removed: `window.toggleColorPopover` (Task 14)
