# Canvas & Notes

## Purpose

Reference for the FlowBoard canvas — a per-project spatial workspace for ideas, notes, and connections. Canvas is the primary input surface for the Specify workflow.

## Data Model

Each project has a `canvas.json` file at `~/.openclaw/projects/<project>/canvas.json`.

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

### Note Properties

| Field | Type | Notes |
|-------|------|-------|
| `id` | string | Auto-generated, unique within project |
| `text` | string | Content, max 50KB |
| `x`, `y` | number | Position on canvas |
| `color` | string | `yellow`, `blue`, `green`, `red`, `purple`, `grey` |
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
| `POST` | `/projects/:name/canvas/notes` | Create note. Body: `{ text, x?, y?, color?, size? }` |
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
- Canvas file is created on first write if absent
