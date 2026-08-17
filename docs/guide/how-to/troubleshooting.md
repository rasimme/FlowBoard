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

Its plist keeps both `RunAtLoad` and `KeepAlive`. On Linux, verify and restart
the user unit:

```bash
systemctl --user is-enabled flowboard-dashboard
systemctl --user restart flowboard-dashboard
systemctl --user status flowboard-dashboard
```

`setup.mjs` checks the loaded/enabled state and then polls
`http://127.0.0.1:<FLOWBOARD_PORT>/api/health`. It does not print service
environment values; inspect configuration locally with appropriate care.

## Remote access returns 401 / blank screen

On localhost the dashboard is trusted and open. Over a tunnel or LAN it **fails closed** unless authentication is fully configured: `TELEGRAM_BOT_TOKEN`, `JWT_SECRET`, `ALLOWED_USER_IDS`, and `DASHBOARD_ORIGIN` must all be set (see the README [Remote Access](../../../README.md#remote-access-telegram-mini-app) section). A missing value means no one is allowed in.

During setup/update, a partial remote configuration emits a warning naming only
the missing variables. Existing launchd/systemd auth and custom variables are
merged into the replacement service definition; `JWT_SECRET` is not rotated
unless `--rotate-secret` is passed explicitly.

## See also

- [Getting started](../getting-started.md)
- [Update FlowBoard](update-flowboard.md)
