# Specify Workflow

## What

The Specify Workflow is the guided process that converts unstructured input
(canvas notes or a chat description) into structured FlowBoard work — task
records with linked spec files. It is a pipeline (analyze, clarify, generate,
confirm, persist) executed in dialogue with the user, bookended by a
server-side **Specify Session** that tracks the bridge from input to output.

One session core serves two transports: the **Dashboard Stepper** (Canvas →
Create Task in the browser, questions answered in a modal) and **chat** (a
chat-bound agent asks the questions in conversation). FlowBoard owns the
session state machine and all persistence; model intelligence comes from an
OpenClaw-backed worker (ADR-0021) for the dashboard path, or from the chat
agent itself for the chat path.

The session is the bookkeeping; the workflow is the discipline; the policy is
enforced server-side. Question discipline (cap, one-at-a-time, impact
requirement) lives in `dashboard/specify-policy.js` and applies to every
transport — the prompt instructions in `context/specify-prompt.md` mirror it
for chat agents.

## Why

The motivating problem: unstructured input + structured output is a gap that
humans solve poorly. Asked to convert a cluster of brainstormed notes into
tasks, the typical human jumps straight to creating tasks — and then realizes
mid-way that a spec was needed, or that this should have been one task with
three subtasks instead of three peer tasks. The structuring decision is best
made *after* the input is fully understood, but a freeform conversation tends
to commit early.

Specify codifies that "understand first, structure second" discipline.
ANALYZE before CLARIFY before GENERATE means a task-structure proposal is
committed only after assessing scope. The CONFIRM step before PERSIST means
the user can reject (or revise) a structure proposal *before* any spec or
task exists — no rollback needed because nothing was written.

The server-side session enforces *one-at-a-time-per-agent* concurrency,
rejects overlapping source notes, and provides explicit abort/retry/complete
endpoints so failed or stale workflows stay visible and recoverable.

## How

**The workflow steps:**

```
1. ANALYZE   — worker scans 5 categories (Scope, Users, Data, Behavior,
                Constraints); the scan is stored on the session.
2. CLARIFY   — up to MAX questions (default 4, SPECIFY_MAX_QUESTIONS), one at
                a time, each with 2-4 options and a recommended answer plus
                free-text override. Server-enforced: a question beyond the cap
                is rejected and a proposal forced; a single underspecified
                canvas note must trigger at least one question; the user can
                skip remaining questions at any time.
3. GENERATE  — worker writes the spec (context/specify-spec-template.md) and
                proposes a structure scaled to complexity:
                  (a) single task
                  (b) parent + subtasks (session spec on the parent)
                  (c) parent + subtasks with individual subtask specs
                  (d) multiple parents — role-tagged breakdown entries; each
                      parent starts a group with its own spec, the session
                      spec is the umbrella on the first parent
4. CONFIRM   — proposal review (structure, tasks, collapsible spec preview,
                note-cleanup checkbox). The user confirms, cancels, or
                requests changes — feedback loops back to the worker for an
                improved proposal (revise loop).
5. PERSIST   — create parent/single task record → write spec file(s) via the
                canonical path (specs/<taskId>-<slug>.md) → create remaining
                task records → delete canvas notes (only with cleanup opted
                in). Automatic rollback of specs + created tasks on failure;
                canvas-note deletion stays strictly last (ADR-0016, amended).
                New tasks land in Backlog.
6. DONE      — success state with created task ids and View-in-Kanban jump;
                session marked complete.
```

**The server's session lifecycle:**

```
created ──► analyzing ──► clarifying ──► proposal-ready ──► confirmed ──► persisting ──► done
                │  ▲           │ ▲  │          │   ▲
                │  └───────────┘ └──┘          │   │ revise (feedback recorded,
                │   more questions             └───┘  back through analyzing)
                │
                ├──► error ──retry──► analyzing      (recoverable: worker
                │                                     timeout/malformed output)
                └──► aborted                          (user cancel; notes stay)
```

