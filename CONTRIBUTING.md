# Contributing

Thanks for helping improve FlowBoard!

## Where to start

- Browse [open issues](https://github.com/rasimme/FlowBoard/issues) — look for `good first issue` or `help wanted` labels
- Have a question? Open a [Discussion](https://github.com/rasimme/FlowBoard/discussions) instead of an issue

## Project structure

```
dashboard/
├── server.js          # Express 5 API + auth
├── index.html         # SPA shell
├── js/
│   ├── app.js         # Main app, routing, sidebar
│   ├── kanban.js      # Kanban board logic
│   ├── canvas/        # Idea Canvas (notes, connections, clusters, toolbar)
│   └── utils.js       # Shared helpers
└── styles/
    ├── dashboard.css   # Global styles
    └── canvas.css      # Canvas-specific styles
```

**Key conventions:**
- Vanilla JS (ES modules), no framework, no build step
- Modules are small and cohesive — one concern per file
- Dark theme, mobile-responsive
- All state is file-based (JSON + Markdown, no database)

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
