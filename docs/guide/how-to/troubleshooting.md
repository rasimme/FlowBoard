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

## Remote access returns 401 / a sign-in error

On localhost the dashboard is trusted and open. Over a tunnel or LAN it **fails closed** unless authentication is fully configured: `TELEGRAM_BOT_TOKEN`, `JWT_SECRET`, `ALLOWED_USER_IDS`, and `DASHBOARD_ORIGIN` must all be set (see the README [Remote Access](../../../README.md#remote-access-telegram-mini-app) section). A missing value means no one is allowed in.

The dashboard now distinguishes this from an empty installation: HTTP 401/403 shows a blocking **Sign-in required** screen instead of `No projects`. Open FlowBoard from the Telegram bot again to refresh its signed init-data and session cookie, then use **Retry**. If the error remains, verify the bot token, allowed user ID, and tunnel URL on the server.

## The dashboard is offline or reports a server error

An unreachable service shows **FlowBoard is offline**; an HTTP 5xx response shows **Dashboard service error**. Use **Retry** after restoring the connection or service. If the dashboard had already loaded, FlowBoard keeps the last valid board visible and shows a persistent error banner — a failed poll never replaces projects or tasks with an empty list.

`No projects` means something different: `/api/projects` completed successfully with HTTP 2xx and returned an empty project list.

## See also

- [Getting started](../getting-started.md)
- [Update FlowBoard](update-flowboard.md)
