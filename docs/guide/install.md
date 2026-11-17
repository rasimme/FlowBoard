# Install FlowBoard

The short path is in the [README Quick Start](../../README.md#quick-start): `openclaw plugins install flowboard`, then `node scripts/setup.mjs`. This page has the detail: what each OpenClaw version gives you, what the install asks you to approve, updating, and the manual install.

## Which OpenClaw you have decides how much you get

FlowBoard adds surfaces as the host supports them and never requires the newest
one:

| Your OpenClaw | What you get | What you need to turn on |
|---|---|---|
| **2026.6.6 – 2026.7.x** | Baseline: the `project-context` hook that tells every agent run which project it is on, plus the standalone dashboard | Nothing |
| **2026.8.x** | Baseline, and the install asks you to approve FlowBoard's capabilities | Nothing |
| **≥ 2026.9.2** | Baseline plus the feature layer: the dashboard as a native **FlowBoard** page in the OpenClaw sidebar, a "Needs me" widget and a session task panel | The *Custom plugin UI* lab (`gateway.controlUi.experimental.customPlugins`), which is off by default (hosts before 2026.9.6 need a Gateway restart after enabling it) |
| **No OpenClaw at all** | The standalone dashboard and the REST API for external agents | Nothing |

Nothing above is a fork in the road: one install works on all of them. On an
older host FlowBoard notices the newer SDK is absent and runs hook-only; with
the lab off there is simply no sidebar entry.

Every release installs the same packed artifact on real hosts and checks that
the hook comes back — currently 2026.6.6, 2026.7.1-2, 2026.9.5, 2026.9.6 and
2026.10.9, with CI also trying the newest published OpenClaw
(`node scripts/release-host-matrix.mjs`, see [CONTRIBUTING](../../CONTRIBUTING.md)).
Details in [OpenClaw Integration](../concepts/openclaw-integration.md).

## What the install asks you to approve

On **OpenClaw 2026.8 and newer**, installing a plugin is a consent decision,
and FlowBoard treats it as one:

```bash
openclaw plugins install flowboard          # shows what FlowBoard asks for, then asks you
```

Read the capability surface it prints before you accept. FlowBoard asks for a
hook on `agent:bootstrap`, a background service, and — on ≥ 2026.9.2 — a
Control UI page and Gateway methods scoped to `operator.read` / `operator.write`.
The native page is **not sandboxed**: it runs in the Control UI origin with your
Gateway authority, which is a trust decision and is written up in
[SECURITY.md](../../SECURITY.md) and [ADR-0037](../adr/0037-trusted-collaborators-and-native-control-ui.md).

A few things that are easy to get wrong:

- **`--accept-capabilities` is for non-interactive installs** (scripts, CI, a
  provisioning run). It records the same consent you would give at the prompt,
  so give it only after you have read the surface once. On 2026.9.x the install
  is *refused* without it when there is no one to prompt.
- **`--yes` and `--force` are not consent.** `--force` overwrites an existing
  install and confirms a non-ClawHub source; neither approves a capability. An
  install that only passes those still stops and asks.
- **Consent is re-asked when the plugin changes**, and for a local archive it is
  re-asked on every re-install — an update cannot quietly widen what FlowBoard
  may do.
- **On 2026.6.6 – 2026.7.x there is no consent prompt at all**, because those
  hosts have no capability model. The plugin installs hook-only there. If that
  matters to you, review the source before installing — which is possible
  precisely because of the next point.

## Source installs only

FlowBoard ships as source: the ClawHub package, an npm tarball, or
`openclaw plugins install <path> --link` against a checkout. It is deliberately
**not** published as a bundle produced by `openclaw plugins pack` — bundling
would inline the 2026.9 plugin SDK into the entry point, which stops the plugin
from loading at all on every host below 2026.9.2 and takes the
`agent:bootstrap` hook down with it. The upside for you is that what runs is
what you can read.

## Already installed as an OpenClaw plugin?

`openclaw plugins install flowboard` wires the project-context hook. To bring
up the dashboard in one step — install deps, build the UI, register a
per-user service (launchd/systemd) and verify health:

```bash
node scripts/setup.mjs          # or: npm run setup
node scripts/setup.mjs --dry-run   # preview, change nothing
```

Re-run with `--update` after `openclaw plugins update` to rebuild & restart.
`--update` requires the standard FlowBoard service to exist and preserves its
persisted environment (including auth/tunnel variables and `JWT_SECRET`). Shell
variables never replace persisted update values implicitly. Persist a named,
allowlisted shell value by adding `--override-env=VARIABLE` to the update
command. The OpenClaw feature layer's `FLOWBOARD_SERVICE_TOKEN` and
`FLOWBOARD_FRAME_ANCESTORS` are persisted the same way, for example
`FLOWBOARD_SERVICE_TOKEN=… FLOWBOARD_FRAME_ANCESTORS=… node scripts/setup.mjs --update --override-env FLOWBOARD_SERVICE_TOKEN,FLOWBOARD_FRAME_ANCESTORS`
(see [OpenClaw Control UI](openclaw-control-ui.md#turn-it-on));
like every service value, the token is never printed. Rotate `JWT_SECRET` only with
`node scripts/setup.mjs --rotate-secret`; rotation re-registers and restarts the
service immediately. On macOS, setup writes launchd output to the owner-only
`~/Library/Logs/FlowBoard/flowboard-dashboard.log` (directory `0700`, file
`0600`, service umask `077`) rather than a shared `/tmp` path.
Prefer the manual path? It's below.

## Updating

After `openclaw plugins update flowboard` the new plugin source is on disk but
the running dashboard still serves the previous build. Two ways to apply it:

- **From the dashboard.** The header **Update** panel
  (SnippetUpgrade) detects the version mismatch and shows an *"Update available -
  vX -> vY"* chip only when self-update is explicitly enabled. Click
  **Update & restart** — it sends an explicit request confirmation to
  `POST /api/update/run`, which runs `setup.mjs --update`
  (reinstall deps + rebuild UI + merge the existing standard service
  environment + restart, leaving project data untouched), then reloads the
  page onto the new build. **Safety:** The API
  requires `FLOWBOARD_ENABLE_SELF_UPDATE=true` to be set
  explicitly in the service configuration before the UI update button is active;
  see below.
- **From the CLI (operator action).** `node scripts/setup.mjs --update` from the
  FlowBoard checkout does the same rebuild + restart without additional confirmation.
  Recommended for automated deployments or operator-initiated updates.

**Self-Update Safety (T-417-6).** In-dashboard updates are **disabled by default**
for published installs. To enable them, set `FLOWBOARD_ENABLE_SELF_UPDATE=true` in
your standard service environment (the launchd plist on macOS or a systemd
drop-in for `flowboard-dashboard.service` on Linux). The dashboard UI will then show the update button and send a typed
request confirmation token with each update request. The CLI path (`setup.mjs --update`)
requires no additional configuration and remains available as the direct operator action.

> **Custom service or supervisor?** Setup and in-UI update manage only the standard per-user service — `ai.openclaw.flowboard-dashboard` (launchd) / `flowboard-dashboard` (systemd `--user`). If you use a different supervisor or label, update dependencies/build manually and restart that supervisor, or migrate to the standard label. Do not run `setup.mjs --update`; it intentionally refuses when the standard service is absent.

> **Dashboard port (T-495):** the default port is now `18700`. The previous default `18790` is the OpenClaw Gateway port + 1, which OpenClaw's MCP Apps sandbox listener claims. `setup.mjs --update` keeps an existing install on its current port (it pins `FLOWBOARD_PORT=18790` into a service that never set one) and prints the `openclaw config set plugins.entries.flowboard.config.dashboardPort …` command the hook then needs. A manually supervised install without `FLOWBOARD_PORT` must set `FLOWBOARD_PORT=18790` before restarting to stay where it is. See [Update FlowBoard](how-to/update-flowboard.md#dashboard-port-t-495).

> **Upgrading to 5.0.0:** the canvas DB schema is created automatically, but importing existing `canvas.json` data is operator-triggered — via the in-app banner, `POST /api/migrations/canvas/run`, or `node dashboard/scripts/migrate-canvas-to-db.mjs --run`. Non-blocking; see the [migrations reference](../reference/api/migrations.md).

## Manual install

Without the plugin.


### 1. Clone & install (manual)

```bash
git clone https://github.com/rasimme/FlowBoard.git
cd FlowBoard/dashboard
npm install
npm run build   # builds the dashboard UI into dist/ (served by the server)
```

### 2. Register the hook with OpenClaw

FlowBoard ships as an OpenClaw hook pack (declared via `package.json` →
`openclaw.hooks`). Register it through OpenClaw's plugin lifecycle so the
gateway runs `project-context` before every agent run (covering `/new`,
`/reset`, gateway startup, daily reset, idle expiry, and project switch
via `PUT /api/status`):

```bash
openclaw plugins install ~/repos/FlowBoard --link
openclaw config set hooks.internal.load.extraDirs '["~/repos/FlowBoard/hooks"]' --merge
openclaw gateway restart
```

`--link` keeps the hook pointing at this checkout, so `git pull` propagates
hook changes without a re-install. The second command (`extraDirs`) is
currently required because OpenClaw's runtime hook discovery doesn't yet
read the `--link` install record directly — once the upstream gap is
closed, this step becomes optional.

Verify the hook is registered:

```bash
openclaw hooks info project-context
# Expect: ✓ Ready, source openclaw-managed, subscribed to agent:bootstrap
```

#### Upgrading from earlier FlowBoard versions

Versions before this change shipped a `scripts/install-hooks.sh` script
that symlinked or copied the hook into `~/.openclaw/hooks/project-context/`.
The new install path replaces that — remove the legacy hook directory once
before running the commands above. Prefer moving it aside first so you can
inspect or restore local edits:

```bash
mv ~/.openclaw/hooks/project-context ~/.openclaw/hooks/project-context.legacy-backup
```

If you previously edited `~/.openclaw/openclaw.json` to register the hook
manually, no extra cleanup is needed — `openclaw config set --merge` keeps
existing entries intact.

### 3. Start the dashboard

Migrations run automatically on server start (HZL project metadata,
per-agent active-project DB setup, PROJECT-RULES canonical-path symlink,
legacy-snippet advisory).

The server stores shared project data under `FLOWBOARD_PROJECTS_DIR` when set,
or `<OPENCLAW_HOME>/projects` by default. `OPENCLAW_WORKSPACE` is still
accepted for older installs and for the HZL DB default.

```bash
node server.js
# Optional custom locations:
# OPENCLAW_HOME=/path/to/.openclaw FLOWBOARD_PROJECTS_DIR=/path/to/projects node server.js
```

For automatic start instead, stop the foreground process and run the supported
cross-platform setup command from the repository root. It registers the
standard per-user service (launchd on macOS, systemd --user on Linux):

```bash
cd ..
node scripts/setup.mjs
```

Linux-only manual alternative (if you do not use `setup.mjs`):

```bash
mkdir -p ~/.config/systemd/user
cp templates/flowboard-dashboard.service ~/.config/systemd/user/flowboard-dashboard.service
systemctl --user enable --now flowboard-dashboard
```

On macOS, `setup.mjs` writes and loads
`~/Library/LaunchAgents/ai.openclaw.flowboard-dashboard.plist` with
`RunAtLoad` and `KeepAlive`; do not copy the Linux systemd unit. The generated
plist and its service environment are owner-only. See [Update FlowBoard](how-to/update-flowboard.md)
for the preservation and verification behavior.

### 4. Finish setup in the dashboard

Open **http://localhost:18700**. If any workspace needs setup, a
**Finish setup** (fresh install) or **Migration required** (upgrade from
an older FlowBoard) chip appears in the header. Click it to open the
setup modal and choose per workspace:

- **Upgrade** — byte-identical legacy snippets → new canonical block
- **Migration required** — user-edited legacy blocks → force-replace (per-file opt-in)
- **Add FlowBoard to workspace** — workspace doesn't have the snippet yet → append it
- **Dismiss** — this workspace shouldn't use FlowBoard (e.g. a voice agent)

Every change writes a `.bak-<timestamp>` copy first. If you prefer the
CLI path: `node dashboard/snippets-doctor.js` does the same detection
and `--apply` upgrades byte-identical blocks only.

The migration modal also shows display-only advisories for legacy
project-state files and OpenClaw config/runtime leftovers. After changing
OpenClaw config such as `memoryFlush`, restart the OpenClaw gateway/runtime;
already-running processes can keep the old compaction prompt in memory.

### 5. Create your first project

Once the chip disappears, issue an explicit FlowBoard command in your live
agent chat:

> FlowBoard: create project my-app

The agent creates the project through `POST /api/projects`, registers it in
FlowBoard metadata/HZL, and uses the Tasks API for operational task state.
