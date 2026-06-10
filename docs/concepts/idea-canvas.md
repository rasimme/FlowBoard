# Idea Canvas

## What

The Idea Canvas is FlowBoard's visual brainstorming surface — a 2D space where you place sticky-note-style notes, draw connections between them, group connected notes into clusters, and *promote* a selected set of notes into tasks. Promoting hands a structured payload to an agent (via the Specify Workflow) that decides task structure, writes spec files, creates tasks, and cleans up the canvas notes.

It is the only FlowBoard surface where new work originates from a non-textual interaction. Everywhere else (Kanban, task creation API), work begins as a title and metadata. On the canvas, work begins as connected ideas in space.

## Why

The motivating use case is the *fuzzy front end* of project work — "I have a bunch of related thoughts, I don't know yet which are tasks, which are constraints, which are subtasks of something else." Forcing those thoughts into the Kanban model immediately requires premature structure. The canvas defers that structure: notes can sit unconnected and grow over time; connections capture relationships that only become visible after several notes exist; clusters emerge organically from connection topology rather than being declared upfront.

Promote bridges the unstructured-to-structured gap by handing the cluster to an agent rather than asking the user to do the structuring. The agent applies the Specify workflow (analyze → clarify → generate → confirm → persist) and produces task records that match the rest of FlowBoard's conventions. The user stays in brainstorm mode; the agent produces structure.

This is also the rationale for keeping the canvas implementation in *vanilla JS* while the rest of the dashboard migrates to React. The interaction model — drag, draw, snap, connection-routing — is ergonomically heavy and was already working well in vanilla. CLAUDE.md (the local instruction set) explicitly marks canvas as do-not-convert. ADR-0005 / ADR-0006 already documented hardening decisions; the *do not migrate* decision is implicit in code comments and would be a useful explicit ADR.

## How

The canvas data model is intentionally simple — three primitives.

**Notes.** Each note has an id, a position (`x`, `y`), a color, and free text. Notes are stored in `canvas.json` per project — *not* in HZL, *not* in `flowboard_agents`. The canvas is an unstructured scratchpad; persisting it as an event log would be over-engineering for the use case. A flat JSON file with full-replace writes is sufficient.

**Connections.** Each connection links two notes by id (`from`, `to`) and optionally specifies which port on each note (`fromPort`, `toPort`) so the connection routes naturally regardless of layout. Connections are undirected at the model level — `from→to` and `to→from` are deduplicated server-side; the API returns `duplicate: true` rather than creating a second edge. A note cannot connect to itself.

**Clusters.** Clusters are not stored. They are *derived* on the client from connection topology — connected components of the connection graph. This means clusters emerge automatically when you draw a connection, and dissolve when you remove the last connection. There's no "create cluster" gesture; the cluster *is* the set of transitively-connected notes.

**The promote pipeline.**

```
canvas (notes + connections)
    │
    │  POST /api/projects/:name/canvas/promote
    │       body: { notes: [...], connections: [...], mode, agentId? }
    ▼
Specify Session created (server-side, ./specify-sessions.js)
    │
    ├─ no agentId (the normal browser case):
    │     Dashboard Specify Stepper opens — the OpenClaw worker
    │     (ADR-0021) asks the clarification questions in a modal,
    │     the user answers/skips, reviews the proposal (with spec
    │     preview, note-cleanup checkbox, revise loop), confirms.
    │
    └─ explicit agentId (scripted/chat-bound callers):
          webhook to the OpenClaw gateway after target validation
          ([SPECIFY_SESSION] message) — the chat agent runs the same
          workflow conversationally through the same session API.
    ▼
ANALYZE → CLARIFY (max N questions) → GENERATE (structure scaled to
complexity, up to multiple parents with own specs) → CONFIRM →
PERSIST (rollback-safe, notes deleted last and only with cleanup
opted in) → DONE
    ▼
tasks in the Kanban Backlog; canvas notes cleaned up (unless opted
out); success screen offers a View-in-Kanban jump with task highlight
```

**Routing of the promote.** Promote is a clarification workflow, not a
background task dispatch. Without an `agentId`, the Dashboard Stepper is the
clarify surface — no chat binding, no hooks token, works on a fresh install
(SC-001). With an explicit, validated `agentId` (scripted callers), that
specific chat-bound agent is woken instead. There is deliberately no
broadcast to project-active agents and no remembered localStorage target —
"active on a project" does not mean "currently talking to the user."

