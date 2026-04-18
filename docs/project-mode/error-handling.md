# Error Handling

## Purpose

Graceful-degradation rules when FlowBoard state is partial, stale, or inconsistent. Prefer canonical DB/runtime state over local files; surface problems rather than guessing.

## Rules

- **Missing active project** → projectless mode. No special context injected; act as a normal agent without project scoping.
- **Missing project folder** → surface clearly. Do not silently create it. The canonical creation path is `POST /api/projects`.
- **Missing spec or capability doc** → report and continue. Treat the capability index in `PROJECT-RULES.md` as the coarse-grained fallback.
- **Corrupt or unreadable state file** → prefer the DB-backed canonical source. FlowBoard runtime owns project registry (`flowboard_projects`) and per-agent active-project state (`flowboard_agents`).
- **Migration leftovers** → when a legacy file (`ACTIVE-PROJECT.md`, `_index.md`, `tasks.json`) disagrees with the DB, trust the DB. File state is transitional.
- **API unreachable during bootstrap** → the project-context hook falls back to the local `ACTIVE-PROJECT.md` for legacy compatibility. This is a soft fallback, not the intended path; if the server is expected to be up, surface the connection failure.
- **Claim conflicts (409)** → another agent holds the claim. Read recent checkpoints/comments, then either wait, coordinate, or (if the lease has expired) steal.

## Related

- `key-principles` — why DB is canonical
- `api-access` — claim/lease semantics and the full endpoint reference
