# FlowBoard Code Analysis v2

**Date:** 2026-03-03
**Scope:** Entire `dashboard/` codebase (post-refactor)
**Branch:** `dev` (commit `e42f04c`)
**Previous:** `docs/code-analysis-2026-03-03.md` — findings from that report are NOT repeated here

---

## What's Now Solid

The refactoring work since the initial analysis resolved the five critical issues identified. Confirming each:

### Canvas Module Split — Done Right
The 2832-line `idea-canvas.js` monolith is now 6 focused modules under `canvas/`. Module responsibilities are clean:
- `state.js` (107 lines) — pure state + coordinate math, no side effects
- `notes.js` (471 lines) — note CRUD, markdown, editing, sidebar
- `connections.js` (753 lines) — routing, SVG rendering, ports, drag
- `events.js` (737 lines) — all input handling, AbortController cleanup
- `toolbar.js` (692 lines) — floating toolbar, formatting, clipboard, promote
- `index.js` (161 lines) — orchestrator, CSS injection, public API

### Event Delegation — Correctly Implemented
All three modules expose `bind*Events(container)` functions attached once in `init()`:
- `bindKanbanEvents(content)` — click delegation with `data-action` switch, drag event delegation
- `bindFileExplorerEvents(content)` — click delegation for file tree and preview actions
- Canvas uses wrap-level delegation in `index.js` + dedicated handlers in `events.js`

Zero remaining inline `onclick="..."` in rendered HTML (the only `onclick` is in `renderDeleteBtn` which is dead code — see finding below).

### AbortController for Canvas Events — Working
`events.js:20-26` correctly creates a new `AbortController` on each `bindCanvasEvents()` call and aborts the previous one. The `document.addEventListener('keydown', ...)` at line 62 uses `{ signal }`. No more accumulating document-level handlers across tab switches.

### app.js Extraction — Clean
`index.html` is now 71 lines of pure HTML. All orchestration lives in `app.js` (511 lines). The `window._*` bridge pattern is documented in CLAUDE.md and justified — it provides cross-module coordination without the modules needing to know about app-level state.

### Task Update Whitelist — Implemented
`server.js:504-509` uses an explicit `ALLOWED` array `['title', 'status', 'priority', 'specFile', 'completed']` with a property-by-property copy loop. No more `Object.assign(task, body)`.

### Server Deduplication — Fixed
No duplicate functions or routes in `server.js`. The file is 982 lines, well-organized.

---

## New Findings

### 1. Event Delegation Implementation Quality

#### 1a. `renderDeleteBtn` is dead code with inline onclick
**File:** `dashboard/js/utils.js:103-105`
**Severity:** Low
**Finding:** The function generates `<button onclick="${onclick}">` — the only remaining inline onclick pattern. It's exported but **never called** anywhere in the codebase. All delete buttons now use `data-action="delete-task"` / `data-action="delete-file"` delegation.
**Fix:** Delete the `renderDeleteBtn` function and its export. ~3 lines.
**Effort:** 2 minutes.

#### 1b. File tree paths not HTML-escaped in data attributes
**File:** `dashboard/js/file-explorer.js:161,174`
**Severity:** Medium
**Finding:** File paths are interpolated directly into `data-path="${entry.path}"` without `escHtml()`. While project file paths are unlikely to contain `"` characters, a filename like `report"test.md` would break the HTML attribute and could theoretically enable attribute injection.
```js
// Line 161 — directory
html += `<div class="tree-item directory" ... data-action="toggle-dir" data-path="${entry.path}">`;
// Line 174 — file
html += `<div class="tree-item..." data-action="load-file" data-path="${entry.path}">`;
```
**Fix:** Use `escHtml(entry.path)` in both locations. The `data-path` attribute does need the raw path back, but `dataset.path` auto-unescapes HTML entities.
**Effort:** 2 minutes.

