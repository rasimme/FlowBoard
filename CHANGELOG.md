# Changelog

### v5.0.4 (2026-06-25) — ClawHub Security Hardening

- **Hardened dashboard file and task mutation surfaces.** Project file reads now
  use a Markdown allow-list, destructive handlers write append-only audit
  records, and high-blast delete paths require typed confirmation tokens.
- **Tightened local network and secret handling defaults.** LAN access is now
  opt-in via `FLOWBOARD_ALLOW_LAN`, CORS defaults to loopback-only, and database
  files holding GitHub tokens are created with stricter permissions plus a
  plaintext-at-rest warning.
- **Reduced packaged and scanner-facing surface.** Legacy scanner triggers,
  dead routes, the DesignTest dev view, and non-runtime artifacts stay out of
  the published package; `SECURITY.md` now states the current threat model
  honestly.
- **Validated by release gates and adversarial review.** The hardening range was
  reviewed for bypasses across read allow-lists, confirmations, CORS, audit
  logging, S-13 LAN behavior, and chmod handling before release.
- **Fixed task archive error reporting.** Invalid archive transitions now return
  actionable 400/409 responses instead of a generic 500 while keeping the
  existing archive rules intact.

### v5.0.2 (2026-06-22) — Custom Ports & ClawPack Publishing

- **Fixed AGENTS snippet migration for custom dashboard URLs.** The snippet
  doctor now renders the canonical current block from configured
  `FLOWBOARD_BASE_URL` / `FLOWBOARD_PORT` values, so custom-port installs no
  longer drift back to the default `18790` URL.
- **Published from ClawPack artifacts.** The release gate now packs a `.tgz`,
  validates the source package, and dry-runs publish with the exact packed
  tarball so ClawHub releases do not regress to legacy ZIP artifacts.
- **Documentation polish.** The remote-access README anchor is now explicit, so
  links jump reliably into the collapsed details section.

### v5.0.1 (2026-06-22) — ClawHub Plugin Install Fix

- **Fixed ClawHub plugin installs.** The packaged artifact now carries the
  native OpenClaw extension entry, and the release install canary verifies that
  the plugin imports and registers the `agent:bootstrap` project-context hook.
- **Custom dashboard URLs are wired end-to-end.** `/api/info`, the external
  trigger installer, and the project-context hook now share base-URL resolution
  via `FLOWBOARD_BASE_URL`, `FLOWBOARD_API`, `FLOWBOARD_PORT`, and plugin
  config (`dashboardBaseUrl` / `dashboardPort`).
- **Release gates hardened.** The custom-port smoke now covers installer output,
  docs drift tracks the URL helper, and hook integration tests assert plugin
  dashboard URL config behavior.

### v5.0.0 (2026-06-17) — React Rebuild, Event-Sourced Backend & Multi-Agent Workspaces

FlowBoard v5 is a ground-up rebuild: a full React frontend, an event-sourced
task backend (HZL), first-class multi-agent support, a customizable project
Overview, a reworked Idea Board + Specify workflow, and installation as an
OpenClaw/ClawHub plugin. Upgrading from 4.0.1 runs automatic migrations plus a
few manual steps — see **Breaking changes & upgrade notes** below.

#### Highlights

- **React + Tailwind rebuild** of the entire dashboard — the last vanilla
  surface (the Idea Canvas) is React too; no vanilla runtime remains.
- **Event-sourced task store (HZL)** — tasks live in an embedded, append-only
  SQLite event log with recomputable projections and a full audit trail,
  replacing per-project `tasks.json`.
- **Multi-agent, first-class** — stable per-action agent identity, external
  (non-OpenClaw) agent discovery & self-onboarding, idle auto-deactivation,
  and a full claim/release/handoff/route task lifecycle over REST.
- **Modular Project Overview** — a server-driven widget dashboard composed from
  a trusted registry; arrange it by agent (REST) or via a drag/resize editor.
- **Idea Board + Specify** — a React canvas plus an iterative
  ANALYZE → CLARIFY → GENERATE workflow driven by a stateless OpenClaw CLI
  worker, with complexity tiers and transactional rollback.
- **ClawHub plugin packaging** — the project-context hook ships as a packaged
  plugin (`openclaw plugins install`) with one-command dashboard bring-up.

#### ⚠️ Breaking changes & upgrade notes (4.0.1 → 5.0.0)

