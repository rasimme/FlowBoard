# ADR-0011: External-agent discovery via `/api/info` and self-onboarding snippet

## Status
Accepted

## Date
2026-04-30

## Source
- private spec `specs/T-179-external-agent-discovery.md` in operator's local FlowBoard project
- public commits:
  - `9b6db98` — `docs(snippets): add external-trigger.md for non-OpenClaw agents (T-179-1)`
  - `ee4e71e` — `feat(api): GET /api/info public discovery endpoint for external agents (T-179-2)`
  - `45204fc` — `feat(installer): node install-trigger.mjs — onboard external agents per repo (T-179-3)`

## Context

ADR-0003 established that the dashboard service has no agent identity and that external agents (Codex, Cursor, Claude Code, cron scripts) are first-class citizens on the same REST surface as OpenClaw-managed agents. That decision opened the door for external agents but did not specify *how an external agent finds the dashboard, learns the API surface, and starts using it without operator hand-holding*.

The natural answer for OpenClaw-managed agents — live-inject of `BOOTSTRAP.md` via the `agent:bootstrap` hook (ADR-0001) — does not work for external agents. They have no workspace, no `agent:bootstrap` event, no live-inject channel. Their only contact with the dashboard is HTTP, and they need a way to discover *what to call and how* before they have any context.

Three onboarding patterns were considered:

- **Per-runtime adapters.** Write a Codex-specific module, a Cursor-specific module, a Claude-Code-specific module, each with hardcoded dashboard endpoints. Rejected: bottlenecks new external agents on operator effort, duplicates surface in N places, drifts.
- **Hard-coded snippet in each agent's repo.** Have the operator paste a snippet into every project repo's `AGENTS.md` (or equivalent). Workable but requires the operator to copy/paste/maintain the snippet across repos and refresh it when the API surface changes.
- **API-first discovery + installer.** A public discovery endpoint serves the current snippet; a small installer script fetches and writes it once per repo. The snippet itself is minimal — it just tells the agent *FlowBoard exists at this URL, here's how to discover the rest.*

The third option keeps the source of truth on the dashboard side (snippet edits propagate without operator action across repos) and reduces per-runtime effort to "one-time install per project repo."

## Decision

Three components, working together:

**1. `GET /api/info` — public discovery endpoint.** Returns `{service, version, api_base, endpoints, agent_id_convention, trigger_snippet}`. No auth required (matches `/api/health`). The `trigger_snippet` field is read fresh from disk per request — editing `snippets/external-trigger.md` takes effect without dashboard restart. The endpoint shape is the canonical discovery contract.

**2. `snippets/external-trigger.md` — minimal trigger.** A short markdown block (~20 lines) that an external agent reads at session start. It tells the agent: there's a FlowBoard at this URL; check `GET /api/status?agentId=<your-id>` first; if a project is active, fetch context via `GET /api/projects/<name>/bootstrap`; load rules on demand. The same minimal-trigger approach as ADR-0005 for OpenClaw agents — same shape, different fetch path (no live-inject).

**3. `install-trigger.mjs` — per-repo installer.** A small Node script (`node install-trigger.mjs --repo <path>`) fetches the trigger snippet from `/api/info` and writes it into `<repo>/AGENTS.md` (or equivalent agent-config file), wrapping it in `<!-- BEGIN/END FlowBoard external trigger -->` markers. Re-running the installer replaces the existing marked block (idempotent). ADR-0006 covers the marker-injection-at-install-time pattern that keeps the source snippet marker-free.

**Lazy registration completes the loop.** An external agent picks a stable agent-id (`codex`, `cursor`, `claude-code`, hostname-suffixed variants like `claude-code-jetson`) and uses it on every API call. The first `PUT /api/status {agentId, project}` lazy-registers the agent in `flowboard_agents`. From then on, the agent appears in the dashboard's active-agents bar identically to an OpenClaw agent. Per ADR-0003, no auth boundary distinguishes external from OpenClaw agents.

## Consequences

- **External agents onboard in two commands.** Operator runs `node install-trigger.mjs --repo /path/to/myrepo` once per repo; the agent reads `AGENTS.md` on session start and starts hitting the API. No per-runtime adapter, no per-snippet-version coordination.
- **Snippet is single-source-of-truth.** The dashboard owns `snippets/external-trigger.md`; every install reads from the same place. Updating the snippet (e.g. adding a new rule section to the lazy-load list) propagates on the next install, with no per-repo manual edit needed. ADR-0006's drift detection covers the case where users have edited their installed copy.
- **Discovery has no auth.** `/api/info` is public — anyone who can reach the dashboard URL can learn the API surface. This is consistent with `/api/health`. The auth boundary applies to per-agent state endpoints (`/api/status`, task lifecycle), not discovery. Dashboard URLs that must remain private should be reachable only via private network or behind a secret hostname.
- **External-agent identity is by convention.** The recommended ids (`codex`, `cursor`, `claude-code`) are convention only — no validation, no allowlist. An external agent can pick any stable string. Hostname suffixes (`claude-code-laptop`, `claude-code-jetson`) are recommended when the same logical agent runs on multiple machines, to avoid the cross-machine collision documented in ADR-0007 / Specify Workflow concept.
- **No live-inject for external agents.** External agents fetch context on demand via `GET /api/projects/<name>/bootstrap` and `GET /api/projects/<name>/rules/<section>`. This means project-state changes (e.g. project activation by another agent) propagate at *next fetch*, not at *next agent run* — there's no push channel. For most workflows the difference is invisible because external agents fetch at session start and on user-driven `Project: <name>` switches.
- **Installer is one-way.** `install-trigger.mjs` writes the snippet but does not uninstall it. Removing the snippet from a repo means deleting the marked block manually (or running a future uninstaller). The marker pattern (`<!-- BEGIN/END FlowBoard external trigger -->`) makes the block locatable for any cleanup script.
- **External agents are blind to operator policies in `~/.openclaw/`.** OpenClaw-managed agents see live-injected `PROJECT.md` per ADR-0001, which can include operator-specific rules (e.g. the Documentation Discipline paragraph from T-197-3). External agents fetch the same `PROJECT.md` via `/api/projects/<name>/bootstrap` — same source — but they do not pick up `~/.openclaw/projects/flowboard/PROJECT.md` automatically. The bootstrap endpoint serves the project's canonical `PROJECT.md` from the shared projects directory, which is the same file. Net effect: parity, as long as the operator keeps a single `PROJECT.md` per project.

## See also

- [Agent Identity concept](../concepts/agent-identity.md) — the agent-id convention referenced by `/api/info`
- [Multi-Agent Model concept](../concepts/multi-agent-model.md) — what `flowboard_agents` lazy registration looks like
- ADR-0003 — Dashboard has no agent identity (the foundation that makes external agents first-class)
- ADR-0005 — Minimal-trigger snippet (parallel decision for OpenClaw agents)
- ADR-0006 — Snippet drift detection + installer marker pattern
