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

## Remote access returns 401 / blank screen

On localhost the dashboard is trusted and open. Over a tunnel or LAN it **fails closed** unless authentication is fully configured: `TELEGRAM_BOT_TOKEN`, the exact ordered `FLOWBOARD_TELEGRAM_AGENT_IDS` mapping, `JWT_SECRET`, `ALLOWED_USER_IDS`, and `DASHBOARD_ORIGIN` must all be set (see the README [Remote Access](../../../README.md#remote-access-telegram-mini-app) section). Additional tokens in `TELEGRAM_BOT_TOKENS` need additional agent IDs at the same positions. A missing value means no one is allowed in.

Startup errors such as `TELEGRAM_AGENT_MAPPING_COUNT`,
`TELEGRAM_AGENT_MAPPING_DUPLICATE`, or `TELEGRAM_AGENT_ID_INVALID` identify the
configuration field and list position without printing bot tokens. During a
Mini App exchange, `TELEGRAM_BOT_NOT_SUPPORTED` means no configured bot signed
the supplied fresh init-data; `TELEGRAM_INIT_DATA_EXPIRED` means the Mini App
must be reopened. FlowBoard clears an existing cross-bot session on these
`/api/auth` failures so an old cookie cannot hide the configuration problem.

## See also

- [Getting started](../getting-started.md)
- [Update FlowBoard](update-flowboard.md)
