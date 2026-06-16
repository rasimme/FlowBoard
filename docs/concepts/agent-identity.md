# Agent Identity

## What

Every action against the FlowBoard API is attributed to an **agent-id**: a plain string like `main`, `alpha-agent`, or `claude-code`. The agent-id is the routing key for per-agent state (active project, task claims) and the attribution key on every task mutation (claim, release, checkpoint, comment, complete).

There is no central registration step and no foreign key — the agent-id is *just a string*, agreed by convention between the agent and the server.

## Why

A naive design would tie agent-id to a session token, an OAuth identity, or a row primary key. FlowBoard rejects all three for two reasons. First, the system runs across heterogeneous agent surfaces: OpenClaw-managed Telegram bots, external CLI agents (Codex, Cursor, Claude Code), cron scripts, manual `curl` from the terminal. A single auth model would either lock out legitimate callers or balloon into a per-surface adapter layer. Second, agent identity is a *workflow* concept, not a security concept — FlowBoard is a personal coordination tool, not a multi-tenant service. Trust-on-write is sufficient for the operator's own machine.

The string-based model has one explicit invariant: the agent must always pass its own id, and the server never substitutes a default. The latent default-fallback bug fixed in ADR-0002 (where `OPENCLAW_AGENT_ID || 'main'` silently routed missing-agentId calls to a phantom agent) is the cautionary tale this rule exists to prevent.

## How

There are two independent layers that happen to use the same agent-id string.

**OpenClaw layer.** For agents managed by OpenClaw (Telegram bots, channel-routed runs), the agent-id is a property of the workspace. OpenClaw's config (`~/.openclaw/openclaw.json`) defines which workspace a channel routes to: `agent alpha-agent` → `~/.openclaw/workspace-alpha-agent`. The `project-context` hook derives the canonical agent-id from `event.context.workspaceDir` using the filesystem convention:

- `~/.openclaw/workspace` → `main`
- `~/.openclaw/workspace-<id>` → `<id>`

The workspace-derived id wins over `event.context.agentId` if they disagree — the workspace is the durable signal, the event field is sometimes empty or stale (see ADR-0001 for the trigger code path that exposed this). The hook then writes the resulting id into the live-injected `## Identity` section of the bootstrap document, which is how the agent normally learns its own name for the duration of the run.

If an OpenClaw-managed agent run does not receive the bootstrap identity block, the workspace convention is still the stable fallback: `~/.openclaw/workspace` resolves to `main`, and `~/.openclaw/workspace-<id>` resolves to `<id>`. This fallback is deliberately narrower than deriving from arbitrary cwd/runtime names. Generated hybrids such as `codex-workspace`, `main-workspace`, or `<runtime>-<workspace-slug>` are invalid because they create phantom agents instead of using the configured OpenClaw identity.

**FlowBoard layer.** The `flowboard_agents` table is FlowBoard's bookkeeping for *which agent is active on which project*:

| Column | Meaning |
|---|---|
| `agent_id` | Primary key, the string |
| `active_project` | Project name or `NULL` |
| `activated_at` | ISO timestamp of last project switch |

**Lazy registration.** A row in `flowboard_agents` is created on the first `PUT /api/status {agentId, project}` for an unknown agent. Task mutations alone (claim, release, complete) do not create an agent row — they store the agent-id in `tasks_current.agent` and that's it. The table answers "which agents have an active project", not "which agents exist". An agent that only claims tasks but never activates a project shows up as `tasks_current.agent` but is invisible to `GET /api/agents`.

**Managed ids.** FlowBoard's public defaults only include portable ids such as `main`, `human`, `claude-code`, `codex`, `cursor`, and `cron-nightly`. Installations with named OpenClaw agents should declare those local names through `FLOWBOARD_MANAGED_AGENT_IDS`, for example `FLOWBOARD_MANAGED_AGENT_IDS=alpha-agent,beta-agent`. Exact managed ids are accepted and classified as `managed`. Near-collision variants such as `alpha-agent-main` or `prod-alpha-agent` are rejected so a managed agent cannot accidentally fork itself into a phantom identity after a session reset.

