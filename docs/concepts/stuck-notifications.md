# Stuck-Task Detection & Notifications

## What it is

A background check that finds tasks which have quietly stalled and nudges someone about them, without spamming the same task repeatedly.

## Why it exists

In a multi-agent board, work can stall silently: an agent claims a task and stops checkpointing, a lease expires, or a task is routed to an agent that never claims it. Nothing is "wrong" enough to error, but the work is stuck. A periodic check turns that invisible stall into an explicit signal.

## How it works

- **What counts as stuck** (from `getStuckTasks()`): `in-progress` with no checkpoint past a staleness threshold (per-task `staleAfterMinutes` overrides the global default), an **expired lease**, **routed-but-not-claimed** (a handoff-contract violation — see [agent bridge](../project-mode/agent-bridge.md)), or an actionable `waiting`/`blocked` state. A due `paused.checkAgainAt` is a nudge/re-evaluation signal; it never changes the task state.
- **Two views, one source:** the API endpoint `GET /api/tasks/stuck` returns *all* currently-stuck tasks (for dashboards). The scheduler calls `getNotifiableStuckTasks()` every ~5 minutes — the same set passed through **notification guards** so a task isn't re-notified every cycle — exposed as `GET /api/tasks/notifiable-stuck`.
- **Delivery** goes out through the OpenClaw gateway. Notification routing distinguishes **waking the owning agent** (so it can resume its own task) from **notifying a human operator** — the two are deliberately separable, so an agent can be re-prodded even when no operator channel is configured.

## Consequences

- Stalls surface as a notification and in the overview `stall-detection` ("Momentum") widget instead of going unnoticed.
- Tuning is per-task (`staleAfterMinutes`) or global; the guard window prevents notification storms.

## Where the code lives

- `dashboard/hzl-service.js` — `getStuckTasks()` and `getNotifiableStuckTasks()` (guard-filtered).
- `dashboard/server.js` — `GET /api/tasks/stuck`, `GET /api/tasks/notifiable-stuck`.
- Tests: `dashboard/test-compliance-detection.js`, `dashboard/test-stuck-notifications.js`.

## Canonical work state and transient indicators (T-443)

The task lifecycle remains `open → in-progress → review → done`.  It is
augmented by the canonical `workState` value `working`, `waiting`, `blocked`,
or `paused`, persisted in `metadata.flowboard.workState`.  The companion
`workStateDetails` object is returned with the stable keys `reason`,
`waitingFor`, `responsible`, `checkAgainAt`, and `setAt`; absent values are
`null`.  `blocked` is a computed compatibility projection (`true` exactly
when `workState === "blocked"`).  Legacy writes of `blocked: true` map to
`blocked`; `blocked: false` maps to the compatibility default `working`.
Supplying contradictory `blocked` and `workState` fields returns HTTP 400 with
`code: "WORK_STATE_CONTRADICTION"`.

Stuck monitoring persists one structured `stuckIndicator` in the same task
metadata.  Re-evaluation updates that key in place and never appends reminder
comments.  Checkpoints, recovery/work-state edits, release, review, and
completion clear the indicator; a future `checkAgainAt` only schedules a
re-evaluation and cannot change lifecycle, ownership, or work state.

Delivery is deduplicated per task with persisted notification timestamps and a
capped exponential backoff. Only the configured `FLOWBOARD_WAKE_AGENT` is
bundled into the safe `/hooks/wake` channel; other OpenClaw or external owners
receive pull-based board/status attention, and unowned work is bundled into one
operator escalation on the dedicated non-live session key. Clearing an
indicator also resets its notification/backoff state, so a new incident is
immediately eligible.
