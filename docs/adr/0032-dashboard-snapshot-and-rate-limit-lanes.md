# ADR-0032: Versioned dashboard snapshot and isolated rate-limit lanes

## Status
Accepted

## Date
2026-08-24

## Source
Private FlowBoard spec `specs/T-445-dashboard-rate-limit-resilienz-snapshot.md`.

## Context

The dashboard shell previously assembled its state from several independent
polling reads. Under load, overlapping reads could consume the same API budget
as agent checkpoints and leave the UI without a coherent last-known snapshot.

## Decision

Expose an additive `GET /api/dashboard/snapshot/v1` endpoint that builds the
projects, agents, status, and viewed-project task read model in-process. The
React shell uses one non-overlapping five-second snapshot lane; FilesView keeps
an independent visible-only 15-second metadata lane. Server rate limiting uses
separate read, mutation, and checkpoint keys based on a verified session
principal or trusted transport identity. Rejections return structured `429`
metadata and `Retry-After`; clients pause only the affected lane, wait for the
advertised duration plus jitter, and make at most one retry while retaining
their last valid data. Unauthenticated remote clients share a bucket per
transport IP; caller-supplied agent ids never form a key. The existing direct
loopback skip remains in force. Authentication failures stop background polling
until an explicit retry.

The rollout has an explicit operator switch: setting
`FLOWBOARD_ENABLE_DASHBOARD_SNAPSHOT=false` and restarting makes the dashboard
use the legacy independent reads. The snapshot endpoint reports
`503 DASHBOARD_SNAPSHOT_DISABLED` while that manual rollback is active.

## Consequences

Legacy endpoints remain available for compatibility and agents. The snapshot
contract can evolve under an explicit version without forcing consumers onto a
new global state model. In-memory limiter state remains process-local; a
multi-instance deployment would need a shared limiter in a future decision.
The rollback flag is deliberately manual and restart-scoped so an operator can
contain a regression without silently changing the active request lane.