- **Task store is HZL-only.** Existing `tasks.json` boards are auto-migrated to
  the SQLite event store on first launch; the legacy dual-mode store and
  `HZL_ENABLED` guards are gone.
- **Project metadata moved to the database** (`flowboard_projects`), replacing
  the `_index.md` registry (migrated automatically at startup).
- **Canvas state moved to the database** (`canvas_notes` / `canvas_connections`).
  This migration is **gated, never automatic** — run it from the in-app update
  window, the migration API, or the headless script; `canvas.json` is renamed to
  `.pre-db.bak` (never deleted) only after a verified import. See *Canvas state
  moved into the DB* below for operator/backup notes.
- **Agent identity overhaul.** The `AGENT_ID` service default is removed; actions
  route by caller-supplied `agentId`. `GET`/`PUT /api/status` now require an
  explicit `agentId` (400 if omitted); the implicit `"main"` default is gone. See
  *Per-Agent API Hardening* below for the migration steps.
- **Workspace files are no longer written or authoritative.** `BOOTSTRAP.md`,
  `ACTIVE-PROJECT.md`, and `PROJECT-RULES.md` are replaced by API-served,
  lazy-loaded bootstrap/rules (`GET /api/projects/:name/bootstrap`,
  `…/rules/:section`). Delete stale files; read state via the API.
- **Agent notification hook payload** field renamed `text` → `message`
  (`/hooks/agent`); update any custom hook payloads.
- **Frontend integration surfaces removed.** `window.appState` is now a
  read-through Proxy over a React-owned store; the command/navigation `window._*`
  bridges and the `__showSpecifyStepper` global no longer exist — use
  `useDashboard()` / `useNavigation()`. All `/api` calls must go through
  `apiFetch`/`apiJson`.
- **Epics require an explicit approve.** A parent reaches `review` only when all
  subtasks are review/done and never auto-completes; `review → done` is a manual
  approve action.
- **Idle auto-deactivation.** Agent project activations expire after a
  configurable idle window (default 48h, `FLOWBOARD_AGENT_IDLE_TTL_HOURS`);
  `GET /api/status` is now the per-run liveness heartbeat (no longer
  side-effect-free). An agent holding a live task claim is never deactivated.
- **Single-writer database** (by convention). Exactly one dashboard process may
  write to the task DB; stop the dashboard before migrating/restoring it.
  Read-only access is fully supported.
- **`PROJECT.md` is now a load-bearing project marker** — directories without it
  are ignored by drift detection; scaffolding tools must write it first.
- **Default landing screen is the Overview** (above the Kanban board).
- **Hook install path changed.** Install via `openclaw plugins install`
  (replaces `install-hooks.sh`); run `snippets-doctor --apply` (byte-identical
  legacy blocks) or `--apply --migrate` (force-replace divergent blocks). The
  long always-on trigger is replaced by a ~20-line minimal trigger.
- **Deployment/security:** `dashboard-data.json` is kept out of the repo; review
  auth/CORS/host-binding config after upgrade. **CI runs on Node 22.**

The detailed, batch-by-batch record of the v5 cycle follows.

#### v5 Release Hardening (T-288)

- **Safer project deletion + restore (T-357, T-358).** Hard-deleting a project
  now needs an explicit `hardDelete` acknowledgement on top of `?confirm=<name>`
  AND the project must be **deactivated (archived) first** — a bare confirm is
  rejected with guidance toward `PUT { archived:true }`. The UI only offers
  "Delete permanently" on already-archived projects. Deleted projects are
  recoverable: a new **Trash** section in the sidebar lists them with a
  **Restore** action (`GET /api/projects/deleted`, `POST /api/projects/:name/restore`).
  Prompted by an accidental hard-delete; the goal is that a project can't be
  deleted by mistake and can always be brought back.

- **Review-followup hardening (T-355).** Fixed a stored XSS in the canvas note
  markdown link renderer (the href is now attribute-escaped; non-http(s) schemes
  are neutralized). Hardened the file endpoints: `PUT` is allow-listed to
  `context/`/`specs/`, and write/delete never follow symlinks while reads cannot
  resolve outside the project/projects/repo roots. The rate limiter no longer
  skips Cloudflare-tunnel traffic, JWT verification is pinned to HS256, and the
  auth middleware was de-duplicated. Functional fixes: global search switches to
  the Tasks tab so the result is revealed; canvas API calls carry auth via
  `apiFetch`; a same-project reparent refreshes the board immediately. The
  context `state` is now an immutable snapshot (meaningful React identity). Plus
  smaller cleanups (task-title trim/bound, memoized note markdown, timer
  cleanup). Remaining architecture cleanup tracked in T-356.

