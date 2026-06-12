# Modular Project Overview

The per-project landing page is a **server-driven widget grid**: a JSON
config (`overview.json` in the project directory) describes which widgets
sit where, and a trusted registry decides what may render. Humans edit it
visually (drag/resize), agents edit it through the same REST API they use
for tasks — one schema, two audiences.

## Why it exists

FlowBoard's model is "I come back — what needs me?". A fixed dashboard
can't answer that for every project: a repo-heavy project needs CI and
PRs up top, a thinking-heavy project needs documents and notes, a
multi-agent project needs the review lane first. The overview makes the
landing page itself a project artifact that both the human and the
project's agents can shape.

## The pieces

- **Config** — `overview.json`: `{ version: 1, layout: "grid", widgets:
  [{ id, type, title?, props?, grid: { x, y, w, h } }] }` on a 12-column
  grid (88px rows, 12px gutters, max 40 widgets). `GET/PUT
  /api/projects/:name/overview`; invalid configs are rejected with
  errors, unknown widget *types* in a stored file are skipped on render
  (forward compatibility, ADR-0023).
- **Trusted registry** — the catalog exists three times in lockstep:
  server (`overview.js` `WIDGET_TYPES`), client
  (`src/components/overview/registry.js`) and the agent rule section
  (`docs/project-mode/overview.md`). A drift test
  (`test-overview-registry-drift.js`) fails the build when they diverge.
- **Renderer** — one component serves view and edit
  (`src/pages/OverviewView.jsx`): view mode is a fluid CSS grid, edit
  mode is react-grid-layout with the same cards (visual parity).
  Container queries adapt every widget from w=2 to w=12; reading
  surfaces cap at 1500px so ultrawide monitors don't stretch them.
- **Presets** — `PUT { preset: "default" | "coding" | "knowledge" |
  "mission" }` materializes a curated layout; the picker previews them
  as generated schematics.

## The catalog (25 types)

Grouped the way the picker groups them:

- **Needs you** — `blocked`, `approvals`, `agent-questions` (open
  `kind: "question"` comments, answerable inline), `since-last-visit`.
- **Live** — `current-focus`, `active-agents`, `activity-stream`,
  `timeline`, `stall-detection` (momentum over a per-day aggregate,
  `GET /api/projects/:name/activity/daily`).
- **Direction** — `next-up`, `project-goals`, `task-stats`,
  `milestones`, `kanban-mini`.
- **GitHub** — `repo-status`, `gh-pulls`, `gh-ci`, `gh-releases`,
  `gh-issues`; all resolve the **project-level binding**
  (`GET/PUT /api/projects/:name/github`, one repo + branch per project,
  set once in any of them) with `props.repo`/`props.branch` as
  per-widget overrides. Server-side fetch with a ~150s cache serves
  stale data through rate limits; an optional token (stored write-only
  via `PUT /api/settings/github-token`, env vars take precedence)
  unlocks private repos and the higher rate limit.
- **Knowledge & actions** — `recent-decisions`, `context-index`,
  `file-viewer` (renders one markdown file, picked in the widget),
  `quick-drop`, `notes` (context/NOTES.md with inline markdown editor),
  `links`, `quick-links`.

Universal props: `title` renames a card, `emphasis` lifts it visually
out of the equal-weight grid — agents use it to mark what needs the
human first.

## Conventions that ride on tasks

Two overview features deliberately have **no data model of their own**:

- **Milestones** are tasks tagged `milestone:<name>`. The widget renders
  each milestone as a definition-of-done checklist (checkmarks = task
  status), creates milestones by tagging a multi-select of tasks, and
  removing one just removes the tag. One source of truth: the task.
- **Agent questions** are comment events with `kind: "question"`; a
  comment with `kind: "answer"` + `questionId` resolves one. Append-only
  — the pairing *is* the resolution, no flags to mutate.

## Practical consequences

- Agents compose dashboards with plain HTTP — same auth, same endpoints
  the UI uses. "Pin the deploy link and emphasize blocked" is one PUT.
- Layout edits are safe to experiment with: Save persists exactly what
  the editor shows (compaction included), Cancel restores.
- New widget types must land in all three registry places plus the docs,
  or CI fails — drift is structurally impossible to merge.

## Where the code lives

- Server: `dashboard/overview.js` (catalog, presets, validation),
  `dashboard/github.js` (GitHub fetch + cache + token),
  `dashboard/server.js` (endpoints), `dashboard/hzl-service.js`
  (activity aggregates, questions).
- Client: `dashboard/src/pages/OverviewView.jsx` (renderer/editor),
  `dashboard/src/components/overview/` (registry + widget files),
  `dashboard/styles/overview.css`.
- Tests: `test-overview-api.js`, `test-overview-registry-drift.js`,
  plus the audit harness `dashboard/tools/ov-audit.mjs`.
