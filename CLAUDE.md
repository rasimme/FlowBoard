# CLAUDE.md — FlowBoard Conventions

## Project Overview
FlowBoard is a project management tool with Kanban dashboard, File Explorer, and Idea Canvas.
Runs as Express server on NVIDIA Jetson Nano. Served as Telegram Mini App via Cloudflare Tunnel.

## Architecture Principles
- **Vanilla JS** — No frameworks, no build step, no bundler
- **ES Modules** — Native `import/export` in browser (`<script type="module">`)
- **No-Build Deploy** — Cache busting via `?v=N` query params (increment when file changes)
- **Single User** — Sync file I/O is acceptable on the server
- **Lazy Loading** — Only load what's needed

## File Structure
```
dashboard/
  server.js          — Express 5 backend (API + Auth + Static)
  index.html         — SPA shell (~70 lines, pure HTML)
  js/
    app.js            — Main app glue: state, routing, refresh polling, Telegram init
    kanban.js         — Kanban board module
    file-explorer.js  — File browser module
    utils.js          — Shared utilities (api(), escHtml(), ICONS, toast, showModal)
    canvas/           — Idea Canvas (split into 6 focused modules)
      index.js        — Orchestrator, CSS injection, public API re-exports
      state.js        — canvasState, constants, coordinate helpers, load/reset
      notes.js        — Note CRUD, markdown rendering, editing, sidebar, color/size
      connections.js  — Manhattan routing, port stacking, SVG rendering, save/delete
      events.js       — Mouse, touch, wheel, pinch-zoom, lasso, keyboard (AbortController)
      toolbar.js      — Floating toolbar, formatting commands, clipboard, promote flow
  styles/
    dashboard.css     — Base styles, Kanban, File Explorer, global theme variables
    canvas.css        — Canvas-specific styles (all canvas styles here, not in dashboard.css)
hooks/
  project-context/    — Loads project context on startup
  session-handoff/    — Handles session reset on project switch
docs/
  plans/              — Design docs and implementation plans (gitignored, local only)
```

## Global State Pattern
- **`window.appState`** — The single global app state object (projects, tasks, currentTab, viewedProject, etc.)
- Canvas modules access project context via `window.appState.viewedProject` (not via canvasState)
- **Never** add back-references to appState inside other state objects (no `canvasState._state` pattern)
- Each module has its own module-level state: `kanbanState`, `canvasState`, `fileState`

## Code Style

### JavaScript
- **camelCase** for functions and variables
- **Underscore prefix** (`_privateVar`) for module-private variables
- **Semicolons** — always
- **Indentation** — 2 spaces
- **State in JS objects** — never use DOM as source of truth
- **ES Module exports** — each module exports its public API explicitly
- **Error handling** — all API routes need try/catch with 500 response
- **Silent catch** — never use empty `catch {}`, at minimum `catch (e) { console.warn(e); }`

### CSS
- **CSS Custom Properties** — use `var(--name)`, never hardcode colors or values
- **No `!important`** — use more specific selectors instead
- **BEM-ish naming** — `.component-element` (e.g. `.note-body`, `.canvas-toolbar`)
- **Consistent spacing** — use theme variables (`--spacing-*`, `--radius-*`)
- **Dark theme only** — designed for Telegram Mini App dark mode
- **Canvas styles** — always go in `canvas.css`, never bleed into `dashboard.css`

### Naming
- CSS classes: `kebab-case`
- CSS IDs: `camelCase` (e.g. `canvasWrap`)
- JS functions: `camelCase`
- JS private vars: `_camelCase`
- Files: `kebab-case.js`

## Cache Busting (`?v=N`)
When modifying a JS or CSS file, increment its version in all import/script/link tags:
- `app.js?v=1` → change to `?v=2` in index.html
- `canvas/index.js?v=1` → change to `?v=2` in app.js AND canvas/index.js imports
- Rule: increment version in every file that references the changed file

## Server Patterns
- **Express 5** with async route handlers
- **Auth:** Telegram WebApp initData HMAC-SHA256 + JWT cookie (`flowboard_session`)
- **Input validation:** Always validate required fields, check path traversal with `path.resolve()` + `startsWith()`
- **Task mutations:** Use explicit property whitelist (`title`, `status`, `priority`, `specFile`, `completed`), never `Object.assign(task, body)` blindly
- **Security headers:** CSP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy — keep all
- **No duplicate routes/functions** — if a function exists, import it; don't copy-paste

## Event Listeners
- **AbortController** for all `document`/`window`-level event listeners in canvas modules
- `events.js` owns the `_canvasAbort` controller — abort and re-create on each `bindCanvasEvents()` call
- `cscrollBind()` in file-explorer.js manages its own controller per scroll container
- Element-level listeners (`el.addEventListener`) don't need AbortController — they're garbage collected with the element

## Git Conventions
- **Branch:** Develop on `dev`, `main` is stable. Never commit to `main` directly.
- **Commit messages:** Conventional (`feat:`, `fix:`, `docs:`, `refactor:`, `chore:`)
- **Keep commits atomic** — one concern per commit

## Privacy (MANDATORY)
- **Never hardcode** private domains, IPs, Telegram IDs, tokens, or hostnames
- **All configurable values** via environment variables
- **Scan commits** before push for personal data leaks
- Gitignored: `dashboard-data.json`, `.cloudflared/*.json`, `.env*`

## Known Patterns to Preserve
- **Polling refresh** (5s interval with JSON diff in app.js) — intentional, don't replace with WebSockets
- **Custom scrollbar** in file-explorer — complex but working, don't refactor
- **Connection routing algorithm** (Manhattan + rounded corners in connections.js) — don't rewrite
- **`?v=N` cache busting** — primitive but effective, keep it (see Cache Busting section above)
- **`window.*` bindings** in app.js — required for inline onclick handlers in dynamically rendered HTML; don't remove

## Testing
No test framework currently. When adding tests, prefer lightweight approaches (Node test runner or similar). No heavy test frameworks.