Worker responses are validated against the policy contract
(`question | proposal | done | error`); malformed output becomes a
recoverable `error` state with a retry control — never a silent shallow
proposal (the static fallback exists only behind `SPECIFY_ALLOW_FALLBACK` /
`NODE_ENV=test`).

**Sessions live in RAM only** (`dashboard/specify-sessions.js`, ADR-0015) —
a `Map<id, session>`, no persistence across restarts. Sessions exist for
minutes; a restart aborts everything in flight implicitly, which is the
correct semantics for a transactional bridge.

**Concurrency is enforced at the agent level, not project level.** Dashboard
sessions without a chat agent run under the `human` agent id. One agent
cannot have two active sessions; overlapping `sourceNoteIds` within a project
are rejected with 409.

**Transports.** Canvas promote without an `agentId` opens the Dashboard
Stepper — no chat binding, no hooks token required. Scripted callers may pass
a validated `agentId`; only then is the structured `[SPECIFY_SESSION]` wake
message sent to that specific chat-bound agent via the gateway webhook
(broadcast to project-active agents is deliberately not a thing). Chat-origin
sessions are created by trigger phrases (`specify: …`, brainstorm-style
intents) and push their questions/proposals through the same session API.

## Consequences

- **A server restart cancels every in-flight Specify session.** No recovery,
  no resume. Acceptable for minutes-long workflows, but operators should not
  restart the dashboard mid-dialogue.
- **No history of past sessions.** Sessions are bridges, not records; the
  audit trail of what was created lives in the HZL event log of the resulting
  tasks, the linked spec files, and the clarifications/ambiguity scan captured
  in the generated spec.
- **Policy is code, prompt is content.** The question cap, single-note guard
  and response schema are enforced in `specify-policy.js` for every transport.
  The conversational instructions (`context/specify-prompt.md`) are per-project
  content and must stay aligned with the policy — they say so explicitly.
- **The worker proposes, the user decides, FlowBoard persists.** The worker
  never writes; persistence runs only after explicit confirmation, with the
  cleanup checkbox controlling the only irreversible step.
- **Structure decisions are revisable, not final.** The revise loop means a
  wrong decomposition (e.g. two features lumped under one parent) costs one
  round of feedback, not a restart.
- **Two agents with the same agent-id collide.** The second concurrent
  promote under one agent id gets 409 — correct, but worth knowing for
  operators running multiple machines under one id.

## Code

- `dashboard/specify-sessions.js` — session store and state machine
  (`createSession`, `updateSession`, `recoverFromError`, …).
- `dashboard/specify-policy.js` — response schema validation, question cap,
  single-note guard, worker directives.
- `dashboard/specify-worker-bridge.js` — policy enforcement, response
  normalization, gated fallback; adapter interface.
- `dashboard/specify-worker-openclaw.js` — the OpenClaw CLI one-shot adapter
  (ADR-0021).
- `dashboard/server.js` — `/api/specify/sessions/...` endpoints
  (`next`, `answer`, `skip`, `retry`, `revise`, `confirm`, `abort`,
  `complete`), `persistSpecifyProposal`, `writeSpecFileForTask` (canonical
  spec creation shared with the specs API), canvas promote integration.
- `dashboard/src/components/SpecifyStepper.jsx`,
  `dashboard/src/context/SpecifyContext.jsx` — the Dashboard transport.
- `context/specify-prompt.md`, `context/specify-spec-template.md` (per
  project) — chat-agent instructions and spec template. Authored content.

## See also

- [Idea Canvas](idea-canvas.md) — the canvas origin and promote pipeline
- [Kanban](kanban.md) — where the resulting tasks land (Backlog)
- [Multi-Agent Model](multi-agent-model.md) — agent-id routing and concurrency
- ADR-0015 (RAM-only sessions), ADR-0016 (persist ordering, amended),
  ADR-0021 (OpenClaw CLI worker)
- `docs/project-mode/specify-workflow.md` — the operational rule section
  served to agents
