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

Same effect: reinstall deps + rebuild UI + preserve/merge the standard service environment + restart the service. The command intentionally fails if no standard service exists; run `node scripts/setup.mjs` (without `--update`) for a first install.

`JWT_SECRET` is generated once on first install. Updates and forced
re-registration preserve it. Rotate it only when intended:

```bash
node scripts/setup.mjs --update --rotate-secret
```

If `JWT_SECRET` is owned by a systemd drop-in or `EnvironmentFile`, rotate it
in that owner-only source and run plain `--update`; setup refuses to create a
competing override.

The generated launchd plist or systemd unit is written with mode `0600` because
it can contain secrets. Setup never prints environment values. On Linux,
existing `EnvironmentFile=` directives and
`flowboard-dashboard.service.d/*.conf` drop-ins are retained.

After registration, setup verifies that launchd loaded the service or that the
systemd unit is enabled, then polls the local `/api/health` endpoint. If remote
auth is only partially configured, it names the missing variable names without
printing configured values.

## See also

- [Getting started](../getting-started.md)
- [Troubleshooting](troubleshooting.md)
