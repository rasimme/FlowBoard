# Troubleshooting

Common issues and how to resolve them. If something here doesn't match what you see, check the [README](../../../README.md) and [concepts](../../concepts/).

## The agent doesn't pick up project context

FlowBoard delivers context through the `project-context` hook. Verify it's registered:

```bash
openclaw hooks info project-context
# Expect: ✓ Ready, source openclaw-managed, subscribed to agent:bootstrap
```

If it's missing, re-run the install step in the [README](../../../README.md#2-register-the-hook-with-openclaw). External agents (Codex, Cursor, …) don't get live injection — they fetch context on demand via `GET /api/projects/<project>/bootstrap`.

## “Context not ready”

An agent should wait for `contextReady === true` before fetching context, polling briefly (a few attempts, ~500 ms apart) and then reporting a blocker rather than guessing. A persistent failure usually means the server can't read the project's files or the HZL store — check the dashboard health and the server logs.

## The dashboard still shows the old version after updating

The running service serves the last build. Apply the update (rebuild + restart) — see [Update FlowBoard](update-flowboard.md).

## Setup says `--update` requires an existing standard service

`--update` is deliberately separate from first install so a typo cannot create
a new service with new defaults. Run `node scripts/setup.mjs` once to create the
standard service. Use `--update` only after that. Custom supervisors are not
rewritten by setup.

## The dashboard does not start automatically

On macOS, verify that the standard launchd job is loaded:

```bash
launchctl print gui/$(id -u)/ai.openclaw.flowboard-dashboard
```

This direct operator command can display the job environment, including
secrets; do not paste its raw output into tickets or chat. Setup itself discards
all `launchctl print` output and reports only success/failure. The plist keeps
both `RunAtLoad` and `KeepAlive`. Its owner-only log is
`~/Library/Logs/FlowBoard/flowboard-dashboard.log`; setup no longer points
launchd at a shared `/tmp` file. On Linux, verify and restart the user unit:

```bash
systemctl --user is-enabled flowboard-dashboard
systemctl --user restart flowboard-dashboard
systemctl --user status flowboard-dashboard
journalctl --user -u flowboard-dashboard.service -n 100 --no-pager
```

`setup.mjs` checks the loaded/enabled state and then polls
`http://127.0.0.1:<FLOWBOARD_PORT>/api/health`. It does not print service
environment values; inspect configuration locally with appropriate care.

## Remote access returns 401 / blank screen

On localhost the dashboard is trusted and open. Over a tunnel or LAN it **fails closed** unless authentication is fully configured: `TELEGRAM_BOT_TOKEN`, the exact ordered `FLOWBOARD_TELEGRAM_AGENT_IDS` mapping, `JWT_SECRET`, `ALLOWED_USER_IDS`, and `DASHBOARD_ORIGIN` must all be set (see the README [Remote Access](../../../README.md#remote-access-telegram-mini-app) section). Additional tokens in `TELEGRAM_BOT_TOKENS` need additional agent IDs at the same positions. A missing value means no one is allowed in.

Startup errors such as `TELEGRAM_AGENT_MAPPING_COUNT`,
`TELEGRAM_AGENT_MAPPING_DUPLICATE`, or `TELEGRAM_AGENT_ID_INVALID` identify the
configuration field and list position without printing bot tokens. During a
Mini App exchange, `TELEGRAM_BOT_NOT_SUPPORTED` means no configured bot signed
the supplied fresh init-data; `TELEGRAM_INIT_DATA_EXPIRED` means the Mini App
must be reopened. FlowBoard clears an existing cross-bot session on these
`/api/auth` failures so an old cookie cannot hide the configuration problem.

During setup/update, a partial remote configuration emits a warning naming only
the missing variables. Existing launchd/systemd auth and custom variables are
merged into the replacement service definition; `JWT_SECRET` is not rotated
unless `--rotate-secret` is passed explicitly.

If a shell variable conflicts with persisted service configuration, update
preserves the persisted value. Use `--override-env NAME` only for a deliberate
main-unit change. For systemd drop-ins and `EnvironmentFile=` sources, edit the
owner file instead.

## Remote access returns 401 / a sign-in error

On localhost the dashboard is trusted and open. Over a tunnel or LAN it **fails closed** unless authentication is fully configured: `TELEGRAM_BOT_TOKEN`, `JWT_SECRET`, `ALLOWED_USER_IDS`, and `DASHBOARD_ORIGIN` must all be set (see the README [Remote Access](../../../README.md#remote-access-telegram-mini-app) section). A missing value means no one is allowed in.

The dashboard now distinguishes this from an empty installation: HTTP 401/403 shows a blocking **Sign-in required** screen instead of `No projects`. Open FlowBoard from the Telegram bot again to refresh its signed init-data and session cookie, then use **Retry**. If the error remains, verify the bot token, allowed user ID, and tunnel URL on the server.

## The dashboard is offline or reports a server error

An unreachable service shows **FlowBoard is offline**; an HTTP 5xx or invalid API response shows **Dashboard service error**. A request that does not finish within 10 seconds is aborted and shows **FlowBoard took too long to respond**. Use **Retry** after restoring the connection or service; Retry is also available during the initial loading screen.

If the dashboard had already loaded, FlowBoard keeps the last valid board visible and shows a persistent error banner — a failed poll never replaces projects or tasks with an empty list. Task-only refreshes cannot hide a global projects/agents/status failure.

`No projects` means something different: `/api/projects` completed successfully with HTTP 2xx and returned a schema-valid empty project list.

## See also

- [Getting started](../getting-started.md)
- [Update FlowBoard](update-flowboard.md)