#### 1c. `cscrollWrap` doesn't pass AbortController signal
**File:** `dashboard/js/file-explorer.js:415`
**Severity:** Low
**Finding:** `cscrollWrap(el)` calls `_bindScroll(el, track, thumb)` without passing a signal (4th param). The `cscrollBind` function correctly creates and manages an AbortController (line 423-424), but `cscrollWrap` doesn't. Since `cscrollWrap` is only called once (for the content element) via `applyStaticScrollbars`, this doesn't cause accumulation, but it's inconsistent.
**Fix:** Add AbortController management to `cscrollWrap` or document the "once-only" invariant.
**Effort:** 10 minutes.

---

### 2. Module Boundaries & Circular Dependencies

#### 2a. Circular imports between canvas modules
**Files:** `canvas/notes.js`, `canvas/toolbar.js`, `canvas/connections.js`
**Severity:** Medium
**Finding:** There are two circular dependency cycles:
```
notes.js → toolbar.js → notes.js
connections.js → toolbar.js → connections.js
```
Specifically:
- `notes.js:6` imports `updateToolbar, renderPromoteButton` from `toolbar.js`
- `toolbar.js:7` imports `setNoteColor, setNoteSize, confirmDeleteNote, ...` from `notes.js`
- `connections.js:8` imports `renderPromoteButton, updateToolbar` from `toolbar.js`
- `toolbar.js:10` imports `renderConnections` from `connections.js`

This works at runtime because ES modules use live bindings and none of these imports are used during module evaluation (only in event handlers). But it's fragile — any future top-level initialization code that references a circularly-imported function will get `undefined`.

**Fix options (pick one):**
1. **Extract shared render triggers** — Create a `canvas/render.js` module that exports `renderAll()`, `renderConnections()`, `updateToolbar()`, `renderPromoteButton()` as thin wrappers. Other modules call these instead of importing each other directly. Breaks the cycle.
2. **Event-based decoupling** — Have notes/connections emit events (`canvas:notes-changed`, `canvas:selection-changed`) and let toolbar/connections subscribe. More robust but more infrastructure.
3. **Accept the status quo** — Document the circular deps in CLAUDE.md with the constraint "never use circularly-imported functions at module top level." Least effort.

**Effort:** Option 1: 1-2 hours. Option 3: 5 minutes.

#### 2b. `canvasState.selectedIds` replaced instead of mutated
**File:** `dashboard/js/canvas/toolbar.js:238,300`
**Severity:** Medium
**Finding:** `duplicateSelected()` and `pasteFromClipboard()` replace the Set:
```js
canvasState.selectedIds = newIds;  // line 238, 300
```
Everywhere else in the codebase uses `.add()`, `.delete()`, `.clear()` to mutate the existing Set. If any module caches a reference to `canvasState.selectedIds` (e.g., in a closure), the cached reference would become stale after this replacement. Currently no module does this, but it's a consistency violation and a future bug waiting to happen.
**Fix:** Replace `canvasState.selectedIds = newIds` with:
```js
canvasState.selectedIds.clear();
for (const id of newIds) canvasState.selectedIds.add(id);
```
**Effort:** 5 minutes.

---

### 3. Error Handling Completeness

#### 3a. `api()` doesn't distinguish success from server errors
**File:** `dashboard/js/utils.js:14-47`
**Severity:** Medium
**Finding:** The `api()` helper returns `res.json()` for ALL non-403 responses, including 404 and 500 errors. Client code must check the returned object for an `ok` field (which only exists when the server explicitly includes it). Example problem flow:
```
1. Client calls: const res = await api('/projects/foo/tasks/T-999', { method: 'DELETE' })
2. Server returns: 404 { error: 'Task not found' }
3. api() returns: { error: 'Task not found' } (no .ok field)
4. Client checks: if (res.ok) — undefined is falsy, so it correctly doesn't proceed
```
This accidentally works but is not robust. A server response of `{ ok: false, ... }` would also be falsy. And some callers don't check at all (see 3b).
**Fix:** Add a non-OK status check to `api()`:
```js
if (!res.ok) {
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (res.status !== 403) console.warn(`API ${res.status}:`, data.error);
  return data; // caller can check .error
}
return res.json();
```
Or return a wrapper: `{ ok: true, data }` / `{ ok: false, error }`.
**Effort:** 30 minutes (includes updating callers).

