# ADR-0023: Overview — server-driven UI with a trusted widget registry

## Status

Accepted (2026-06-11, T-305 — modular dashboard concept v2)

## Context

Projects opened on the Kanban, although the natural flow is *ideas →
kanban → files* with a missing hub above it. At the same time v5's headline
ambition is an **agent-customizable** surface: the agent should compose and
rearrange the landing page with the same mechanics it uses for tasks and
canvas notes — without any ability to inject code or arbitrary UI.

A visual page-builder (Puck) was evaluated in depth and rejected for this
surface: it is a document/page editor without resize-in-grid-units or an
x/y/w/h placement model (open upstream issue #843), and its recursive
tree/slot data format would replace FlowBoard's flat, agent-friendly schema.
Analysis: workspace `context/T-305-puck-analyse.md`.

## Decision

**Server-driven UI.** The per-project landing page (`OverviewView`,
default tab) renders from data:

- `overview.json` in the project directory holds
  `{ version: 1, layout: "grid", widgets: [{ id, type, title?, props?, grid: {x,y,w,h} }] }`
  on a 12-column grid (88px row unit, 12px gutter). The schema is flat by
  design: every position directly addressable, trivially writable by agents.
- A **trusted registry** (mirrored server- and client-side) is the only set
  of renderable widget types. `PUT /api/projects/:name/overview` validates
  against it and rejects unknown types/grid violations with an error list;
  the renderer skips unknown types in stored configs (forward
  compatibility — this is the versioning strategy, together with the
  `version` field).
- **Named presets** (`agent`, `status`, `context` — the three design
  variants) can be materialized via `PUT { preset }`. A project without a
  stored file serves the `agent` preset on read; nothing is scaffolded.
- Widgets adapt to their cell width via container queries (w=4 compact →
  w=8+ rich), so any arrangement — human- or agent-made — works.
- **Drag/resize editing** uses react-grid-layout 2.x (v2 uses the nodeRef
  path; layout model `{i,x,y,w,h}` matches the schema 1:1). The editor
  writes the same schema agents write. Puck remains a candidate for a
  later *document-like* generative view layer, not for this grid.
- Agents learn the contract through the lazy-loaded `overview` rule
  section (rules-api).

## Consequences

- UI injection is structurally impossible: agents arrange approved
  widgets, never code. Deep generation (inventing new widgets) and a code
  sandbox stay out of v5 by decision (concept doc "Schnittlinie").
- New widget types ship in lockstep: server catalog (`overview.js`),
  client registry, rule section. Older stored configs keep rendering.
- Thin generative UI (natural language → config, "Stufe 2a") can reuse
  this machinery unchanged; the open guardrail before enabling it is a
  preview/confirm step — validation and unknown-type fallback already
  exist.
- The dashboard carries a new runtime dependency (react-grid-layout,
  MIT, React 18+); the view renders a plain CSS grid outside edit mode.
