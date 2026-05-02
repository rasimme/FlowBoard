# Spec: T-196 — Doctor Structural Fingerprinting + BOOT Legacy Advisory

## Problem

The snippet doctor originally detected installed FlowBoard snippets with brittle, byte-oriented markers. Real installed workspaces had drifted copies of `AGENTS.md`: the FlowBoard block was still clearly present, but exact marker phrases or byte-identical snapshots no longer matched. Result: the UI/API could miss legacy installs or show them as plain missing setup.

At the same time, the new lazy-loading architecture makes `BOOT.md` no longer FlowBoard-owned. The doctor must not auto-migrate or rewrite `BOOT.md`, but it should still warn users when old FlowBoard BOOT content remains.

## Goals

1. Detect legacy/drifted `AGENTS.md` snippets using structural fingerprints, not one exact marker.
2. Keep canonical/current detection robust enough to avoid re-flagging already-updated files.
3. Remove `BOOT.md` from auto-migration targets.
4. Surface legacy FlowBoard content in `BOOT.md` as display-only advisory.
5. Preserve installer idempotency for external agents after `external-trigger.md` was simplified.
6. Cover all behavior with regression tests.

## Non-goals

- Do not rewrite arbitrary user-authored `BOOT.md` files.
- Do not infer project state from file contents.
- Do not put FlowBoard project context back into OpenClaw-owned `BOOTSTRAP.md`/`BOOT.md`.

## Design

### AGENTS.md classification

`classifyFile()` now uses multi-phrase fingerprints:

- Current snippet fingerprint: phrases such as `Check your status`, `GET /api/status`, `activeProject === null`, `lazy`.
- Legacy snippet fingerprint: phrases from the previous always-on AGENTS block, such as `FlowBoard delivers project context automatically`, `At session start`, `project context`, and `Fetch individual sections on demand`.
- A threshold match (75%) classifies a file as current or legacy/drifted.
- Byte-identical legacy snapshots still become `identical`; structurally matched but changed blocks become `drifted`.

Current detection wins before legacy detection, so files with the new snippet plus stray old prose are not repeatedly flagged.

### BOOT.md behavior

`BOOT.md` is removed from `TARGETS`; it is not upgradeable/migratable by the doctor.

A separate `bootLegacyFiles` list is returned by `collectStatus()` when old FlowBoard BOOT content is detected. These entries are informational only:

- state: `legacy`
- variant: `info`
- no apply/migrate action
- user cleanup is manual because BOOT.md belongs to OpenClaw/user boot behavior, not FlowBoard.

### External installer idempotency

`external-trigger.md` no longer carries `<!-- BEGIN/END FlowBoard external trigger -->` markers in the source file. That keeps `/api/info` output as clean minimal instructions.

`install-trigger.mjs` now wraps the source snippet with markers at install time via `buildMarkedBlock()` before writing to target `AGENTS.md`. This preserves:

- repeat install = replace existing marked block, not append duplicate
- uninstall = remove marked block
- source snippet = marker-free minimal instructions

## Acceptance criteria

- Drifted real-world AGENTS files are recognized as `drifted`.
- Current files are skipped from the UI list.
- Missing files remain opt-in setup entries.
- BOOT legacy files are returned as advisory entries, not migratable files.
- Running `install-trigger.mjs --repo <repo> --no-symlink` twice leaves `AGENTS.md` byte-identical and with exactly one marker block.
- `/api/info.trigger_snippet` includes the external-agent trigger heading and `GET /api/status` lazy-loading guidance.
- Regression suites pass.

## Evidence / tests

Verified locally after implementation:

- `node dashboard/test-snippets-doctor.js` → 109/109 passed
- `node dashboard/test-snippets-integration.js` → 82/82 passed
- `node dashboard/test-snippets-realdata.js` → dry-run real workspace classification, no writes
- `node dashboard/test-t168-t177-integration.js` → 74/74 passed, including new installer idempotency coverage

## Risk notes

- Fingerprint thresholds are intentionally conservative. Future snippet versions should add explicit versioned fingerprints instead of relying on a single phrase.
- BOOT.md cleanup is deliberately manual to avoid deleting user/OpenClaw boot instructions.
- Marker removal from source snippets is safe only because the installer now injects markers into installed files.

## Related tasks

- T-188: Minimal-trigger architecture and BOOT ownership cleanup
- T-179: External-agent discovery and installer
- T-196-1: Fingerprinting engine
- T-196-2: V2 AGENTS fingerprint
- T-196-3: BOOT.md legacy advisory
- T-196-4: Fuzzy matching tests