- **Canvas: server-side note auto-placement (T-352).** `POST /canvas/notes`
  without `x`/`y` now drops the note into a collision-free slot near the existing
  cluster (or beside an optional `near` note) instead of stacking at (0,0) —
  agent-friendly. Explicit coordinates are still honored.

- **In-dashboard self-update (T-353).** After `openclaw plugins update flowboard`,
  the SnippetUpgrade panel detects the newer on-disk version and offers a
  one-click rebuild + restart (`setup.mjs --update`; `.env`/data untouched) via
  `GET/POST /api/update/status|run`, then reloads onto the fresh build.

- **Canvas v2 — editing & navigation polish (T-345).** The note sidebar is now
  a real CodeMirror `MarkdownEditor` (syntax-highlighted) instead of a plain
  textarea; a **minimap + zoom controls** (−/%/+/Fit) make pan/zoom
  discoverable; the **viewport persists per project** for the browser session
  (no more starting zoomed-out); deleting uses an **undo toast** instead of a
  confirm modal; Escape clears the connection overlay → sidebar → selection;
  and a double-click reliably opens the editor (rendered markdown on the card
  is display-only, so links/formatted text no longer swallow the gesture —
  links are followed from the sidebar). The canvas DB migration window was
  folded into the existing "Migration required" update window (no separate
  banner).

- **Canvas state moved into the DB — `canvas.json` deprecated (T-344).** Canvas
  notes/connections now live as plain relational tables (`canvas_notes`,
  `canvas_connections`, `canvas_meta`) in the events DB file — last-write-wins,
  deliberately still not event-sourced. ADR-0025 supersedes ADR-0014. The data
  import is user-gated: a dashboard update window (banner → modal → run →
  result, "Later" per browser session) or `GET/POST
  /api/migrations/canvas/status|run` / `scripts/migrate-canvas-to-db.mjs`
  migrates per project (transactional import, count verification), then renames
  `canvas.json` to `canvas.json.pre-db.bak` — the file is never deleted.
  Unmigrated projects keep working unchanged via a per-project dual-read
  switch; new projects are DB-native (no `canvas.json` scaffold). Note IDs now
  come from a monotonic sequence — deleted IDs are no longer reused.
  **Operator notes:** if a `canvas.json` re-appears next to a migrated project
  (e.g. restored from a pre-migration backup), the DB stays authoritative, the
  status endpoint reports a conflict, and a run refuses — inspect the file,
  then delete it or re-import deliberately; never auto-merged. Check your
  backup excludes: jobs skipping `*.db-wal`/`*.db-shm` need a
  `wal_checkpoint` on the events DB before backup (canvas writes now sit in
  that WAL), and `*.bak*` excludes will skip the `.pre-db.bak` safety copies.

- **Canvas is React now — no vanilla runtime left (T-340).** The Idea Canvas
  was ported 1:1 from vanilla ES modules to React: the tuned routing/cluster/
  markdown logic moved verbatim into pure, unit-tested modules
  (`src/utils/canvas*.mjs`), rendering/state/events live in `CanvasView.jsx` +
  `src/components/canvas/`. Behavior, server API and `canvas.json` persistence
  are unchanged; promote opens the Specify stepper via context instead of a
  window bridge. `dashboard/js/` (canvas modules, `utils.js`, `app.js`
  bootstrap) is gone — the bootstrap is now `src/bootstrap.js`, first import of
  the bundle. Covered by ~160 new unit assertions plus a headless browser
  smoke (`test-canvas-browser-smoke.js`). ADR-0024 supersedes ADR-0012.

- **Modular project overview (T-305).** Every project now opens on a
  widget dashboard instead of the Kanban: active agents (claims, lease
  countdown), task stats, next-up, decisions/goals from markdown, quick
  links and a board preview — arranged by `overview.json` on a 12-column
  grid. Agents compose the page through `PUT /api/projects/:name/overview`
  (trusted registry, named presets `agent`/`status`/`context`); humans get
  a drag+resize editor (react-grid-layout) writing the same schema.

