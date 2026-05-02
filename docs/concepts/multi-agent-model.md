# Multi-Agent Model

## What

FlowBoard treats agents as first-class but lightweight: each agent owns a row in `flowboard_agents` (active-project bookkeeping) and may own zero or more task claims in HZL's `tasks_current` table (work-in-progress accounting). An agent can be active on at most one project at a time; a project can have many concurrent agents. Multiple agents collaborating on the same project see each other's claims, comments, and checkpoints in real time.

## Why

The classical alternatives — single-agent (one operator, no collaboration) or session-scoped (each browser tab is its own identity) — both break the dogfooding model where multiple OpenClaw bots (`dev-botti`, `design-botti`, `main`) plus external agents (`claude-code`, `codex`) collaborate on the same FlowBoard project. The operator needs to see at a glance who is doing what, hand off work between agents without losing context, and audit who completed which task.

A second consideration: the system must work for agents that don't have an OpenClaw workspace. External CLI tools running in a developer's repo cannot rely on `agent:bootstrap` injection. They need a uniform protocol — same endpoints, same agent-id contract, same task lifecycle — so the dashboard treats `claude-code` and `dev-botti` identically. ADR-0003 records the decision that the dashboard has no agent identity of its own; that decision is what makes external agents first-class.

## How

The model has three components: agent registration (lazy), active-project tracking (`flowboard_agents`), and task ownership (`tasks_current`).

**Lazy registration.** No registration endpoint exists. An agent first appears in `flowboard_agents` when it calls `PUT /api/status` with a previously-unseen `agentId`. The row is created with `active_project` set from the request body. A typo creates a new agent silently — that's the cost of the no-auth model.

**Active-project tracking.** `flowboard_agents` has three columns: `agent_id` (PK, the string), `active_project` (project name or `NULL`), and `activated_at` (ISO timestamp of the last switch). At most one project per agent. The table answers "which agents have an active project right now"; it does not list every agent that has ever existed. An agent that has only claimed tasks (no `PUT /api/status`) is not in the table.

**Task ownership.** Tasks live in HZL's event-sourced store. The materialized view `tasks_current` carries one row per task with the current claim state: `agent` (the holder, or `NULL`), `claimed_at`, `lease_until`, `status`. A task is claimed via `POST /api/projects/<name>/tasks/<id>/claim {agent}`, with optimistic concurrency — a second agent's claim returns 409 unless the lease has expired. Released tasks (or expired leases) become claimable again. Completed tasks transition to `review` (work done, awaiting acceptance) and then `done` (accepted) — both terminal states preserve `agent` as the holder of record.

**The endpoints:**

- `GET /api/agents` — lists the `flowboard_agents` rows, used by the UI's active-agents bar.
- `GET /api/status?agentId=<id>` — one agent's row.
- `PUT /api/status {agentId, project|null}` — set or clear the agent's active project.
- `DELETE /api/agents/:id` — remove the row. Returns 409 if the agent has active claims; `?force=true` releases them (status preserved, lease dropped) and proceeds.

**String-based attribution.** `agent_id` is a string in `flowboard_agents.agent_id` and a string in `tasks_current.agent`. There is no foreign key. Deleting an agent removes the bookkeeping row but does not orphan completed work — `tasks_current.agent = "dev-botti"` and the HZL event log keep the historical attribution intact even after `dev-botti` is deleted from `flowboard_agents`.

## Consequences

- **Multi-agent collaboration is unceremonious.** Two agents on the same project simply both `PUT /api/status` with that project name. They both appear in `GET /api/agents`. They both see the same task list. Claims serialize via the lease mechanism; everything else is shared state.
- **Project switching is per-agent.** When `dev-botti` switches from `flowboard` to `coreops`, only `dev-botti`'s row changes. `main`'s active project (and live-injected bootstrap) is untouched.
- **Handoff has no special API.** An agent releases a claim (`POST .../release`) and another claims it. The lease mechanism makes this race-free without explicit lock transfer. The HZL event log records both events with their respective `agent` strings.
- **Attribution outlives membership.** Completed work attributed to a now-deleted agent shows the original agent-id forever. The UI will render `agent: "old-bot"` even if `old-bot` no longer exists in `flowboard_agents`. This is intentional — audit trail matters more than referential cleanliness.
- **No quota, no concurrency cap.** Any number of agents can register; any number can claim tasks (subject to one-claim-per-task by the lease). This is appropriate for a personal coordination tool; it would not survive a hostile multi-tenant deployment, which FlowBoard explicitly does not target.
- **External agents need no special handling.** The same endpoints, same lazy-registration, same task lifecycle. The only operational difference is that external agents fetch project context via `/api/projects/<name>/bootstrap` instead of receiving it through the `agent:bootstrap` hook.

## Code

- `dashboard/fb-meta.js` — `flowboard_agents` table CRUD: `setAgentActiveProject`, `listAgents`, `getAgentRow`, `deleteAgentRow`.
- `dashboard/hzl-service.js` — task claim/release/complete, lease semantics, `listTasksClaimedBy(agentId)`.
- `dashboard/server.js` — `/api/agents` (list), `/api/status` (per-agent active-project), `DELETE /api/agents/:id` (with `?force=`), the per-task endpoints under `/api/projects/<name>/tasks/<id>/{claim,release,complete,checkpoint,comment}`.
- `dashboard/migrations.js` — the `flowboard_agents` schema and the `m003` one-shot backfill from the legacy `ACTIVE-PROJECT.md`.

## See also

- [ADR-0003](../adr/0003-dashboard-has-no-agent-identity.md) — Dashboard has no agent identity (the foundation that makes external agents first-class)
- [Agent Identity](agent-identity.md) — how the agent-id string is sourced for OpenClaw vs. external agents
- [Hook Architecture](hook-architecture.md) — how OpenClaw agents receive their per-run context
