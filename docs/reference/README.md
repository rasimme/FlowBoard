# Reference

Factual lookups: what every endpoint takes and returns, what every config knob does, what every snippet looks like. No interpretation, no opinion — accurate facts you can pin to.

## Available reference

<!-- Reference docs land here as they are written. -->

- [Environment Variables](env-vars.md) — every env var the server and hook read, defaults, purpose
- [API manifest](api-manifest.json) — machine-readable list of every HTTP endpoint (used by the drift test in T-197-8)
- API endpoint docs (per-group, prose):
  - [Discovery](api/discovery.md) — `/api/health`, `/api/info`
  - [Agents & Status](api/agents.md) — `/api/agents`, `/api/status`
  - [Projects](api/projects.md) — projects CRUD, `/bootstrap`, `/rules`
  - [Tasks](api/tasks.md) — task CRUD + lifecycle (claim, release, complete, checkpoint, comment, route, handoff)
  - [Migrations](api/migrations.md) — gated canvas `canvas.json` → DB migration (`/api/migrations/canvas/status|run`)

The remaining endpoint groups (`auth`, `files`, `specs`, `canvas`, `specify`, `snippets`, `hooks`) are listed in the [API manifest](api-manifest.json) but do not yet have prose docs. Prose is added on demand as concrete questions surface.

## See also

- [Concepts](../concepts/) — the *why* layer
- [How to](../how-to/) — practical guides