- **Parent aggregation honors the review gate.** One aggregation rule
  remains (`recalcParentStatus`): while any subtask still has work left the
  parent stays In Progress; once every subtask is Review or Done the parent
  moves to Review. Parents never auto-complete — Review → Done is the
  approve action. Previously two competing rules could push a parent
  straight to Done, bypassing approval. The subtask-update response now
  reports the parent transition. (T-299)

- **Packaging no longer leaks private data.** The npm `files` allowlist gained
  negations for local plan docs, test residue (project dirs, test-workspaces,
  test files, fixtures) and SQLite WAL/SHM; the privacy scanner now also
  dry-runs `npm pack` and rejects forbidden paths and the bare operator name.
- **Git history scrubbed.** Pre-anonymization screenshots (real project names)
  and the internal SECURITY-REVIEW.md were removed from the entire history;
  the synthetic demo screenshots remain.
- **Version bumped to 5.0.0** across both package.json files, the OpenClaw
  plugin manifest, and the README badge.
- **Fresh install works.** Quick Start now builds the frontend; the server
  warns and serves a build-required page instead of a bare 500 when `dist/`
  is missing, while keeping the API up for headless/CI installs.
- **Docs match v5 promote behavior.** README, the idea-canvas concept, and the
  canvas-and-notes rule no longer claim webhooks are required for promote —
  the dashboard stepper path needs none; only the chat-agent path does.
- **Dependencies clean.** `npm audit` reports zero vulnerabilities (was 2 high
  / 2 moderate). Agent-facing wake-event strings are English.

#### Specify Clarify Loop (T-262)

- **Real iterative clarification for Canvas → Create Task.** The Dashboard
  Specify Stepper now runs a genuine ANALYZE → CLARIFY → GENERATE loop:
  multiple-choice questions with a recommended option and free-text override,
  one at a time, capped (default 4, `SPECIFY_MAX_QUESTIONS`), with skip,
  retry, and a proposal revise loop ("Request changes"). No more static
  fallback proposal in production — a missing worker is a retryable error.
- **OpenClaw-backed Specify worker, zero setup.** Worker steps run as
  synchronous `openclaw agent --json` one-shots against `SPECIFY_WORKER_AGENT`
  (default `main`) in isolated session keys (ADR-0021). FlowBoard owns no
  model credentials; responses are schema-validated server-side.
- **All decomposition tiers persist correctly.** Single task, parent +
  subtasks, individual subtask specs, and multiple parents (role-tagged
  breakdown, own spec per parent). Specs are created through one canonical
  path (`specs/<taskId>-<slug>.md`) shared with the specs API and linked to
  the owning task only. New tasks land in Backlog. Persistence rolls back
  tasks and specs on failure; canvas notes are deleted last and only with
  the (default-on) cleanup checkbox.
- **Post-create flow.** Success screen with created task ids, success toast,
  canvas refresh, and a View-in-Kanban jump that highlights the new task.
- **Dashboard promote needs no hooks token.** The 503 on installations
  without webhook configuration is gone; only the chat-agent path requires
  `OPENCLAW_HOOKS_TOKEN`.
- **Design-system foundation fix.** A scoped base layer restores the two
  preflight guarantees the React components rely on (solid/zero-width border
  defaults, button background reset) — fixes the recurring 3D-bevel contour
  and unreadable raw-button backgrounds. `Modal` gains a `size` prop.
- **Migration hardening.** m004 now skips symlinked or physically identical
  project roots instead of crashing (fixes CI with test-spawned servers).

#### Agent Identity Guardrails (T-206)

- **Stable agent identity validation.** `/api/status`, task claim/release/complete/checkpoint/route, and canvas promote now share one agent-id validator. Known OpenClaw ids and stable external ids still work; placeholders and generated workspace/replay ids are rejected.
- **External agents remain first-class.** Unknown stable lowercase kebab-case ids are accepted and marked as external, so Codex/Cursor/Claude-style tools can still self-onboard without pre-registration.
- **Legacy generated ids stop mutating state.** Existing rows such as `codex-workspace` or `main-workspace` can still appear in agent listings, but rejected ids can no longer activate projects or mutate task state. Canvas promote also rejects a literal `default` agent id; dashboard-originated promotes without an agent id continue to broadcast through the gateway.
- **Task activity authors are less anonymous.** Checkpoint reads now preserve their agent id, UI comments use the authenticated dashboard author, and unowned status events render as `flowboard` instead of the generic `system`.
- **Snippets and docs tightened.** OpenClaw-managed agents must use the bootstrap-provided id; external agents must choose one stable runtime id instead of deriving names from cwd/session state.

