# Update FlowBoard

After you pull a new FlowBoard version (`openclaw plugins update flowboard`, or `git pull` in the checkout), the new source is on disk but the **running dashboard still serves the previous build**. Two ways to apply it.

## From the dashboard (recommended)

When the running version is behind the source, an **"Update available - vX -> vY"** chip appears in the header only if `FLOWBOARD_ENABLE_SELF_UPDATE=true` is set in the standard FlowBoard service environment (the launchd plist on macOS or a systemd drop-in for `flowboard-dashboard.service` on Linux).

1. Click the chip to open the **Update & restart** panel.
2. Click **Update & restart**. The dashboard sends an explicit request confirmation to `POST /api/update/run`, which reinstalls dependencies, rebuilds the UI, merges the existing service environment, and restarts the service. Auth, tunnel, custom service variables, the existing `JWT_SECRET`, and project data are preserved.
3. The page reloads onto the new build.

This is backed by `GET /api/update/status` (version detection) and `POST /api/update/run`.

## From the CLI

From the FlowBoard checkout:

```bash
node scripts/setup.mjs --update
```

Same effect: reinstall deps + rebuild UI + preserve the standard service
environment + restart the service. Persisted service values win over conflicting
shell variables. The command intentionally fails if no standard service exists;
run `node scripts/setup.mjs` (without `--update`) for a first install.

The service manager's autostart contract is restored and verified on every
registration: macOS uses the standard
`ai.openclaw.flowboard-dashboard` LaunchAgent with `RunAtLoad` and `KeepAlive`;
Linux uses the `flowboard-dashboard.service` user unit and runs
`systemctl --user enable` plus `is-enabled`. Setup preserves the existing
service environment and custom values while keeping those standard autostart
properties. A custom supervisor or label is never rewritten by this command.

To intentionally replace an allowlisted value stored in the main launchd plist
or systemd unit, name it explicitly:

```bash
DASHBOARD_ORIGIN=https://flowboard.example.com \
  node scripts/setup.mjs --update --override-env DASHBOARD_ORIGIN
```

### Dashboard port (T-495)

The default dashboard port is now `18700`; it used to be `18790`, which is the
OpenClaw Gateway port + 1 that OpenClaw's MCP Apps sandbox listener claims when
`mcp.apps.enabled` is on. An update never moves a running install:

- A service that already stores `FLOWBOARD_PORT` keeps that value.
- A service without `FLOWBOARD_PORT` ran on the old code default, so
  `--update` writes `FLOWBOARD_PORT=18790` into it and says so.
- Setup prints the matching hook command whenever the port is not `18700`,
  because the project-context hook's own default moved too:

  ```bash
  openclaw config set plugins.entries.flowboard.config.dashboardPort 18790
  ```

To move an existing install to the new default instead, update the service and
the hook together:

```bash
FLOWBOARD_PORT=18700 node scripts/setup.mjs --update --override-env FLOWBOARD_PORT
openclaw config unset plugins.entries.flowboard.config.dashboardPort
```

Settings owned by a systemd drop-in or `EnvironmentFile=` must be changed in
that owner-only source instead; setup refuses a competing main-unit override.

`JWT_SECRET` is generated once on first install. Updates and forced
re-registration preserve it. Rotate it only when intended:

```bash
node scripts/setup.mjs --rotate-secret
```

If `JWT_SECRET` is owned by a systemd drop-in or `EnvironmentFile`, rotate it
in that owner-only source and run plain `--update`; setup refuses to create a
competing override. `--rotate-secret` bypasses the healthy-service no-op guard,
re-registers the service, and restarts an existing service so the new key takes
effect immediately.

The generated launchd plist or systemd unit is written with mode `0600` because
it can contain secrets. Setup never prints environment values. On Linux,
existing `EnvironmentFile=` directives and
`flowboard-dashboard.service.d/*.conf` drop-ins are retained. Readable
EnvironmentFiles are evaluated in declared order for diagnostics and health
port resolution; later files keep systemd precedence over earlier files and
inline `Environment=` values. `UnsetEnvironment=` is applied last with systemd's
name-versus-exact-assignment semantics, including empty-list resets. Setup
refuses an override or JWT rotation that would still be removed. Existing unit
specifier handling is deliberately fail-safe: only `%%`, `%h`, and `%U` are
accepted by the normalizer, and literal percent signs in rewritten
`Environment=` values are emitted as `%%`.
The reader decodes valid systemd escapes exactly once (`\\xHH`, `\\s`, `\\t`,
exactly-three-digit octal escapes such as `\\040`, and escaped backslashes or
quotes). Unclosed quotes, trailing backslashes, malformed escapes, and invalid
octal values abort before dependencies, the build, or service registration are
touched. UTF-8 BOMs in unit/drop-in files and EnvironmentFile content are also
rejected instead of being silently stripped. Backslashes in Windows-style
values therefore need the usual doubled unit-file spelling (for example
`C:\\\\Users\\\\FlowBoard`). `EnvironmentFile=`
uses systemd's complete path RHS instead: spaces and backslashes stay path
characters (only `%` specifiers are expanded), and the path is never parsed as
an `Environment=` word list. Relative or wildcard paths are retained but cause
an update to stop safely because setup cannot evaluate their effective values.

On macOS, launchd stdout/stderr goes to
`~/Library/Logs/FlowBoard/flowboard-dashboard.log`. Setup creates the directory
as `0700`, pre-creates the file as `0600` without following symlinks, and writes
umask `077` into the plist. A current-user regular legacy
`/tmp/flowboard-dashboard.log` is secured and moved to
`flowboard-dashboard.legacy.log`; unsafe pre-created links or foreign files are
left untouched and never followed. The secure-log check uses `lstat` +
`O_NOFOLLOW|O_NONBLOCK` + `fstat`, so FIFOs, sockets, devices, and concurrent
special-file replacements fail closed without blocking before launchd is
stopped.

After registration, setup verifies that launchd loaded the service or that the
systemd unit is enabled, then polls the local `/api/health` endpoint. If remote
auth is only partially configured, it names the missing variable names without
printing configured values.

## See also

- [Getting started](../getting-started.md)
- [Troubleshooting](troubleshooting.md)
