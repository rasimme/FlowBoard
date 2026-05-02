# Project Mode (operational rules — NOT human-facing documentation)

This directory contains operational rules served via the FlowBoard API:

```
GET /api/projects/:name/rules/:section
```

The agent fetches a specific rule section on demand when an active project is set. The content is consumed by **active-project agents at runtime**, not by humans reading documentation.

## Not human-facing

Tooling that processes the documentation tree should **exclude** this directory:

- doc-site builds (Mintlify, Docusaurus, MkDocs, etc.) — exclude `docs/project-mode/`
- glob-based documentation generators — exclude this path
- table-of-contents generators — exclude this path
- The agent-facing `llms.txt` index does NOT link here (the rules are reached via the API, not via static files)

## Why it lives in `docs/`

The `RULES_DIR` resolution in `dashboard/rules-api.js:15` is `path.resolve(__dirname, '..', 'docs', 'project-mode')`. Relocating the directory would require coordinated code changes in `rules-api.js` and `dashboard/migrations.js` and would break path expectations on existing FlowBoard installs. The disclaimer above is the lower-cost solution.

## Sections served

The available rule sections are listed by `GET /api/projects/:name/rules/`. As of writing they include `commands`, `api-access`, `hzl`, `canvas`, `files`, `specify`, `agent-bridge`, `error-handling`, `key-principles`. Each is a Markdown file in this directory consumed by an agent on-demand.

## See also

- [`dashboard/rules-api.js`](../../dashboard/rules-api.js) — the lazy-load registry
- [`docs/concepts/lazy-loading.md`](../concepts/lazy-loading.md) — the *why* behind on-demand loading (when written)
