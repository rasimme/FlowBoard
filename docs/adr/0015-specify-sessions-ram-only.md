# ADR-0015: Specify sessions are RAM-only — no DB persistence, no resume across restarts

## Status
Accepted

## Date
2026-05-02

## Source
- code at `dashboard/specify-sessions.js`: pure in-memory `Map<id, session>`, no file IO, no DB
- code-comment invariant in the same file: *"In-memory session state for active Specify sessions. No database, no file I/O — pure RAM state, lost on server restart."*
- concept doc [`docs/concepts/specify-workflow.md`](../concepts/specify-workflow.md) — the workflow this session bookkeeps for

## Context

The Specify Workflow (ADR-pending in the umbrella sense; described in the [Specify Workflow concept doc](../concepts/specify-workflow.md)) is a 6-step agent-driven pipeline that converts canvas notes into structured tasks. Between the canvas-promote API call and the eventual task creation, a server-side **Specify Session** tracks the bridge: which notes are being processed, which agent owns the dialogue, what stage it's at.

A natural design instinct is to persist this session in HZL or in a JSON file — sessions are *state*, persisted state is *recoverable*, recoverable state is *good*. That instinct is wrong here for three reasons:

- **Sessions are short-lived.** A Specify dialogue runs for minutes (analyze → clarify → generate → confirm → persist → done). The window of "session exists, has not yet completed" is the duration of the conversation. Persistence pays a write cost on every state transition; lifetimes shorter than backup intervals don't benefit.
- **Resume semantics are wrong.** If the server restarts mid-dialogue, the agent has lost its context too — the server's session restoration doesn't help if the agent doesn't have anywhere to plug it back into. The right behavior on restart is *abort*, not *resume*.
- **Audit lives in the artifacts.** The output of a successful Specify session is a spec file plus task records. Both are persisted (spec file on disk, task in HZL with full event log). The session itself is a transactional bridge, not the system of record. Once `persist` succeeds, the session is done; once it fails, the session is aborted. Either way, the session has fulfilled its purpose and disappears.

Persistence here would solve a problem that doesn't exist while introducing a problem that does (stale sessions in the DB after server restart, waiting for an agent that no longer remembers them).

## Decision

Specify sessions live in a single in-memory `Map<id, session>` in `dashboard/specify-sessions.js`. The map is built fresh on server start and lost on server stop. There is no database persistence, no file IO, no recovery mechanism. A server restart cancels every in-flight Specify session implicitly.

The session API is intentionally minimal:

- `createSession({project, origin, sourceNoteIds, agentId})` — adds an entry; rejects if the agent already has an active session or if `sourceNoteIds` overlap an active session for the same project.
- `getSession(id)`, `getActiveSessionForAgent(agentId)`, `listSessions({project, status})` — read-only queries.
- `updateSession(id, patch)`, `abortSession(id)`, `completeSession(id)` — state transitions; the latter two are terminal.

The HTTP surface (`/api/specify/sessions/...`) exposes read, abort, and complete; create is internal (called from the canvas-promote handler).

## Consequences

- **Server restart cancels every active Specify dialogue.** Operators should avoid restarting the dashboard while a Specify dialogue is in progress. The agent will eventually call `/abort` or `/complete` on a session id the server no longer knows; the response will be `404 Session not found`. The agent (or its operator) handles this by acknowledging the failure and starting fresh — no data is lost because nothing was committed.
- **No session history.** Once aborted or completed, sessions stay in the in-memory map until the next restart. There is no DB query for "all Specify sessions in the last 30 days." The audit trail of *what was created* lives in the HZL event log of the resulting tasks; the audit trail of *what was attempted* is not preserved past the process lifetime.
- **One-active-per-agent is a process-wide constraint.** The collision check (`getActiveSessionForAgent`) only sees sessions in the current process. An agent that was active in the previous process is no longer active after restart — the post-restart server will accept a new `createSession` even if pre-restart there was an active session. This is correct (the previous session is implicitly aborted by the restart) but surprising if the operator doesn't understand the lifecycle.
- **Operational simplicity.** No migration scripts when the session schema changes — there's no on-disk schema. No backup/restore concerns. The price is the lack of resume; for short-lived bridges, that's the right trade.
- **Scaling is bounded but reasonable.** A single map of active sessions; each session is hundreds of bytes. Even with hundreds of concurrent sessions (an unlikely scenario for a personal-tool deployment), the memory footprint is trivial. The constraint on this approach is *clustering*, not *capacity* — see next.
- **No multi-process FlowBoard deployment.** ADR-0008 already documents that the HZL DB has a single writer. The Specify session map adds another reason: a second dashboard process would have its own in-memory session map; an agent's session created on process A would be invisible to process B. Like ADR-0008's constraint, this is enforced by convention, not by mechanism.
