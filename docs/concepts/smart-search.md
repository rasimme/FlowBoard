# Smart Search

## What it is

A command-palette search (`Cmd/Ctrl+K`) that finds tasks across **all** projects from one box, combining free-text matching with structured filter operators.

## Why it exists

The board is per-project and column-oriented; once you have many projects and tasks, "where is that task about X?" has no fast answer by scrolling. Search makes the whole task corpus addressable in one keystroke, without leaving the current view, and tolerant of imperfect recall (a task number, a partial title, a typo).

## How it works

- A query string is split into **free text** and **operators** (`status:`, `project:`, `agent:`, `is:` (`is:blocked`, `is:claimed`, `is:stale`), `has:`). Operators narrow the candidate set; free text ranks within it.
- Free text matches task numbers (`T-123`), and titles with partial / typo-tolerant scoring; an exact title match is flagged so it can be surfaced first.
- The search runs server-side over the materialized task projection, so it sees every project regardless of which one is active (search is read, not context activation — see [Multi-Agent Model](multi-agent-model.md)).

## Consequences

- **Users** get one global jump-to-task affordance with a small operator grammar (documented in the [user guide](../guide/how-to/search-and-filter.md)).
- **Agents** can use the same `GET /api/search` to locate work across projects without switching their active project.
- New operators must be added to the parser *and* surfaced to users; the operator set is the contract.

## Where the code lives

- `dashboard/smart-search.js` — query parsing + matching/ranking.
- `GET /api/search` in `dashboard/server.js` — the cross-project endpoint.
- `dashboard/src/components/SearchPalette.jsx` — the `Cmd/Ctrl+K` UI.
- Tests: `dashboard/test-search-query-parser.js`, `dashboard/test-smart-search.js`, `dashboard/test-search-api.js`.
