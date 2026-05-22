# ADR-0018: HZL filesystem-level rollback detection via boot watermark

## Status
Accepted

## Date
2026-05-22

## Source
- `dashboard/hzl-integrity.js` — the watermark module
- `dashboard/server.js` — boot-time check, `GET /api/health/integrity` endpoint
- `dashboard/test-hzl-integrity.js` — unit-test contract
- public commits on `dev` introducing the feature
- ADR-0008 (HZL single-writer constraint) and the `events_no_update` / `events_no_delete` triggers — the SQL-layer invariants this ADR extends

## Context

The `events` table holds the canonical history of every task and project mutation. Two SQL triggers — `events_no_update` and `events_no_delete` — enforce the append-only invariant at the SQL layer: no `UPDATE` and no `DELETE` against the events table will ever succeed. This is the foundation that the projection in `tasks_current` and every downstream consumer rely on.

The triggers protect against logical mistakes (a future change to the codebase that tries to delete events, an accidental `sqlite3 flowboard.db "DELETE FROM events"`, an outbound migration that miscompiles). They do **not** protect against the file itself being replaced from underneath the running service:

- a snapshot/restore tool (Time Machine selective restore, `rsync --delete` from a stale snapshot, `cp old.db /path/to/flowboard.db`) overwrites the live `.db` file with an older copy that has fewer events
- a poorly written boot-time script restores `.hzl/` from a backup directory before the service starts
- a manual `git checkout` in the workspace repo replaces tracked DB blobs with an older revision

In any of these cases the SQL invariants stay technically satisfied — no event row was modified or deleted via SQL — but the dashboard wakes up serving a regressed state. The previous boot saw `max(events.id) = N`; the new boot sees `max(events.id) = M` where `M < N`. The N − M events between the two are silently gone. Reads continue, the projection is rebuilt to match the older state, and no part of the runtime signals that anything is wrong.

A real incident demonstrated the failure mode: between two boots, the live `events` table regressed by 163 rows (six days of writes), and the dashboard kept serving as if nothing had happened. The backup chain (the workspace git repo pushed nightly to GitHub) still held the lost events, so recovery was possible — but only because an operator noticed missing projects and dug. With more time elapsed, the daily backup would have overwritten the good history with the regressed one, making recovery impossible.

The gap is structural: SQL triggers cannot observe filesystem-level mutations of the database file they live in.

## Decision

Add a single-purpose integrity watermark that lives at the application layer and survives across boots:

1. **Watermark storage**: three rows in `hzl_local_meta` (the existing per-instance key/value table inside `flowboard-cache.db`):
   - `integrity.events_max_id` — the highest `events.id` last seen
   - `integrity.events_count` — `COUNT(*) FROM events` last seen
   - `integrity.last_check_at` — ISO-8601 timestamp of the last successful check

2. **Boot-time check** (in `server.js`, immediately after `hzlService.init()`):
   - read the stored watermark
   - read the current `MAX(id)` and `COUNT(*)` from `events`
   - compare: if either current value is *lower* than the stored value, treat as a regression

3. **On regression**:
   - log a multi-line `[integrity] ⚠️ REGRESSION DETECTED` block to stderr that names the previous and current values and points the operator at the workspace git history and the manual `DELETE FROM hzl_local_meta WHERE key LIKE 'integrity.%'` reset path
   - **do not** overwrite the watermark — keep the higher previous value so subsequent boots continue to flag until the operator explicitly clears it
   - if `HZL_INTEGRITY_STRICT=true` is set in the environment, `process.exit(1)` after logging; otherwise continue serving

4. **On no regression**:
   - overwrite the watermark with the current values so the baseline tracks normal growth

5. **External visibility** via `GET /api/health/integrity` (no auth, matches the existing `/api/health` pattern):
   - returns `{ stored, current, regression, boot_check, strict_mode }`
   - lets monitoring tools poll for the regression flag without depending on any particular notification channel (Telegram, Slack, PagerDuty, email — adopters wire their own)

