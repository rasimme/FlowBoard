# Projects Endpoints

Project CRUD + the bootstrap and rules endpoints used by external agents to fetch context. All require `HZL_ENABLED=true`.

## `GET /api/projects`

Lists every project with task counts. Per-agent active-project state is not included here — read `/api/agents` or `/api/status?agentId=<id>` for that (ADR-0003).

**Response 200:**

```json
{
  "projects": [
    { "name": "flowboard", "displayName": "FlowBoard", "archived": false, "group": null, "order": 0, "taskCounts": {"backlog": 12, "in-progress": 3, "review": 4, "done": 80} }
  ]
}
```

## `POST /api/projects`

Create a new project.

**Body:**

```json
{
  "name": "myproject",
  "displayName": "My Project",
  "group": "personal"
}
```

**Response 201:** `{"project": {<created project>}, "warnings"?: [...]}`
**400** validation error. **409** duplicate name. **501** if HZL is not enabled.

## `PUT /api/projects/:name`

Update metadata: `displayName`, `archived`, `group`, `order`.

**Body:** any subset of those fields.

**Response 200:** `{"project": {<updated>}}`
**400** validation error. **404** project not found. **501** if HZL is not enabled.

## `DELETE /api/projects/:name?confirm=:name`

Hard-delete with double confirmation. The query parameter must equal the path parameter.

**Response 200:** `{"ok": true, "archivedTaskCount": <n>, "warnings"?: [...]}`
**400** if `?confirm=<name>` is missing or doesn't match.
**404** project not found.

**Side effects:**
- Tombstones the project name; folder moves to `.trash/<name>-<timestamp>/`.
- Every `flowboard_agents` row pointing at this project is cleared (`active_project = null`).

## `GET /api/projects/:name/bootstrap`

Returns the **full** bootstrap document for a project — active-project header, identity stub (caller fills in their own), embedded rule sections, the project's `PROJECT.md`. Used by external agents that prefer eager loading.

**Response 200:** `text/markdown` (not JSON). Body is the bundled markdown document.

The hook for OpenClaw-managed agents does *not* call this endpoint — it uses `buildRulesManifest()` directly from `dashboard/rules-api.js` and only injects the manifest, not the full bundle. See ADR-0001, the [Lazy Loading concept](../../concepts/lazy-loading.md).

## `GET /api/projects/:name/rules`

Lists available rule sections.

**Response 200:**

```json
{
  "ok": true,
  "manifest": "<markdown manifest>",
  "sections": [
    { "name": "commands",       "label": "Project commands (activate, deactivate, list)" },
    { "name": "api-access",     "label": "Task API — endpoints, task model, lifecycle" },
    { "name": "hzl",            "label": "HZL backend — event store, lease semantics, multi-agent state" },
    { "name": "canvas",         "label": "Canvas — ideas, spatial notes, promote-to-task" },
    { "name": "files",          "label": "Project file roles — PROJECT.md, SESSIONS.md, context/, specs/" },
    { "name": "specify",        "label": "Specify workflow — spec generation lifecycle" },
    { "name": "agent-bridge",   "label": "Agent bridge — claim/checkpoint/complete, handoff, multi-agent" },
    { "name": "error-handling", "label": "Error handling — missing files, corrupt state, migration leftovers" },
    { "name": "key-principles", "label": "Key principles — API-first, DB-canonical, context-loading semantics" }
  ]
}
```

## `GET /api/projects/:name/rules/:section`

Returns a single rule section's markdown.

**Response 200:** `text/markdown` body, the section content.
**404** if the section name is unknown.

Section names are public API; the underlying filenames in `docs/project-mode/` are private and may move (ADR-0005).

## See also

- [Lazy Loading concept](../../concepts/lazy-loading.md)
- [ADR-0001](../../adr/0001-live-inject-bootstrap.md)
- [ADR-0005](../../adr/0005-minimal-trigger-and-lazy-rules.md)