#### Legacy Project-State Hardening (T-205)

- **Legacy `ACTIVE-PROJECT.md` fallback is opt-in**. The project-context hook now emits projectless context when the FlowBoard API is unreachable unless `FLOWBOARD_ALLOW_ACTIVE_PROJECT_FILE_FALLBACK=true` is set for an explicit migration recovery window.
- **HZL/API state stays authoritative**. Under HZL, server-side active-project resolution no longer falls back to `ACTIVE-PROJECT.md` when an agent row is missing.
- **Upgrade visibility for stale state files**. The snippets doctor/dashboard now surfaces `SESSION-STATE.md`, `BOOTSTRAP.md`, and `ACTIVE-PROJECT.md` as manual cleanup advisories instead of mutating them automatically.

#### Per-Agent API Hardening (T-177)

**Breaking change for installs that set `OPENCLAW_AGENT_ID` on the dashboard service.**

- **`/api/status` now requires explicit `agentId`** (T-177-2). GET via `?agentId=<id>` query parameter or `x-openclaw-agent-id` header. PUT in request body. Returns `400` without it. Previously, missing-agentId calls silently routed into the service-default agent (whatever `OPENCLAW_AGENT_ID` env var pointed at, or `"main"`), which produced wrong attribution — observed bug: `main` agent reported "Projekt flowboard war aktiv" because it queried `/api/status` without a query parameter and got `dev-botti`'s state.
- **`AGENT_ID` server-default removed** (T-177-3). The dashboard service has no own agent identity. Outbound paths (task-complete notifications, promote webhooks, stale-check broadcasts) route based on the agent that triggered the action, not a static service default.
- **`GET /api/projects` no longer returns `activeProject`** (T-177-3). Multi-agent active state lives on per-agent rows; read `/api/agents` (list with `active_project` per agent) or `/api/status?agentId=<id>` for one. The React UI already used `/api/agents` as the source of truth (Sidebar).
- **External agents are first-class** (T-177-3). Non-OpenClaw runtimes (Codex, Cursor, Claude Code, scripts) can now claim tasks and activate projects under their own agent-id. The `flowboard_agents` row is lazily registered on first `PUT /api/status`. Discovery snippet for project repos lands separately (T-179).

**Migration for existing installs:**

If your dashboard's systemd unit has `Environment=OPENCLAW_AGENT_ID=<something>`, **remove that line** — it was an anti-pattern (bot-specific runtime identity bound to a service). The dashboard now requires no env-defined identity. After the edit:

```bash
systemctl --user daemon-reload
systemctl --user restart flowboard-dashboard
```

If your custom bots/scripts call `/api/status` or `PUT /api/status` without `agentId`, they will now get `400`. Update them to pass `agentId` (recommended) or use `?agentId=<id>` / `x-openclaw-agent-id` header. The bundled snippet (`snippets/AGENTS-trigger.md`) reflects the new contract — re-install with `flowboard plugins install --link` or via the doctor.

The bundled `templates/dashboard.service` was already correct (no `OPENCLAW_AGENT_ID`); only fresh installs that copied it manually after editing need attention.

### v4.0.0 (2026-03-05) — Agent-Native Workflows + Idea Canvas
- **Idea Canvas (sticky notes + connections + clusters)** — Visual ideation space with auto-framing for connected notes
- **Canvas → Task Promote (Agent-Assisted)** — Select a note or cluster → send structured payload → agent creates tasks/specs/subtasks and cleans up notes
- **OpenClaw Webhook Session Bridge** — Promote delivery via `POST /hooks/agent` (fast, fire-and-forget, no CLI cold-start)
- **Parent Tasks + Subtasks UX** — Expand/collapse, progress indicator, delete flows support subtasks
- **Unified Delete Modal** — When a task has subtasks and/or a spec, modal shows checkboxes (delete spec, delete subtasks)
- **Mobile/touch hardening** — Fixed regressions around popovers, expand toggles, sort toggle, and canvas toolbar interactions
- **Security + robustness fixes (from review)**
  - XSS hardening in modals (escape user-provided titles)
  - Canvas note text length validation (prevents disk fill)
  - Correct byte-size checks for file writes (`Buffer.byteLength`)
