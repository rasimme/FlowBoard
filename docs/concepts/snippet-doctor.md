# Snippet Doctor

## What it is

The mechanism that keeps the small FlowBoard "trigger" blocks installed in workspace files (`AGENTS.md`, and the legacy `BOOT.md`) in sync with the canonical snippet shipped in the repo — detecting drift and offering safe upgrades.

## Why it exists

The trigger snippet evolves (new rule sections, contract bumps). Installed copies in many workspaces would silently fall behind, and a user may have hand-edited theirs. A byte diff is too brittle (whitespace, reordering); blindly overwriting would clobber user edits. The doctor needs to tell *byte-identical-but-old* apart from *user-modified* apart from *absent*, and act differently for each.

## How it works

- **Structural fingerprinting** ([ADR-0006](../adr/0006-structural-fingerprinting-for-snippet-drift.md)): the doctor matches on a set of stable phrases/markers rather than an exact byte match, so cosmetic differences don't read as drift.
- It classifies each workspace: **byte-identical legacy** → safe auto-**upgrade** to the new canonical block; **user-edited** → **migration required**, force-replace only with per-file opt-in; **absent** → **add**; **not-applicable** → dismiss.
- Every change writes a `.bak-<timestamp>` copy first. The same detection runs from the dashboard setup modal and from the `snippets-doctor.js` CLI (`--apply` upgrades byte-identical blocks only).
- Vendored copies under `snippets/legacy/*.vN.md` are the references the fingerprint compares against.

## Consequences

- Upgrades are safe-by-default: user edits are never silently overwritten, and every write is backed up.
- The minimal-snippet contract is enforceable — the doctor flags a snippet that grew beyond a trigger.

## Where the code lives

- `dashboard/snippets-doctor.js` — detection + state machine.
- `dashboard/install-trigger.mjs` — marker-wrapped install for external repos.
- `snippets/AGENTS-trigger.md`, `snippets/external-trigger.md`, `snippets/legacy/*`.
- Foundation: [ADR-0006](../adr/0006-structural-fingerprinting-for-snippet-drift.md).
