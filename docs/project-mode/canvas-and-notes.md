# Canvas & Notes

## Purpose

Reference for the FlowBoard canvas — a per-project spatial workspace for ideas, notes, and connections. Canvas is the primary input surface for the Specify workflow.

## Data Model

Canvas state is stored in DB tables (`canvas_notes`, `canvas_connections`, `canvas_meta` in the events DB file — relational, last-write-wins, not event-sourced; ADR-0025). Always read and write it through the API below, never through files or SQL. The API shape is unchanged from the legacy file era:

```json
{
  "notes": [
    {
      "id": "n1",
      "text": "User auth flow",
      "x": 100, "y": 200,
      "color": "yellow",
      "size": "small",
      "created": "2026-03-15"
    }
  ],
  "connections": [
    { "from": "n1", "to": "n2", "fromPort": "right", "toPort": "left" }
  ]
}
```

Legacy projects that still have a `~/.openclaw/projects/<project>/canvas.json` keep working off that file (per-project dual-read) until the operator runs the gated migration (`GET/POST /api/migrations/canvas/status|run`); the migration renames the file to `canvas.json.pre-db.bak`. New projects are DB-native — no `canvas.json` is created anymore. A literal `canvas.json` re-appearing next to a migrated project is a conflict: the DB stays authoritative, the file is ignored, and resolution is an operator decision (never auto-merge).

### Note Properties

| Field | Type | Notes |
|-------|------|-------|
| `id` | string | Auto-generated, unique within project |
| `text` | string | Content, max 50KB |
| `x`, `y` | number | Position on canvas |
| `color` | string | `grey`, `yellow`, `blue`, `green`, `red`, `teal` |
| `size` | string | `small`, `medium`, `large` |
| `created` | date string | Creation date |

### Connection Properties

| Field | Type | Notes |
|-------|------|-------|
| `from`, `to` | string | Note IDs (bidirectional dedup) |
| `fromPort`, `toPort` | string? | Optional port hints |

## API Endpoints

Base: `http://localhost:18790/api`

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/projects/:name/canvas` | Read full canvas |
| `POST` | `/projects/:name/canvas/notes` | Create note. Body: `{ text, x?, y?, color?, size?, near? }`. Omit **both** `x` and `y` for collision-free auto-placement near the existing note cluster (or beside `near: <noteId>`) — ideal for agents that just want to drop a note. Explicit coordinates (incl. an explicit `0`) are always honored (T-352). |
| `PUT` | `/projects/:name/canvas/notes/:id` | Update note fields |
| `DELETE` | `/projects/:name/canvas/notes/:id` | Delete single note |
| `DELETE` | `/projects/:name/canvas/notes/batch` | Batch delete. Body: `{ noteIds: [...] }` |
| `POST` | `/projects/:name/canvas/connections` | Create/update connection. Body: `{ from, to, fromPort?, toPort? }` |
| `DELETE` | `/projects/:name/canvas/connections` | Delete connection. Body: `{ from, to }` |

## Promote (Canvas → Specify)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/projects/:name/canvas/promote` | Send selected notes to agent for Specify |

Body:
```json
{
  "notes": [{ "id": "n1", "text": "...", "color": "yellow" }],
  "connections": [{ "from": "n1", "to": "n2" }],
  "mode": "single",
  "agentId": "dev-botti"
}
```

Promote supports two paths. **Dashboard path (default, no `agentId`):** creates a Specify session for the `human` agent and the dashboard opens the Specify Stepper — clarification, proposal review, and confirmation happen in the browser, with no webhook configuration required. **Chat-agent path (explicit `agentId`):** the session is routed to that specific chat-bound agent via the gateway webhook (`OPENCLAW_HOOKS_TOKEN` required); if the `agentId` is invalid or dispatch fails, the session is not left active and the endpoint returns an error. Do not broadcast canvas promote to arbitrary project-active agents; chat-based Specify clarification must happen in a user-visible agent chat.

## Behavior Notes

- Deleting a note auto-cleans orphaned connections
- Batch delete cleans connections for all removed notes
- Self-connections are rejected
- Duplicate connections are idempotent (returns `duplicate: true`)
- An empty canvas reads as `{ "notes": [], "connections": [] }` — no setup call needed
- Note IDs come from a monotonic per-project sequence; deleted IDs are never reused
