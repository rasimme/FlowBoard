# In-App Update

## What it is

A way to apply a new FlowBoard version from the running dashboard: the header detects a version mismatch and offers **Update & restart**, which rebuilds the UI and restarts the service in place.

## Why it exists

After `openclaw plugins update flowboard` (or a `git pull`), the new source is on disk but the **running process still serves the previous build** — there's no automatic pickup. Operators needed a one-click, data-safe way to go live without hand-running build/restart commands and without risking their `.env` or project data.

## How it works

- `GET /api/update/status` reports `{ running, installed, updateAvailable }` by comparing the running version against the on-disk package. It is **fail-silent**: if it can't determine status, it reports "no update" rather than erroring, so a detection hiccup never blocks the dashboard.
- `POST /api/update/run` shells out to a **fixed command** — `node scripts/setup.mjs --update` — not an arbitrary string, so the endpoint can't be coerced into running something else. `setup.mjs --update` reinstalls dependencies, rebuilds the UI, and restarts the service, leaving `.env` and data untouched.
- The header **SnippetUpgrade** panel surfaces the "vX → vY" chip and drives the flow; the same `setup.mjs --update` is available from the CLI.

## Consequences

- The update path is intentionally narrow (fixed command, fail-silent status) — a safety property, not a limitation.
- A restart briefly bumps the live service; in a shared/multi-agent install, do it when the checkout is clean.
- Documented for users in [Update FlowBoard](../guide/how-to/update-flowboard.md).

## Where the code lives

- `dashboard/server.js` — `GET /api/update/status`, `POST /api/update/run` (fixed `setup.mjs --update` command).
- `scripts/setup.mjs` — the `--update` rebuild + restart path.
- `dashboard/src/components/SnippetUpgrade.jsx` — the header chip + Update & restart panel.
- Tests: `dashboard/test-app-update.js`, `dashboard/test-app-update-ui.mjs`.
