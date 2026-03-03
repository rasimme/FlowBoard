# CLAUDE.md — FlowBoard Conventions

## Project Overview
FlowBoard is a project management tool with Kanban dashboard, File Explorer, and Idea Canvas.
Runs as Express server on NVIDIA Jetson Nano. Served as Telegram Mini App via Cloudflare Tunnel.

## Architecture Principles
- **Vanilla JS** — No frameworks, no build step, no bundler
- **ES Modules** — Native `import/export` in browser (`<script type="module">`)
- **No-Build Deploy** — Cache busting via `?v=N` query params
- **Single User** — Sync file I/O is acceptable on the server
- **Lazy Loading** — Only load what's needed

## File Structure
```
dashboard/
  server.js          — Express 5 backend (API + Auth + Static)
  index.html         — SPA shell
  js/
    kanban.js         — Kanban board module
    idea-canvas.js    — Infinite canvas module
    file-explorer.js  — File browser module
    utils.js          — Shared utilities (api(), escHtml(), icons)
  styles/
    dashboard.css     — Base styles + Kanban + File Explorer
    canvas.css        — Canvas-specific styles
hooks/
  project-context/    — Loads project context on startup
  session-handoff/    — Handles session reset on project switch
docs/
  plans/              — Design docs and implementation plans
```

## Code Style

### JavaScript
- **camelCase** for functions and variables
- **Underscore prefix** (`_privateVar`) for module-private variables
- **Semicolons** — always
- **Indentation** — 2 spaces
- **State in JS objects** — never use DOM as source of truth
- **ES Module exports** — each module exports its public API explicitly
- **Error handling** — all API routes need try/catch with 500 response

### CSS
- **CSS Custom Properties** — use `var(--name)`, never hardcode colors
- **No `!important`** — use more specific selectors instead
- **BEM-ish naming** — `.component-element` (e.g. `.note-body`, `.canvas-toolbar`)
- **Consistent spacing** — use theme variables (`--spacing-*`, `--radius-*`)
- **Dark theme only** — designed for Telegram Mini App dark mode

### Naming
- CSS classes: `kebab-case`
- CSS IDs: `camelCase` (e.g. `canvasWrap`) — to be unified to kebab-case over time
- JS functions: `camelCase`
- JS private vars: `_camelCase`
- Files: `kebab-case.js`

## Server Patterns
- **Express 5** with async route handlers
- **Auth:** Telegram WebApp initData HMAC-SHA256 + JWT cookie (`flowboard_session`)
- **Input validation:** Always validate required fields, check path traversal with `path.resolve()` + `startsWith()`
- **Task mutations:** Use explicit property whitelist, never `Object.assign(task, body)` blindly
- **Security headers:** CSP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy — keep all

## Git Conventions
- **Branch:** Develop on `dev`, `main` is stable
- **Commit messages:** Conventional (`feat:`, `fix:`, `docs:`, `refactor:`, `chore:`)
- **Keep commits atomic** — one concern per commit

## Privacy (MANDATORY)
- **Never hardcode** private domains, IPs, Telegram IDs, tokens, or hostnames
- **All configurable values** via environment variables
- **Scan commits** before push for personal data leaks
- Gitignored: `dashboard-data.json`, `.cloudflared/*.json`, `.env*`

## Known Patterns to Preserve
- **Polling refresh** (5s interval with JSON diff) — intentional, don't replace with WebSockets
- **Custom scrollbar** in file-explorer — complex but working, don't refactor
- **Connection routing algorithm** (Manhattan + rounded corners) — extract but don't rewrite
- **`?v=N` cache busting** — primitive but effective, keep it

## Testing
No test framework currently. When adding tests, prefer lightweight approaches (Node test runner or similar). No heavy test frameworks.
