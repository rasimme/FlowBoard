# ADR-0039: Session-scoped project binding with agent-level fallback

## Status

Accepted (2026-09-20, T-487-2)

## Source

- T-487 spec, section "Session-scoped context", and the 2026-09-20 OpenClaw
  reassessment (verdict for T-487-2: *keep* — design as context, not
  authorization).
- OpenClaw `agent:bootstrap` context fields (`workspaceDir`, `agentId`,
  `sessionKey`, `sessionId`), docs `/automation/hooks/event-types`.
- Implementation: `dashboard/flowboard-metadata.js`, `dashboard/server.js`
  (`GET`/`PUT /api/status`, `GET /api/agents`), `dashboard/migrations.js`
  (`m012`), `hooks/project-context/handler.js`.
- Contract tests `dashboard/test-session-project-binding.js` and
  `dashboard/test-hook-session-binding.mjs`.

## Context

FlowBoard binds the active project per `agent_id`: one row in
`flowboard_agents`, written by `PUT /api/status` and read by `GET /api/status`
and the `project-context` hook. That was accurate while an agent meant one
long-running conversation.

On a shared OpenClaw Gateway it no longer is. One agent id can serve several
concurrent sessions — `agent:<id>:main`, `agent:<id>:telegram:<chat>`, a cron
wake, a delegated run — and OpenClaw hands every `agent:bootstrap` an optional
`sessionKey` that names exactly which one is running. With a single per-agent
row, a Telegram session that activates project *B* silently repoints the main
session's context away from project *A*, and the main session only notices on
its next bootstrap. The same agent id is also the attribution key for task
claims, so the two sessions are not otherwise distinguishable.

Two constraints shape the fix. First, external agents (Codex, Cursor, scripts,
`curl`) have no session concept at all and must keep working unchanged —
ADR-0011 makes them first-class. Second, OpenClaw itself states that session
ownership is a usability feature, not a security boundary, and FlowBoard's own
trust model (ADR-0003, ADR-0029) treats every caller-supplied identity as
attribution rather than authentication. A session key is therefore not a
credential and must never be treated as one.

## Decision

1. **A second, more specific binding layer, not a replacement.** A new table
   `flowboard_session_projects (agent_id, session_key, active_project,
   activated_at, last_seen)` with `PRIMARY KEY (agent_id, session_key)` holds
   session-scoped activations. `flowboard_agents` is unchanged in schema and in
   meaning, and remains the fallback. Added by the idempotent migration `m012`.

2. **Resolution is session → agent → null.** `GET /api/status?agentId=<id>`
   optionally takes `&sessionKey=<key>`. If a session row exists for
   (agent, session) it answers with `binding: "session"`; otherwise the agent
   row answers with `binding: "agent"`; otherwise `activeProject: null` and
   `binding: null`. The response always carries `binding` and echoes
   `sessionKey` when one was supplied. Without `sessionKey` the behaviour is
   exactly the pre-T-487-2 behaviour plus the `binding` field.

3. **Activation is scoped by the presence of `sessionKey`.**
   `PUT /api/status { project, agentId, sessionKey }` upserts the session row
   and leaves the agent-level `active_project` alone.
   `PUT /api/status { project: null, agentId, sessionKey }` **deletes** the
   session row, so the agent-level binding shows through again — deleting
   rather than nulling is what makes the fallback visible; a row holding
   `active_project = NULL` would shadow it. Without `sessionKey` the write is
   the agent-level write it has always been.

4. **The heartbeat follows the row that answered.** `GET /api/status` is the
   per-run heartbeat (ADR-0020). It refreshes `last_seen` on whichever row
   resolved the request: the session row when a session binding answered,
   the agent row otherwise. An agent-level binding that no live session uses
   any more therefore still ages out, which is the intended ADR-0020
   semantics.

