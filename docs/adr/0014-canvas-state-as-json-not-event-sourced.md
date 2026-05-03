# ADR-0014: Canvas state in `canvas.json` per project, not HZL event-sourced

## Status
Accepted

## Date
2026-04-01

## Source
- private spec `specs/T-080-idea-canvas-sticky-note-board-mit-cluste.md` and follow-ups in operator's local FlowBoard project
- code: `dashboard/server.js:372,387` — `path.join(PROJECTS_DIR, projectName, 'canvas.json')`
- public commit history of the canvas surface (T-080..T-092) predates the HZL migration (T-126); the canvas was *never* on HZL
- ADR-0007 — the HZL Task-Bridge that made event-sourcing the default for tasks

## Context

ADR-0007 made tasks event-sourced via HZL: every state change appends an immutable event; current state is a projection (`tasks_current`); audit trail is lossless. That model is appropriate for tasks because the audit trail matters — multi-agent collaboration only works when "who claimed what when" is uncontestable.

The Idea Canvas has different requirements. Canvas notes are *pre-task* brainstorming material — sticky notes with positions, connections, and clusters that may or may not become tasks. The interaction model is rapid: drag a note, snap it, draw a connection, undo, redo, drag again. Treating each of those as an appended event would mean either:

- **Event-source faithfully** — every micro-interaction (mouse drag tick, snap correction, connection re-route) becomes an event. The event log grows by thousands of rows per active session. Useful for replay, useless for audit.
- **Coarsen events** — only persist on save / promote, batch all interim state into one event. Defeats the point of event-sourcing (no per-step audit) and replicates JSON-file semantics with extra overhead.

There's also a domain mismatch: HZL's projector model assumes event types map to projections of *meaningful* state (tasks, dependencies, comments). Canvas state — note positions, connection endpoints, cluster-derivation — is a tightly-coupled rendering model that doesn't naturally split into multiple projections. There's effectively one projection: the canvas itself.

The pre-T-126 implementation stored the canvas as a JSON file (`canvas.json` per project). When tasks moved to HZL, the canvas could have been migrated as a parallel exercise, but the cost/benefit was inverted: tasks gained audit and race-safety; canvas had no need for either.

## Decision

Canvas state is stored as a single JSON file per project at `~/.openclaw/projects/<name>/canvas.json`. Every write is a full-file replace. There is no event log, no projection, no HZL involvement.

The file structure is flat:

```json
{
  "notes": [{ "id": "...", "x": 120, "y": 240, "color": "yellow", "text": "..." }, ...],
  "connections": [{ "from": "...", "to": "...", "fromPort": "...", "toPort": "..." }, ...]
}
```

Reads (`GET /api/projects/:name/canvas`) return the file. Writes (note CRUD, connection CRUD) read the file, mutate the JSON, write the file. Concurrency is handled the same way as any single-file JSON store: last-write-wins on the file system. The dashboard process is the only writer.

Clusters are not stored — they are derived on the client from the connection graph (connected components).

Promote is the only path that writes *both* canvas state and HZL state: the canvas-promote handler creates a Specify session (RAM-only, see ADR-0015), the agent eventually creates HZL tasks for the promoted notes, and the canvas notes are deleted from `canvas.json` last (per ADR-0016's persist-ordering rule).

## Consequences

- **No audit trail of canvas edits.** Who moved a note, when, from where to where — none of this is recorded. The history of a canvas is only its current state. This is acceptable because canvas is brainstorming, not the system of record; the system-of-record artifact is the task that promote eventually creates.
- **No multi-agent canvas collaboration.** Two agents (or the human + an agent) editing the canvas concurrently risk last-write-wins data loss. In practice the canvas is single-user (the human brainstorms; agents only consume on promote), so this is not a current pain point. If it became one, the response would be either a per-canvas lock or migration to event-sourcing — the latter would supersede this ADR.
- **Recovery is per-project file restore.** Backup is a `cp canvas.json canvas.json.bak` and restore is the reverse. No projection rebuild, no event replay.
- **Rendering performance.** The full-file read on every API call is acceptable because canvas files are small (a few KB for typical use, tens of KB worst case) and reads are bounded by the client's polling interval. If a canvas grew large enough to make the file IO visible, that would be a revisit trigger.
- **Asymmetry to tasks is documented but real.** Two different persistence models live in the same dashboard process. Contributors must know which surface uses which (HZL for tasks/comments/checkpoints; JSON file for canvas; in-RAM for Specify sessions per ADR-0015). The Coverage Matrix and concept docs make this navigable; new persistence-needing features should pick consciously rather than picking by inertia.
- **Schema changes are forward-only.** Adding a new optional field to a note or connection is safe — the JSON read tolerates extra fields, and writes preserve them. Removing or renaming fields requires a migration script that reads, transforms, and rewrites every project's `canvas.json`. Manageable but not free.

## See also

- [Idea Canvas concept doc](../concepts/idea-canvas.md) — the data model in detail
- ADR-0007 — the HZL Task-Bridge that defines the *other* persistence model in the system
- T-199-10 — Specify sessions are RAM-only (a third persistence asymmetry, planned ADR-0015)
