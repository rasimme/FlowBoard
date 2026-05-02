# ADR-0004: On-disk BOOTSTRAP.md is non-authoritative; only the run-context copy is

## Status
Accepted

## Date
2026-05-01

## Source
- private spec `specs/T-181-live-inject-anti-stale.md` in operator's local FlowBoard project
- public commits `9db42df` (snippet rewording, session-start state-check) and `4001920` (regression test asserting hook never writes a disk file)

## Context

ADR-0001 stopped the hook from writing `BOOTSTRAP.md` to disk, but pre-existing on-disk copies remained. The trigger snippet still said *"Read `BOOTSTRAP.md` — that is your project context"*, which an agent reasonably interpreted as a Read-tool call on the workspace path. On 2026-05-01 `dev-botti` did exactly that: it read a 21-hour-old file written by the legacy hook, and the answer happened to be correct only because the underlying DB row hadn't changed. Across all seven workspaces on the operator's machine, every `BOOTSTRAP.md` on disk was stale — none carried the T-168-5 anti-inference markers or the T-177-5 anti-trust phrasing. Hardening that lives only in the live-inject path is wasted if the consumer reads from disk.

A taxonomy clarification was needed before editing: `BOOTSTRAP.md` as the **injected context name** (the loader-recognized basename) is unchanged; `BOOTSTRAP.md` as an **on-disk generated file** is what's being removed; `ACTIVE-PROJECT.md` as a **legacy migration/fallback** stays only in two narrow paths (hook fallback when the FlowBoard API is unreachable, and the `m003` one-shot backfill).

## Decision

The trigger snippets (`AGENTS-trigger.md`, `external-trigger.md`) now say explicitly that `BOOTSTRAP.md` is delivered into the run context and that the on-disk copy is *not authoritative* — agents must not use the Read tool on the workspace path. Existing stale `~/.openclaw/workspace*/BOOTSTRAP.md` files were removed in a one-shot cleanup. A regression test parses the hook source and asserts no `fs.writeFileSync(.*BOOTSTRAP)` pattern exists, so the behavior cannot regress under future refactors. Hook telemetry (`console.log` on success) is gated behind `FLOWBOARD_HOOK_TELEMETRY=1`; error logs stay ungated.

## Consequences

- **Positive:** Only the live-injected, per-run content is canonical — closing the last gap in ADR-0001's architecture.
- **Positive:** All snippet hardening (anti-inference, anti-trust) now actually reaches the agent on every turn.
- **Positive:** Regression-guarded: future contributors cannot reintroduce file writes without the test failing.
- **Negative:** External agents (Codex, Cursor, Claude Code) get no live-inject — they have no workspace and no `agent:bootstrap` hook. They fetch on demand via `GET /api/projects/<name>/bootstrap`. ADR-0005 covers the on-demand model.