#### 3b. Fire-and-forget API calls with no error feedback
**Files:** Various
**Severity:** Low
**Finding:** Several API mutations are awaited but their error status is ignored:
- `kanban.js:311` — `saveTitle` calls `api(PUT)` but doesn't check the result
- `kanban.js:359` — `setPriority` calls `api(PUT)` without checking response
- `notes.js:109-111` — `repositionZeroNote` fires PUT with `.catch(() => {})`
- `notes.js:364-368` — `saveNoteText` PUT with `catch { /* silent */ }`

All of these are "optimistic update" patterns where the local state is already changed. The 5-second polling will eventually correct any discrepancy. This is acceptable for a single-user app, but the user gets no feedback on failure.
**Fix:** Consider adding a subtle toast on failure for save operations that the user explicitly triggered (saveTitle, setPriority). Leave position saves and auto-saves silent.
**Effort:** 15 minutes.

#### 3c. Silent catch blocks on server without logging
**File:** `dashboard/server.js:226,235,236`
**Severity:** Low
**Finding:** These `catch {}` blocks swallow file-read errors without any logging:
```js
try { fs.writeFileSync(BOOTSTRAP_FILE, ''); } catch {}          // line 226
try { rulesContent = fs.readFileSync(rulesPath, 'utf8'); } catch {}  // line 235
try { projectContent = fs.readFileSync(projectMdPath, 'utf8'); } catch {} // line 236
```
Per CLAUDE.md: "never use empty `catch {}`, at minimum `catch (e) { console.warn(e); }`".
**Fix:** Add `console.warn` to each. 3 one-line changes.
**Effort:** 2 minutes.

---

### 4. State Management Consistency

#### 4a. Undeclared `canvasState._nativeScroll` property
**File:** `dashboard/js/canvas/events.js:527,531,644,708`
**Severity:** Low
**Finding:** `canvasState._nativeScroll` is set and read in events.js but never declared in the initial state object in `state.js:26-40`. This makes the state shape non-obvious.
**Fix:** Add `_nativeScroll: false` to the `canvasState` declaration in state.js.
**Effort:** 1 minute.

#### 4b. Refresh polling mutates canvas state directly
**File:** `dashboard/js/app.js:358-359`
**Severity:** Low (intentional)
**Finding:** The refresh function directly sets `canvasState.notes = canvasData.notes || []` and `canvasState.connections = canvasData.connections || []`. This bypasses any canvas module encapsulation. It works because the polling code also calls `refreshCanvas()` which re-renders from the updated state.

This is documented behavior (polling is intentional per CLAUDE.md), but if a canvas module ever cached a reference to the `notes` or `connections` arrays, the cached reference would become stale.

**Fix:** Consider calling a `canvasState.setData(notes, connections)` function in state.js that handles the update. Low priority.
**Effort:** 15 minutes.

---

### 5. Performance & Memory

#### 5a. ResizeObserver and MutationObserver never disconnected
**File:** `dashboard/js/file-explorer.js:376-377`
**Severity:** Medium
**Finding:** Every call to `_bindScroll()` creates:
```js
new ResizeObserver(update).observe(scrollEl);
new MutationObserver(update).observe(scrollEl, { childList: true, subtree: true });
```
Neither observer is ever `.disconnect()`ed. When `cscrollBind()` is called again for the same element (e.g., switching between edit and preview modes), old observers continue running. Over many file switches, this accumulates observers.

The `cscrollBind()` function (line 419-430) removes the old track element and aborts the old AbortController for window-level listeners, but doesn't clean up observers.

