# Contributing

Thanks for helping improve FlowBoard!

## Where to start

- Browse [open issues](https://github.com/rasimme/FlowBoard/issues) — look for `good first issue` or `help wanted` labels
- Have a question? Open a [Discussion](https://github.com/rasimme/FlowBoard/discussions) instead of an issue

## Project structure

```
dashboard/
├── server.js           # Express 5 API + auth + project/task endpoints
├── index.html          # SPA shell (loads styles/dashboard.css + the Vite bundle)
├── src/
│   ├── components/     # React UI components (incl. components/canvas/)
│   ├── context/        # React state contexts + window.appState bridge
│   ├── pages/          # React-owned views (TasksView, CanvasView, …)
│   ├── state/          # Task/canvas runtime helpers + mutations
│   └── utils/          # Pure utility modules (geometry, markdown, …)
└── styles/
    ├── dashboard.css   # Global/dashboard styles
    └── canvas.css      # Canvas-specific styles
docs/
├── adr/                # Architecture Decision Records
├── concepts/           # Conceptual architecture docs
└── reference/          # API/env/reference docs
```

**Key conventions:**
- Backend: Express 5 API; HZL/SQLite is canonical task state
- Frontend: React is the dashboard UI runtime; the Idea Canvas is a React view (`src/pages/CanvasView.jsx`). The former vanilla `js/` runtime (canvas, app.js, utils.js) has been removed (ADR-0024).
- Modules are small and cohesive - one concern per file
- Dark theme, mobile-responsive
- Project knowledge is Markdown/JSON; operational task state lives in HZL/SQLite
- T-215 introduces `dashboard/src/state/` as the task-runtime helper boundary

## Frontend runtime rules

Task UI state has one intended mutation path. Read [Frontend Runtime](docs/concepts/frontend-runtime.md) and [ADR-0019](docs/adr/0019-frontend-runtime-foundation.md) before changing task UI state behavior.

- Do not add new direct writes to `window.appState.tasks` outside the runtime bridge.
- Use the task runtime helpers for new task actions once they exist.
- Apply optimistic UI changes through the runtime, then merge the canonical server response.
- Handle related server records such as `parentUpdated` explicitly.
- Treat polling as reconciliation only, not as the visible update path for local actions.
- The Canvas is React now (ADR-0024 supersedes ADR-0012); its notes/connections live in the DB (ADR-0025 supersedes ADR-0014) — read/write via the canvas API, never files or SQL.

### Architecture invariants (enforced) — read [ADR-0026](docs/adr/0026-frontend-architecture-invariants.md)

These are checked by `dashboard/test-runtime-guardrails.mjs`; the gate fails on a regression. **Do not reintroduce `window.*` globals — use the contexts:**

- **State** → the store is `src/state/appStore.mjs`; `window.appState` is a transparent Proxy over it (every write notifies React → no un-notified mutations, no watchdog). Change state via `dispatch` (`useAppState`); read the immutable snapshot `state`.
- **Commands** (view/tab/project/spec) → `useDashboard()`. No `window._viewProject`/`_switchTab`/`_openSpec`/… bridges.
- **Navigation intents** (scroll-to/new-x) → `useNavigation()`. No `window._scrollTo*`/`_pendingNew*` flags.
- **API** → always `apiFetch`/`apiJson` (carries auth). A bare `fetch('/api…')` 403s under tunnel auth; only `bootstrap.js` may call it raw.
- New cross-view flows: add a check to the dashboard-shell E2E (`dashboard/test-dashboard-shell.js`).

## Design tokens & styling

CSS custom properties in `styles/dashboard.css` are the single source of truth for colors, shadows, radii and durations; `tailwind.config.js` only maps them to utility classes.

- **Tailwind preflight is disabled** (it would conflict with legacy `dashboard.css`). Raw HTML elements keep browser defaults — every `<button>`, `<input>` etc. in React components must set its background, border and margin classes explicitly.
- Reference tokens, don't hardcode values. New colors/shadows start as a `--token` in `dashboard.css`, then get a mapping in `tailwind.config.js` if needed.
- A `var(--token)` without a fallback must be defined in `styles/*.css` — `test-design-tokens-drift.js` (part of `npm test`) fails otherwise. Runtime-injected variables must always carry a fallback value.
- Tailwind opacity modifiers (`bg-accent/50`) don't work with CSS-variable colors; use explicit `-subtle`/`-hover` token variants.

## Development workflow

```bash
# 1. Fork and clone
git clone https://github.com/YOUR_USERNAME/FlowBoard.git
cd FlowBoard

# 2. Create a feature branch off dev
git checkout dev
git pull origin dev
git checkout -b feat/my-change

# 3. Run locally
cd dashboard
npm install
node server.js
# → http://localhost:18790

# 4. Make changes, test, commit
git commit -m "feat: my change"

# 5. Push and open PR against dev
git push origin feat/my-change
```

### Plugin host compatibility

`openclaw/` supports two host generations at once, and the split is not
optional:

| Layer | Hosts | Entry point |
|---|---|---|
| Baseline — `agent:bootstrap` hook + standalone dashboard | **≥ 2026.6.6** (`openclaw.install.minHostVersion`) | `openclaw/flowboard-plugin.js` |
| Feature contract + native Control UI page | **≥ 2026.9.2** plus the *Custom plugin UI* lab | `openclaw/feature-entry.js` |

`openclaw/plugin-sdk/feature-plugin` and `feature-contract` do not exist before
2026.9.2. A top-level import of them in the entry does not merely disable the
new UI on an older host — the whole entry fails to load, so the hook every
agent run depends on is never registered. The entry therefore loads the feature
layer through one guarded, synchronous `require('./feature-entry.js')` and
falls back to the hook-only definition, recording the reason and reporting it
once at debug level.

Rules when touching these files:

- **Never** add a static `openclaw/...` import to `openclaw/flowboard-plugin.js`.
  `contract.js`, `adapter.js` and `feature-entry.js` are feature-only and must
  stay unreachable from the baseline path.
- **Never** use top-level `await` in the entry — the host loads plugin entries
  through jiti (CJS), and the runtime treats a function default export as
  `register`, so the entry must resolve synchronously.
- `dashboard/test-plugin-entry-compat.js` enforces both rules; run it after any
  change to the entry.
- Keep `openclaw.install.minHostVersion` at `>=2026.6.6` and
  `openclaw.compat.pluginApi` at `>=2026.5.20`. `openclaw.build.openclawVersion`
  tracks the SDK the Control UI bundle was built with and is a separate thing.

### Plugin build

`openclaw/` is an OpenClaw feature plugin. After changing anything under
`openclaw/control-ui/`, `openclaw/contract.js`, or the plugin config schema,
regenerate `openclaw.plugin.json` and the browser bundle:

```bash
npm install          # repo root — installs the pinned openclaw + esbuild dev deps
npm run build:plugin # openclaw plugins build → dist/control-ui/<hash>/ + manifest
npm run validate:plugin
```

Needs **Node ≥ 24.16** (the OpenClaw CLI refuses older runtimes); the dashboard
itself still runs on the repo's normal Node version. The build regenerates
`id`, `name`, `description`, `version`, `configSchema`, `activation`,
`contracts` and `controlUi` from the plugin entry, while `enabledByDefault`,
`uiHints` and `configContracts` are hand-authored and survive regeneration.
Never hand-edit a generated field — `validate:plugin` fails on a stale
manifest. `dist/` is gitignored and is built before packing a release.

`validate:plugin` and `build:plugin -- --check` both **refuse outright when
`dist/control-ui/` is missing** ("Control UI build is missing or stale"), so run
the plain build first. That is also why CI and `release-check.mjs` build and
then diff the two generated files instead of running `--check` on a clean
checkout.

**Never run `openclaw plugins pack`.** It bundles the backend, which hoists the
`openclaw/plugin-sdk/feature-*` imports out of `openclaw/feature-entry.js` into
the entry itself. Those subpaths do not exist before 2026.9.2, so a packed
artifact fails to load on every older host — taking the `agent:bootstrap` hook
with it. FlowBoard ships **source installs only** (ClawHub package, `--link`,
or the npm tarball). See
[ADR-0040](docs/adr/0040-gateway-verified-principal-via-service-credential.md).

### Host compatibility canaries

Two scripts prove the supported host range instead of asserting it. Both are
version-*aware* without being version-*branched*: they read what the host CLI
accepts out of its own `--help` (`scripts/lib/openclaw-host.mjs`) and adapt.
Hard-coding a flag is the bug they exist to prevent — `--accept-capabilities`
is mandatory on 2026.9.x and makes 2026.6.6 abort with "unknown option".

```bash
# One host: pack, install, enable, inspect, doctor, re-install, uninstall
node scripts/release-install-canary.mjs
node scripts/release-install-canary.mjs --json         # machine-readable report

# Several hosts, one packed artifact, one table
FLOWBOARD_HOST_MATRIX="\
2026.6.6: node=/opt/node24/bin/node /opt/oc66/node_modules/.bin/openclaw,\
2026.9.5: node=/opt/node2421/bin/node /opt/oc95/node_modules/.bin/openclaw" \
  node scripts/release-host-matrix.mjs
```

A matrix entry is `[<label>: ][node=<node-path> ]<cli-path>`. The `node=` part
is usually required: the OpenClaw bin is a `#!/usr/bin/env node` script, so it
runs on whatever `node` comes first on `PATH`, and 2026.9.x demands ≥ 24.16
while 2026.6.6 predates that. `FLOWBOARD_HOST_MATRIX_NODE` sets a default for
entries without a prefix.

Canary and matrix environment variables — tooling only. The server reads none
of them, which is why they are documented here rather than in
[env-vars.md](docs/reference/env-vars.md):

| Variable | Effect |
|---|---|
| `FLOWBOARD_OPENCLAW_CLI` | Pin the host CLI. Default: the pinned devDependency, then `PATH`. |
| `FLOWBOARD_OPENCLAW_NODE` | Node runtime for that CLI (binary or directory), prepended to `PATH`. |
| `FLOWBOARD_CANARY_ARTIFACT` | Reuse a packed tarball instead of running `npm pack`. The matrix runner sets it so every host sees identical bytes. |
| `FLOWBOARD_CANARY_KEEP_HOME=1` | Keep the disposable OpenClaw home for debugging (alias: `FLOWBOARD_KEEP_CANARY_TEMP=1`). |
| `FLOWBOARD_CLAWHUB_SPEC` | Default spec for `--clawhub`. |
| `FLOWBOARD_HOST_MATRIX` / `FLOWBOARD_HOST_MATRIX_NODE` | Matrix entries and their default Node. |

**Why the canary writes an `exec-approvals.json` stub.** Every run gets a
throwaway `OPENCLAW_STATE_DIR`, but on 2026.6.x / 2026.7.x that is not enough:
the first CLI call against a fresh state dir runs a one-shot legacy-state
migration whose *source* path comes from the home directory rather than the
state dir. If the isolated target file does not exist yet, the migration adopts
the machine's real `~/.openclaw/exec-approvals.json` and renames the live file
to `exec-approvals.json.migrated-<ts>` — silently breaking the Gateway of
whoever ran the canary. Pre-creating a stub makes the migration a no-op. Do not
remove it: it is the reason this is safe to run on a workstation with a live
OpenClaw.

### Reload and hot install (hosts ≥ 2026.9.x)

The canary deliberately does **not** start a Gateway — that would bind a port
and load the machine's channels and secrets — so its `reload` step reports
`skip` ("no Gateway in the disposable home"). That is a documented limitation,
not a failure. The behaviour was verified separately against an isolated
2026.9.5 Gateway (2026-09-20; disposable home, loopback, token auth, Telegram /
cron / heartbeat / mDNS off):

- `plugins install <artifact> --accept-capabilities --force` **while the Gateway
  runs** applies immediately ("Applied in Gateway generation 3") — no restart,
  no separate reload.
- `plugins reload flowboard` returns `restartRequired: false` with a new
  generation and source digest. Afterwards `hooks list` still shows
  `project-context ✓ Ready`, and `plugins inspect --runtime` still lists the
  `flowboard:feature-events` service and the `flowboard.ui.identity` method.
- Code changed on disk **is** picked up by reload: a changed feature-contract
  handler, a newly added contract operation, *and* a newly added
  `api.registerGatewayMethod` were all reachable after `plugins reload`, with
  the Gateway PID unchanged. This supersedes the T-487-4 spike note that new
  Gateway methods need a restart — that was measured before the plugin moved to
  `defineFeaturePlugin` with `activation.onStartup: true`.
- Capability acceptance is **not** sticky for an archive source: re-installing
  the same unchanged tarball is refused again without `--accept-capabilities`.
- `plugins update flowboard` reports `Skipping "flowboard" (source: archive)` —
  a locally installed artifact has no upstream to update from. Expected.

## Branch strategy

- **`main`** — stable releases only
- **`dev`** — active development, PRs target this branch
- Feature branches off `dev`: `feat/...`, `fix/...`, `docs/...`

## Pull requests

- Keep PRs focused (one topic per PR)
- Include screenshots for UI changes
- Mention what platform you tested on (desktop / mobile / both)
- Reference related issues: `Closes #123`

## Release gates

Before publishing a release, run:

```bash
node scripts/release-check.mjs
```

That gate includes privacy scanning, plugin packaging lint, the plugin
metadata build + drift check + `plugins validate`, ClawPack
pack/source-validate/tarball-dry-run checks, the OpenClaw install canary,
dashboard tests, and the dashboard build.

The gate needs an OpenClaw CLI that understands feature plugins — the pinned
devDependency, so run `npm install` at the repo root first (**Node ≥ 24.16**)
or point `FLOWBOARD_OPENCLAW_CLI` at an OpenClaw ≥ 2026.9 binary. It refuses to
run otherwise rather than silently skipping the manifest checks; a
pre-2026.9 CLI is detected by capability (no `plugins validate --json` /
`plugins pack`), not by parsing its version. Every OpenClaw call in the gate
runs against a throwaway home, so it does not touch the machine's
`~/.openclaw`.

Before a release, also run the supported-host matrix (see *Host compatibility
canaries* above) across at least the oldest supported host and the newest one
FlowBoard claims the native UI on.

Publish the ClawPack tarball produced by `clawhub package pack`, not the local
folder or GitHub source directly. The release gate validates the source package,
then dry-runs publish with the packed tarball so the latest ClawHub version does
not regress to a legacy ZIP artifact.

After publishing to ClawHub, run the live registry canary once:

```bash
node scripts/release-install-canary.mjs --clawhub flowboard@x.y.z
```

This installs the published ClawHub artifact into a temporary `OPENCLAW_HOME`
and catches registry/install-path drift that local package checks cannot see.

For releases intended to change the ClawHub security-audit verdict, run a
manual stored-report comparison before and after publishing:

```bash
node scripts/clawhub-scan-summary.mjs 5.0.3 x.y.z
```

The summary maps SkillSpector/ClawScan findings to the FlowBoard hardening
phase meant to address them, so changes can be judged against the actual report
instead of scanner folklore. It is intentionally a manual audit helper rather
than a CI gate: stored ClawHub reports only exist after a submitted version has
been scanned server-side.

## Code style

- No semicolons (project convention)
- `const` over `let`, no `var`
- Descriptive function/variable names
- Avoid adding dependencies unless there's a clear, significant win
- User-facing UI strings (labels, buttons, empty states, toasts, preset names,
  notifications) **and** agent-facing API messages are **English only** — no
  German or other localized strings in shipped UI/API copy

## Commit conventions

- Conventional-commit style: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`
- Do **not** add AI co-author trailers (`Co-Authored-By: Claude …` or similar) —
  commits use owner-only attribution

## Documentation discipline

If your patch introduces or changes an architectural decision (new endpoint, new convention, default-behaviour change, new agent type, new hook event, removed concept), write an ADR under `docs/adr/` and update the relevant concept doc under `docs/concepts/`. If it changes user-visible behaviour, update the affected guide under `docs/guide/`. Bug fixes, refactors, test additions, and dependency bumps do not require documentation updates. When in doubt, ask.

Structural consistency is enforced by drift tests in `npm test`: `test-docs-drift.js` (API manifest + env vars), `test-adr-index-drift.js` (every ADR appears in the index and `llms.txt`), and `test-concepts-index-drift.js` (concept docs are linked and resolve). A red drift test names exactly what to update.
