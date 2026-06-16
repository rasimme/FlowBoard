# Migrations Endpoints

Operator-facing endpoints for the gated canvas data migration: importing legacy per-project `canvas.json` files into the DB-backed canvas store ([ADR-0025](../../adr/0025-canvas-state-in-db.md)). The schema itself is created automatically (migration `m008-canvas-schema`); the *data* import only ever runs through these endpoints — triggered by the dashboard update window (`CanvasMigrationBanner`), the headless runner `dashboard/scripts/migrate-canvas-to-db.mjs`, or a manual call.

## `GET /api/migrations/canvas/status`

Migration overview across all projects. Polled by the dashboard banner on init.

**Response 200:**

```json
{
  "pending": [
    { "project": "myproject", "displayName": "My Project", "notes": 12, "connections": 7, "bytes": 4096 }
  ],
  "migrated": [
    { "project": "otherproject", "migratedAt": "2026-06-12T20:11:04.512Z" }
  ],
  "conflicts": [
    { "project": "thirdproject", "displayName": "Third", "bytes": 2048, "migratedAt": "2026-06-12T20:11:04.512Z" }
  ],
  "total": 2
}
```

- `pending` — projects with a `canvas.json` on disk and no `canvas_meta.migrated_at` flag. Counts are the *cleaned* counts (invalid notes, orphaned connections and reverse duplicates dropped) — exactly what a run would import. Empty scaffold files appear with `notes: 0`.
- `migrated` — projects served from the DB store.
- `conflicts` — DB-migrated projects where a literal `canvas.json` exists on disk *again* (typically a workspace restore from a pre-migration backup). The DB stays authoritative and the file is ignored; conflicted projects also remain in `migrated`. Resolution is an operator decision — inspect the file, then delete it or deliberately re-import. Never auto-merged. `.pre-db.bak` files never count as conflicts.
- `total` — `pending.length + migrated.length`.

## `POST /api/migrations/canvas/run`

Run the migration for all pending projects, or a subset.

**Body (optional):**

```json
{ "projects": ["myproject", "otherproject"] }
```

Without a body (or without `projects`), every pending project is migrated. `projects`, when present, must be a non-empty array of valid project names (**400** otherwise).

**Response 200:**

```json
{
  "results": [
    { "project": "myproject", "ok": true, "notes": 12, "connections": 7 },
    { "project": "otherproject", "ok": true, "skipped": true, "notes": 3, "connections": 1 },
    { "project": "brokenproject", "ok": false, "error": "invalid canvas.json: ..." },
    { "project": "thirdproject", "ok": false, "conflict": true, "error": "conflict: ..." }
  ],
  "failed": 2
}
```

Per project the run is: strict read + validation → transactional import → count verification against the cleaned file counts → set `canvas_meta.migrated_at` (flips the dual-read switch to the DB) → rename `canvas.json` to `canvas.json.pre-db.bak` (collision-safe: `.pre-db.bak.<epoch>`). The file is **never deleted** and only renamed *after* the verified import. A failed rename downgrades to a `warning` on an otherwise successful result.

Semantics:

- **Idempotent** — already-migrated projects return `ok: true, skipped: true` with their current DB counts.
- **Partial failures don't stop the batch** — each project gets its own result row; `failed` counts the `ok: false` rows.
- **Failure leaves the file authoritative** — on validation, import, or count-verification failure the migrated flag stays unset and the dual-read switch keeps serving `canvas.json`. A later run repairs the state via the transactional re-import.
- **Conflicts refuse loudly** — a migrated project that has a `canvas.json` again returns `ok: false, conflict: true` instead of silently skipping or re-importing over the DB data (see status endpoint above).

## Headless usage

```
node dashboard/scripts/migrate-canvas-to-db.mjs           # status
node dashboard/scripts/migrate-canvas-to-db.mjs --run     # migrate all pending
node dashboard/scripts/migrate-canvas-to-db.mjs --run --project foo --project bar
```

Talks to a running server (`--base` / `FLOWBOARD_BASE_URL` / `FLOWBOARD_PORT`, default `http://127.0.0.1:18790`). Exit codes: `0` ok, `1` at least one project failed, `2` usage or connection error.

## See also

- [ADR-0025](../../adr/0025-canvas-state-in-db.md) — canvas state in relational DB tables; migration and conflict rationale
- [Idea Canvas concept](../../concepts/idea-canvas.md) — data model and promote pipeline
