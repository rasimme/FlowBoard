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

## Coordinate-free authoring (flow)

Computing `x/y/w/h` by hand is error-prone. To author a layout without
coordinates, `PUT` a **flow** body — an ordered widget list. The server packs
it into the grid above (left-to-right, wrapping rows) and validates the result:

```json
{
  "layout": "flow",
  "widgets": [
    { "type": "task-stats", "size": "full" },
    { "type": "blocked", "size": "m" },
    { "type": "approvals", "size": "m" },
    { "type": "notes" }
  ]
}
```

`size` is a coarse width hint — `s` (3 cols), `m` (6), `l` (8), `full` (12);
omit it to use the widget's natural `defaultSize`. Order is reading order:
widgets fill a row and wrap to the next, never overlapping. `props`, `title`
and an explicit `id` are preserved; missing ids are generated. The same
trusted registry applies — unknown types are rejected (400). The stored
result is a normal `grid` config, so the UI drag-editor and later edits work
unchanged.

Use flow to compose a fresh layout fast; use the explicit grid form when you
need exact placement.

## Incremental patch-ops

To refine an existing overview without resending the whole layout, `POST` a
batch of small operations to `/api/projects/:name/overview/ops`. The server
reads the current layout, applies the ops in order, re-packs into a clean grid
(no coordinates), validates and saves it:

```json
{
  "ops": [
    { "op": "add", "type": "blocked", "size": "m" },
    { "op": "remove", "id": "w-notes" },
    { "op": "resize", "id": "w-stats", "size": "full" },
    { "op": "reorder", "id": "w-stats", "toIndex": 0 }
  ]
}
```

- `add` — append a widget (`type` required; optional `size`, `props`, `title`,
  `id`; an id is generated when omitted).
- `remove` — drop the widget with that `id`.
- `resize` — set the coarse width hint (`s` | `m` | `l` | `full`).
- `reorder` — move the widget to integer `toIndex` (clamped to bounds).

`size` uses the same coarse buckets as flow authoring. Ops apply atomically:
an unknown `id`, unknown `op`, or `add` without a `type` fails the whole batch
with a `400` naming the offending op index (e.g. `ops[2]: no widget with id
"x"`) and nothing is written. The response is the saved `grid` config, so the
UI drag-editor and later edits work unchanged.

## Trusted registry

Only registered widget `type`s render; `PUT` rejects unknown types with an
error list (400). Fetch `GET /api/overview/widgets` for the current catalog
with `defaultSize` and accepted `props` per widget. Do not invent types.

Current catalog — needs-me cluster: `blocked` (blocked tasks waiting for a
human), `approvals` (the review lane as your inbox), `agent-questions`
(open `kind: "question"` comments, answerable inline), `since-last-visit`
(what moved while you were away); live: `current-focus` (claimed tasks,
prominent), `active-agents`, `activity-stream`, `timeline` (dated spine),
`stall-detection` (momentum check); github (all opt-in via `props.repo`):
`repo-status` (branch/CI/PRs/commits overview), `gh-pulls` (PR inbox),
`gh-ci` (workflow run history, `props.branch` optional), `gh-releases`
(latest release + unreleased commits), `gh-issues` (triage); direction: `next-up`, `project-goals`,
`task-stats`, `milestones` (tag tasks `milestone:<name>`), `kanban-mini`;
knowledge & actions: `recent-decisions`, `context-index` (pin via
`props.pins`), `file-viewer` (renders one file, `props.path`),
`quick-drop`, `notes` (context/NOTES.md), `links` (`props.links`),
`quick-links`.

GitHub widgets resolve their repository from the project-level binding
(`GET/PUT /api/projects/:name/github`, one repo + branch per project) —
set it once in any gh widget and all of them follow; `props.repo` /
`props.branch` stay as per-widget overrides.

Universal widget props: `title` overrides the display name; `emphasis`
(boolean) visually lifts a card out of the equal-weight grid (stronger
frame, accent tick) — use it to mark what needs the human first.

## Presets

`PUT { "preset": "default" | "coding" | "knowledge" | "mission" }`
materializes a named layout:

- **default** — standard daily driver: momentum + timeline on top,
  knowledge (context, notes, quick-drop) at hand, stats and board below.
- **coding** — repo-first: `repo-status`, `gh-ci`, `gh-pulls` on top,
  focus/blocked/approvals, releases & issues, board preview.
- **knowledge** — document-first: large `file-viewer`, context index,
  notes, decisions — for projects that are mostly thinking, not tasks.
- **mission** — review desk: blocked + approvals emphasized, focus,
  milestones, stats, agents — for steering many parallel agents.

When creating a new project, pick the preset that fits it — or compose a
custom layout from the catalog. Projects without a stored file serve the
`default` preset automatically; you only need to write when deviating.

**At creation time the server already suggests a best fit.** `POST
/api/projects` returns an `overview` hint: `{ preset, rationale, applied,
mode }`. For an agent/headless caller a non-`default` best fit is applied
straight away (`mode: "auto"`, `applied: true`); the dashboard UI receives a
suggestion to confirm (`mode: "suggested"`, `applied: false`). The inference
is a deterministic floor from the project's name/description/group — treat it
as a starting point and override it (preset, flow or full grid) whenever you
know the project better.

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
