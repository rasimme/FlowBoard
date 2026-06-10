# Specify Workflow

## Purpose

System-level reference for the Specify capability — the structured path from idea (canvas note or chat input) to spec + task(s) in FlowBoard. For the agent-injected prompt instructions, see `specify-prompt.md`.

## Overview

Specify turns unstructured input into:
1. A written **spec document** (markdown, stored in `context/`)
2. One or more **FlowBoard tasks** linked to the spec

It runs as a guided session with user confirmation before any persistence. FlowBoard owns the session state machine; OpenClaw owns worker execution; Dashboard and chat are transports over the same workflow.

## Session Model

Specify sessions are in-memory (RAM-only, lost on server restart). They track:

| Field | Description |
|-------|-------------|
| `id` | `specify-{timestamp}-{seq}` |
| `project` | Target project |
| `origin` | `canvas` or `chat` |
| `transport` | `dashboard`, `chat`, or `api` |
| `sourceNoteIds` | Canvas note IDs being processed |
| `agentId` | Agent (or `human` for dashboard sessions) running the session |
| `status` | `created → analyzing → clarifying (loop) → proposal-ready → confirmed → persisting → done`, plus `error` / `aborted` |
| `clarifications` | Asked questions: `{id, question, options, recommended, answer, affectedFields}` |
| `ambiguityScan` | Latest worker scan: `{identifiedGaps, confidence}` |
| `draftProposal` | Worker proposal awaiting confirmation |

### Constraints
- One active session per agent
- No overlapping `sourceNoteIds` within the same project
- Sessions are created by the promote endpoint or recognized chat triggers
- `error` is recoverable only via the retry endpoint (`error → analyzing`)

## Session API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/specify/sessions` | List sessions. Query: `?project=`, `?status=` |
| `GET` | `/specify/sessions/:id` | Get session details |
| `POST` | `/specify/sessions/:id/next` | Request the next worker step (question or proposal) |
| `POST` | `/specify/sessions/:id/answer` | Record an answer (dashboard) or push question/proposal (chat) |
| `POST` | `/specify/sessions/:id/skip` | Skip remaining questions — proposal from recommended answers/defaults |
| `POST` | `/specify/sessions/:id/retry` | Recover an errored session and re-run the step |
| `POST` | `/specify/sessions/:id/revise` | Reject the draft proposal with feedback — worker returns an improved proposal |
| `POST` | `/specify/sessions/:id/confirm` | Confirm (persist) or reject the proposal |
| `POST` | `/specify/sessions/:id/abort` | Abort session (notes stay on canvas) |
| `POST` | `/specify/sessions/:id/complete` | Mark session done |

## Worker

Specify intelligence runs on OpenClaw infrastructure — FlowBoard owns no model credentials or provider config.

- **Dashboard transport**: the server invokes the **OpenClaw CLI worker adapter** (`specify-worker-openclaw.js`) — one synchronous `openclaw agent --json` call per step against `SPECIFY_WORKER_AGENT` (default `main`, exists on every install) inside an isolated session key `agent:<id>:flowboard-specify-<sessionId>`. The worker is stateless: every call carries the full session context and returns exactly one JSON object.
- **Chat transport**: the chat-bound agent itself is the clarify surface and drives the same session API.
- Worker responses are validated against the contract in `specify-policy.js`; malformed responses become recoverable `error` sessions (retry button in the stepper).
- The static fallback proposal is dev/test-only (`SPECIFY_ALLOW_FALLBACK=true` or `NODE_ENV=test`) — production without a reachable worker shows a retryable error instead of a shallow proposal.

Worker response contract (one of):
- `question` — `{text, options: [{key,label,rationale}], recommended, affectedFields}`
- `proposal` — `{summary, taskStructure, specContent, taskBreakdown, sourceCleanupPlan}`
- `done` / `error` — with `message`

Env vars: see `docs/reference/env-vars.md` § Specify worker.

## Clarify Policy

Enforced server-side for the dashboard path (`specify-policy.js`) and mirrored in the chat prompt instructions:

1. **Ambiguity scan** — the worker assesses 5 categories (Scope, Users, Data, Behavior, Constraints); the scan is stored on the session.
2. **Max 4 questions**, one at a time. A 5th question is rejected and a proposal is forced.
3. Each question must name `affectedFields` — which FR / user story / success criterion the answer changes. No implementation-detail questions; no question when a low-risk default exists.
4. Questions prefer **2-4 options with one recommendation**; free-text override always available.
5. **Single-note rule** — one canvas note is underspecified by definition: an instant proposal triggers one `require-clarification` re-request.
6. **Skip remaining** — user shortcut to a proposal built from recommendations/defaults (chat equivalent: "weiter"/"passt").

## Workflow Steps

1. **ANALYZE** — Worker assesses input across 5 categories. Determines whether clarification is needed.
2. **CLARIFY** — Up to 4 questions, one at a time, with recommended answers. Stops early on user signal (skip / "weiter" / "passt").
3. **GENERATE** — Worker writes spec (template: `context/specify-spec-template.md`) and proposes task structure, scaled to complexity:
   - Simple → 1 task (session spec on the task)
   - Medium → Parent + subtasks (session spec on the parent)
   - Complex → Parent + subtasks with individual specs (subtasks may carry their own `specContent`)
   - Very complex / multiple distinct features → Multiple parents: each `role: parent` entry in the breakdown starts a group with its own spec, `role: subtask` entries attach to the closest preceding parent; the session spec is the umbrella overview on the first parent
4. **CONFIRM** — Summary + collapsible spec preview shown to user. Explicit confirmation required before any writes.
5. **PERSIST** — In strict order: write spec file(s) → create task(s) via API → delete source canvas notes (batch delete). Session marked complete.
6. **ERROR HANDLING** — On failure at any persist step: undo partial writes, abort session, inform user. Notes stay on canvas. Worker failures before persistence are recoverable via retry.

## Entry Points

- **Canvas Promote** — Dashboard UI selects notes → POST promote → Specify Stepper (no chat agent or hooks token required). Scripted callers may pass `agentId` to route the session to a chat-bound agent via webhook instead.
- **Chat Trigger** — Agent recognizes Specify-triggering phrases (`specify:`, brainstorm-style intents) in conversation.

## Spec Storage

Specs are written to `~/.openclaw/projects/<project>/context/` and indexed in `specs/_index.json` with FlowBoard task ID mappings.

## Integration with Tasks API

Specify creates tasks via the standard `POST /api/projects/:name/tasks` endpoint. The created tasks reference their spec via `links` or `metadata`. This is not a separate task creation path — Specify is a workflow that uses the Tasks API.
