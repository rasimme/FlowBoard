# ADR-0043: Claim required for agent task writes

## Status

Accepted (2026-11-17, T-526)

## Source

- T-526 spec, "Claim-Gate: Agent-Schreibzugriffe auf Tasks nur mit eigenem Claim".
- Implementation: `dashboard/claim-gate.js`, `dashboard/server.js`
  (`POST …/checkpoint`, `POST …/complete`, `POST …/claim`,
  `POST /api/workflows/start`, `GET /api/tasks/stuck`),
  `dashboard/flowboard-metadata.js` (`flowboard_rejected_writes`),
  `dashboard/rules-api.js` (`buildRulesManifest`).
- Contract test `dashboard/test-claim-gate.js`.

## Context

`rules/agent-bridge` has always said "only the claiming agent can checkpoint",
but the server only checked ownership when a task already had an owner. An
agent that never claimed could checkpoint a task, and the write succeeded
without any signal. In practice this happened at scale: parallel sessions
wrote 6 to 21 checkpoints each on backlog tasks that had no agent and no
claim. Everything that assumes a claim then silently does nothing for those
tasks: the session binding made by a claim (T-520), the commit checkpoint and
the finalize reminder (T-521), stale and expired-lease detection.

Since T-512 the rules reach agents only as a short manifest in `FLOWBOARD.md`,
which OpenClaw places in the cached part of the system prompt. The manifest
named `api-access` for claiming, but nothing pointed an agent at the claim
step before it starts checkpointing.

## Decision

1. **The server enforces the rule.** `POST /api/projects/:name/tasks/:id/checkpoint`
   and `POST …/complete` answer `409 NOT_CLAIMED` when the caller holds no
   claim on the task. A claim is live while `claimedAt` is set; release,
   complete and a review/done status change clear it, lease expiry does not.
   - A live claim of the caller passes, also with an expired lease; the
     checkpoint renews the lease as before.
   - A live claim of another agent passes on to the service, which keeps
     answering `403 NOT_OWNER` (now with `code` in the body).
   - The caller's own task in `review`/`done` passes, so a closing checkpoint
     after `complete` keeps working.
   - Everything else is `NOT_CLAIMED`: never claimed, released, routed but not
     claimed, finished by another agent.

2. **The refusal teaches the fix.** The body carries a one-sentence `error`,
   `code`, a `hint` with the exact claim call (and `POST /api/workflows/start`
   as the alternative), `rules: /api/projects/<p>/rules/agent-bridge`, and for
   a checkpoint `rejected: { message, progress }`, so the agent can claim and
   resend the text unchanged instead of losing it.

3. **The gate lives in the routes, not in `hzl-service`.** Internal workflows
   write through the service and must keep working: `workflowHandoff` writes
   the handoff checkpoint on the unclaimed follow-on task, `workflowDelegate`
   checkpoints the source, imports and migrations write history directly.

4. **Refusals are recorded.** Each `NOT_CLAIMED` is stored in
   `flowboard_rejected_writes` in the FlowBoard metadata database (time,
   project, task, agent, session key, action, message shortened to 200
   characters), bounded to 7 days and 1000 rows. `GET /api/tasks/stuck`
   returns the last 24 hours as `stuck.rejectedUnclaimed`, grouped per agent
   and task. A later claim by the same agent (`claim` or `workflows/start`)
   resolves the entries. They are not part of `combined` and never trigger a
   stuck notification.

5. **One static manifest line.** `buildRulesManifest` gains exactly one line
   under "When to load what": claim before working on, checkpointing or
   completing a task, and FlowBoard rejects writes on unclaimed tasks with
   `409 NOT_CLAIMED`. It contains no variables and no task state.

## Alternatives considered

- **Auto-claim on the first checkpoint.** Rejected: a silent side effect that
  bypasses routing (`ROUTING_MISMATCH`), dependency checks
  (`PARENT_NOT_CLAIMABLE`) and the session binding a deliberate claim makes.
  The agent would also never learn the protocol.
- **Per-turn prompt injection of the claim state.** Rejected: dynamic content
  in `FLOWBOARD.md` changes the cached system prompt on every task change,
  which is exactly what T-512 removed. A tool result arrives at the end of the
  conversation and leaves the cached prefix alone, so the correction belongs in
  the API response.
- **Blocking in OpenClaw's `before_tool_call`.** Rejected: it only covers
  OpenClaw. Codex, Claude Code and scripts reach FlowBoard over HTTP, and the
  server is the one place every agent passes.
- **Gating inside `hzlService.addCheckpoint`/`completeTask`.** Rejected: it
  would break handoff, delegate, imports and migrations, which write on tasks
  nobody has claimed by design.

## Consequences

- **Behaviour change for external agents.** Clients that checkpointed or
  completed without claiming now get `409 NOT_CLAIMED`. The fix is the call in
  `hint`. Clients that already claim are unaffected.
- Tests that checkpointed without a claim now claim first.
- The manifest, and therefore `FLOWBOARD.md`, grows by one line (about 200
  characters); the document stays independent of task state.
- **Known limit: `PUT /api/projects/:name/tasks/:id` is not gated.** Its body
  carries no required agent identity (`actor` is optional), and the dashboard
  and operator move tasks through it. A status change to `review`
  through `PUT` on a task nobody claimed still succeeds. ADR-0035 applies:
  FlowBoard enforces the form it can see, and this is form per agent id, not
  authorization. Agent ids remain self-asserted (ADR-0003).
