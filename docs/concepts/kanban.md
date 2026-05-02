# Kanban

## What

The Kanban board is FlowBoard's primary work surface — a five-column view (`Backlog`, `Open`, `In Progress`, `Review`, `Done`) where tasks move through their lifecycle. Each task can have subtasks (one level of nesting), can be claimed by an agent (with a lease), can be marked blocked (orthogonal flag), can carry a priority (`low`/`medium`/`high`/`critical`), and can be soft-deleted into a trash bin before permanent removal.

The board is the same view for humans (dashboard UI) and agents (REST API). A drag-and-drop in the UI and a `PUT /api/projects/:name/tasks/:id` body call hit the same lifecycle code path.

## Why

Two tensions shape every decision in this surface.

**Multi-agent collaboration vs. single-board simplicity.** Many agents working the same project need a single, shared canonical view of who is working on what. Per-user boards or per-agent queues would fragment that view. A single shared board with explicit lease ownership (`tasks_current.agent` + `lease_until`) gives every agent and the human the same picture without coordination protocol.

**Visual workflow vs. event-sourced truth.** Kanban as a UX is fundamentally about state and transitions — drag a card, status changes. But the data layer (HZL) is event-sourced; statuses are derived from event history. The Kanban model is the *materialized projection* on top of an immutable event log. That gives lossless audit (every move is a recorded event) without making the UI care about events.

The lifecycle states themselves were chosen for the agent-collaboration use case rather than mirroring traditional Kanban (which often uses `Todo` / `Doing` / `Done`). The five states encode an agent-aware workflow: `Backlog` (planned, not yet ready to start), `Open` (ready to claim), `In Progress` (claimed and being worked), `Review` (work submitted, awaiting acceptance), `Done` (accepted). The split between `In Progress` and `Review` is load-bearing — it's where multi-agent handoff happens (one agent finishes, another reviews).

## How

The board's state model has four orthogonal axes plus a soft-delete pointer.

**Status (one of 6).** `backlog`, `open`, `in-progress`, `review`, `done`, `archived`. The UI shows the first five as columns; `archived` is hidden by default and surfaced only via a toggle. Status transitions are arbitrary in the API (any → any, validated only against the enum), but the UI presents the natural left-to-right flow. Two transitions have side effects:

- → `review` or `done` while claimed: auto-releases the lease (preserves `agent` for attribution but clears `claimed_at` and `lease_until`).
- → `done` from `archived`: explicit unarchive event in the HZL log.

**Priority (one of 4).** `low`, `medium`, `high`, `critical`. Internally stored as a 0–3 integer in HZL's `priority` column; mapped to the strings on read. New top-level tasks default to `medium`. New subtasks **inherit the parent's priority** at creation time and cannot diverge later.

**Blocked (boolean).** `blocked: true` is a flag, **not a status**. It overlays on top of any column — a card in `In Progress` can be `blocked` simultaneously. The UI renders blocked cards with a visual indicator. This is deliberate: blocked is a *reason for not progressing*, not a destination state. Modeling it as a flag keeps the column count small and keeps a blocked task in the column where the work actually lives, so the holder knows where to come back to.

**Claim / lease (three fields).** `agent` is the holder; `claimed_at` is when the claim happened; `lease_until` is when the claim expires (default 30 minutes from claim). Once `lease_until` passes, the task is *stale* and can be reclaimed by anyone (the original `agent` field is preserved until a successful re-claim happens). Checkpoints (`POST .../checkpoint`) reset the lease timer.

**Routed agent (independent of claim).** `routedAgent` is a *pre-assignment* — a hint that this task is intended for a specific agent. While set, only that agent can claim. Routing is set via `POST .../route` and is independent of the current claim holder. Use case: the UI assigns a task to `dev-botti` before it's `Open`; when `dev-botti` later opens its session, only it can pick up the work.

**Subtasks (one level only).** A task with `parentId` set is a subtask. The server rejects creating a subtask under a subtask — the depth is hard-capped at one. The motivation: the natural graph for FlowBoard work is *epic → tasks*, not arbitrary trees. Three levels deep means no one knows where to look.

