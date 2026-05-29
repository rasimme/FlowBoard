# Contributing

Thanks for helping improve FlowBoard!

## Where to start

- Browse [open issues](https://github.com/rasimme/FlowBoard/issues) — look for `good first issue` or `help wanted` labels
- Have a question? Open a [Discussion](https://github.com/rasimme/FlowBoard/discussions) instead of an issue

## Project structure

```
dashboard/
├── server.js           # Express 5 API + auth + project/task endpoints
├── index.html          # SPA shell
├── js/
│   ├── app.js          # Legacy shell bridge and project refresh
│   ├── canvas/         # Vanilla Idea Canvas runtime
│   └── utils.js        # Legacy shared helpers
├── src/
│   ├── components/     # React UI components
│   ├── context/        # React bridge over app state
│   ├── pages/          # React-owned views
│   └── utils/          # React-side utility modules
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
- Frontend: React is the primary dashboard UI runtime
- Legacy JS is compatibility infrastructure and still hosts the vanilla Canvas
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
- Keep Canvas vanilla until ADR-0012 is superseded, but use the runtime foundation for future Canvas task-state work.

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

## Code style

- No semicolons (project convention)
- `const` over `let`, no `var`
- Descriptive function/variable names
- Avoid adding dependencies unless there's a clear, significant win

## Documentation discipline

If your patch introduces or changes an architectural decision (new endpoint, new convention, default-behaviour change, new agent type, new hook event, removed concept), write an ADR under `docs/adr/` and update the relevant concept doc under `docs/concepts/`. Bug fixes, refactors, test additions, and dependency bumps do not require documentation updates. When in doubt, ask.
