# ADR-0021: Specify worker runs as OpenClaw CLI one-shot — no dedicated agent, no FlowBoard LLM layer

## Status
Accepted

## Date
2026-06-10

## Context

The Specify clarify loop (T-262-9..13) needs model intelligence for the
dashboard transport: analyze canvas input, ask clarification questions,
generate the spec/task proposal. Chat-origin sessions already have a model —
the chat-bound agent itself. Dashboard-origin sessions (Canvas → Create Task
in a plain browser) have none.

Constraints from the T-262 spec:

- FlowBoard must not own model credentials, provider config, or a separate
  LLM configuration layer (FR-005).
- Clarification must not be routed to arbitrary project-active agents
  ("active on a project" ≠ "currently talking to the user").
- FlowBoard is installed by third parties and is planned as a ClawHub
  plugin. Any setup step ("create a worker agent first") is an adoption
  barrier.

Options considered:

1. **Dedicated registered worker agent** (`openclaw agents add specify-worker`).
   Cleanest isolation, but the plugin manifest cannot declaratively ship
   agents, and imperative creation at install time is invasive (workspace
   dirs, model choice, uninstall cleanup). Every installation would need
   manual setup.
2. **Async webhook wake + session polling** (reuse the chat-path pattern).
   More moving parts: the worker needs API write access, and timeout/error
   states become distributed instead of a simple request/response.
3. **Plugin SDK completion** (`api.runtime.llm.complete`). The ideal endgame,
   but only callable from code loaded inside the gateway process as a plugin.
   The dashboard server is a standalone Express process today, and the plugin
   manifest hints it may stay external ("launched by an external supervisor").
4. **Synchronous CLI one-shot**: `openclaw agent --agent <id> --session-key
   <isolated> --json` per workflow step against an existing agent.

## Decision

Option 4. The worker adapter (`dashboard/specify-worker-openclaw.js`) runs one
synchronous `openclaw agent --json` call per workflow step:

- **Target agent is `SPECIFY_WORKER_AGENT`, default `main`** — exists on every
  OpenClaw installation. Zero setup. Power users may point the env var at a
  dedicated lean agent; nobody has to.
- **Isolated session key** `agent:<id>:flowboard-specify-<sessionId>` keeps
  worker turns out of the user's normal conversations.
- **The worker is stateless**: every call carries the full session context
  (notes, connections, prior Q&A, revision feedback, draft proposal) and must
  return exactly one JSON object (`question | proposal | done | error`,
  validated by `specify-policy.js`). All session state and write ordering stay
  in FlowBoard.
- **The worker never persists.** It returns proposals; FlowBoard persists
  after explicit user confirmation (ADR-0016).
- **Gateway env vars are stripped from the child process** —
  FlowBoard's own `OPENCLAW_GATEWAY_URL`/`GATEWAY_PORT` (used for its webhook
  calls) would otherwise be interpreted by the CLI as a gateway override
  requiring explicit credentials.
- **No silent degradation**: without a reachable worker the session enters a
  recoverable `error` state with a retry control. The static fallback proposal
  is gated behind `SPECIFY_ALLOW_FALLBACK=true` / `NODE_ENV=test`.

The chat transport is unchanged: the chat-bound agent is the clarify surface
and drives the same session API.

## Consequences

- **Zero-setup on every installation.** No agent provisioning, no credentials
  in FlowBoard, FR-005 holds.
- **Latency is seconds per step** (CLI spawn + full agent turn). Acceptable
  behind a stepper with busy states; will improve with the SDK adapter.
- **Worker output can carry the target agent's persona.** Mitigated by the
  strict JSON-only contract and schema validation; not fully eliminated until
  the SDK adapter exists.
- **Gateway must be running** — true on any functioning OpenClaw install.
- **The SDK adapter (`api.runtime.llm.complete`) is the planned successor**
  once plugin packaging decides how the dashboard server is hosted
  (tracked as a backlog task). The bridge interface
  (`adapter.call(request) → response`) is unchanged by that swap; everything
  except the ~150-line adapter is adapter-agnostic.

## See also

- ADR-0015 — Specify sessions are RAM-only
- ADR-0016 — PERSIST ordering as rollback contract (amended for canonical
  spec naming)
- `docs/project-mode/specify-workflow.md` — system reference incl. worker
  contract and clarify policy
- `docs/reference/env-vars.md` § Specify worker
