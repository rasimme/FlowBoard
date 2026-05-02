# Architecture Decision Records (ADRs)

Immutable records of architectural decisions that shaped FlowBoard. Each ADR captures *what was decided, when, and why* — once accepted, an ADR is not edited. If a later decision overrides an earlier one, a new ADR supersedes the old.

## Template

Each ADR follows the [Nygard-style](https://martinfowler.com/bliki/ArchitectureDecisionRecord.html) template:

```markdown
# ADR-NNNN: <decision title>

## Status
Draft | Accepted | Superseded by ADR-MMMM

## Date
YYYY-MM-DD

## Source
The artefact this ADR distils. Concrete reference required for `Status: Accepted`:
- private spec (`specs/T-XXX-name.md` in operator's local FlowBoard project), or
- public commit `<hash>` and message, or
- code comment at `<file:line>`.

ADRs without a concrete source artefact stay `Status: Draft`.

## Context
The forces that influenced the decision.

## Decision
What we decided to do.

## Consequences
What follows — positive and negative.
```

## Numbering

ADRs are numbered monotonically: `0001`, `0002`, …. Numbers are assigned at merge time to avoid collisions on parallel branches.

## Index

<!-- Accepted ADRs only. Drafts are not linked from llms.txt or the index. -->

- [ADR-0001](0001-live-inject-bootstrap.md) — Project context delivered via live-inject, not file-write (2026-05-01)
- [ADR-0002](0002-api-status-requires-agent-id.md) — `/api/status` requires an explicit agentId (2026-04-30)
- [ADR-0003](0003-dashboard-has-no-agent-identity.md) — The dashboard service has no agent identity (2026-04-30)
- [ADR-0004](0004-disk-bootstrap-is-non-authoritative.md) — On-disk `BOOTSTRAP.md` is non-authoritative (2026-05-01)
- [ADR-0005](0005-minimal-trigger-and-lazy-rules.md) — Minimal-trigger snippet + lazy rule loading (2026-05-02)
- [ADR-0006](0006-structural-fingerprinting-for-snippet-drift.md) — Multi-phrase structural fingerprinting for snippet drift detection (2026-05-02)
- [ADR-0007](0007-hzl-task-bridge-and-brain-muscle-split.md) — HZL Task-Bridge + Brain/Muscle split (umbrella, retroactive 2026-04-01)
- [ADR-0008](0008-hzl-single-writer-constraint.md) — HZL DB single-writer constraint (retroactive 2026-04-01)
- [ADR-0009](0009-blocked-as-flag-not-status.md) — `blocked` is a flag, not a status (retroactive 2026-04-01)
- [ADR-0010](0010-subtask-depth-max-one.md) — Subtask depth hard-capped at one level (retroactive 2026-04-01)
- [ADR-0011](0011-external-agent-discovery.md) — External-agent discovery via `/api/info` and self-onboarding snippet (2026-04-30)
- [ADR-0012](0012-canvas-migration-deferred.md) — Canvas migration deferred — vanilla retained pending scope review (2026-05-03)

## See also

- [Concepts](../concepts/) — the *why* layer (current architecture truth)
- [llms.txt](../../llms.txt) — agent-facing index
