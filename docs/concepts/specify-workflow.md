# Specify Workflow

## What

The Specify Workflow is the agent-driven process that converts unstructured input (canvas notes, but the architecture is extensible to other origins) into structured FlowBoard work — task records, optionally with spec files. It is a six-step pipeline (analyze, clarify, generate, confirm, persist, done) executed by an agent in conversation with the user, bookended by a server-side **Specify Session** that tracks the bridge from input to output.

The session is the bookkeeping; the workflow is the discipline. The session prevents collisions (an agent can have at most one active session) and provides rollback context (the input note ids are remembered so cleanup can find them). The workflow is encoded in the prompt template `context/specify-prompt.md` (per-project file) — it is *content*, not code, so it can be revised per project without server changes.

## Why

The motivating problem: unstructured input + structured output is a gap that humans solve poorly. Asked to convert a cluster of brainstormed notes into tasks, the typical human jumps straight to creating tasks — and then realizes mid-way that a spec was needed, or that this should have been one task with three subtasks instead of three peer tasks. The structuring decision is best made *after* the input is fully understood, but a freeform conversation tends to commit early.

Specify codifies that "understand first, structure second" discipline as a 6-step protocol the agent must follow. The step order is the value: ANALYZE before CLARIFY before GENERATE means the agent commits to a task-structure proposal only after assessing scope. The CONFIRM step before PERSIST means the user can reject a structure proposal *before* any spec or task exists — no rollback needed because nothing was written.

The server-side session exists for two reasons. First, it enforces *one-at-a-time-per-agent* concurrency at the API boundary, so two simultaneous canvas promotes for the same agent can't tangle. Second, it gives explicit abort and complete endpoints — the agent or the UI can signal terminal state, and stale sessions become visible (lastActivity timestamp). Without a session, a failed-mid-step workflow would leak inconsistent state.

## How

The workflow is two concurrent state machines: the *agent's* (the 6 steps it executes in conversation with the user) and the *server's* (the session lifecycle).

**The agent's six steps:**

```
1. ANALYZE   — assess across 5 categories (Scope, Users, Data, Behavior, Constraints).
                Decide: Simple or Complex.
2. CLARIFY   — if Complex: ask max 4 questions, one at a time, each with a
                recommended answer. Skip if Simple.
3. GENERATE  — write a spec following context/specify-spec-template.md.
                Decide task structure: one of
                  (a) 1 task
                  (b) parent task + subtasks (sharing one spec)
                  (c) parent task + subtasks, each with its own spec file
4. CONFIRM   — show summary to user. Wait for explicit confirmation.
5. PERSIST   — strict ordering:
                  (i)   write spec file(s)
                  (ii)  create task(s) via API
                  (iii) delete canvas notes via batch-delete
6. DONE      — confirmation message; call POST .../complete on the session.
```

