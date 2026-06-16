# Stuck-Task Detection & Notifications

## What it is

A background check that finds tasks which have quietly stalled and nudges someone about them, without spamming the same task repeatedly.

## Why it exists

In a multi-agent board, work can stall silently: an agent claims a task and stops checkpointing, a lease expires, or a task is routed to an agent that never claims it. Nothing is "wrong" enough to error, but the work is stuck. A periodic check turns that invisible stall into an explicit signal.

## How it works

- **What counts as stuck** (from `getStuckTasks()`): `in-progress` with no checkpoint past a staleness threshold (per-task `staleAfterMinutes` overrides the global default), an **expired lease**, or **routed-but-not-claimed** (a handoff-contract violation — see [agent bridge](../project-mode/agent-bridge.md)).
- **Two views, one source:** the API endpoint `GET /api/tasks/stuck` returns *all* currently-stuck tasks (for dashboards). The scheduler calls `getNotifiableStuckTasks()` every ~5 minutes — the same set passed through **notification guards** so a task isn't re-notified every cycle — exposed as `GET /api/tasks/notifiable-stuck`.
- **Delivery** goes out through the OpenClaw gateway. Notification routing distinguishes **waking the owning agent** (so it can resume its own task) from **notifying a human operator** — the two are deliberately separable, so an agent can be re-prodded even when no operator channel is configured.

## Consequences

- Stalls surface as a notification and in the overview `stall-detection` ("Momentum") widget instead of going unnoticed.
- Tuning is per-task (`staleAfterMinutes`) or global; the guard window prevents notification storms.

## Where the code lives

- `dashboard/hzl-service.js` — `getStuckTasks()` and `getNotifiableStuckTasks()` (guard-filtered).
- `dashboard/server.js` — `GET /api/tasks/stuck`, `GET /api/tasks/notifiable-stuck`.
- Tests: `dashboard/test-compliance-detection.js`, `dashboard/test-stuck-notifications.js`.
