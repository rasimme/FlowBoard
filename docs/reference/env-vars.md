# Environment Variables

All environment variables read by the FlowBoard server (`dashboard/server.js`), the project-context hook (`hooks/project-context/handler.js`), and the tooling (`snippets-doctor.js`, `install-trigger.mjs`, `migrate-tasks.js`, `hzl-service.js`). No secrets in this file. Mechanically asserted complete by `dashboard/test-docs-drift.js`.

## Networking

| Variable | Default | Component | Purpose |
|---|---|---|---|
| `FLOWBOARD_PORT` | `18790` | server, hook | TCP port the dashboard binds to. Hook reads it to call the local API. |
| `PORT` | `18790` | hzl-service | **Legacy fallback** in `hzl-service.js` for the on-complete hook callback URL. `FLOWBOARD_PORT` takes precedence. Kept for backwards compatibility with environments that pre-date the rename; new deployments should set `FLOWBOARD_PORT` only. |
| `FLOWBOARD_HOST` | `127.0.0.1` | server | Bind address. Loopback-only by default. |
| `FLOWBOARD_API` | `http://localhost:18790` | install-trigger, tests | Base URL consumers use to reach the dashboard. |
| `FLOWBOARD_GITHUB_TOKEN` | empty | github | GitHub token for the gh-* overview widgets (private repos, higher rate limit). Takes precedence over `GITHUB_TOKEN` and over a token stored via `PUT /api/settings/github-token`. |
| `GITHUB_TOKEN` | empty | github | Fallback GitHub token (same purpose, conventional name). |
| `OPENCLAW_GATEWAY_PORT` (alias `GATEWAY_PORT`) | `18789` | server | Port of the OpenClaw gateway used for outbound wake events. |
| `OPENCLAW_GATEWAY_URL` (alias `GATEWAY_URL`) | `http://127.0.0.1:18789` | server | Full gateway URL; takes precedence over the port-only form. |

## Storage paths

| Variable | Default | Component | Purpose |
|---|---|---|---|
| `OPENCLAW_WORKSPACE` | repo root (`..` from `dashboard/`) | server | Workspace root used to locate the HZL DB and legacy `ACTIVE-PROJECT.md`. |
| `OPENCLAW_HOME` | `~/.openclaw` | snippets-doctor | Base directory for OpenClaw workspaces (used by the doctor to scan). |
| `FLOWBOARD_PROJECTS_DIR` | `~/.openclaw/projects` | server, hook | Where per-project files (`PROJECT.md`, `tasks.json`, `specs/`) live. |
| `FLOWBOARD_REPO` | `~/repos/FlowBoard` | hook | Path to the FlowBoard repo, used by the hook to load `dashboard/rules-api.js`. |
| `HZL_DB_PATH` | `<workspace>/.hzl/flowboard.db` | server | SQLite path for the HZL event store. |

## Feature flags

| Variable | Default | Purpose |
|---|---|---|
| ~~HZL_ENABLED~~ | ~~unset (off)~~ | **Removed in T-129-1.** HZL is always enabled now. |
| `HZL_INTEGRITY_STRICT` | unset (off) | Boot-time integrity check (see ADR-0018). When unset, a watermark regression is logged as a loud WARN and the service continues. When `true`, the service `process.exit(1)`s on regression — for setups that prefer hard fail-fast over silent operation on a rolled-back DB. To reset the baseline after a legitimate restore, clear the watermark manually: `DELETE FROM hzl_local_meta WHERE key LIKE 'integrity.%';` |
| `INTEGRITY_WEBHOOK_URL` | empty | Optional. On integrity regression at boot, the server `POST`s a JSON body to this URL: `{ message, regression, current, stored, host }`. The `message` field matches the OpenClaw gateway `/hooks/agent` contract; the structured fields ride alongside for monitoring tools. Empty disables the push channel — the stderr WARN block and `GET /api/health/integrity` remain the only signal. Adopters running Slack / Discord / PagerDuty wire a small relay (those surfaces expect `text` / `content` / `payload.summary` respectively). |
| `INTEGRITY_WEBHOOK_TOKEN` | empty | Bearer token sent with `Authorization: Bearer <token>` on the `INTEGRITY_WEBHOOK_URL` `POST`. Empty = unauthenticated request. |
| `AUTH_ALWAYS` | unset (off) | Forces auth middleware on every request (otherwise loopback bypass applies in non-production). |
| `FLOWBOARD_ALLOW_ACTIVE_PROJECT_FILE_FALLBACK` | unset (off) | Hook-only migration escape hatch. Set to `true` only during explicit legacy recovery if the FlowBoard API is unreachable and `ACTIVE-PROJECT.md` must be read once. Normal installs must leave this off so stale files cannot resurrect old project state during bootstrap or compaction. |