5. **Idle auto-deactivation covers session rows, on the same TTL.** The sweeper
   in the shared agent read model expires session bindings with
   `FLOWBOARD_AGENT_IDLE_TTL_HOURS` and the same live-claim protection as agent
   rows. An expired session row is **deleted**, not nulled, so expiry restores
   the agent-level fallback instead of pinning "no project".

6. **`sessionKey` is context, never authorization.** It selects which binding
   answers; it grants nothing, protects nothing, and is never an access check.
   Validation exists only to bound the storage shape: a non-empty string of at
   most 256 characters with no control characters, otherwise `400`. Anyone who
   can reach the dashboard port can assert any session key exactly as they can
   assert any agent id (ADR-0003, ADR-0029).

7. **Exposure is additive.** `GET /api/agents` gains a `sessions` array per
   agent (`sessionKey`, `activeProject`, `activatedAt`, `lastSeen`, possibly
   empty); the existing `agent_id` / `active_project` fields are untouched, so
   the active-agents bar, the overview widgets and the dashboard snapshot keep
   working without change. The `project-context` hook forwards
   `context.sessionKey` when OpenClaw supplies one and renders
   `Binding: session` / `Binding: agent` under the active-project header — it
   never prints the raw session key into model context. The hook's
   workspace-first `agentId` precedence (T-168) is unchanged.

## Alternatives considered

- **Session-only binding (replace the agent row).** Cleanest model, rejected:
  external agents have no session key, so every Codex/Cursor/script caller
  would lose its context, and the hook would break on any OpenClaw build that
  omits `sessionKey`. Backwards compatibility is the whole point of the
  fallback.
- **`sessionKey` as a tenant token.** Treating the key as proof of "this
  session may only see its own context" would turn a usability field into a
  security boundary. Rejected: OpenClaw documents session ownership as a
  usability feature, the key travels in a query string and through logs, and
  FlowBoard's boundary is the loopback port (ADR-0029). Pretending otherwise
  would create authorization theatre.
- **A compound `agentId` such as `main#telegram-4711`.** Zero schema change,
  rejected: agent id is the attribution key on every claim, checkpoint and
  comment (ADR-0003), so per-session ids would fragment task ownership and
  defeat the near-collision guards in `agent-identity.js`.
- **Nulling expired/deactivated session rows instead of deleting them.**
  Rejected: a retained row with a null project is indistinguishable from an
  intentional "no project here" and would shadow the agent-level binding
  forever.

## Consequences

- Two OpenClaw sessions of the same agent can hold different project context at
  the same time, and neither can silently overwrite the other.
- Every caller that does not send `sessionKey` — external agents, `curl`, older
  FlowBoard clients, older hook versions — behaves exactly as before. The only
  visible change is the additive `binding` field.
- A caller that sends a session key it does not "own" simply reads and writes
  that binding. This is intentional and identical to asserting a foreign agent
  id; it is not a new exposure.
- Agents now have two places a project can be bound. `GET /api/status` reports
  which one answered through `binding`, and `GET /api/agents` lists every
  session binding, so the state stays inspectable.
- A session binding that nothing refreshes disappears after the idle TTL and
  the agent-level binding takes over. Operators who want a session-scoped
  context to survive a long pause must re-activate it.
- The dashboard UI does not yet render session bindings; it keeps showing the
  agent-level project. Surfacing them is follow-up work.

## See also

- [ADR-0001](0001-live-inject-bootstrap.md) — live-injected bootstrap from the canonical row
- [ADR-0003](0003-dashboard-has-no-agent-identity.md) — the dashboard is a service, identity is attribution
- [ADR-0011](0011-external-agent-discovery.md) — external agents are first-class and session-less
- [ADR-0020](0020-agent-idle-auto-deactivation.md) — `last_seen` heartbeat, lease-protected TTL
- [ADR-0029](0029-local-first-single-operator-security-boundary.md) — attribution, not authorization
- [Agent Identity](../concepts/agent-identity.md) — § Session-scoped project binding
