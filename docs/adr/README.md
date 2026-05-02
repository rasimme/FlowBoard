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

(none yet — first wave arrives with T-197-4)

## See also

- [Concepts](../concepts/) — the *why* layer (current architecture truth)
- [llms.txt](../../llms.txt) — agent-facing index
