# Lazy Loading

## What

FlowBoard's project-context system loads operational rules **on demand**, not all at once. The bootstrap document an agent receives at session start contains a *manifest* of available rule sections — names, one-line labels, and a URL template — but not the section content itself. An agent fetches a section only when it actually needs it.

Concrete example: an agent that wants to claim a task fetches the `api-access` section. An agent that never touches the canvas never fetches `canvas`. The rules for sections the agent doesn't use never enter its run context.

## Why

The full ruleset for FlowBoard is roughly 9 sections at a few hundred lines each — call it 2–3k lines of operational guidance covering task lifecycle, HZL semantics, canvas, file roles, error handling, and so on. Embedding every section into every session start would mean:

- every cold-start session pays that token cost, even when the user only wants to chat
- minor rule edits force every active agent to reload before they take effect
- the trigger snippet (the always-on part) couldn't shrink — adding a new rule section would grow it linearly

The architecture solves this by separating two concerns: the **trigger** (always on, ~20 lines, says *FlowBoard exists, here's how to find it*) and the **rules** (loaded only when relevant). See ADR-0005 for the decision record.

## How

The lazy-loading machinery is a small registry plus three endpoints.

**The registry** (`dashboard/rules-api.js`) is a static array of `{name, file, label}` entries. Each entry maps a public section name (e.g. `api-access`) to a markdown file under `docs/project-mode/`. The mapping is intentional — section names are stable public API; the underlying filenames can be reorganized without breaking consumers.

**The endpoints:**

- `GET /api/projects/:name/rules/` — lists available sections (manifest).
- `GET /api/projects/:name/rules/:section` — returns one section's markdown.
- `GET /api/projects/:name/bootstrap` — returns the *full* bundled document (manifest + every section embedded). Used by external agents that prefer eager loading over per-call fetches.

**The injection path** (OpenClaw-managed agents): the `project-context` hook fires on `agent:bootstrap`, builds a document containing the active-project header, identity section, the rules **manifest** (not full content), the project's `PROJECT.md`, and a live task-status summary. The hook injects this as `BOOTSTRAP.md` into `event.context.bootstrapFiles`. See ADR-0001 for the live-inject decision; ADR-0004 for why on-disk copies are not authoritative.

**The fetch path** (external agents): external agents have no live-inject. The minimal trigger snippet (per ADR-0005) instructs them to call `GET /api/projects/<name>/bootstrap` once at session start to get the full document, or `GET /api/projects/<name>/rules/<section>` per-section as needed.

The manifest format is plain markdown — the section names appear as code-formatted bullet items with their labels, and the URL template is given verbatim. An agent reading the manifest can construct the section URL directly without a separate schema lookup.

## Consequences

- **Token cost scales with use.** A session that only triggers the status check costs a manifest (~20 lines). A session that touches three rule sections costs the manifest plus those three sections — never the unused six.
- **Rule edits propagate naturally.** Editing `docs/project-mode/hzl.md` takes effect on the next `GET /api/projects/<name>/rules/hzl` from any agent. No snippet rebuild, no cache invalidation, no agent restart.
- **Section names are public API.** The registry names (`api-access`, `hzl`, `canvas`, `files`, `specify`, `agent-bridge`, `error-handling`, `key-principles`, `commands`) are referenced in the trigger snippet and in external agent code. Renaming one is a breaking change. Filenames behind them are private and can move freely.
- **External agents have an eager-load escape hatch.** `GET /api/projects/<name>/bootstrap` returns everything bundled. External agents that prefer one fetch over nine can use it; the per-section endpoints are still available if they later want to refresh one section in place.
- **No client-side caching is required, but is cheap.** The endpoints are read-only, idempotent, and serve files of a few KB each. An agent that caches sections in its run context for the duration of the session avoids re-fetching; an agent that doesn't cache pays a sub-millisecond local-API round trip per fetch.
- **The manifest is the contract; the embedded full bundle is a convenience.** Both reflect the same registry, so they cannot diverge — `buildBootstrapDocument` and `buildRulesManifest` iterate the same `SECTIONS` array.

## Code

- `dashboard/rules-api.js` — the registry, `listRuleSections`, `readRuleSection`, `buildRulesManifest`, `buildBootstrapDocument`.
- `dashboard/server.js` — endpoint wiring at `/api/projects/:name/rules/`, `/rules/:section`, `/bootstrap`.
- `hooks/project-context/handler.js` — calls `buildRulesManifest()` (not `buildBootstrapDocument`); the live-inject path uses the manifest, never the full bundle.
- `docs/project-mode/` — the section markdown files behind the registry.

## See also

- [ADR-0001](../adr/0001-live-inject-bootstrap.md) — Project context delivered via live-inject
- [ADR-0005](../adr/0005-minimal-trigger-and-lazy-rules.md) — Minimal-trigger snippet + lazy rule loading
- [ADR-0006](../adr/0006-structural-fingerprinting-for-snippet-drift.md) — Drift detection for the trigger snippet