## Specify worker (T-262)

| Variable | Default | Purpose |
|---|---|---|
| `SPECIFY_WORKER_AGENT` | `main` | OpenClaw agent id the CLI worker adapter runs Specify steps on. The default targets the `main` agent (exists on every install — zero setup). Point it at a dedicated lean agent if desired. |
| `SPECIFY_WORKER_TIMEOUT` | `90` | Per-step worker timeout in seconds, passed to `openclaw agent --timeout`. The adapter kills the process 15s after that. |
| `SPECIFY_MAX_QUESTIONS` | `4` | Clarification question budget per Specify session (hard cap, server-enforced). Raise cautiously — beyond ~5 questions answer quality drops; prefer the proposal revise loop for complex topics. |
| `SPECIFY_OPENCLAW_CLI` | `openclaw` | Path to the OpenClaw CLI binary used by the worker adapter. |
| `SPECIFY_WORKER_DISABLED` | unset (off) | Set to `true` to skip registering the OpenClaw CLI worker adapter at startup. Without an adapter, Specify sessions return a recoverable error (or the fallback proposal where allowed). |
| `SPECIFY_ALLOW_FALLBACK` | unset (off) | Dev/test opt-in: when no worker adapter is configured, serve the static single-task fallback proposal instead of an error. Also implied by `NODE_ENV=test`. Never enable in production — the fallback skips clarification entirely. |
| `SPECIFY_WORKER_MOCK` | unset | Test-only (`NODE_ENV=test`): path to a module exporting a scripted worker adapter, injected at startup. Used by `test-specify-clarify-regression.js`. |

## Authentication

| Variable | Default | Purpose |
|---|---|---|
| `JWT_SECRET` | empty | HMAC secret for issuing/verifying JWTs at `/api/auth`. Empty = auth disabled. |
| `ALLOWED_USER_IDS` | empty | Comma-separated Telegram user IDs allowed to authenticate. |
| `TELEGRAM_BOT_TOKEN` | empty | Primary bot token for Telegram-init-data verification. |
| `TELEGRAM_BOT_TOKENS` | empty | Additional bot tokens, comma-separated. Server accepts any matching token. |
| `FLOWBOARD_TELEGRAM_AGENT_IDS` | empty | Optional comma-separated agent IDs matching `TELEGRAM_BOT_TOKEN` followed by `TELEGRAM_BOT_TOKENS`; lets the dashboard infer the caller agent from the bot that signed Telegram init data. |
| `DASHBOARD_ORIGIN` | empty | Allowed CORS origin for browser clients. |
| `OPENCLAW_HOOKS_TOKEN` (alias `HOOKS_TOKEN`) | empty | Shared secret required on `POST /api/hooks/task-complete`. Empty disables the endpoint. |
| `NODE_ENV` | unset | When set to `production` *and* auth is unconfigured, the server logs a warning. |

## Telemetry

| Variable | Default | Purpose |
|---|---|---|
| `FLOWBOARD_HOOK_TELEMETRY` | unset | Hook only. `1` enables the per-run success log line; error logs stay ungated. |
| `FLOWBOARD_RULES_TELEMETRY` | unset | Server only. `1` enables per-request logging of the rules endpoints. |
| `LOG_REQUESTS` | unset | `true` logs every HTTP request. Implicitly enabled when `DEBUG` is set or `NODE_ENV !== 'production'`. |
| `DEBUG` | unset | Any truthy value enables verbose logging. |

## Operational

