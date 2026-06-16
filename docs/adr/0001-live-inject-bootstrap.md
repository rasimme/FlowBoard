# ADR-0001: Project context delivered via live-inject, not file-write

## Status
Accepted

## Date
2026-05-01

## Source
- private spec `specs/T-168-hook-lifecycle-coverage.md` in operator's local FlowBoard project
- public commit `016a58f` — `fix(hook): workspace-derived agentId wins over context.agentId (T-168 review)`

## Context

Pre-T-168, the `project-context` hook wrote `BOOTSTRAP.md` to disk on `command:new`, `command:reset`, `gateway:startup`, and `session:compact:after`. That set of triggers missed the cold session start, the daily 4 AM reset, idle-expiry, and project-activation via `PUT /api/status`. Result: the on-disk file drifted from `flowboard_agents.active_project` (the canonical state). On 2026-04-29 `dev-botti.active_project = 'flowboard'` in the DB while the workspace `BOOTSTRAP.md` had only the identity section — last written 21 hours earlier on `/new`.

Audit of `src/hooks/internal-hooks.ts` showed `agent:bootstrap` fires before *every* agent run, with a mutable `bootstrapFiles` array in the event context. The basename `BOOTSTRAP.md` is already a recognized loader entry. SQLite reads are sub-millisecond on the local DB; the per-run cost is negligible compared to file-IO.

## Decision

Subscribe `project-context` to `agent:bootstrap` only. The handler mutates `event.context.bootstrapFiles` in place with content built from `flowboard_agents` + `flowboard_projects` at hook-time. No file is written to disk. The agent-id is derived from `event.context.workspaceDir` (filesystem convention `~/.openclaw/workspace-<id>`) — the workspace-derived id wins over `event.context.agentId`.

The four previously-subscribed events (`command:new`, `command:reset`, `gateway:startup`, `session:compact:after`) are dropped — `agent:bootstrap` dominates each of them on the next run. `PUT /api/status` no longer needs a hook trigger; the next run sees the new DB row automatically.

## Consequences

- **Positive:** Run always sees fresh DB state. No race between DB update and file update. Coverage of every session-boundary use-case (cold start, daily reset, idle-expiry, project-switch) is automatic. No file-IO in the hot path.
- **Positive:** The basename `BOOTSTRAP.md` continues to work — it's the loader's recognized entry, only the source changed.
- **Negative:** A DB read is added to every agent turn. SQLite local + prepared statements keep this under a millisecond; telemetry can opt-in via `FLOWBOARD_HOOK_TELEMETRY=1`.
- **Follow-on:** On-disk `BOOTSTRAP.md` files left over from the old hook are now non-authoritative. ADR-0004 covers their removal and the matching snippet wording.
