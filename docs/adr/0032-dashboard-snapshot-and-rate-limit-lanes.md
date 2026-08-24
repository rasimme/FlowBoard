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
metadata and `Retry-After`; clients pause only the affected lane and retain
their last valid data. Authentication failures stop background polling until an
explicit retry.

## Consequences

Legacy endpoints remain available for compatibility and agents. The snapshot
contract can evolve under an explicit version without forcing consumers onto a
new global state model. In-memory limiter state remains process-local; a
multi-instance deployment would need a shared limiter in a future decision.
