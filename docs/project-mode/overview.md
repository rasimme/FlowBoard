# Overview — the modular per-project landing page

## Purpose

Every project opens on the **Overview** — a modular widget dashboard. The
layout is data, not code: `overview.json` in the project directory describes
which widgets render where on a 12-column grid. Agents customize it through
the same API humans use. This is the agent-facing contract.

## The contract in one look

```
GET  /api/overview/widgets              → widget catalog + presets + grid contract
GET  /api/projects/:name/overview       → current layout (or the default preset)
PUT  /api/projects/:name/overview       → write a preset name or a full config
```

Schema (flat by design — every position directly addressable):

```json
{
  "version": 1,
  "layout": "grid",
  "widgets": [
    { "id": "w-agents", "type": "active-agents", "grid": { "x": 0, "y": 0, "w": 8, "h": 3 } },
    { "id": "w-nextup", "type": "next-up", "props": { "limit": 5 }, "grid": { "x": 8, "y": 0, "w": 4, "h": 2 } }
  ]
}
```

Grid contract: **12 columns** (`x` 0–11, `x+w ≤ 12`), row unit **88px**
(`h` in rows), 12px gutter. Widgets adapt their content to their width
(w=4 compact → w=8+ rich) — any arrangement works.

## Trusted registry

Only registered widget `type`s render; `PUT` rejects unknown types with an
error list (400). Fetch `GET /api/overview/widgets` for the current catalog
with `defaultSize` and accepted `props` per widget. Do not invent types.

Current catalog — needs-me cluster: `blocked` (blocked tasks waiting for a
human), `approvals` (the review lane as your inbox), `since-last-visit`
(what moved while you were away); live: `current-focus` (claimed tasks,
prominent), `active-agents`, `activity-stream`, `timeline` (dated spine),
`stall-detection` (momentum check), `repo-status` (GitHub CI/PRs/commits,
opt-in via `props.repo`); direction: `next-up`, `project-goals`,
`task-stats`, `milestones` (tag tasks `milestone:<name>`), `kanban-mini`;
knowledge & actions: `recent-decisions`, `context-index` (pin via
`props.pins`), `quick-drop`, `notes` (context/NOTES.md), `links`
(`props.links`), `quick-links`.

## Presets

`PUT { "preset": "default" | "agent" | "status" | "context" }` materializes
a named layout:

- **default** — re-orientation after autonomous work: what needs you first
  (blocked, approvals, since-last-visit), then current focus, next-up,
  agents, goal and quick actions.
- **agent** — daily work with running agents (active-agents hero).
- **status** — reviews/stand-ups (stats + board preview first).
- **context** — documentation-heavy projects (PROJECT.md/DECISIONS.md dominant).

When creating a new project, pick the preset that fits it — or compose a
custom layout from the catalog. Projects without a stored file serve the
`default` preset automatically; you only need to write when deviating.

## Editing rules for agents

1. **Read before write**: `GET` the current config, modify, `PUT` the whole
   document back (it is one file, not a patch API).
2. Typical commands map directly:
   - "add a decisions widget" → append `{ id, type: "recent-decisions", grid: {...} }` in a free slot
   - "make the activity widget bigger" → increase that widget's `grid.w`/`grid.h`
   - "remove the board preview" → delete the entry
3. Keep `id`s stable when moving/resizing — they identify widgets across edits.
4. Avoid overlaps; the UI compacts vertically, but clean coordinates keep
   human drag-editing predictable.
5. Humans edit the same file through the UI's drag/resize editor — respect
   an existing custom layout: change what was asked, do not reformat.

## Errors

- `400` with `errors[]` — fix the listed problems (unknown type, grid
  overflow, duplicate id) and retry.
- Unknown types in an already-stored config are skipped by the renderer
  (forward compatibility); the UI shows how many were skipped.
