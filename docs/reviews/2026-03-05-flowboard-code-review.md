# FlowBoard Code Review — 2026-03-05

**Scope:** Full codebase review of `dev` branch (110 commits ahead of `main`)
**Files:** 15 source files, ~8,300 lines of code
**Focus:** Bugs, security, code quality, architecture, maintainability, vanilla JS assessment

---

## Summary

FlowBoard is a well-structured vanilla JS project management tool with three main features: Kanban board, File Explorer, and Idea Canvas. The codebase is clean and follows its own conventions (documented in CLAUDE.md) reasonably well. The dev branch adds two major features — subtask management and canvas promote-to-task flow — along with dozens of bug fixes for touch/mobile interactions.

**Overall health:** Good for a single-developer project at this scale. A few real bugs need attention, one XSS vulnerability should be fixed, and the cache-busting version system is the main source of fragility.

---

## 1. Bugs & Regressions

### CRITICAL

#### B-01: File delete uses `activeProject` instead of `viewedProject`
**File:** `app.js:306`
```js
const res = await fetch(`/api/projects/${state.activeProject}/files/${filePath}`, { method: 'DELETE' });
```
**Impact:** If a user views project B while project A is active, clicking delete on a file will delete from project A — not the viewed project B. This is a data-loss bug.
**Fix:** Change `state.activeProject` to `state.viewedProject`.

### HIGH

#### B-02: XSS in delete dialog for tasks with spec files
**File:** `kanban.js:665`
```js
`<strong>${id}</strong>: ${title}<br>This task has a spec file. Delete it too?`
```
The `title` variable is passed **unescaped** to `showModal()` body (which uses `innerHTML`). If a task title contains `<script>` or `<img onerror=...>` tags, they will execute. The subtask case on line 653 correctly uses `escHtml(title)`, but this branch does not.
**Fix:** Change `${title}` to `${escHtml(title)}`.

#### B-03: Module duplication via cache-bust version mismatch
**Files:** All canvas modules import `utils.js` with mismatched versions:
- `app.js`, `kanban.js`, `file-explorer.js`, `canvas/index.js` → `utils.js?v=5`
- `canvas/state.js`, `canvas/notes.js`, `canvas/toolbar.js`, `canvas/connections.js` → `utils.js?v=4`
- `canvas/clusters.js` → `utils.js?v=1`

