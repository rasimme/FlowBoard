# ADR-0020: Agent idle auto-deactivation (last_seen heartbeat, lease-protected TTL)

## Status
Accepted

## Date
2026-06-05

## Source
- public commit `ab19081` (`feat(agents): idle auto-deactivation via last_seen heartbeat, lease-protected (T-231)`) and its review follow-up (`fix(agents): lease-aware claim protection`)
- code: `dashboard/flowboard-metadata.js` — `last_seen` column, `isAgentIdleExpired()`, `countLiveClaims()`, `touchAgentLastSeen()`, `clearAgentActiveProject()`
- code: `dashboard/server.js` — heartbeat on `GET`/`PUT /api/status`, lazy expiry in `GET /api/agents`
- migration: `dashboard/migrations.js` — `m007-agent-last-seen`

## Context

`flowboard_agents` (`agent_id`, `active_project`, `activated_at`) had no lifecycle
for `active_project`. `setAgentActiveProject` only ever upserts; nothing clears an
agent's active project automatically. An external agent that activated a project
and never explicitly deactivated stayed "active" forever — observed in practice
with `claude-code`, which sat active on `flowboard` from 2026-05-03 until it was
cleaned up by hand on 2026-06-05.

This is an asymmetry with task **claims**, which already have a lifecycle:
`lease_until` plus the stale-task sweeper (`getStuckTasks`, `STALE_THRESHOLD_MINUTES`)
let abandoned claims be reclaimed. Only the agent's *project activation* had no
expiry. Stale activations pollute `/api/agents` and the multi-agent "who is working
on what" view, and mislead coordination.

## Decision

Add an idle lifecycle to agent activation, mirroring the lease model used for
claims, without weakening any existing invariant.

1. **`last_seen` heartbeat (schema + `m007`).** `flowboard_agents` gains a
   `last_seen TEXT` column. The bootstrap hook calls `GET /api/status` before
   every agent run, so that read — plus `PUT /api/status` — refreshes `last_seen`.
   A live agent therefore heartbeats once per run. `m007-agent-last-seen` adds the
   column idempotently (`pragma_table_info` guard) and backfills
   `last_seen = activated_at`, so pre-existing stale activations become eligible
   immediately.

2. **Lazy expiry on read (no scheduler).** `GET /api/agents` clears
   `active_project` for any agent idle longer than `FLOWBOARD_AGENT_IDLE_TTL_HOURS`
   (default **48** — generous on purpose). Expiry runs on read rather than via a
   cron sweeper because `/api/agents` is the only consumer of activation truth;
   making it self-correcting on read needs no scheduler and cannot run while the
   server is down. The agent row and `last_seen` are kept (cleared to
   `active_project = NULL`), so the agent stays visible and re-establishes liveness
   on its next heartbeat.

3. **Lease protection (the load-bearing safety rule).** An agent that holds a
   **live** task claim is never auto-deactivated. "Live" means lease-aware:
   `countLiveClaims()` ignores claims whose `lease_until` has expired, because an
   expired-lease claim is dead work the system would reclaim — counting it would
   re-introduce the exact "grabbed a task, died, never released" leak this ADR
   closes. A claim with no lease is treated as live/protecting, consistent with
   `getStuckTasks` only flagging leased claims.

## Consequences

- **Correctness of the idle window depends on the bootstrap hook calling
  `GET /api/status` per run.** That is the only liveness signal for an agent that
  holds no claim. This dependency is documented at both call sites.
- **`GET /api/status` is no longer side-effect-free:** it lazy-creates a row
  (`active_project = NULL`) for any valid agent ID that polls status. This is
  consistent with the already-documented lazy-registration of unknown external
  agent IDs (`agent-identity.js`); NULL-project rows can never be wrongly expired
  (guarded) and consumers filter on `active_project`.
- **Lazy, not eager:** an idle agent stays `active` in the DB until something reads
  `/api/agents`. Acceptable because that endpoint is the only place activation
  truth is consumed; a future cron sweep could be added if eager expiry is ever
  needed (explicitly out of scope here).
- Tuning via `FLOWBOARD_AGENT_IDLE_TTL_HOURS` (documented in
  `docs/reference/env-vars.md`); set very high to effectively disable.

## Alternatives considered

- **Cron sweeper** (like the stale-task check): rejected as over-engineering for
  this need — adds a scheduler dependency for state only ever observed on read.
- **Expire by `activated_at` instead of `last_seen`:** rejected — `activated_at`
  never refreshes, so a long-running legitimate activation would wrongly expire.
- **Delete the agent row on expiry:** rejected — rows are kept for visibility and
  historical attribution (see `deleteAgentRow`, a separate explicit action).
