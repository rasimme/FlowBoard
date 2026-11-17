# ADR-0044: Project activity is derived from live claims and recent session bindings

## Status

Accepted (2026-11-17, T-529)

## Source

- T-529 spec, "Projekt-Aktivität: Aktiv-Punkt in der Seitenleiste und
  Startprojekt des Viewers", with the operator decision of 2026-11-17.
- Implementation: `dashboard/project-activity.js`, `dashboard/hzl-service.js`
  (`listClaimedTasks`), `dashboard/server.js` (`GET /api/projects`,
  `GET /api/dashboard/snapshot/v1`), `dashboard/dashboard-snapshot.js`,
  `dashboard/src/utils/projectActivity.mjs`,
  `dashboard/src/utils/projectSelection.mjs`,
  `dashboard/src/components/Sidebar.jsx`, `dashboard/src/utils/activeAgents.js`.
- Tests: `dashboard/test-project-activity.js`,
  `dashboard/test-project-activity-api.js`, `dashboard/test-project-selection.mjs`,
  `dashboard/test-active-agents.mjs`, `dashboard/test-dashboard-shell.js`.

## Context

The sidebar marked a project with an activity dot when some row in
`flowboard_agents` had `active_project` set to it, and the viewer opened the
caller's or another agent's `active_project` on a fresh load. Since ADR-0039 an
OpenClaw activation writes a session binding (`flowboard_session_projects`) and
leaves `flowboard_agents.active_project` null, so no project showed the dot any
more and the viewer opened the first project instead of the one being worked
on. A binding also says nothing about whether anyone is still there: bindings
only age out after the idle TTL (48 hours by default), so a session that was
abandoned yesterday still looks bound.

## Decision

1. **A project is active when at least one of these holds:**
   - an agent holds a live claim there: task `in-progress`, `agent` and
     `claimedAt` set, lease not expired (a claim without a lease counts as live,
     the same rule as `countLiveClaims` and the claim gate);
   - a session binding, or a legacy agent-wide binding
     (`flowboard_agents.active_project`), points at the project and its
     `last_seen` is within the activity window. The window defaults to 30
     minutes and is set with `FLOWBOARD_PROJECT_ACTIVITY_WINDOW_MINUTES`.

   An agent-wide binding counts only for an agent without a fresh session
   binding and without a live claim: claims and session activations refresh
   `flowboard_agents.last_seen` too, so for such an agent the heartbeat says
   nothing about its old agent-wide binding, and a same-project session would
   count the agent twice. Archived projects are never active. Several projects
   can be active at the same time.

2. **The server derives it; clients only read it.** Every project in
   `GET /api/projects` and in the dashboard snapshot carries
   `activity: { active, lastActivityAt, claims, sessions, agents }`.
   `lastActivityAt` is the newest of claim time, last checkpoint and binding
   `last_seen` over the sources that make the project active, and `null` when
   it is inactive. `agents` lists the agent ids behind those sources,
   deduplicated and sorted. The derivation reads the RAM task cache and the two
   binding tables only, never the event store.

3. **The snapshot ETag stays stable.** The current time only decides which
   sources are live or fresh; every value is a projection of stored
   timestamps, so `activity` changes only when a source enters or leaves the
   active set. A poll with nothing changed still gets `304`; a claim expiring
   or a binding leaving the window changes the snapshot.

4. **Start project.** The viewer keeps an explicit view first. On a fresh load
   (no viewed project yet) it opens the active project with the most recent
   activity, then falls back to the previous order: the caller's active
   project, another agent's active project, the first project. The viewed
   project is not persisted across page loads, and every poll sends the
   current one back, so a project the user picked is never replaced by
   activity on a later poll.

5. **The activity dot reads `project.activity.active`**, labelled for example
   "Active: 2 claims, 1 session". The Active Agents bar and the overview
   widgets also treat a session binding as binding the agent to its project,
   as long as it is within the window (`GET /api/agents` marks each session
   with `active`). The route popover keeps listing every agent with a binding
   until the idle TTL removes it.

6. **The agent prompt is unchanged.** `FLOWBOARD.md` and the rules manifest do
   not include activity.

## Consequences

- The dot and the start project work again for session-scoped activations and
  stop showing projects nobody has touched within the window.
- An agent-wide binding of an agent that keeps calling `GET /api/status` stays
  active, because every such call refreshes `last_seen`. Claims and session
  activations refresh it as well; that is why an agent working through a
  session or a claim does not keep its agent-wide project active.
- On a fresh load, an active project of another agent wins over the viewer's
  own older or inactive binding. Users who want a specific project pick it;
  that choice holds until the page is reloaded.
- Old bindings are not deleted by this decision. Deletion stays with the
  existing idle TTL (ADR-0020, ADR-0039).

## See also

- [ADR-0020](0020-agent-idle-auto-deactivation.md) — idle TTL for agent bindings
- [ADR-0032](0032-dashboard-snapshot-and-rate-limit-lanes.md) — dashboard snapshot and its ETag
- [ADR-0039](0039-session-scoped-project-binding.md) — session-scoped project binding
- [Multi-Agent Model](../concepts/multi-agent-model.md)
