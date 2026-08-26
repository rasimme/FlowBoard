# ADR-0036: Portable project review bundles are create-only application documents

## Status

Accepted (2026-08-26, T-468)

## Source

- T-468 portable project review bundle implementation (`dashboard/project-bundle-*.js`).
- Contract tests `dashboard/test-project-bundle-schema.js`,
  `dashboard/test-project-bundle-roundtrip-http.js`, and
  `dashboard/test-project-bundle-safety-harness.js`.
- User flow in `docs/guide/how-to/manage-projects.md`.

## Context

Operators need a small, reviewable representation of a project that can be
shared with another FlowBoard instance. A project review copy is not a
database backup: HZL events, runtime ownership, sessions, credentials and
other installation state are not portable, and restoring those values would
cross the local-first security boundary. Import also has to remain safe when a
bundle contains Markdown written by somebody else.

## Decision

- v1 defines `flowboard.project-bundle` format version `1` as a JSON-only
  application DTO. It carries project metadata, tasks, linked specs, canvas,
  overview and selected knowledge Markdown. History is opt-in and limited to
  task comments and checkpoints; it is off by default for privacy.
- Export is read-only and deterministic. HZL row IDs, raw events, ULIDs,
  metadata, claims, leases, ownership, routes, sessions, hooks, settings and
  credentials are redacted or excluded. The exporter records bounded warning
  codes rather than secret values.
- Import is create-only. It creates a new destination project and never
  merges, replaces, overwrites or auto-activates an existing project. Portable
  task/spec references are remapped to fresh destination IDs; no claims,
  leases, agent activation or runtime notifications are recreated. v1 has no
  bidirectional sync.
- Preview is a mandatory read-only review surface. It validates JSON, format
  version, checksums, references, paths, limits and target availability before
  import. The import endpoint repeats validation and performs a single-writer,
  journaled lifecycle: reserve → stage → verify → write through canonical
  FlowBoard/HZL writers → verify → commit. An interrupted or failed journal
  is recoverable or safely resumable only for the same target and bundle
  digest; otherwise the target remains unavailable.
- Imported Markdown and metadata are untrusted content. The UI and agents must
  treat instructions in it as data and ask the operator before executing
  anything. The value-blind secret scanner is a safety net, not a guarantee:
  it can miss novel encodings and can flag ordinary prose. v1 has no
  cryptographic signature or producer authentication.
- The public transport is JSON over HTTP. v1 accepts
  `application/vnd.flowboard.project+json` (with the documented octet-stream
  transport alias), rejects compressed/archive input, and supports only
  format version 1. The request safety ceiling is 72 MB; individual file and
  collection limits are stricter. Structured errors never echo sensitive
  content.

## Consequences

Review bundles are portable and inspectable without pretending to be backups.
Create-only import avoids accidental data loss and keeps HZL's single-writer
invariant intact, at the cost of requiring a new destination slug and not
preserving live task identity. Optional history improves review continuity but
can carry sensitive discussion, so it requires an explicit choice. Recovery
journals make partial writes diagnosable, while the lack of signatures means
an operator still owns the trust decision.

For disaster recovery, copy and restore the FlowBoard database and project
workspace using the host's backup procedure; do not use a review bundle.