| Variable | Default | Purpose |
|---|---|---|
| `FLOWBOARD_MANAGED_AGENT_IDS` | empty | Comma-separated local OpenClaw-managed agent ids for this installation. Exact ids are accepted as managed identities; near-collision variants such as `<id>-main` are rejected so managed agents do not silently fork into phantom external identities. |
| `FLOWBOARD_KNOWN_AGENT_IDS` | empty | Comma-separated extra stable agent ids to classify as known without near-collision protection. Prefer `FLOWBOARD_MANAGED_AGENT_IDS` for OpenClaw-managed local agents. |
| `STALE_THRESHOLD_MINUTES` | `30` | Minutes of idle before a claimed task is considered stale by the cron sweeper. |
| `NOTIFICATION_WINDOW_MINUTES` | `60` | Minimum minutes between repeat stuck-task notifications for the same task in the cron sweeper. |
| `STUCK_FALLBACK_AGENT` | `main` | Agent that receives stuck-task notifications when the affected task has no responsible agent (unassigned stale/expired, unroutable). |
| `FLOWBOARD_NOTIFICATION_CHANNEL` | `telegram` | OpenClaw delivery channel used by FlowBoard agent notifications when posting to `/hooks/agent`. Required when multiple gateway channels are configured. |
| `FLOWBOARD_NOTIFICATION_TARGET` | empty | Optional delivery target for FlowBoard agent notifications, e.g. a Telegram chat id. If unset and exactly one `ALLOWED_USER_IDS` entry exists with `FLOWBOARD_NOTIFICATION_CHANNEL=telegram`, that id is used. |
| `FLOWBOARD_NOTIFICATION_TO` | empty | Legacy alias for `FLOWBOARD_NOTIFICATION_TARGET`. |
| `FLOWBOARD_NOTIFICATION_TARGET` | empty | Target session key for stuck-task notifications (gateway routing). |
| `FLOWBOARD_NOTIFICATION_TO` | empty | Recipient override for stuck-task notifications. |
| `STUCK_NOTIFICATION_CHANNEL` | `telegram` | Legacy alias for `FLOWBOARD_NOTIFICATION_CHANNEL`, kept for existing stuck-task notification deployments. |
| `FLOWBOARD_AGENT_IDLE_TTL_HOURS` | `48` | Hours an agent can be idle before its `active_project` is auto-cleared on read (`GET /api/agents`). An agent holding an active task claim is never auto-deactivated, and `GET`/`PUT /api/status` refresh the agent's heartbeat. Set very high to effectively disable. |
| `LOCAL_HOSTNAME` | empty | Hostname the dashboard advertises in `/api/info` for self-discovery from outside loopback. |
| `FLOWBOARD_UPDATE_DRY` | unset | When set, `POST /api/update/run` returns 202 without spawning `setup.mjs --update` (no rebuild/restart). Used by tests for the in-dashboard self-update flow (T-353). |

## Hook-only

| Variable | Default | Purpose |
|---|---|---|
| `FLOWBOARD_HOOK_TELEMETRY` | unset | See Telemetry. |
| `FLOWBOARD_REPO` | `~/repos/FlowBoard` | See Storage paths. |
| `FLOWBOARD_PORT` | `18790` | Hook reads this to construct the local API URL. |
| `FLOWBOARD_PROJECTS_DIR` | `~/.openclaw/projects` | See Storage paths. |
| `FLOWBOARD_ALLOW_ACTIVE_PROJECT_FILE_FALLBACK` | unset | See Feature flags. |
| `FLOWBOARD_HOOK_FETCH_TIMEOUT_MS` | `2000` | Per-attempt timeout (ms) for the hook's calls to the local FlowBoard API. |
| `FLOWBOARD_HOOK_FETCH_RETRIES` | `2` | Extra retries (after the first attempt) on a transient API failure (connection refused during a KeepAlive restart, or a 5xx). Backoff: 150/400/800 ms. Rides out brief server restarts so a transient miss does not surface as a failed tool call. |

## Node defaults

| Variable | Source | Purpose |
|---|---|---|
| `HOME` | shell | Used to compute default storage paths. Always set on a real Linux session. |

## Deprecated

| Variable | Status | Notes |
|---|---|---|
| `OPENCLAW_AGENT_ID` | Deprecated 2026-04-30 (ADR-0003) | The server no longer routes by this value. The variable still appears in the startup log for diagnostics; setting it has no functional effect. Operators should remove it from systemd unit files. |

## See also

- [ADR-0003](../adr/0003-dashboard-has-no-agent-identity.md) — why `OPENCLAW_AGENT_ID` was removed from routing
- [ADR-0004](../adr/0004-disk-bootstrap-is-non-authoritative.md) — `FLOWBOARD_HOOK_TELEMETRY` rationale