Subtask IDs follow the parent: `T-128-1`, `T-128-2`, etc. Subtask numbering is per-parent; numbering gaps from deletions are not reused. Parent's status is *recalculated* when a subtask completes — if all subtasks are `done`, the parent transitions to `review` automatically.

**Soft-delete (`trashedAt`).** Deleting a task sets `trashedAt` to an ISO timestamp; the task disappears from the board but the row stays in the DB. A separate `DELETE /api/projects/:name/tasks/trash` empties the trash permanently. This is the only destructive operation that requires no confirmation prompt — the soft-delete step *is* the confirmation.

## Consequences

- **Optimistic UI with server reconciliation.** A drag-and-drop in the UI immediately updates the local state and fires the API call; on failure, the UI reverts and shows a toast. Same pattern for status changes via the picker. The API is the source of truth, the UI is the projection.
- **Lease expiry is silent.** A claimed task whose lease passed is *de facto* released — anyone can claim. The original holder is not notified. This avoids the multi-agent deadlock where one stuck agent blocks everyone else; the trade-off is that a long-running task without checkpoints can be lost mid-work. The convention is: any agent doing work longer than ~20 minutes should checkpoint regularly.
- **Status-without-claim is allowed.** A task can be in `In Progress` with no `agent` set (e.g. after auto-release on lease expiry). The UI shows this as an "abandoned" card and offers either re-claim or move-to-Review.
- **Subtask completion rolls up.** Completing the last subtask transitions the parent to `Review`, not `Done` — accepting the work is still an explicit step. This catches the failure mode where one subtask was missed but its sibling-completion silently completes the parent.
- **`Done` is not the end.** Tasks in `Done` can be moved back to any earlier state (re-opening), or moved to `Archived` (hidden but preserved), or soft-deleted (`trashedAt`). The HZL event log captures every transition, so the audit trail survives all of these.
- **Multi-agent visibility is structural.** The UI's per-task agent chip and the active-agents bar both read from `tasks_current.agent` and `flowboard_agents` directly. There is no separate "presence" or "online" signal — *who is holding a lease* is the presence signal. An idle agent has no claims, so they're not visible on the board until they pick something up.
- **Archived ≠ Trashed.** Archived is "this work is done and irrelevant for current planning, but I want it in the record." Trashed is "this should not have existed, hide it pending purge." Both preserve the row; only Trash → Empty removes it.

## Code

- `dashboard/hzl-service.js` — task lifecycle: `createTask`, `updateTask`, `claimTask`, `releaseTask`, `completeTask`, `addCheckpoint`, `routeTask`, `archiveTask`, `purgeTrash`. The 6-status enum lives in `VALID_STATUSES`; `FB_TO_HZL` / `HZL_TO_FB` map between FlowBoard's UI vocabulary and HZL's internal status names.
- `dashboard/src/pages/TasksView.jsx` — the board view. `STATUS_KEYS` defines the column order (`backlog`, `open`, `in-progress`, `review`, `done`); `STATUS_LABELS` is the UI vocabulary.
- `dashboard/src/components/DetailPanel.jsx` — per-task drawer with status picker, claim/release controls, blocked toggle, comment thread, checkpoint history.
- `dashboard/src/components/AgentChip.jsx`, `PriorityPill.jsx` — visual primitives for the per-task metadata.
- `dashboard/server.js` — endpoints under `/api/projects/:name/tasks/...` and `/api/projects/:name/tasks/:id/...`.
- HZL backend (external dependency `hzl-core`) — the event store and projection engine. `tasks_current` is its materialized view.

## See also

- [Multi-Agent Model](multi-agent-model.md) — what `tasks_current.agent` means in the cross-cutting picture, and how claims interact with `flowboard_agents`
- [HZL Event Sourcing](hzl-event-sourcing.md) — the event store and `tasks_current` materialization (planned, T-200-4)
- [Tasks API reference](../reference/api/tasks.md) — endpoint shapes for everything described here
- T-199-1 (backlog) — foundation ADR for the HZL Task-Bridge that anchors this surface