**Impact:** ES modules are cached by full URL (including query params). The browser loads **three separate copies** of `utils.js`. This means:
- Triple the download size and memory for utils.js
- The `_displayNames` cache, `ICONS`, and `api()` function exist in 3 separate instances
- `registerDisplayNames()` called from app.js only populates the v=5 instance — canvas modules using v=4 would get `formatDisplayName` fallback behavior (though they currently don't call it, so no functional bug yet)

**Fix:** Align all imports to the same version param (currently `?v=5`).

Similar version mismatches exist in canvas cross-imports:
- `toolbar.js` is imported as `?v=10` in some files, but `notes.js` is imported as `?v=4` in some and `?v=2` in others
- `connections.js` is consistently `?v=3`

### MEDIUM

#### B-04: Context bar color logic is unreachable
**File:** `file-explorer.js:191`
```js
const color = pct > 80 ? 'var(--warn)' : pct > 100 ? 'var(--danger)' : 'var(--ok)';
```
The `pct > 100` branch can never execute because `pct > 80` catches it first. The danger threshold is dead code.
**Fix:** Reverse order: `pct > 100 ? 'var(--danger)' : pct > 80 ? 'var(--warn)' : 'var(--ok)'`

#### B-05: `setPriority` doesn't handle API failures
**File:** `kanban.js:631-647`
The function optimistically updates local state and DOM, then fires an API call. If the API fails, the local state is never reverted. Compare with `onDrop` (line 769) which correctly reverts on failure.

#### B-06: Race condition in refresh polling
**File:** `app.js:325-421`
`refresh()` makes 4 sequential API calls (projects, tasks, files, canvas). If the user calls `viewProject()` mid-refresh, the in-flight responses could apply stale data from the old project to the new one. No guard checks `state.viewedProject` consistency between calls.

#### B-07: Dead duplicate wheel listener
**File:** `events.js:54-60`
A second `wheel` listener (capture phase) is added to `wrap` at line 54, but the first capture-phase listener at line 37 already calls `e.stopPropagation()` for non-selected notes, preventing the second from firing. This is dead code and should be removed.

### LOW

#### B-08: `server.js` re-requires `fs` on line 138
```js
app.get('/', (req, res) => {
  const fs = require('fs');  // Already required at line 2
```
Harmless (Node caches requires) but indicates the code was added piecemeal.

#### B-09: Unused variable in `computePortPositions`
**File:** `connections.js:367`
```js
const n = group.length;  // never used
```

#### B-10: `refreshCanvas` clears selection but `renderAll` calls `renderPromoteButton` twice
**File:** `canvas/index.js:192-201`
`refreshCanvas()` calls `renderAll()` (which calls `renderPromoteButton()`), then calls `renderPromoteButton()` and `updateToolbar()` again. Double render is wasteful.

---

## 2. Security

### HIGH

#### S-01: XSS in modal body (see B-02)
Task title not escaped in one `startDelete` branch. See B-02 for details.

### MEDIUM

#### S-02: CORS wildcard when no origin configured
**File:** `server.js:98-100`
```js
} else {
  app.use(cors());
}
```
When `DASHBOARD_ORIGIN` is not set, CORS allows any origin with credentials. For local Jetson use this is acceptable, but if the server becomes reachable via tunnel, any website could make authenticated API calls. Consider defaulting to a restrictive CORS policy.

#### S-03: No text length limit on canvas notes
**File:** `server.js:1026`
POST/PUT canvas notes accept `text` of arbitrary length. A malicious or buggy client could store megabytes of text per note, eventually filling disk. Add a reasonable limit (e.g., 50KB).

#### S-04: File write size check uses string length, not byte length
**File:** `server.js:897`
```js
if (content.length > 100 * 1024) return res.status(413).json(...)
```
`content.length` is character count, not byte count. Multi-byte UTF-8 characters could produce files up to 4x the expected size. Use `Buffer.byteLength(content, 'utf8')` instead.

### LOW

#### S-05: Auth token expiry only checked on initData, not on JWT
The Telegram initData has a 1-hour staleness check (line 43), but JWTs are issued for 8 hours. If a user's access is revoked in ALLOWED_USER_IDS, existing JWTs remain valid until expiry. Acceptable for single-user but worth noting.

#### S-06: `JSON.stringify(localHostname)` injection in HTML
**File:** `server.js:140`
```js
html = html.replace('</head>', `<script>window.__LOCAL_HOSTNAME__ = ${JSON.stringify(localHostname)};</script></head>`);
```
`JSON.stringify` is safe for string values (escapes quotes and special chars), so this is not exploitable. But for defense-in-depth, consider using a CSP nonce or moving this to a data attribute.

---

## 3. Code Quality & Architecture

### Convention Violations

#### Q-01: Extensive `!important` usage in canvas.css
**Convention:** "No `!important` — use more specific selectors instead" (CLAUDE.md)
**Reality:** canvas.css uses `!important` at least 15 times (lines 20-48, 97, 102, 115, 125, 131, 375). These override styles from dashboard.css for note cards.
**Assessment:** The overrides are intentional (canvas notes need different styling from their dashboard.css base), but could be achieved with more specific selectors like `.canvas-viewport .note` instead of `.note { ... !important }`.

#### Q-02: Inline styles in JS
Several places use inline `style` attributes instead of CSS classes:
- `kanban.js:305` — card layout flex styles
- `kanban.js:803` — sort button styling
- `file-explorer.js:191` — context bar color
- `toolbar.js:743` — connection delete button positioning

Most of these are minor, but the pattern goes against the convention of keeping styles in CSS.

### Architecture

#### Q-03: State management is fragmented
Four separate state objects exist:
- `window.appState` (app.js) — global projects/tasks/currentTab
- `kanbanState` (kanban.js) — board UI state
- `canvasState` (state.js) — canvas UI state + data
- `fileState` (file-explorer.js) — file explorer UI state

Each follows different patterns. `window.appState` is the canonical data source, while module states are UI-only. This is documented and works, but the lack of any reactive update mechanism means manual `renderAll()`/`updateBoard()` calls are required everywhere.

#### Q-04: Circular imports in canvas modules
Documented as intentional in CLAUDE.md and working correctly via ES module live bindings. The dependency graph is:
- `notes.js` ↔ `toolbar.js`
- `connections.js` ↔ `toolbar.js`
- `clusters.js` → `connections.js` → `toolbar.js` → `notes.js`

This is functioning but makes the module boundaries less clear. No code change needed — just documenting for awareness.

#### Q-05: Long functions
Several functions exceed 100 lines and would benefit from extraction:
- `routePath()` — 213 lines, complex routing logic
- `updateBoard()` — 140 lines, board rendering
- `onTouchStart()` — 120 lines, touch event handling
- `renderFilePreview()` — 90 lines
- `renderIdeaCanvas()` — 117 lines (mostly HTML template)

### Code Cleanliness

#### Q-06: Inconsistent error handling patterns
- Some catch blocks: `catch { /* silent */ }` (22 occurrences)
- Some catch blocks: `catch (e) { console.warn(e); }` (8 occurrences)
- Some catch blocks: `toast('Failed...', 'error')` (12 occurrences)

There's no consistent policy for when to silently swallow, warn, or toast. Background saves (position, text) swallow silently which is reasonable. But some API failures that should surface to the user are also silently swallowed.

#### Q-07: `server.js` growing large
At 1,246 lines, `server.js` handles auth, middleware, 20+ API routes, file tree building, task management, canvas CRUD, promote bridge, and project context management. Consider extracting route groups into separate files (e.g., `routes/tasks.js`, `routes/canvas.js`, `routes/files.js`).

---

## 4. Maintainability & Scalability

### HIGH IMPACT

#### M-01: Cache-busting version system is fragile
The `?v=N` system requires manual version bumps in every importing file whenever a module changes. The current state proves this is error-prone:
- `utils.js` is imported with 3 different versions (v=1, v=4, v=5)
- `notes.js` is imported as v=2 and v=4 in different files
- `toolbar.js` is consistently v=10 (recent alignment)

**Recommendation:** Add a simple build step that generates a hash-based version from file content, or use a single version file that all imports reference. Even a shell script that `sed`s the version from `package.json` into all files would be more reliable.

#### M-02: No test coverage
0 tests for 8,300+ lines of code spanning server routes, state management, DOM manipulation, and complex algorithms (Manhattan routing, port stacking). Adding tests for at least:
1. Server API routes (Node test runner + supertest)
2. Task CRUD logic (nextTaskId, recalcParentStatus, enrichTasks)
3. Canvas routing algorithm (ptsToRoundedPath, routePath)
...would catch regressions and enable confident refactoring.

### MEDIUM IMPACT

#### M-03: Polling overhead on Jetson Nano
The 5-second refresh cycle makes 4 sequential API calls per tick (~48 requests/minute). Each call does synchronous file I/O (readFileSync for tasks.json, canvas.json, plus readdirSync for file tree). On the Jetson Nano's limited CPU/IO, this is noticeable.

**Mitigations to consider:**
- Only poll the active tab's data (skip canvas polling when on tasks tab)
- Use ETags or If-Modified-Since to skip unchanged responses
- Debounce refresh when user is interacting (partially done via `isUserInteracting()`)

#### M-04: Synchronous file I/O in server
All file operations use sync variants (`readFileSync`, `writeFileSync`, `readdirSync`). CLAUDE.md explicitly permits this for the single-user use case. If multi-user access is ever needed, these would need to become async to avoid blocking the event loop.

#### M-05: No data migration strategy
Tasks and canvas data are stored as JSON files with a specific schema (e.g., `subtaskIds`, `fromPort`, `toPort`). Schema changes require manual migration of existing project data. Consider adding a version field to `tasks.json` and `canvas.json`.

### LOW IMPACT

#### M-06: German comments in server.js
Lines 57, 70, 91, 102, etc. contain German comments (`// Auth nicht konfiguriert → offen lassen`, `// abgelaufen`, etc.). The rest of the codebase is in English. Consistency would help future contributors.

#### M-07: Magic numbers scattered throughout
Examples:
- `300` — double-tap timeout (events.js)
- `500` — long-press timeout (events.js)
- `60` — snap threshold (events.js)
- `40` — fit-to-notes padding (index.js)
- `50` — setTimeout for focus (kanban.js, used ~5 times)
- `5` — drag threshold (events.js)
- `3000` — promote poll interval (toolbar.js)
- `60000` — promote timeout (toolbar.js)

These should be named constants, at least the ones that appear multiple times.

---

## 5. Vanilla JS Assessment

### Current Status: Appropriate

At ~8,300 lines with 3 features (Kanban, File Explorer, Canvas), vanilla JS with ES modules is a **reasonable choice** for this project. The constraints support it:

- **No build step** = instant deploy on Jetson Nano (no `node_modules` bloat, no webpack)
- **Single user** = no complex state synchronization
- **Telegram Mini App** = framework overhead matters on mobile WebView
- **Canvas feature** = direct DOM/SVG manipulation is cleaner in vanilla JS than through framework abstractions

### Where Vanilla JS Shows Strain

1. **Manual re-rendering:** Every state change requires explicit `updateBoard()`, `renderConnections()`, `updateToolbar()` calls. Missing one causes stale UI. A lightweight reactive system would eliminate this class of bugs.

2. **Event delegation boilerplate:** The `data-action` + switch statement pattern in `bindKanbanEvents` (40 cases) and the canvas event handlers is essentially a hand-rolled event router. It works but it's verbose.

3. **Cache-bust version management:** The `?v=N` system is the most painful part of the no-build approach. It would be the #1 reason to add a minimal build step.

4. **Module boundaries blur:** Without TypeScript or JSDoc types, the interfaces between modules are implicit. The circular imports work but make refactoring risky.

### Recommendations

**Short term (no architecture change):**
1. Fix the 3 cache-bust version mismatches (B-03)
2. Add a script to auto-bump versions (e.g., `scripts/bump-version.sh`)
3. Add JSDoc `@typedef` for shared data shapes (task, note, connection)
4. Extract server.js routes into separate files

**Medium term (if codebase grows to 12,000+ lines):**
1. Add a minimal build step (esbuild or Rollup) for reliable cache-busting via content hashes
2. Introduce a tiny pub/sub event bus for state → UI updates (replace manual render calls)
3. Add TypeScript via JSDoc comments (zero build step required, just IDE support)
4. Add basic API tests with Node's built-in test runner

**Long term (if app fundamentally grows):**
1. Consider Lit or Preact for the Kanban/File Explorer (lighter than React, works with existing CSS)
2. Consider a dedicated canvas library (Konva.js) if the Idea Canvas gets significantly more complex
3. Consider SQLite instead of JSON files if data grows beyond 100 tasks/notes per project

---

## Prioritized Action Items

| Priority | ID | Issue | Effort |
|----------|------|----------------------------------------------|--------|
| P0 | B-01 | File delete uses wrong project | 1 line |
| P0 | B-02/S-01 | XSS in delete modal for spec tasks | 1 line |
| P1 | B-03 | Fix utils.js version mismatches | 10 min |
| P1 | B-04 | Fix context bar color logic order | 1 line |
| P1 | S-03 | Add text length limit to canvas notes API | 3 lines |
| P2 | B-05 | Add error handling to setPriority | 10 lines |
| P2 | B-07 | Remove dead wheel listener | 7 lines |
| P2 | S-04 | Use Buffer.byteLength for file write check | 1 line |
| P2 | Q-01 | Replace !important with specific selectors | 30 min |
| P3 | M-01 | Script or build step for cache-busting | 1 hour |
| P3 | M-02 | Add basic test coverage for server routes | 2-4 hours |
| P3 | Q-07 | Extract server.js routes into modules | 1-2 hours |
| P4 | M-03 | Optimize polling (tab-aware, ETags) | 2-3 hours |

---

## Appendix: Files Reviewed

| File | Lines | Notes |
|------|-------|-------|
| `server.js` | 1,246 | Express 5, 20+ routes, auth, file I/O |
| `app.js` | 538 | SPA shell, state, polling, tab routing |
| `kanban.js` | 876 | Task board, subtasks, drag-and-drop |
| `utils.js` | 139 | API helper, toast, modal, escHtml |
| `file-explorer.js` | 506 | File tree, preview, custom scrollbar |
| `canvas/index.js` | 216 | Canvas orchestrator, CSS injection |
| `canvas/state.js` | 107 | State, constants, coordinate helpers |
| `canvas/notes.js` | 491 | Note CRUD, markdown, editing, sidebar |
| `canvas/connections.js` | 810 | Manhattan routing, SVG, ports |
| `canvas/events.js` | 752 | Mouse, touch, wheel, pinch, lasso |
| `canvas/toolbar.js` | 733 | Toolbar, formatting, clipboard, promote |
| `canvas/clusters.js` | 134 | Cluster frames, promote buttons |
| `index.html` | 71 | SPA entry point |
| `dashboard.css` | 1,251 | Base styles, kanban, file explorer |
| `canvas.css` | 417 | Canvas-specific styles |

**Review date:** 2026-03-05
**Branch:** `dev` (commit `1861b03`)
**Reviewer:** Claude (automated code review)
