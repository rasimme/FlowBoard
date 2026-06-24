# ADR-0017: Project drift detection and healProject() recovery path

## Status
Accepted

## Date
2026-05-22

## Source
- public commits `80ec742` (`feat(project-lifecycle): add healProject + detectProjectDrift`) and `17f79d3` (`feat(api): heal route + drift endpoint + startup invariant; fix stale-check guard`)
- code: `dashboard/project-lifecycle.js` — `healProject()` and `detectProjectDrift()`
- code: `dashboard/server.js` — `POST /api/projects/:name/heal`, `GET /api/projects/drift`, boot-time `[invariant]` warning

## Context

A FlowBoard project's identity lives at three layers that all need to stay aligned:

1. **HZL `events` table — the canonical source of truth.** A project is visible to `/api/projects` only if there is a `project_created` event for it (`dashboard/server.js:949` — the listing iterates over `hzlService.listHzlProjects()`). This is the single-writer model from ADR-0007 / ADR-0008.
2. **`flowboard_projects` metadata table — the enrichment layer.** Stores `display_name`, `status`, `assigned_agents`, `config`. Joined onto the HZL projection by `fbMeta.listProjects(hzlProjects)`.
3. **`~/.openclaw/projects/<name>/` filesystem dir — the content layer.** Holds `PROJECT.md`, `SESSIONS.md`, `DECISIONS.md`, `specs/`, `context/`, `canvas.json` — the human-authored artefacts.

`createProject()` (the orchestration behind `POST /api/projects`) writes all three layers atomically and then refuses to ever rewrite. Its pre-flight checks throw `409 DUPLICATE` if *any* layer already exists. This is correct for the new-project path, but it produces a hard gap when the layers drift apart:

- A legacy migration script writes `flowboard_projects` rows in bulk without firing a corresponding HZL event.
- An agent creates a `projects/<name>/` directory manually (or via a non-API path) to scaffold content.
- A historical schema migration purges or never replays the projection in `projects` (the legacy HZL projection table).

In every case the project becomes invisible to `/api/projects`: it has metadata or files but no HZL event. The user perceives this as "the project disappeared." Worse: `createProject()` rejects any attempt to repair it because the filesystem dir or metadata row already exists, so there is no canonical path to bring it back.

A second problem follows from the same architecture: there is no operator signal that the drift exists. A project can be silently invisible for weeks before anyone notices, because the legacy projection happily reports the projects it does know about and no part of the boot path compares the three layers against each other.

## Decision

Introduce three pieces — none of them weaken the "HZL is the source of truth" invariant.

1. **`healProject(input, deps)` in `project-lifecycle.js`** — idempotent recovery. If a name exists at at least one layer but lacks an HZL event, write the missing event (and, when applicable, the missing metadata row). Explicitly **do not** scaffold `PROJECT.md`/`SESSIONS.md`/`DECISIONS.md` — heal is for *existing* content, not for creating it. Explicitly **do not** overwrite an existing metadata row's `display_name`. If the name is absent at every layer, throw `NOT_FOUND` instead of silently creating a new project.

2. **`detectProjectDrift(deps)` in `project-lifecycle.js`** — read-only inverse. Lists every name that lives in `flowboard_projects` or on disk but not in HZL. Hidden dirs (`.trash`, `.hzl`) and tombstoned names are filtered out. Directories without a `PROJECT.md` marker are also filtered — they are agent manuals, backup snapshots, or unrelated leftovers, not project candidates.

3. **Boot-time `[invariant]` warning in `server.js`** — runs after migrations, logs a single block listing each drift entry with its sources (`metadata`, `filesystem`, or both), with a pointer at `POST /api/projects/<name>/heal`. The corresponding read-only API is `GET /api/projects/drift` for programmatic consumption.

The route surface is:

- `POST /api/projects/:name/heal` — idempotent. Returns `{ healed, project, actions }` where `actions ∈ {'hzl_event', 'metadata_row'}` enumerates what was written. `404` if the name is absent at every layer; `400` on slug validation; `200` with `healed: false, actions: []` on idempotent no-op.
- `GET /api/projects/drift` — returns `{ drift: [{ name, sources }] }`. Empty array means the system is consistent.

`createProject()` stays strict — it is not weakened. The two paths complement each other: one creates from nothing, the other repairs from partial state.

## Consequences

- **Three layers stay aligned by surfacing drift, not by collapsing them.** HZL remains the only writer of project visibility. The metadata table remains an enrichment-only join. The filesystem stays the home of human content. The novelty is making any skew between them auditable rather than silent.
- **The heal path is strictly less powerful than createProject.** It cannot bring a name into existence from scratch (returns `NOT_FOUND` for completely unknown slugs), and it cannot overwrite metadata that already exists. This bounds the blast radius: at worst, a faulty heal call writes a `project_created` event for a name that already has filesystem content the user wanted to keep — and that content remains untouched.
- **The boot warning trades log volume for early detection.** Operators see drift the moment the dashboard starts, not weeks later when someone notices "where did project X go?". The cost is one WARN block per boot when drift is present; the benefit is that the failure mode that motivated this ADR (silent invisibility) becomes immediately diagnosable.
- **`PROJECT.md` is now load-bearing as a marker.** Any dir under `projects/` without it will be ignored by the drift detector. This codifies an existing implicit convention from `_scaffoldFilesystem()` (which always writes `PROJECT.md`) into a system-level invariant. Tools and scripts that create project-shaped directories should write `PROJECT.md` first, then content — otherwise their dir is treated as "not a project."
- **Heal does not undo deletions.** If `flowboard_deleted_projects` tombstones a name, heal throws `NOT_FOUND` rather than reviving it. Restoring a deleted project remains a manual operation (move from `projects/.trash/`, clear the tombstone, then `POST /api/projects`).
- **A future change could fold heal back into createProject** as a `mode: "heal"` flag, but the current split keeps semantics legible: `POST /api/projects` always means "from nothing", `POST /api/projects/:name/heal` always means "from partial state." Mixing them would reintroduce the ambiguity this ADR exists to remove.
- **The drift endpoint is read-only operator metadata, not a public discovery API.** It follows FlowBoard's normal auth model: loopback is trusted for the single-operator local deployment, and non-loopback/production access should be behind Telegram/JWT auth (`AUTH_ALWAYS=true` when exposed). Writing the actual heal requires a POST, which is subject to the same auth as `POST /api/projects`.

## See also

- ADR-0007 — HZL Task-Bridge + Brain/Muscle split (HZL as source of truth)
- ADR-0008 — HZL single-writer constraint (why heal must go through `hzlService.createProject`)
- ADR-0004 — On-disk `BOOTSTRAP.md` is non-authoritative (similar invariant: file presence ≠ canonical state)
- `dashboard/test-heal-project.js` — unit-test contract for `healProject` and `detectProjectDrift`
