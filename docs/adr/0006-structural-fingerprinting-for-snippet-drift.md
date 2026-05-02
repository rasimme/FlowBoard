# ADR-0006: Multi-phrase structural fingerprinting for snippet drift detection

## Status
Accepted

## Date
2026-05-02

## Source
- private spec `specs/T-196-structural-fingerprinting-boot-legacy.md` in operator's local FlowBoard project
- public commits `4471207` (initial fingerprinting + BOOT cleanup + installer marker injection) and `f69a724` (migrate fingerprint-only drifted agents)

## Context

The snippet doctor originally classified installed `AGENTS.md` files by exact byte match against a single canonical marker. Real installed copies had drifted: users had reordered sections, edited prose, or composed FlowBoard's snippet with their own additions. The byte-oriented matcher missed all of these and reported them as `missing` — which the UI then offered to install over, risking duplicate or fragmented blocks.

A second, distinct concern emerged with ADR-0005: `BOOT.md` is no longer FlowBoard-owned. The doctor must not auto-migrate or rewrite a user's BOOT.md, but it should still warn when old FlowBoard BOOT content lingers there.

A third concern: removing the `<!-- BEGIN/END FlowBoard external trigger -->` markers from the source `external-trigger.md` (so `/api/info` returns clean instructions) broke installer idempotency — repeat installs would no longer find a marker block to replace.

## Decision

`classifyFile()` uses **multi-phrase fingerprints** with a 75% match threshold:

- **Current** snippet phrases: `Check your status`, `GET /api/status`, `activeProject === null`, `lazy`, …
- **Legacy** snippet phrases: `FlowBoard delivers project context automatically`, `At session start`, `project context`, `Fetch individual sections on demand`, …

Current detection wins before legacy detection so an updated file with stray old prose is not repeatedly flagged. Byte-identical legacy snapshots become `identical`; structurally matched but byte-changed blocks become `drifted`. Drifted entries become migration candidates; current entries are skipped.

`BOOT.md` is removed from the doctor's `TARGETS`. A separate `bootLegacyFiles` list is returned with `state: 'legacy'` and `variant: 'info'` — no apply or migrate action, advisory only. User cleanup is manual because BOOT.md belongs to OpenClaw/user boot behavior, not FlowBoard.

`external-trigger.md` ships marker-free. `install-trigger.mjs` wraps the snippet with `<!-- BEGIN/END FlowBoard external trigger -->` markers at install time via `buildMarkedBlock()`. Repeat install replaces the existing marked block; uninstall removes it; the source file in `/api/info` stays clean.

## Consequences

- **Positive:** Real-world drifted snippets are correctly classified and migratable without forcing users back to a byte-identical copy.
- **Positive:** BOOT.md is OpenClaw/user territory; the doctor only advises.
- **Positive:** Installer idempotency restored without polluting `/api/info` output.
- **Negative:** Fingerprint thresholds are tuned to current and previous snippet versions. Future snippet revisions need their own fingerprint set; otherwise `current` and `legacy` confidence both fall below the 75% threshold and the file falls back to `missing`. Documented as a follow-up: explicit versioned fingerprints rather than phrase lists.
- **Negative:** A user editing `AGENTS.md` past the 75% legacy threshold is asked to migrate. This is intentional — the doctor's job is to surface drift — but contributors should know the threshold is conservative.
