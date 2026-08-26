# Projects Endpoints

Project CRUD + the bootstrap and rules endpoints used by external agents to fetch context. HZL is always enabled in current FlowBoard releases.

## `GET /api/projects`

Lists every project with task counts. Per-agent active-project state is not included here — read `/api/agents` or `/api/status?agentId=<id>` for that (ADR-0003).

**Response 200:**

```json
{
  "ok": true,
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
  "group": "personal",
  "taskDiscipline": "standard"
}
```

`taskDiscipline` is optional (`list`, `standard`, or `development`; an unknown
value normalizes to the default `list`). When omitted, the server derives an
initial value from `name`/`displayName`/`description`/`group`: a keyword
match for coding-shaped terms (repo, backend, api, deploy, …) suggests
`development`, a match for docs/coordination-shaped terms (docs, research,
mission, multi-agent, …) suggests `standard`, and anything else defaults to
`list`. This is a one-time starting point, not a lock — change it later via
`GET|PUT /api/projects/:name/task-discipline` (see [tasks.md](tasks.md)).

**Response 201:** `{"project": {<created project>}, "warnings"?: [...]}`
**400** validation error. **409** duplicate name. **501** if HZL is not enabled.

## `GET /api/projects/drift`

Read-only operator listing of names that exist in the `flowboard_projects` metadata table or as a `projects/<name>/` filesystem dir but have no canonical HZL `project_created` event. An empty array means the system is consistent. This endpoint follows FlowBoard's normal auth model: loopback is trusted for the single-operator local deployment, and exposed deployments should use Telegram/JWT auth with `AUTH_ALWAYS=true`. See [ADR-0017](../../adr/0017-project-drift-and-heal.md) for the architectural context.

**Response 200:** `{"drift": [{"name": "<slug>", "sources": ["metadata"|"filesystem", ...]}, ...]}`

Hidden dirs (`.trash`, `.hzl`), tombstoned names, and dirs without a `PROJECT.md` marker are filtered out so the response only contains actionable items.

## `POST /api/projects/:name/heal`

Idempotent recovery: backfill the missing HZL `project_created` event (and, when needed, the missing metadata row) for a project that exists at the filesystem or metadata layer but is invisible to `GET /api/projects` because the canonical event is missing.

Unlike `POST /api/projects`, heal never throws `DUPLICATE` for already-present filesystem/metadata state — that is precisely the case it exists to repair. It explicitly does **not** scaffold `PROJECT.md`/`SESSIONS.md`/`DECISIONS.md` and does **not** overwrite an existing `display_name`.

**Body (all optional):**

```json
{
  "displayName": "My Project",
  "description": "..."
}
```

`displayName` is only honoured when no metadata row exists yet; an existing row's display name is preserved.

**Response 200:** `{"healed": <bool>, "project": {"name", "displayName", "status"}, "actions": ["hzl_event"|"metadata_row", ...]}`

`healed: false, actions: []` means the project was already fully registered (idempotent no-op).

**400** validation error on slug. **404** project absent at every layer (use `POST /api/projects` to create instead). **501** if HZL is not enabled.

## `PUT /api/projects/:name`

Update metadata: `displayName`, `archived`, `group`, `order`.

**Body:** any subset of those fields.

**Response 200:** `{"project": {<updated>}}`
**400** validation error. **404** project not found. **501** if HZL is not enabled.

## `DELETE /api/projects/:name?confirm=:name`

Hard-delete a project — a deliberately two-step, guarded operation (T-357/T-358):

