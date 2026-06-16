# Testing Strategy

## What it is

How FlowBoard verifies itself: one `npm test` gate combining fast unit tests, a real-browser end-to-end harness for UI behavior, and a family of drift tests that keep docs and contracts honest.

## Why it exists

The dashboard has a meaningful client runtime (React over a legacy bridge), a REST surface many agents depend on, and documentation that must track the code. Unit tests alone can't prove what the app *renders*, and prose review can't prove docs still match reality. The gate is the single bar every change clears before it lands on `dev`.

## How it works

- **Real-browser E2E:** `test-support/browser-harness.js` exposes `withDashboard(fn)`, which boots the server and drives a real Edge/Chromium instance against the live DOM. UI behavior is proven by asserting what actually renders, not by mocking. Render tests are named `test-<feature>-e2e.js` and wired into `npm test`. The harness degrades gracefully when no browser binary is available.
- **Runtime guardrails:** `test-runtime-guardrails.mjs` enforces the frontend architecture invariants (no reintroduced `window.*` globals, one task-state mutation path) from [ADR-0026](../adr/0026-frontend-architecture-invariants.md).
- **Drift tests:** see [Docs-drift enforcement](docs-drift-enforcement.md) — mechanical checks that fail the gate when code and its documentation/registry diverge.
- **The gate:** `cd dashboard && npm test` must be green (suite exit 0) before commit. Browser tests can be timing-flaky; a single failure is re-run in isolation before being treated as real.

## Consequences

- New UI behavior should add or extend a `*-e2e.js` render test rather than rely on a unit test of a helper.
- The gate is the contract for landing; a red suite blocks the change.

## Where the code lives

- `dashboard/test-support/browser-harness.js` — `withDashboard`, reporter, browser detection.
- `dashboard/test-*-e2e.js` — render tests (reference: `test-kanban-sort-e2e.js`).
- `dashboard/test-runtime-guardrails.mjs`, the `dashboard/test-*-drift.js` family, and the `test` script in `dashboard/package.json`.