The strict ordering in step 5 is rollback-safe: spec files are written first (reversible by deletion); tasks are created next (reversible by deletion); canvas notes are deleted last (irreversible — but only after the rest succeeded). Failure in step 5(i) — abort, nothing persisted. Failure in 5(ii) — delete the spec file, abort. Failure in 5(iii) — tasks remain (they're valid), notes stay (also fine — the user can re-promote without canvas data loss).

**The server's session lifecycle:**

```
                createSession()
                       │  validates: agent has no other active session;
                       │  no overlap of sourceNoteIds with another active
                       │  session for the same project
                       ▼
                  status: active
                       │
        ┌──────────────┼──────────────┐
        │                             │
        ▼                             ▼
   abortSession()              completeSession()
        │                             │
        ▼                             ▼
  status: aborted              status: done
   (terminal)                   (terminal)
```

**Sessions live in RAM only.** The session store (`dashboard/specify-sessions.js`) is a `Map<id, session>` — no database, no file I/O, no persistence across server restarts. Sessions exist for minutes (the time of one Specify conversation); a server restart aborts everything in flight implicitly, which is the correct semantics — agents that lose their session mid-workflow should restart cleanly rather than try to recover. This is a deliberate asymmetry to the rest of FlowBoard's persistence model (HZL event store, canvas.json) — Specify sessions are *transactional bridges*, not records to keep.

**Concurrency is enforced at the agent level, not project level.** Two different agents (`dev-botti` and `claude-code`) can have simultaneous active sessions for the same project, working on different note clusters. One agent cannot have two active sessions in any project — the constraint is "one Specify dialogue at a time per agent."

**Note-overlap rejection.** A second session for the same project that lists overlapping `sourceNoteIds` is rejected with 409. This is a guard against the failure mode where canvas A and canvas B both promoted the same notes — the second promote returns an error rather than creating a parallel session.

**The session's `origin` field is extensible.** Today it is always `canvas` — the canvas-promote endpoint creates the session. The field exists because the workflow itself is generic: any origin that produces unstructured input could create a Specify session. Voice transcription, email, even a paste from another tool — none implemented today, but the field reserves the namespace.

**Wake message format.** When canvas promote creates a session, it sends a structured `[SPECIFY_SESSION]` message via the OpenClaw gateway webhook. The message embeds session id, project, origin, mode, the notes themselves, the connections, and the workflow steps as numbered instructions. The agent receives it as the next message in its session and starts at step 1.

## Consequences

- **A server restart cancels every in-flight Specify session.** No recovery, no resume. This is appropriate given the workflow length (minutes) but means operators should avoid restarting the dashboard while a Specify dialogue is happening — a restart will leave the agent talking to a session id the server no longer knows about, and the eventual `/complete` will return 404.
- **There is no "history" of past Specify sessions.** Once a session is `aborted` or `done`, it stays in the in-memory map until restart. There is no DB query for "all Specify sessions in the last 30 days" — that's by design (sessions are bridges, not records). The actual audit trail of *what was created* lives in the HZL event log of the resulting tasks.
- **The 6-step protocol is content, not code.** It lives in `context/specify-prompt.md` per project. A project that wants different rules (e.g. "always create a parent + subtasks for clusters of 4 or more notes") edits its prompt file. The server doesn't enforce or validate the protocol — it only enforces the session lifecycle.
- **The agent owns the structure decision.** Step 3 says the agent decides "1 task / parent+subtasks / parent+subtasks-with-specs." The user only confirms in step 4. This is the same trade-off as Idea Canvas: the agent is the architect of the resulting work, not the user. Users who want manual control should create tasks via the Kanban API, not via canvas promote / Specify.
- **Step ordering in PERSIST is the rollback contract.** Spec → Tasks → Canvas-cleanup. Any contributor changing the persist order risks a failure mode where canvas notes are deleted before the spec is written, leaving the user with no source-of-record for what was promoted. The order is documented in `context/specify-prompt.md` and in the wake message itself; both must stay aligned.
- **Two agents with the same agent-id collide.** If both `claude-code` instances on different machines try to promote canvas notes in the same project at the same time, the second one gets 409. This is correct (one logical agent shouldn't run two Specify dialogues) but worth knowing for operators running multiple machines under the same agent-id.

## Code

- `dashboard/specify-sessions.js` — the session store. Pure in-memory Map; functions: `createSession`, `getSession`, `getActiveSessionForAgent`, `updateSession`, `abortSession`, `completeSession`, `listSessions`.
- `dashboard/server.js` — endpoints under `/api/specify/sessions/...`. Session creation is internal (called from the canvas promote handler), not a public endpoint.
- `dashboard/server.js` (canvas promote, around line 1916) — the integration point: creates the session, builds the `[SPECIFY_SESSION]` wake message, fires the gateway webhook.
- `context/specify-prompt.md` (per active project) — the 6-step protocol the agent runs. Authored content, not generated.
- `context/specify-spec-template.md` (per active project) — the template the agent uses in step 3. Authored content.

## See also

- [Idea Canvas](idea-canvas.md) — the only origin that creates Specify sessions today
- [Kanban](kanban.md) — where the resulting tasks land
- [Multi-Agent Model](multi-agent-model.md) — how `agentId` routing and the 1-per-agent concurrency rule fit together
