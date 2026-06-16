# Docs-Drift Enforcement

## What it is

A family of mechanical tests, run as part of `npm test`, that fail the build when code and its documentation drift apart. They make "the docs are current" a checkable property instead of a hope.

## Why it exists

Documentation rots silently: an endpoint is added but the manifest isn't, an ADR ships but the index still stops at the previous number, a widget lands without a catalog entry. Narrative review doesn't catch this reliably (it had already happened — ADRs accepted on disk but missing from the index). Tying each doc that *can* map to a code artifact back to that artifact turns silent rot into a red, actionable test.

## How it works

Each check pairs a documentation artifact with its source of truth and asserts they match, failing with a list of exactly what's missing or stale:

- `test-docs-drift.js` — every `/api/*` route ↔ `docs/reference/api-manifest.json`; every `process.env.*` ↔ `docs/reference/env-vars.md`.
- `test-design-tokens-drift.js` — every `var(--token)` ↔ a token defined in `styles/`.
- `test-overview-registry-drift.js` — the server widget catalog ↔ the frontend registry ↔ the agent rule doc `overview.md`.
- `test-adr-index-drift.js` — every `docs/adr/NNNN-*.md` ↔ the ADR index and `llms.txt` (by status).
- `test-concepts-index-drift.js` — every `docs/concepts/*.md` ↔ links in the concepts index, and those links resolve.
- `test-widget-catalog-drift.js` — every registered widget `type` ↔ the user widget catalog.
- `test-canvas-db-drift.js` — canvas schema ↔ its documented shape.

What can't be mechanized (prose correctness, "every shipped surface has a row") is governed by the documentation decision tree in `CONTRIBUTING.md` and the project's development rules, reviewed at the `review → done` gate.

## Consequences

- A contributor who changes code but not the matching doc gets a red gate naming the fix — the cheapest possible reminder.
- When a new documentation category becomes mechanizable, the pattern is to add another drift test rather than rely on discipline.

## Where the code lives

- `dashboard/test-*-drift.js` — the checks; all wired into the `test` script in `dashboard/package.json`.
- `.github/workflows/ci.yml` — runs `npm test` in CI.
