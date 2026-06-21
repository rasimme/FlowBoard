# Contributing

Thanks for helping improve FlowBoard!

## Where to start

- Browse [open issues](https://github.com/rasimme/FlowBoard/issues) — look for `good first issue` or `help wanted` labels
- Have a question? Open a [Discussion](https://github.com/rasimme/FlowBoard/discussions) instead of an issue

## Project structure

```
dashboard/
├── server.js           # Express 5 API + auth + project/task endpoints
├── index.html          # SPA shell (loads styles/dashboard.css + the Vite bundle)
├── src/
│   ├── components/     # React UI components (incl. components/canvas/)
│   ├── context/        # React state contexts + window.appState bridge
│   ├── pages/          # React-owned views (TasksView, CanvasView, …)
│   ├── state/          # Task/canvas runtime helpers + mutations
│   └── utils/          # Pure utility modules (geometry, markdown, …)
└── styles/
    ├── dashboard.css   # Global/dashboard styles
    └── canvas.css      # Canvas-specific styles
docs/
├── adr/                # Architecture Decision Records
├── concepts/           # Conceptual architecture docs
└── reference/          # API/env/reference docs
```

**Key conventions:**
- Backend: Express 5 API; HZL/SQLite is canonical task state
- Frontend: React is the dashboard UI runtime; the Idea Canvas is a React view (`src/pages/CanvasView.jsx`). The former vanilla `js/` runtime (canvas, app.js, utils.js) has been removed (ADR-0024).
- Modules are small and cohesive - one concern per file
- Dark theme, mobile-responsive
- Project knowledge is Markdown/JSON; operational task state lives in HZL/SQLite
- T-215 introduces `dashboard/src/state/` as the task-runtime helper boundary

## Frontend runtime rules

Task UI state has one intended mutation path. Read [Frontend Runtime](docs/concepts/frontend-runtime.md) and [ADR-0019](docs/adr/0019-frontend-runtime-foundation.md) before changing task UI state behavior.

- Do not add new direct writes to `window.appState.tasks` outside the runtime bridge.
- Use the task runtime helpers for new task actions once they exist.
- Apply optimistic UI changes through the runtime, then merge the canonical server response.
- Handle related server records such as `parentUpdated` explicitly.
- Treat polling as reconciliation only, not as the visible update path for local actions.
- The Canvas is React now (ADR-0024 supersedes ADR-0012); its notes/connections live in the DB (ADR-0025 supersedes ADR-0014) — read/write via the canvas API, never files or SQL.

### Architecture invariants (enforced) — read [ADR-0026](docs/adr/0026-frontend-architecture-invariants.md)

These are checked by `dashboard/test-runtime-guardrails.mjs`; the gate fails on a regression. **Do not reintroduce `window.*` globals — use the contexts:**

- **State** → the store is `src/state/appStore.mjs`; `window.appState` is a transparent Proxy over it (every write notifies React → no un-notified mutations, no watchdog). Change state via `dispatch` (`useAppState`); read the immutable snapshot `state`.
- **Commands** (view/tab/project/spec) → `useDashboard()`. No `window._viewProject`/`_switchTab`/`_openSpec`/… bridges.
- **Navigation intents** (scroll-to/new-x) → `useNavigation()`. No `window._scrollTo*`/`_pendingNew*` flags.
- **API** → always `apiFetch`/`apiJson` (carries auth). A bare `fetch('/api…')` 403s under tunnel auth; only `bootstrap.js` may call it raw.
- New cross-view flows: add a check to the dashboard-shell E2E (`dashboard/test-dashboard-shell.js`).

## Design tokens & styling

CSS custom properties in `styles/dashboard.css` are the single source of truth for colors, shadows, radii and durations; `tailwind.config.js` only maps them to utility classes.

- **Tailwind preflight is disabled** (it would conflict with legacy `dashboard.css`). Raw HTML elements keep browser defaults — every `<button>`, `<input>` etc. in React components must set its background, border and margin classes explicitly.
- Reference tokens, don't hardcode values. New colors/shadows start as a `--token` in `dashboard.css`, then get a mapping in `tailwind.config.js` if needed.
- A `var(--token)` without a fallback must be defined in `styles/*.css` — `test-design-tokens-drift.js` (part of `npm test`) fails otherwise. Runtime-injected variables must always carry a fallback value.
- Tailwind opacity modifiers (`bg-accent/50`) don't work with CSS-variable colors; use explicit `-subtle`/`-hover` token variants.

## Development workflow

```bash
# 1. Fork and clone
git clone https://github.com/YOUR_USERNAME/FlowBoard.git
cd FlowBoard

# 2. Create a feature branch off dev
git checkout dev
git pull origin dev
git checkout -b feat/my-change

# 3. Run locally
cd dashboard
npm install
node server.js
# → http://localhost:18790

# 4. Make changes, test, commit
git commit -m "feat: my change"

# 5. Push and open PR against dev
git push origin feat/my-change
```

## Branch strategy

- **`main`** — stable releases only
- **`dev`** — active development, PRs target this branch
- Feature branches off `dev`: `feat/...`, `fix/...`, `docs/...`

## Pull requests

- Keep PRs focused (one topic per PR)
- Include screenshots for UI changes
- Mention what platform you tested on (desktop / mobile / both)
- Reference related issues: `Closes #123`

## Release gates

Before publishing a release, run:

```bash
npm run release:check
```

That gate includes privacy scanning, plugin packaging lint, the built-artifact
OpenClaw install canary, dashboard tests, and the dashboard build.

After publishing to ClawHub, run the live registry canary once:

```bash
npm run release:postpublish-canary -- flowboard@x.y.z
```

This installs the published ClawHub artifact into a temporary `OPENCLAW_HOME`
and catches registry/install-path drift that local package checks cannot see.

## Code style

- No semicolons (project convention)
- `const` over `let`, no `var`
- Descriptive function/variable names
- Avoid adding dependencies unless there's a clear, significant win
- User-facing UI strings (labels, buttons, empty states, toasts, preset names,
  notifications) **and** agent-facing API messages are **English only** — no
  German or other localized strings in shipped UI/API copy

## Commit conventions

- Conventional-commit style: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`
- Do **not** add AI co-author trailers (`Co-Authored-By: Claude …` or similar) —
  commits use owner-only attribution

## Documentation discipline

If your patch introduces or changes an architectural decision (new endpoint, new convention, default-behaviour change, new agent type, new hook event, removed concept), write an ADR under `docs/adr/` and update the relevant concept doc under `docs/concepts/`. If it changes user-visible behaviour, update the affected guide under `docs/guide/`. Bug fixes, refactors, test additions, and dependency bumps do not require documentation updates. When in doubt, ask.

Structural consistency is enforced by drift tests in `npm test`: `test-docs-drift.js` (API manifest + env vars), `test-adr-index-drift.js` (every ADR appears in the index and `llms.txt`), and `test-concepts-index-drift.js` (concept docs are linked and resolve). A red drift test names exactly what to update.