**Fix:** Store observer references and disconnect them in `cscrollBind()` before creating new ones:
```js
function _bindScroll(scrollEl, track, thumb, signal) {
  // ... existing code ...
  const ro = new ResizeObserver(update);
  ro.observe(scrollEl);
  const mo = new MutationObserver(update);
  mo.observe(scrollEl, { childList: true, subtree: true });
  // Return cleanup handle
  return { update, ro, mo };
}
```
Then in `cscrollBind()`:
```js
if (trackHost._cscrollObservers) {
  trackHost._cscrollObservers.ro.disconnect();
  trackHost._cscrollObservers.mo.disconnect();
}
trackHost._cscrollObservers = _bindScroll(...);
```
**Effort:** 20 minutes.

#### 5b. `renderConnections()` called on every drag frame
**File:** `dashboard/js/canvas/events.js:262,675`
**Severity:** Low (known pattern, preserve per CLAUDE.md)
**Finding:** During note drag, `renderConnections()` is called on every mousemove/touchmove frame. This function:
1. Removes ALL SVG groups (`querySelectorAll('.conn-line-group').forEach(g => g.remove())`)
2. Removes ALL dynamic dots (`querySelectorAll('.conn-dot[data-dynamic]').forEach(d => d.remove())`)
3. Calls `computePortPositions()` which does `document.getElementById()` + `.offsetWidth` for every connection
4. Recreates all SVG paths and dots

With 20+ connections, this causes significant layout thrashing during drag. However, CLAUDE.md explicitly says "Connection routing algorithm — don't rewrite." The proper fix would be to only update connections involving the dragged note(s), but that's a selective optimization, not a rewrite.

**Partial fix (compatible with "don't rewrite"):** Add a `requestAnimationFrame` throttle so `renderConnections()` is called at most once per frame during drag. Currently it's called synchronously in the mousemove handler.
**Effort:** 15 minutes for rAF throttle.

#### 5c. Full note DOM rebuild on every render
**File:** `dashboard/js/canvas/notes.js:115-137`
**Severity:** Low
**Finding:** `renderNotes()` removes all `.note` elements (except the one being edited) and recreates them. There's no diffing. The kanban module (`kanban.js:56-164`) does proper diff-based updates — only creates new cards and updates existing ones.

For typical canvas usage (< 50 notes), this isn't a performance issue. It becomes noticeable only when combined with 5-second polling updates on the Ideas tab.

**Fix:** Implement a diff-based approach matching the kanban pattern. Low priority given note counts.
**Effort:** 1-2 hours.

---

### 6. Security

#### 6a. Unescaped file paths in HTML attributes
(Same as finding 1b — `file-explorer.js:161,174`)

#### 6b. No CSRF protection
**File:** `dashboard/server.js`
**Severity:** Low (unchanged from v1 analysis)
**Finding:** Cookie-based auth (`flowboard_session`) with `SameSite: 'none'` allows cross-origin requests. No CSRF token. In the Telegram WebApp context, the risk is minimal (WebView is sandboxed), but formally this is a gap.
**Fix:** Add `SameSite: 'strict'` or implement a CSRF token. However, this may break the Telegram WebApp flow which requires `SameSite: 'none'`.
**Effort:** Investigate compatibility first (30 min), then implement if feasible.

---

### 7. Vanilla JS Best Practices

#### 7a. Cache-busting version params are inconsistent
**Files:** All JS modules
**Severity:** Medium
**Finding:** The same file is imported with different `?v=N` values depending on who imports it:

| File | Imported as | By |
|------|------------|-----|
| `utils.js` | `?v=3` | app.js, canvas/* |
| `utils.js` | `?v=4` | kanban.js, file-explorer.js |
| `notes.js` | `?v=2` | canvas/index.js |
| `notes.js` | `?v=1` | events.js, toolbar.js |
| `connections.js` | `?v=2` | canvas/index.js |
| `connections.js` | `?v=1` | events.js, toolbar.js, notes.js |
| `toolbar.js` | `?v=2` | canvas/index.js |
| `toolbar.js` | `?v=1` | notes.js, connections.js |

The browser treats `utils.js?v=3` and `utils.js?v=4` as **different modules** (different specifiers = different module instances). This means the `_displayNames` cache in utils.js, the `ICONS` object, and all exports could exist in two separate instances. In practice, ES module loaders deduplicate by resolved URL, so if both resolve to the same file, the browser may or may not share the instance depending on the engine.

**Fix:** Normalize all version params per file. When a file changes, update ALL import statements referencing it. This is the #1 maintenance risk in the cache-busting system.
**Effort:** 15 minutes to align; ongoing discipline required.

#### 7b. CSS `--duration-fast` used but never defined
**File:** `dashboard/styles/dashboard.css:292,318,320`
**Severity:** Medium
**Finding:** Three declarations reference `var(--duration-fast)`:
```css
.spec-badge { transition: all var(--duration-fast); }       /* line 292 */
.priority-popover { animation: popIn var(--duration-fast) var(--ease-out); }  /* line 318 */
.priority-popover .priority-pill { transition: opacity var(--duration-fast); } /* line 320 */
```
But `--duration-fast` is never defined in `:root`. The existing timing variables are:
- `--duration-normal: 0.2s`
- `--duration-slow: 0.35s`

Without a definition, `var(--duration-fast)` resolves to the initial value (empty string), causing the transition/animation to have 0s duration (instant, no animation).

**Fix:** Add `--duration-fast: 0.12s;` to `:root` in dashboard.css.
**Effort:** 1 minute.

#### 7c. German text in user-facing strings
**Files:** `utils.js:41-42`, `file-explorer.js:36,61`
**Severity:** Low
**Finding:** Several user-facing strings are in German:
- `utils.js:41` — "Session abgelaufen" → "Session expired"
- `utils.js:42` — "Bitte über Telegram neu öffnen." → "Please reopen via Telegram."
- `file-explorer.js:36` — "Datei nicht gefunden" → "File not found"
- `file-explorer.js:61` — "Fehler beim Laden" → "Failed to load"

Server-side German comments (server.js) are less critical but worth noting for consistency.

**Fix:** Replace with English equivalents.
**Effort:** 5 minutes.

#### 7d. `--radius` duplicates `--radius-md`
**File:** `dashboard/styles/dashboard.css:29-33`
**Severity:** Nitpick
**Finding:** Both `--radius-md: 8px` and `--radius: 8px` are defined. `--radius` is used in 3 places (priority-popover), `--radius-md` is used everywhere else. One should be removed.
**Fix:** Replace `var(--radius)` usages with `var(--radius-md)` and remove the `--radius` variable.
**Effort:** 5 minutes.

#### 7e. `!important` count in CSS
**Files:** `dashboard.css`, `canvas.css`
**Severity:** Low (improved from v1)
**Finding:**
- `dashboard.css`: 17 `!important` usages — mostly in scrollbar hide (2), mobile media queries (5), and note editing overrides (7). The scrollbar `!important` is necessary (framework-level override). Mobile media queries use it for `display: flex !important` which is a common pattern.
- `canvas.css`: 8 `!important` usages — all for canvas-specific overrides of dashboard.css base styles (note backgrounds, dot opacity).

The root cause (identified in v1) is that `dashboard.css` defines base `.note` styles that `canvas.css` must override. Moving ALL note styles to `canvas.css` would eliminate the need.

**Fix:** Long-term: migrate `.note` base styles from dashboard.css to canvas.css. Low priority — the current approach works.
**Effort:** 1-2 hours.

#### 7f. Unused import in state.js
**File:** `dashboard/js/canvas/state.js:3`
**Severity:** Nitpick
**Finding:** `import { api, toast, ICONS } from '../utils.js?v=3'` — `ICONS` is imported but never used in state.js. Only `api` and `toast` are used.
**Fix:** Remove `ICONS` from the import.
**Effort:** 1 minute.

---

## Summary Table

| # | Finding | Severity | Effort | File(s) |
|---|---------|----------|--------|---------|
| 1a | Dead `renderDeleteBtn` with inline onclick | Low | 2 min | utils.js:103-105 |
| 1b | Unescaped file paths in data attributes | Medium | 2 min | file-explorer.js:161,174 |
| 1c | `cscrollWrap` missing AbortController | Low | 10 min | file-explorer.js:415 |
| 2a | Circular imports notes↔toolbar, connections↔toolbar | Medium | 5 min–2 hr | canvas/*.js |
| 2b | `selectedIds` replaced instead of mutated | Medium | 5 min | toolbar.js:238,300 |
| 3a | `api()` doesn't distinguish success from error | Medium | 30 min | utils.js:14-47 |
| 3b | Fire-and-forget API calls with no error feedback | Low | 15 min | kanban.js, notes.js |
| 3c | Silent catch blocks on server | Low | 2 min | server.js:226,235,236 |
| 4a | Undeclared `_nativeScroll` on canvasState | Low | 1 min | events.js, state.js |
| 4b | Polling mutates canvas state directly | Low | 15 min | app.js:358-359 |
| 5a | ResizeObserver/MutationObserver never disconnected | Medium | 20 min | file-explorer.js:376-377 |
| 5b | renderConnections on every drag frame (no throttle) | Low | 15 min | events.js:262,675 |
| 5c | Full note DOM rebuild on every render | Low | 1-2 hr | notes.js:115-137 |
| 6b | No CSRF protection | Low | 30 min+ | server.js |
| 7a | Cache-busting versions inconsistent across imports | Medium | 15 min | all JS |
| 7b | `--duration-fast` CSS variable never defined | Medium | 1 min | dashboard.css |
| 7c | German text in user-facing strings | Low | 5 min | utils.js, file-explorer.js |
| 7d | `--radius` duplicates `--radius-md` | Nitpick | 5 min | dashboard.css |
| 7e | `!important` overrides in canvas.css | Low | 1-2 hr | dashboard.css, canvas.css |
| 7f | Unused ICONS import in state.js | Nitpick | 1 min | state.js:3 |

**Quick wins (< 5 min each):** 1a, 1b, 3c, 4a, 7b, 7c, 7d, 7f — Total: ~20 minutes for 8 fixes.

**Medium effort (< 30 min):** 2b, 5a, 1c, 5b — Total: ~50 minutes for 4 fixes.

**Larger items:** 2a (circular deps), 3a (api error handling), 5c (note diffing), 7a (version params).

---

## Metrics

| Metric | Value | Assessment |
|--------|-------|------------|
| Total JS (Client) | ~3282 lines (6 canvas + app + kanban + file-explorer + utils) | Good — down from 4487 |
| Total JS (Server) | ~982 lines | Good — down from 1100 |
| Total CSS | ~1341 lines (dashboard: 971, canvas: 370) | Appropriate |
| Largest client file | canvas/connections.js: 753 lines | Acceptable |
| `!important` count (canvas.css) | 8 | Reduced from 15 in v1 |
| `!important` count (dashboard.css) | 17 | Acceptable (scrollbar + media query) |
| Silent `catch {}` blocks | 13 client, 7 server | 3 server blocks violate CLAUDE.md |
| Circular dependency cycles | 2 (notes↔toolbar, connections↔toolbar) | Document or fix |
| Observer leaks | 1 location (file-explorer scrollbar) | Fix |
| Dead code | 1 function (renderDeleteBtn) | Remove |
| German user-facing strings | 4 | Translate |
| `?v=N` inconsistencies | 3 files imported with mismatched versions | Fix |

---

*Report generated 2026-03-03. Analysis only — no code changes made.*
