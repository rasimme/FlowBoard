# Hook Architecture

## What

FlowBoard ships exactly one OpenClaw hook, `project-context`. It subscribes to a single event — `agent:bootstrap` — and on each fire it mutates `event.context.bootstrapFiles` in place, adding a `FLOWBOARD.md` entry that contains the agent's identity, the active-project header, the rules manifest, the project's `PROJECT.md` content, and a live task-status summary. No file is written to disk.

That's the entire surface. There are no other event subscriptions, no plugin hooks, no daemons, no caches.

## Why

Earlier versions of the hook subscribed to four events (`command:new`, `command:reset`, `gateway:startup`, `session:compact:after`) and wrote `BOOTSTRAP.md` to the workspace directory on each fire. That covered explicit session boundaries but missed three classes of state changes: the daily 4 AM reset (creates a new `sessionId` without firing `command:new`), idle-expiry (same, on the next message after the idle window), and project activation via `PUT /api/status` (a pure DB write with no command event). The on-disk file drifted from the canonical `flowboard_agents.active_project` row, sometimes by hours or days. ADR-0001 documents the decision to consolidate on `agent:bootstrap`; ADR-0004 documents the cleanup of the on-disk file.

A second motivation: the `agent:bootstrap` event exposes `bootstrapFiles` as a *mutable* array, which is the same pattern OpenClaw's bundled `bootstrap-extra-files` hook uses. By following this pattern, FlowBoard's hook is structurally identical to the standard one — anything that consumes bootstrap-files works without special handling.

## How

The handler runs roughly:

```
on agent:bootstrap event:
  if event.action !== 'bootstrap': return
  workspaceDir   = event.context.workspaceDir
  agentId        = deriveAgentIdFromWorkspace(workspaceDir)   // workspace-<id> → <id>
  apiResult      = GET /api/status?agentId=<agentId>           // local FlowBoard API
  if API unreachable:
    projectName  = read ACTIVE-PROJECT.md only if opt-in env is enabled
  else:
    projectName  = apiResult.activeProject                      // may be null

  if projectName is null:
    content = "# No Active Project\n..." + identitySection      // anti-inference header
  else:
    content = activeProjectHeader
            + identitySection
            + rulesManifest                                     // lazy-load index, not full bundle
            + PROJECT.md from ~/.openclaw/projects/<name>/
            + taskStatusSummary

  replace the event.context.bootstrapFiles entry named FLOWBOARD.md
  (or at <workspaceDir>/FLOWBOARD.md); append if there is none.
  Never touch any other entry, including a real BOOTSTRAP.md.
```

**`agent:bootstrap` fires before every agent run.** That includes cold session start, every turn within a session, gateway restart's first run, daily reset, idle-expiry, and the run immediately after `PUT /api/status`. By dominating all four legacy subscriptions, it covers cases the legacy set never did.

**Workspace-derived id wins over `event.context.agentId`.** The filesystem convention `~/.openclaw/workspace-<id>` is durable; the event field is sometimes empty (see the trigger code path in `auto-reply/reply/commands-reset-hooks.ts:108-115`). When they disagree, the workspace wins.

**API-canonical with opt-in file fallback.** The hook reads `flowboard_agents.active_project` via the local API. If the API is unreachable (e.g. gateway booted before the FlowBoard server is up), the hook emits an `# Active Project: Unknown` bootstrap by default so agents retry the API instead of resurrecting stale file state. The legacy `ACTIVE-PROJECT.md` fallback is available only during explicit migration recovery with `FLOWBOARD_ALLOW_ACTIVE_PROJECT_FILE_FALLBACK=true`. An *authoritative* `null` from the API never triggers the file fallback.

**The entry is called `FLOWBOARD.md`, not `BOOTSTRAP.md`.** OpenClaw owns `BOOTSTRAP.md` as its one-shot onboarding file: on a set-up workspace core drops that entry again after the hooks have run, and it strips any context file with that basename unless bootstrap mode is `full`. Until T-501 the hook used that name and its context was silently discarded. `dashboard/test-hook-core-bootstrap-filter.mjs` re-implements both core rules and checks the injected entry against them.

**Scope on OpenClaw 2026.9+.** Core re-applies its per-session allowlists after the hooks (subagents: `AGENTS.md` only; cron: `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`), so `FLOWBOARD.md` reaches main, direct and group sessions. Subagents get their FlowBoard work through the handoff package. On older hosts every run type sees it.

**Size is bounded by OpenClaw, not the hook.** The hook does not trim its document; core truncates each bootstrap file at `bootstrapMaxChars` (default 20000 characters) and all of them together at `bootstrapTotalMaxChars` (default 60000).

**No file writes.** The handler never calls `fs.writeFileSync`. A regression test parses the handler source and asserts no `fs.writeFileSync(.*BOOTSTRAP)` pattern exists. ADR-0004 covers the rationale.

**Telemetry is gated.** A success log line (`[project-context] injected for <agentId>`) is emitted only when `FLOWBOARD_HOOK_TELEMETRY=1`. Error logs (`console.warn`) for unreachable API, missing rules, or build failures stay ungated — errors must be visible regardless of the env-var.

## Consequences

- **External agents have no hook.** Agents not running under an OpenClaw workspace (Codex in a repo, Cursor on a developer's laptop, Claude Code in `~/repos/anywhere`) don't trigger `agent:bootstrap`. They fetch project context on demand via `GET /api/projects/<name>/bootstrap`. The hook is purely an OpenClaw integration; FlowBoard's API surface is the cross-cutting interface.
- **Per-run cost is one DB read plus one in-memory build.** SQLite local on the same machine, prepared statements — sub-millisecond. Negligible compared to the per-turn model latency.
- **State changes propagate within one turn.** `PUT /api/status` writes the DB; the next `agent:bootstrap` fire (next agent message) sees the new state. There is no caching, no invalidation, no stale window beyond a single turn.
- **The hook is the only writer of the bootstrap document.** Nothing else in FlowBoard writes `FLOWBOARD.md` or `BOOTSTRAP.md`, in any form. If either appears on disk because of FlowBoard, something has gone wrong (or a contributor reverted ADR-0004's behavior — the regression test should catch this in CI).
- **Failure is graceful.** If the FlowBoard API is unreachable, the hook returns identity plus a soft `# Active Project: Unknown` header. The agent learns its own id and that project state must be retried via the API — never a crash, never a stale project name from a stuck cache.

## Code

- `hooks/project-context/handler.js` — the entire hook. Single file, no shared state.
- `hooks/project-context/HOOK.md` — the OpenClaw hook manifest declaring the `agent:bootstrap` subscription.
- `dashboard/server.js` — `GET /api/status?agentId=<id>` (the canonical state read), `GET /api/projects/<name>/rules/<section>` (the lazy-loaded rule sections referenced by the manifest the hook injects).
- `dashboard/test-t168-t177-integration.js` — regression test asserting no on-disk write.
- `dashboard/test-hook-core-bootstrap-filter.mjs` — regression test proving the injected entry survives OpenClaw's `BOOTSTRAP.md` filters.

## See also

- [ADR-0001](../adr/0001-live-inject-bootstrap.md) — Project context delivered via live-inject
- [ADR-0004](../adr/0004-disk-bootstrap-is-non-authoritative.md) — On-disk BOOTSTRAP.md is non-authoritative
- [Lazy Loading](lazy-loading.md) — what's in the manifest the hook injects
- [Agent Identity](agent-identity.md) — how the workspace-derived id is computed