6. **Optional push notification** via `INTEGRITY_WEBHOOK_URL` (+ optional `INTEGRITY_WEBHOOK_TOKEN` as Bearer auth):
   - on regression, the server `POST`s a JSON body to the configured URL with a 5-second `AbortSignal` timeout
   - body shape: `{ message, regression, current, stored, host }`. The `message` field carries the human-readable one-line summary and matches the OpenClaw gateway's `/hooks/agent` contract (verified against a live install — the gateway returns `400 message required` when the field is missing). The structured `regression` / `current` / `stored` / `host` fields ride alongside for monitoring tools that prefer parsed data over string scraping.
   - adopters running a different notification surface (Slack incoming webhook expects `text`; Discord expects `content`; PagerDuty Events API expects `payload.summary`) wire a small relay between FlowBoard and their channel; the body schema documented here is stable and the upstream code stays free of any specific notification-framework knowledge
   - in `HZL_INTEGRITY_STRICT` mode the server `await`s the `fetch` (capped by the timeout) before `process.exit(1)`, so the alert lands before SIGTERM-equivalent shutdown cuts it off

The check is intentionally minimal — it does not attempt to repair the data, the upstream code does not know about any specific notification channel, and the boot path adds one read + two writes plus an optional outbound `POST` per boot when a regression fires.

## Consequences

- **The append-only invariant now has a second line of defence.** Triggers catch in-SQL mistakes; the watermark catches filesystem-level overwrites. Together they cover the realistic failure modes that ADR-0008 alone could not.
- **First boot after upgrade is silent.** With no stored watermark, the first check writes the baseline and reports `regression: null`. Existing installations get protected only on the *second* boot onwards, after the first baseline has been written.
- **A legitimate restore looks like a regression.** If an operator deliberately rolls back the database (because the recent state was bad), the watermark will flag it as a regression on the next boot. The reset path is documented inline in the WARN message and in the env-vars reference: `DELETE FROM hzl_local_meta WHERE key LIKE 'integrity.%'`. We chose this trade-off because a noisy false positive after a deliberate operator action is much less harmful than a silent regression after an accidental one.
- **`strict_mode` is opt-in, not the default.** Public adopters running the dashboard on a single user's laptop should not have the service refuse to start on a regression — they should see the warning and decide. Operators running multi-tenant or unattended deployments are the ones who want hard fail-fast, and they can flip `HZL_INTEGRITY_STRICT=true`.
- **The endpoint is unauthenticated.** Mirroring `/api/health`, the integrity endpoint must be reachable by external monitoring even when the auth setup is incomplete. The response contains only counters and timestamps — no secrets, no PII, no project-specific data.
- **The watermark lives in `flowboard-cache.db`, not `flowboard.db` itself.** This is deliberate: if the events DB is rolled back, an attacker (or restore script) cannot also roll back its own watermark in the same operation. The two files have to be replaced *together* with consistent content to hide a regression. That raises the bar enough that the realistic failure modes (single-file restores, selective backup tools) get caught.
- **The check assumes monotonic growth.** A future feature that legitimately shrinks the events table (e.g. a retention policy that aggregates and deletes old events) would need to either (a) update the watermark explicitly via the same code path or (b) replace the bare comparison with a structural check (hash chain, last-event-id pointer per project, etc.). This ADR does not commit to such a feature; the trigger-based append-only invariant remains the canonical model.
- **A `count_regressed` type exists in addition to `max_id_regressed`.** A count-only regression with the same max_id is rare in practice — it would require a partial restore that copied a subset of rows while preserving the highest id — but the check is cheap and the diagnostic helps when it happens.

## See also

- ADR-0007 — HZL Task-Bridge + Brain/Muscle split (the architecture this defends)
- ADR-0008 — HZL DB single-writer constraint (the SQL-layer invariants this complements)
- ADR-0017 — Project drift detection and `healProject()` recovery path (sibling: surfacing skew between layers)
- `docs/reference/env-vars.md` — `HZL_INTEGRITY_STRICT` configuration
- `dashboard/test-hzl-integrity.js` — unit-test contract for the watermark logic