**External agents** are first-class citizens under the same rules. They:
- pick a stable agent-id (recommended convention: `codex`, `cursor`, `claude-code`, `cron-nightly`, or deliberately stable variants like `claude-code-lab`)
- pass `agent` / `agentId` in every API call (no server defaults — see ADR-0002, ADR-0003)
- are lazy-registered into `flowboard_agents` on their first `PUT /api/status`
- fetch project context via `GET /api/projects/<name>/bootstrap` since they have no live-inject

The `GET /api/info` endpoint documents the convention and serves the external-trigger snippet for self-onboarding.

**Identity guardrails.** FlowBoard validates agent ids at API ingress. Stable unknown external ids are still accepted because external tools must remain first-class. Obvious placeholders and generated names are rejected: examples include `default`, `unknown`, `<agentId>`, `workspace-*`, `*-workspace`, and replay/timestamp ids like `t198-replay-1777837445357`. Configured managed ids also get a near-collision guard: variants that start or end with the managed id plus a hyphen are rejected. This catches the common failure mode where a model invents an identity from the current directory instead of using the bootstrap identity or the narrow OpenClaw workspace convention.

## Consequences

- **The string is the contract.** A typo in the agent-id can create a new lazy-registered external agent if it still looks stable. There is no fuzzy match. Agents must use the exact id from their bootstrap (for OpenClaw agents, the `## Identity` section), the OpenClaw workspace convention when that bootstrap identity is absent, or their stable convention (for external agents).
- **Attribution survives agent deletion.** `DELETE /api/agents/:id` removes the `flowboard_agents` row, but `tasks_current.agent = "<id>"` and the HZL event log are unaffected — agent-id is a string, not an FK. Old comments, checkpoints, and completed tasks keep their authorship even if the agent is later removed.
- **Active-claim conflict on delete.** `DELETE /api/agents/:id` returns 409 if the agent has open task claims, listing them. `?force=true` releases the claims (status preserved, lease dropped) and proceeds. This is the only place where agent-id behaves like a relationship.
- **No auth boundary.** Anyone with access to the dashboard port can pose as any agent-id. This is intentional for the personal-tool deployment model. Don't expose the dashboard to a network you don't trust.
- **The two layers don't enforce each other.** An OpenClaw agent (workspace-derived id) that never activates a project never appears in `flowboard_agents`. A `claude-code` external agent that never has a workspace can still activate projects and claim tasks. This is by design — the layers are loosely coupled by convention on the string alone.

## Code

- `hooks/project-context/handler.js` — `deriveAgentIdFromWorkspace()`, `buildIdentitySection()`.
- `dashboard/agent-identity.js` — API-ingress validation and classification for known, test, and external agent ids.
- `dashboard/server.js` — `/api/status` (per-agent), `/api/agents` (list), `DELETE /api/agents/:id` (with `?force=`), `/api/info` (external onboarding).
- `dashboard/flowboard-metadata.js` — `flowboard_agents` table CRUD (`getAgentRow`, `setAgentActiveProject`, `listAgents`, `deleteAgentRow`).
- `dashboard/hzl-service.js` — `listTasksClaimedBy(agentId)`, the conflict check for `DELETE /api/agents/:id`.

## See also

- [ADR-0002](../adr/0002-api-status-requires-agent-id.md) — `/api/status` requires explicit agentId
- [ADR-0003](../adr/0003-dashboard-has-no-agent-identity.md) — Dashboard has no agent identity
- [Hook Architecture](hook-architecture.md) — how OpenClaw agents learn their own id
- [Multi-Agent Model](multi-agent-model.md) — what `flowboard_agents` tracks vs. what task rows track
