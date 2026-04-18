# Project Commands

## Purpose

Chat commands that control project lifecycle and activation state. All commands route through the FlowBoard API — never edit state files by hand.

## Commands

| Utterance | Effect | API |
|-----------|--------|-----|
| `Projekt: [Name]` | Activate project for the current agent | `PUT /api/status` with `{ project, agentId }` |
| `Projekt beenden` | Deactivate the active project | `PUT /api/status` with `{ project: null, agentId }` |
| `Projekte` | Show project list; indicate which is active | `GET /api/projects` + `GET /api/status?agentId=…` |
| `Neues Projekt: [Name]` | Create a project (does NOT auto-activate) | `POST /api/projects` |

## Semantics

- **Active project = context loading, not access control.** Cross-project reads and quick task creation are allowed without switching. Only switch when the main focus of work changes.
- **Creation and activation are separate actions.** After `Neues Projekt:`, the caller must activate explicitly if that's the intended follow-on.
- **Per-agent activation.** Each agent has its own `active_project` row in `flowboard_agents`. Activating a project for one agent does not affect others.

## Related

- `api-access` — full task & project API reference
- `key-principles` — API-first rule and canonical-state semantics