**Origin of structure decisions.** The worker/agent — not the user, not the
server — proposes whether the cluster becomes one task, a parent with
subtasks, subtasks with individual specs, or multiple parents (role-tagged
breakdown, own spec per parent). The user confirms at step 4 — or sends the
proposal back with feedback (revise loop) until the structure fits.

**Session lifecycle.** The Specify Session is the bookkeeping bridge between
canvas state and the eventual task creation. It tracks `sourceNoteIds` (so
cleanup can find them), `agentId` (dashboard sessions run as `human`), the
clarifications with their options and answers, the ambiguity scan, revision
feedback, and a status machine (`created → analyzing → clarifying →
proposal-ready → confirmed → persisting → done`, plus recoverable `error`
and `aborted`). Cancel at any pre-persist step aborts with nothing written;
worker failures are retryable; persistence failures roll back created tasks
and spec files automatically — canvas notes are only ever deleted last
(ADR-0016).

## Consequences

- **Canvas state is divorced from task state.** Until promote happens, canvas notes are not tasks. Searching the Kanban does not find canvas content. This is intentional — pre-task ideas don't pollute the work board — but it means brainstorming work is invisible to anyone who isn't looking at the canvas tab.
- **Promote is opinionated and asynchronous.** The user does not see the spec being drafted; they see the agent's confirmation message, and accept or reject the structure. The agent is the architect of the resulting tasks, not the user. Users who want manual control should create tasks via the Kanban, not promote from canvas.
- **Vanilla canvas, React rest.** The canvas runs as ES module vanilla JS (`dashboard/js/canvas/`) with module-level state, event delegation via `data-action` attributes, and circular imports across `notes.js` / `connections.js` / `clusters.js`. The rest of the dashboard is React. The boundary is clean: the React shell loads the canvas as an iframe-equivalent, the canvas does its own thing inside.
- **Connections are undirected in the data model, directed in the rendering.** The store dedupes `A→B` and `B→A`, but the renderer can distinguish source-port and target-port for visual purposes. This bites at API time — clients should not assume `from` and `to` survive a round-trip in the order they sent.
- **Self-loops and duplicate edges are silently swallowed.** Posting a connection that already exists returns `duplicate: true` with no creation; posting `A→A` returns 400. Neither produces a duplicate row to clean up later. This is desirable for ergonomic drag-to-connect interaction (the user might connect twice by accident) but means clients cannot rely on the response status to learn how many edges they created.
- **Canvas needs OpenClaw webhooks to function.** Promote requires `OPENCLAW_HOOKS_TOKEN` and `OPENCLAW_GATEWAY_URL`. Without them, the canvas itself works (notes, connections, clusters) but promote returns 503. This is documented in the README's "Canvas → Task Promote" section.
- **Specify-session collision is enforced server-side.** A second promote request for the same `agentId` while a session is already `active` returns 409. The agent cannot have two pending Specify sessions at once; canvas + voice + chat can't simultaneously hand work to the same agent.

## Code

- `dashboard/js/canvas/index.js` — canvas bootstrap and lifecycle.
- `dashboard/js/canvas/notes.js` — note CRUD, drag, edit.
- `dashboard/js/canvas/connections.js` — connection drawing, port routing, Manhattan-with-rounded-corners path generation.
- `dashboard/js/canvas/clusters.js` — connected-component derivation.
- `dashboard/js/canvas/state.js` — module-level state container.
- `dashboard/js/canvas/toolbar.js`, `events.js` — toolbar UI and event delegation.
- `dashboard/styles/canvas.css` — canvas-specific styles (kept separate from `dashboard.css`).
- `dashboard/server.js` — endpoints under `/api/projects/:name/canvas/...` and the promote handler.
- `dashboard/specify-session.js` — Specify session bookkeeping (create, complete, abort, query).
- `~/.openclaw/projects/<name>/canvas.json` — per-project canvas state.
- `context/specify-prompt.md` (in the active project) — the workflow the agent runs after promote.

## See also

- [Specify Workflow](specify-workflow.md) — the agent-side process that promote triggers (planned, T-200-5)
- [Multi-Agent Model](multi-agent-model.md) — how `agentId` routing on promote works
- T-199-2 (backlog) — foundation ADR for External-Agent Discovery (relevant because canvas promote uses the same gateway-webhook channel)
