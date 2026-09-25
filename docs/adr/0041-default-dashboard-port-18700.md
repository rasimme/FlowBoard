# ADR-0041: Default dashboard port 18700, clear of OpenClaw's derived ports

## Status
Accepted (2026-09-25, T-495)

## Date
2026-09-25

## Source
- Task: **T-495** ("Default port 18790 collides with OpenClaw MCP Apps sandbox listener").
- Code: `dashboard/flowboard-url.cjs` (`DEFAULT_DASHBOARD_PORT`, `LEGACY_DEFAULT_DASHBOARD_PORT`), `dashboard/port-collision.js`, the listen block in `dashboard/server.js`, the service-environment seeding in `scripts/setup.mjs`.
- OpenClaw 2026.9.6: `docs/cli/mcp/apps.md`, `docs/gateway/multiple-gateways.md`, `extensions/browser/src/config/port-defaults.ts`.

## Context
FlowBoard's dashboard defaulted to `18790`. OpenClaw derives a block of
loopback ports from its Gateway port (default `18789`):

| Port | Owner |
|---|---|
| Gateway | Gateway WebSocket/HTTP (`18789`) |
| Gateway + 1 | MCP Apps sandbox listener when `mcp.apps.enabled` is on (`18790`, moved by `mcp.apps.sandboxPort`); historically the bridge |
| Gateway + 2 | Browser control server (`18791`) |
| Gateway + 3 .. + 10 | Reserved for one-off services (canvas `18793`, extension relay `18799`) |
| Gateway + 11 .. + 110 | Managed Chrome CDP range (`18800`–`18899`) |

OpenClaw's multi-gateway guide says each instance reaches base + 110 and
recommends further bases such as `19001` (`--dev`), `19100`+ (fleet) and
`19789` (rescue). With MCP Apps enabled, whichever of FlowBoard and the Gateway
binds `18790` first wins and the other fails with a bare `EADDRINUSE`.

## Decision
1. **New default `18700`.** It sits below the Gateway's entire derived block,
   so no Gateway on the default or any documented higher base can reach it.
   It is outside common development ports and below every fixed port FlowBoard's
   tests use (all between `18789` and `20000`). One constant in
   `dashboard/flowboard-url.cjs` feeds the server, the hook, the adapter,
   setup, snippets and the on-complete callback.
2. **Updates never move a running install.** `setup.mjs` seeds
   `FLOWBOARD_PORT=18700` only on a first install. On `--update`, a service
   that stores `FLOWBOARD_PORT` keeps it; a service without it ran on the old
   code default, so setup writes `FLOWBOARD_PORT=18790` into it and says so.
   Whenever the effective port is not the default, setup prints the
   `plugins.entries.flowboard.config.dashboardPort` command the hook needs,
   because the hook's default moved as well.
3. **Name the collision.** At startup the server warns when its port equals
   the configured Gateway port + 1, and on `EADDRINUSE` it prints which
   listener owns that port and both fixes: `FLOWBOARD_PORT` or
   `mcp.apps.sandboxPort`. Other `EADDRINUSE` failures get a generic
   `FLOWBOARD_PORT` hint.

## Alternatives considered
- **Keep `18790` and only detect the collision.** Every default install with
  MCP Apps enabled would still break; detection only explains it.
- **`18843` (the example in the plugin schema).** It is inside the managed
  Chrome CDP range (`18800`–`18899`) and is used by FlowBoard's tests.
- **A port between `18900` and `19000`.** Clear today, but between the default
  block and the `--dev` base; a Gateway moved up a little would reach it.
  Below the Gateway is the only side the derivation never grows into.
- **Hook-side fallback to `18790`.** The hook would probe a port that the MCP
  Apps sandbox may own, and the adapter and UI would still disagree. Explicit
  configuration printed by setup is simpler and verifiable.

## Consequences
- Fresh installs and dev servers use `18700`; docs, snippets, templates and CI
  use it.
- Installs updated through `setup.mjs --update` stay on their port. If that
  port is `18790` and the Gateway does not set `FLOWBOARD_PORT` or
  `FLOWBOARD_BASE_URL`, the operator must set the plugin's `dashboardPort` to
  `18790` (setup prints the command) or move the dashboard to `18700`.
- Manually supervised installs whose unit or plist has no `FLOWBOARD_PORT`
  move to `18700` on the next restart unless the operator adds
  `FLOWBOARD_PORT=18790` first. The shipped systemd template now sets the port
  explicitly.
- Snippet rendering replaces both the old and the new default URL with the
  configured base URL, so previously installed snippets keep working.

## See also
- [ADR-0029](0029-local-first-single-operator-security-boundary.md) — loopback-first dashboard
- [Environment variables](../reference/env-vars.md) — `FLOWBOARD_PORT`
- [Update FlowBoard](../guide/how-to/update-flowboard.md#dashboard-port-t-495)
