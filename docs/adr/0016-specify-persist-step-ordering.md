# ADR-0016: Specify PERSIST step — strict ordering as rollback contract

## Status
Accepted — **amended 2026-06-10** (T-262-16)

> **Amendment:** the dashboard persistence path (`persistSpecifyProposal` in
> `dashboard/server.js`) now creates the first task *record* before writing
> the spec file, because canonical spec naming (`specs/<taskId>-<slug>.md`,
> via the shared `writeSpecFileForTask` helper) requires the task id. The
> effective order is: create parent/single task record → write spec file(s) →
> create remaining task records → delete canvas notes. The *invariant* of this
> ADR is unchanged: the irreversible step (canvas-note deletion) still runs
> strictly last, and every reversible step before it is rolled back
> automatically on failure (spec files removed, created task records
> archived). HZL task records are reversible, so creating one before the spec
> does not weaken the contract. The chat-agent instructions in
> `specify-prompt.md` keep the original spec-first wording for the
> agent-driven path; both paths preserve the notes-last invariant.

## Date
2026-05-02

## Source
- workflow definition in `context/specify-prompt.md` (per-project file) — the 6-step protocol
- canvas-promote message template in `dashboard/server.js:1981` — *"PERSIST (in order): Write spec file(s) → Create task(s) via API → Delete canvas notes via batch-delete."*
- concept doc [`docs/concepts/specify-workflow.md`](../concepts/specify-workflow.md) — the rollback semantics

## Context

The Specify Workflow's step 5 (PERSIST) writes results to three different stores:

1. spec file(s) on disk under `~/.openclaw/projects/<name>/specs/`
2. task record(s) in HZL via `POST /api/projects/:name/tasks`
3. canvas note deletion(s) via `DELETE /api/projects/:name/canvas/notes/batch`

The three are independent — no transaction encloses them. Any one can fail mid-step (disk full, HZL constraint violation, network blip on the canvas API). Without an ordering convention, a partial failure leaves the system in any of several broken states:

- **Tasks created without specs** — the task references a `specFile` that doesn't exist; the agent chose a structure but the explanation is gone.
- **Specs written without tasks** — orphan spec files in the project directory; nothing on the Kanban references them; the user sees no result of their promote.
- **Canvas notes deleted without tasks/specs** — the worst failure mode. The user's brainstorming work is gone, with no replacement to show for it. The promote disappeared the input and produced no output.

The third failure mode is worst because it's irreversible. Spec files can be deleted; task records can be deleted; canvas notes, once batch-deleted, cannot be recovered without backup. *Ordering* is the cheap mitigation: do the irreversible step last, after the reversible steps have succeeded.

## Decision

Step 5 (PERSIST) of the Specify Workflow MUST execute in this order:

1. **Write spec file(s).** Reversible: a partial spec write can be deleted before proceeding.
2. **Create task(s) via API.** Reversible: an over-created task can be deleted via the task API. The task records reference the spec file(s) written in step 1.
3. **Delete canvas notes via batch-delete.** Irreversible at the canvas level; only run after steps 1 and 2 succeeded.

Failure handling:

- **Failure in step 1** — abort the session (`POST /api/specify/sessions/:id/abort`), inform the user, persist nothing else. No cleanup needed; no other store was touched.
- **Failure in step 2** — delete the spec file(s) written in step 1, abort the session, inform the user. Canvas notes stay; the user can re-promote without canvas data loss.
- **Failure in step 3** — accept the partial success. Tasks exist (they're valid), specs exist (they're valid), canvas notes also still exist (they're idempotent — extra copies are not harmful). The user can manually delete the canvas notes if they want; the system reports success on tasks/specs.

The ordering and the failure handling are encoded in `context/specify-prompt.md` (the agent's instructions) and in the canvas-promote wake message itself. Both must stay aligned. The agent calls `/abort` or `/complete` on the session as the terminal action of any path.

## Consequences

- **Worst-case outcome is bounded.** A failure during PERSIST cannot disappear the user's input *and* fail to produce output. If canvas notes were deleted, tasks and specs exist (because step 3 only runs after steps 1 and 2 succeeded). If canvas notes were not deleted, the user can re-promote.
- **The reverse ordering would be catastrophic.** Deleting canvas notes first, then trying to write spec/tasks, would lose user data on every spec-write or task-create failure. The order is asymmetric on purpose.
- **Step 3 idempotency matters.** A canvas-note batch delete that partially succeeds (some notes deleted, others fail) leaves the canvas in a clean state — the deleted notes are gone, the rest remain. The user can re-promote the remaining notes if they want; the workflow does not retry step 3 automatically.
- **Atomicity is not provided.** Step 5 is *not* a transaction. A power loss between step 2 and step 3 leaves tasks created and notes still on canvas. The user sees the tasks (correct outcome at the task layer) and the still-visible notes (recoverable by manually deleting them or re-promoting). This is acceptable because the worst case is user-visible duplication, not data loss.
- **Agents must follow the ordering, not just be told it.** The 6-step protocol is content (ADR-0015's sibling: workflow lives in `specify-prompt.md`). An agent that decides to "optimize" by deleting notes early would violate this ADR. The protocol document is the authority; deviations should be caught in code review when the Specify session shows unexpected state transitions.
- **Reversing a successful promote requires manual cleanup.** If a user wants to undo a successful promote (specs written, tasks created, notes deleted), the recovery path is: delete the tasks, delete the spec files, manually re-create the canvas notes from the spec files. There is no automated rollback. The promote is *intended* to be a one-way commit; if the user changes their mind, they re-do the work.

## See also

- [Specify Workflow concept doc](../concepts/specify-workflow.md) — the full 6-step protocol
- ADR-0015 — Specify sessions are RAM-only; this ADR's failure handling depends on the session abort path being available
- ADR-0014 — Canvas state in `canvas.json` provides the storage layer for step 3's notes
