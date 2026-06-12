# Changelog

### Unreleased — v5 Release Hardening (T-288)

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

### Unreleased — Specify Clarify Loop (T-262)

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

### Unreleased — Agent Identity Guardrails (T-206)

- **Stable agent identity validation.** `/api/status`, task claim/release/complete/checkpoint/route, and canvas promote now share one agent-id validator. Known OpenClaw ids and stable external ids still work; placeholders and generated workspace/replay ids are rejected.
- **External agents remain first-class.** Unknown stable lowercase kebab-case ids are accepted and marked as external, so Codex/Cursor/Claude-style tools can still self-onboard without pre-registration.
- **Legacy generated ids stop mutating state.** Existing rows such as `codex-workspace` or `main-workspace` can still appear in agent listings, but rejected ids can no longer activate projects or mutate task state. Canvas promote also rejects a literal `default` agent id; dashboard-originated promotes without an agent id continue to broadcast through the gateway.
- **Task activity authors are less anonymous.** Checkpoint reads now preserve their agent id, UI comments use the authenticated dashboard author, and unowned status events render as `flowboard` instead of the generic `system`.
- **Snippets and docs tightened.** OpenClaw-managed agents must use the bootstrap-provided id; external agents must choose one stable runtime id instead of deriving names from cwd/session state.

### Unreleased — Legacy Project-State Hardening (T-205)

- **Legacy `ACTIVE-PROJECT.md` fallback is opt-in**. The project-context hook now emits projectless context when the FlowBoard API is unreachable unless `FLOWBOARD_ALLOW_ACTIVE_PROJECT_FILE_FALLBACK=true` is set for an explicit migration recovery window.
- **HZL/API state stays authoritative**. Under HZL, server-side active-project resolution no longer falls back to `ACTIVE-PROJECT.md` when an agent row is missing.
- **Upgrade visibility for stale state files**. The snippets doctor/dashboard now surfaces `SESSION-STATE.md`, `BOOTSTRAP.md`, and `ACTIVE-PROJECT.md` as manual cleanup advisories instead of mutating them automatically.

### Unreleased — Per-Agent API Hardening (T-177)

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
