# Environment Variables

All environment variables read by the FlowBoard server (`dashboard/server.js`) and the project-context hook (`hooks/project-context/handler.js`). No secrets in this file.

## Networking

| Variable | Default | Component | Purpose |
|---|---|---|---|
| `FLOWBOARD_PORT` | `18790` | server, hook | TCP port the dashboard binds to. Hook reads it to call the local API. |
| `FLOWBOARD_HOST` | `127.0.0.1` | server | Bind address. Loopback-only by default. |
| `FLOWBOARD_API` | `http://localhost:18790` | install-trigger, tests | Base URL consumers use to reach the dashboard. |
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
| `HZL_ENABLED` | unset (off) | Enables HZL-backed task lifecycle, `flowboard_agents`, and `tasks_current`. Must be `true` for any task or agent endpoint to function. |
| `AUTH_ALWAYS` | unset (off) | Forces auth middleware on every request (otherwise loopback bypass applies in non-production). |

## Authentication

| Variable | Default | Purpose |
|---|---|---|
| `JWT_SECRET` | empty | HMAC secret for issuing/verifying JWTs at `/api/auth`. Empty = auth disabled. |
| `ALLOWED_USER_IDS` | empty | Comma-separated Telegram user IDs allowed to authenticate. |
| `TELEGRAM_BOT_TOKEN` | empty | Primary bot token for Telegram-init-data verification. |
| `TELEGRAM_BOT_TOKENS` | empty | Additional bot tokens, comma-separated. Server accepts any matching token. |
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
| `STALE_THRESHOLD_MINUTES` | `30` | Minutes of idle before a claimed task is considered stale by the cron sweeper. |
| `LOCAL_HOSTNAME` | empty | Hostname the dashboard advertises in `/api/info` for self-discovery from outside loopback. |

## Hook-only

| Variable | Default | Purpose |
|---|---|---|
| `FLOWBOARD_HOOK_TELEMETRY` | unset | See Telemetry. |
| `FLOWBOARD_REPO` | `~/repos/FlowBoard` | See Storage paths. |
| `FLOWBOARD_PORT` | `18790` | Hook reads this to construct the local API URL. |
| `FLOWBOARD_PROJECTS_DIR` | `~/.openclaw/projects` | See Storage paths. |

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