- **Kanban UI fixes** — Priority popover rendered at body level (no clipping) + optimistic update revert on failure
- **Docs refresh** — New README pitch, updated screenshots, extracted `CHANGELOG.md`

### v3.1.0 (2026-02-27) - UX & Mobile Improvements
- **Delete files** - Remove files from `context/` and `specs/` directly in the dashboard
- **Spec pre-fill** - `POST /specs/:taskId` accepts optional content body for programmatic creation
- **Smart session log trimming** - project-context hook keeps only last 2 sessions (smaller context)
- **Shared UI components** - `ICONS` registry and `renderDeleteBtn()` for consistent UI
- **LAN access via custom hostname** - Configurable `LOCAL_HOSTNAME` env var for auth bypass
- **Kanban scroll preservation** - Scroll position kept when switching between tabs
- **Mobile fixes** - Ghost-tap prevention, file explorer rebuild, no-cache HTML header
- **Extended PROJECT.md template** - Scope, Project Files, context/ convention documented
- **env.example template** - Easier setup with documented environment variables

### v3.0.0 (2026-02-22) - Telegram Mini App + Remote Access
- **Telegram Mini App** - Access dashboard from Telegram via secure tunnel
- **Auth middleware** - HMAC-SHA256 initData validation + JWT session cookies
- **User allowlist** - Only configured Telegram user IDs can access
- **AUTH_ALWAYS mode** - Tunnel-agnostic auth (Cloudflare, ngrok, Tailscale, etc.)
- **Security hardening** - Rate limiting, CORS, CSP, X-Frame-Options, auth logging
- **Health endpoint** - `GET /api/health` for monitoring
- **Responsive mobile CSS** - Horizontal kanban scroll, sidebar overlay, touch-friendly cards
- **Mobile file explorer** - Navigation pattern (tree → preview → back button)
- **Telegram WebApp SDK** - Theme sync, viewport handling, haptic feedback
- **Single Source of Truth** - Git repo = live dashboard instance (canvas/ removed)
- **Templates** - Cloudflare config, systemd auth drop-in, .env.example

### v2.5.0 (2026-02-19) - Spec Files & Auto-Refresh
- **Spec file system** - Optional `specs/` folder for complex tasks with template scaffolding
- **Spec UI integration** - Lucide SVG badge on task cards (click to open, hover to create)
- **File auto-refresh** - File explorer auto-updates on create/modify/delete (fingerprint-based polling)
- **Auto-expand directories** - Opening a file via badge auto-expands parent dirs in tree
- **Deleted file handling** - Auto-opens first file when selected file is deleted
- **Priority popover fix** - Correct horizontal layout
- **Design guidelines** - Documented design system reference (Gateway Dashboard alignment)
- **Spec API** - `POST /api/projects/:name/specs/:taskId` for programmatic spec creation

### v2.4.0 (2026-02-15) - Modular Frontend
- **JavaScript module refactoring** - Separated Kanban and File Explorer into clean modules
- **Improved code organization** - utils.js, kanban.js, file-explorer.js
- **Better maintainability** - Clear separation of concerns
- **Enhanced documentation** - Updated architecture diagrams

### v2.3.0 (2026-02-14) - Production Ready
- **API-based project switching** - Dashboard + chat use same endpoint
- **Wake events** - Instant context switching without /new
- **project-context Hook** - Automatic BOOTSTRAP.md generation
- **Webhook integration** - System events to agent
- **End-to-end tested** - Dashboard + chat verified

### v2.2.0 (2026-02-14)
- File Explorer with tab system
- Markdown & JSON preview with syntax highlighting
- Inline file editing
- Context health tracking

### v2.1.1 (2026-02-14)
- Memory-flush integration for session persistence
- SESSION-STATE.md reminder after compaction

### v2.1.0 (2026-02-13)
- Dashboard systemd auto-start service
- Port 18790
- UI polish

### v2.0.0 (2026-02-12)
- Task management system with tasks.json
- Kanban Dashboard with drag & drop
- Task workflow rules
- Auto-task creation

---

## Philosophy

- 🎯 **Simplicity** - No unnecessary complexity
- 💰 **Low cost** - Efficient token usage
- 🔒 **Privacy** - Everything runs locally
- ⚡ **Automatic** - Self-maintaining

---

## License

MIT © 2026
