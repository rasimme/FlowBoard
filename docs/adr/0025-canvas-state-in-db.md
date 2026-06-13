# ADR-0025: Canvas state in relational DB tables — gated migration off `canvas.json`

## Status
Accepted

## Date
2026-06-12

## Source
- epic T-344 (private workspace specs T-344 / T-344-1..-8) — schema, dual-read, migration workflow, UI window, conflict semantics
- code: `dashboard/hzl-service.js` (canvas store, `CANVAS_SCHEMA`), `dashboard/migrations.js` (`m008-canvas-schema`, with the full target-DB rationale as an inline comment), `dashboard/server.js` (`canvasBackend()`, `/api/migrations/canvas/*`), `dashboard/src/components/CanvasMigrationBanner.jsx`, `dashboard/scripts/migrate-canvas-to-db.mjs`
- ADR-0014 — the `canvas.json` decision this ADR supersedes
- ADR-0008 (single-writer), ADR-0018 (filesystem rollback detection) — the invariants the new storage relies on

This ADR supersedes ADR-0014.

## Context

ADR-0014 stored canvas state as one `canvas.json` per project: full-file replace on every write, no event log, no DB involvement. The arguments were sound for the canvas of that time and most of them still hold — but the file split itself started to hurt:

- **Two canonical stores for one dashboard.** Tasks, projects, agents and settings live in SQLite; the canvas alone lived in per-project JSON files. Every operational concern (backup, restore, integrity checking, multi-surface access) had to be solved twice.
- **File-level last-write-wins.** Concurrent writers (UI + agent via API) replace the whole file; a lost update silently drops notes. The DB store keeps last-write-wins *semantics* but at row granularity behind a single writer, which removes the lost-file-update class entirely.
- **Backup and integrity unification.** The events DB file is watermark-protected against filesystem-level rollbacks (ADR-0018); `canvas.json` had no equivalent — a stale restore of a project folder silently reverted the canvas with no signal.

What has *not* changed: the ADR-0014 case against event-sourcing the canvas. Canvas edits are rapid micro-interactions (drag, snap, re-route); event-sourcing them faithfully floods the log with audit-useless events, and coarsening events replicates snapshot semantics with extra overhead. There is still effectively one projection — the canvas itself. Event-sourcing remains rejected; only the storage location moves.

## Decision

**Canvas state moves to plain relational tables — `canvas_notes`, `canvas_connections`, `canvas_meta` — with last-write-wins row updates and no event log.** The legacy `canvas.json` files are imported through a user-gated migration and kept as renamed backups; they are deprecated as a storage format.

**Target DB: the events DB file (`flowboard.db`), not the cache DB.** The cache DB (`flowboard-cache.db`) is documented as disposable — deleting it forces a projection rebuild from the event store. Canvas data is canonical and *not* derivable from events, so it must not live in a file whose operational contract is "safe to delete". The events DB file is the canonical, watermark-protected file (ADR-0018). Its append-only triggers guard only the `events` table; plain tables alongside it are fine, and the single-writer constraint (ADR-0008) holds because all canvas access goes through the canvas store in `hzl-service.js`. The full pre-verification (which code paths drop which DB file) is recorded as a comment on migration `m008-canvas-schema` in `dashboard/migrations.js`.

**Dual-read transition, per project.** `canvasBackend(project)` is the single switch: projects flagged in `canvas_meta.migrated_at` use the DB store; unmigrated projects keep the legacy file behavior byte-for-byte (same response shapes, same error semantics). The eight canvas endpoints and the Specify-PERSIST cleanup all go through the switch. New projects are DB-native from creation — no `canvas.json` scaffold is written anymore.

**Gated migration, never automatic.** Schema creation (`m008`) is automatic; the *data import* is not. The operator triggers it via the dashboard update window (`CanvasMigrationBanner`: banner → modal → run → result, "Later" dismisses per browser session), via `GET/POST /api/migrations/canvas/status|run`, or via the headless `dashboard/scripts/migrate-canvas-to-db.mjs`. Per project the run is: strict read + validation → transactional import → count verification against the cleaned file counts → flip `migrated_at` → rename `canvas.json` to `canvas.json.pre-db.bak` (collision-safe: `.pre-db.bak.<epoch>`). The file is **never deleted** and only renamed *after* the verified import; on any failure the flag stays unset and the dual-read switch keeps serving the file. Partial failures don't stop other projects; re-runs are idempotent.

**Conflict behavior (ADR-0018 family).** A workspace restore from a pre-migration backup can put a literal `canvas.json` back next to a DB-migrated project. The DB stays authoritative and the file is ignored; the status endpoint reports the project under `conflicts`, the server logs a warning, and an explicit migration run for it refuses with `ok: false, conflict: true`. There is deliberately **no auto-merge and no silent overwrite in either direction** — resolution is an operator decision: inspect the file, then delete it or deliberately re-import. The inverse case — imported DB rows while `migrated_at` is unset (a run that failed count verification) — is *not* a conflict: the file remains authoritative and a later successful run repairs the state transactionally.

**Deliberate deviation: monotonic note IDs.** The legacy implementation derived the next note ID by max-scanning current notes, so deleting the highest note could reuse its ID. The DB store draws IDs from a per-project sequence (`canvas_meta.note_seq`); deleted IDs are never reused. Format (`N-` + zero-padded number) and continuation from the current max are identical.

## Consequences

- **One canonical store.** Canvas data shares the events DB file's operational story: single file to back up, watermark-protected against stale restores (ADR-0018), readable by any server-side surface without per-project file IO.
- **`canvas.json` is deprecated.** It survives only as `.pre-db.bak` backups and in unmigrated installs during the dual-read transition. No documentation may describe it as the canonical store except historically. A re-appearing `canvas.json` next to a migrated project is a *conflict signal*, not a data source.
- **Still no audit trail and no multi-agent merge.** Last-write-wins moved from file level to row level — finer-grained, but two concurrent edits to the *same* note still resolve by last write. ADR-0014's consequence stands: if collaborative canvas editing becomes real, that is a new decision.
- **Recovery changes.** Restoring a canvas is no longer "copy `canvas.json` back". For migrated projects, canvas state is part of the DB backup/restore; the `.pre-db.bak` file is a one-time pre-migration snapshot, re-importable only by deliberate operator action (resolve the conflict first).
- **Operational notes (known issues, tracked separately):**
  - Backup jobs that exclude SQLite `*.db-wal`/`*.db-shm` files must run a `wal_checkpoint` against the events DB before the backup, or recent canvas (and event) writes that still sit in the WAL are missing from the backup. The reference deployment's nightly backup currently checkpoints a different DB only, while the events DB WAL can grow to hundreds of MB — a real gap until fixed.
  - Backup excludes matching `*.bak*` will skip the `canvas.json.pre-db.bak` safety copies; the reference deployment's nightly backup currently does. Until adjusted, the pre-migration snapshots exist only on the live disk.
- **Schema changes are real migrations now.** Adding a note field is an `ALTER TABLE` in a registered migration instead of a tolerated extra JSON key. Costlier per change, but versioned and testable.

## See also

- ADR-0014 — the superseded `canvas.json` decision (its case against event-sourcing is carried forward, not overturned)
- ADR-0008 — single-writer constraint the canvas store operates under
- ADR-0018 — filesystem rollback detection; the conflict semantics here extend its restore-incident thinking to canvas data
- [Idea Canvas concept](../concepts/idea-canvas.md) — data model and promote pipeline
- [Migrations API reference](../reference/api/migrations.md) — `GET/POST /api/migrations/canvas/status|run`
