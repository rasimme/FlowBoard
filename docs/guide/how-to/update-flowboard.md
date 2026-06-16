# Update FlowBoard

After you pull a new FlowBoard version (`openclaw plugins update flowboard`, or `git pull` in the checkout), the new source is on disk but the **running dashboard still serves the previous build**. Two ways to apply it.

## From the dashboard (recommended)

When the running version is behind the source, an **“Update available · vX → vY”** chip appears in the header.

1. Click the chip to open the **Update & restart** panel.
2. Click **Update & restart**. This reinstalls dependencies, rebuilds the UI, and restarts the service — your `.env` and project data are left untouched.
3. The page reloads onto the new build.

This is backed by `GET /api/update/status` (version detection) and `POST /api/update/run`.

## From the CLI

From the FlowBoard checkout:

```bash
node scripts/setup.mjs --update
```

Same effect: reinstall deps + rebuild UI + restart the service.

## See also

- [Getting started](../getting-started.md)
- [Troubleshooting](troubleshooting.md)