1. The project must already be **archived** (`PUT { "archived": true }`, reversible). Deleting an active project returns **409** `NOT_ARCHIVED`.
2. `?confirm=<name>` must equal the path parameter, **and** an explicit acknowledgement is required — `?hardDelete=true` (or `{ "hardDelete": true }` in the body). Without it: **400** `HARD_DELETE_NOT_ACKNOWLEDGED`. (The project name alone is trivially known, so it isn't treated as proof of destructive intent — this stops "deactivate" from being one-shot-confused with permanent deletion.)

**Response 200:** `{"ok": true, "archivedTaskCount": <n>, "warnings"?: [...]}`
**400** missing/mismatched `confirm`, or missing `hardDelete` ack. **404** project not found. **409** not archived.

**Side effects:**
- Tombstones the project name; the folder moves to `.trash/<name>-<timestamp>/` — **recoverable** via restore below.
- Every `flowboard_agents` row pointing at this project is cleared (`active_project = null`).

## `GET /api/projects/deleted`

Lists tombstoned (hard-deleted) projects so the UI can offer restore.

**Response 200:** `{"projects": [{ "name", "deletedAt", ... }]}`

## `POST /api/projects/:name/restore`

Reverses a hard-delete: untombstones the project and moves its folder back from `.trash/`; tasks reappear from the HZL projection. A deleted project stays restorable until the `.trash/` directory is cleared manually on disk.

**Response 200:** `{"ok": true, "restoredFrom": "<trash path>", "warnings"?: [...]}`
**404** no tombstoned project by that name.

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
    { "name": "error-handling", "label": "Error handling — missing files, inconsistency resolution, migration leftovers" },
    { "name": "key-principles", "label": "Key principles — API-first, DB-canonical, context-loading semantics" },
    { "name": "overview",       "label": "Overview — modular landing page, widget catalog, layout API" },
    { "name": "compliance",     "label": "Compliance — stuck/stale + routed-unclaimed detection, health metrics" }
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

## Overview (T-305)

Per-project modular landing page (Server-Driven UI). The layout lives in
`overview.json` in the project directory and is validated against a trusted
widget registry — agents and the edit-mode UI write the same schema.

### GET /api/overview/widgets
Widget catalog (type, label, description, defaultSize, props) plus the named
presets (`default`, `coding`, `knowledge`, `mission`) and the grid contract
(12 columns, 88px row unit, 12px gutter).

### GET /api/projects/:name/overview
**200** `{ ok, overview }` — the stored config (`source: "file"`), or the
`default` preset (`source: "default"`) when no file exists or the
stored file no longer validates.

### GET /api/projects/:name/export

Downloads a sanitized v1 project review bundle as a `.flowboard.json` file.
The response is read-only and contains only this project's portable metadata,
all current and archived tasks, linked specs, canvas, overview and selected
knowledge Markdown (`PROJECT.md`, `DECISIONS.md`, and safe `context/*.md`).
Internal HZL identifiers, ownership, claims, leases, routes, sessions,
credentials, backups, hidden files and executables are excluded. Optional file
exclusions are recorded as deterministic `manifest.warnings` entries.

**200** `application/json` attachment with a safe filename. **404** if the
project does not exist. **500** if a canonical project read or linked spec
cannot be completed. Importing the artifact is a separate server-side
operation; this endpoint never mutates project files or task state.

### POST /api/projects/import/preview

Previews a portable project review bundle without creating a project or
retaining upload state. v1 accepts only
`application/vnd.flowboard.project+json` (and the optional
`application/octet-stream` transport alias); ZIP/archive media is rejected.
The route uses a bounded raw parser, strict UTF-8 decoding, schema/checksum and
reference validation, path/link metadata checks, case-fold collision checks,
and value-blind sensitive-content warnings.

The optional `targetName` query parameter is the lowercase destination slug.
An existing, tombstoned, or already-present destination returns a successful
preview with `target.availability: "conflict"` and `canImport: false`. A
malformed body returns **400**, unsupported media **415**, and invalid or
unsafe bundle content **422**. Sensitive-content warnings never contain a
secret value or content snippet and set `canImport: false`.

**200** returns a structured preview containing the stable `bundleDigest`,
source/provenance, format compatibility, counts, options, redactions,
included/excluded content, manifest warnings, security warnings and target
availability. Preview is read-only: it does not append HZL events/audits,
write metadata or files, or activate a project.

### PUT /api/projects/:name/overview
Body is either `{ preset: "default" | "coding" | "knowledge" | "mission" }` (materializes the
preset) or a full config:
`{ version: 1, layout: "grid", widgets: [{ id, type, title?, props?, grid: {x,y,w,h} }] }`.
A `{ layout: "flow", widgets: [...] }` body is also accepted — the server packs the
widgets into the grid for you (no hand-placed coordinates).
**200** `{ ok, overview }` — **400** `{ error, errors[] }` on validation
failure (unknown type, grid overflow, duplicate id, …).

### POST /api/projects/:name/overview/ops
Incremental patch-ops (T-365-2) — refine a layout without rewriting it. Body:
`{ ops: [...] }` of small, coordinate-free operations (add / remove / resize /
reorder a widget). The current layout is loaded, the ops applied and re-packed
into a clean grid, then run through the same trusted validator as a full write.
**200** `{ ok, overview }` — **400** `{ error }` (bad op) or `{ error, errors[] }`
(validation) — **404** project not found.

### GET /api/github/repo-status
Query: `repo=owner/name` (required). Feeds the `repo-status` overview
widget — default branch, CI state (`passing|failing|pending|none` from
check-runs), up to 5 open PRs and the 5 latest commits. Fetched
server-side (a `FLOWBOARD_GITHUB_TOKEN`/`GITHUB_TOKEN` env token never
reaches the client) and cached ~150s per repo.
**200** `{ ok, status }` — **400** invalid repo — **404/502** GitHub errors.

### GET | PUT /api/projects/:name/github
Project-level GitHub binding `{ repo, branch? }` — the one repository all
gh-* widgets on the project's overview share. Connecting a repo or
picking a branch in any GitHub widget writes it here; widget
`props.repo`/`props.branch` remain per-widget overrides. `PUT` with
`{ repo: null }` clears the binding.

### GET /api/github/insight
Query: `repo=owner/name` and `view=pulls|ci|releases|issues` (+ optional
`branch` for `ci`). Feeds the `gh-*` overview widgets — open PRs with
requested reviews, workflow run history, latest release vs unreleased
commits, issue triage. Same server-side token and ~150s cache as
repo-status.
**200** `{ ok, insight }` — **400** invalid input — **404/502** GitHub errors.

### GET | PUT | DELETE /api/settings/github-token
Server-side GitHub token for the gh-* widgets, stored write-only in the
meta DB: `GET` returns only `{ set, source }` (never the value), `PUT`
`{ token }` stores it (a `FLOWBOARD_GITHUB_TOKEN`/`GITHUB_TOKEN` env var
takes precedence), `DELETE` removes it. Saving clears the GitHub cache so
the token applies immediately.

### GET /api/projects/:name/stats
Project metrics — the same numbers the `task-stats` overview widget shows,
for agents to query programmatically. **200** `{ ok, stats: { total,
counts: { backlog, open, in-progress, review, done }, blocked,
throughput7d, cycleDays, stuck, generatedAt } }` — counts cover non-archived tasks (subtasks included); `throughput7d` =
completed in the last 7 days (archived-done included); `cycleDays` = mean
created→completed over the most recent 30. These match the task-stats widget exactly.

### GET /api/projects/:name/questions
Query: `limit` (default 20). Open agent questions — comment events with
`kind: "question"` that no `kind: "answer"` comment references via
`questionId`. Answering through the comment endpoint resolves a question;
everything stays append-only on the task's activity feed.
**200** `{ ok, questions: [{ id, taskId, title, author, message, timestamp }] }`

### GET /api/projects/:name/activity/daily
Query: `days` (default 14, max 90). Per-day event counts for the project
plus the latest event — feeds the momentum widget; the row feed caps at
200 events, which busy days outgrow.
**200** `{ ok, days: [{ day, count }], latest, total }`

### GET /api/projects/:name/activity

Project-wide activity feed from the HZL event store (newest first) — feeds
the `since-last-visit` and `activity-stream` widgets.
Query: `since?` (ISO timestamp), `limit?` (default 50, max 200).
**200** `{ ok, activity: [{ taskId, title, agent, event, message, timestamp }] }`
