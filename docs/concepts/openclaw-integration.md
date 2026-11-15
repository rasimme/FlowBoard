# OpenClaw Integration

## What

FlowBoard is usable on its own, but it is built to sit inside OpenClaw. This doc explains *which*
surfaces FlowBoard uses to attach to an OpenClaw Gateway, why each one exists, and what the operator
is trusting when they enable the newest of them — the native page inside the OpenClaw Control UI.

Three surfaces, in order of how long they have existed and how little they assume about the host:

| Surface | What it does | Minimum host | Off-switch |
|---|---|---|---|
| `agent:bootstrap` hook | Injects the active project's context into an agent run | 2026.6.6 | Disable the plugin |
| Standalone dashboard | The full FlowBoard SPA on its own port and its own auth | none (no OpenClaw needed) | Stop the service |
| Native Control UI page | The FlowBoard dashboard as a page in the Control UI sidebar, plus a widget and a session panel | 2026.9.2 + lab flag | Lab flag, or disable the plugin |

The first two are the baseline and stay the baseline. The third is progressive enhancement.

## Why

FlowBoard's value in OpenClaw is that the agent already knows what it is working on. That is the
hook's job and it needs almost nothing from the host. The dashboard is where a human looks at the
board, and it must keep working when there is no OpenClaw at all — for external agents, non-browser
clients, older hosts, and anyone who runs FlowBoard standalone.

The native page exists because the previous answers to "show FlowBoard inside OpenClaw" were all
bad. A plugin tab renders in an iframe whose `sandbox` attribute is a *Gateway-wide* setting; in its
default form the frame has an opaque origin, so FlowBoard's cookies, CSRF checks and storage all
break. The only way to fix that would have been to ask operators to weaken sandboxing for every
embed on their Gateway — a price FlowBoard will not ask anyone to pay for a Kanban board. A feature
plugin's page is the plugin's own DOM instead, which makes the embedding question ordinary again.

The cost is that a feature plugin is not sandboxed at all. That trade is the subject of
[ADR-0037](../adr/0037-trusted-collaborators-and-native-control-ui.md) and of the
"OpenClaw Control UI integration" section in `SECURITY.md`; the short version is below.

## The three surfaces

### `agent:bootstrap` hook — the baseline

One hook subscription, no other events. It reads the calling agent's workspace, resolves the active
project, and mutates the run's bootstrap files in memory. It never writes project context to disk
and it never needs the Control UI. See [Hook Architecture](hook-architecture.md) and
[ADR-0001](../adr/0001-live-inject-bootstrap.md).

### Standalone dashboard — always kept

The React SPA served by FlowBoard's own Express server, with FlowBoard's own auth
([Auth Model](auth-model.md)). This is what an operator opens today, what the Telegram Mini App
loads, and what every non-OpenClaw client talks to over REST. No OpenClaw integration removes it,
and every fallback path below lands here.

### Native Control UI page — the React dashboard (T-515)

A feature plugin ships a compiled browser bundle that the Control UI imports same-origin and mounts
as a real sidebar destination, reached at `/plugin?plugin=flowboard&id=flowboard`. That bundle is
the dashboard's own React app (`dashboard/src`), built a second time for this host. There is one
codebase for the standalone dashboard and the page; a view that works in one works in the other.

Four things make the same app run inside someone else's page:

- **A mount function instead of a document.** `mountDashboard(container)` renders the app into a
  node the host hands over and returns a `dispose`. Overlays render into a root inside that node
  rather than into `document.body`, and the globals the app used to own are set up per mount and
  removed again.
- **A transport seam.** The Control UI's `connect-src` policy does not let the page `fetch()`
  FlowBoard's port. `apiFetch` therefore takes a transport: standalone it is `fetch`, in the page
  it is the Gateway connection (below). The indirection is not a workaround — it is what lets a
  write carry the operator's verified identity instead of a cookie.
- **Scoped styles.** `scripts/build-native-ui.mjs` runs Tailwind and prefixes every selector with
  `.fb-native-root`, so no FlowBoard rule can match a host element. Rules that name a class, id or
  attribute carry the scope twice, because the host styles generic class names such as `.btn`
  with selectors that would outrank a singly scoped rule; element and universal rules keep the
  single scope so a reset cannot outrank a third-party class rule such as CodeMirror's.
- **The host's theme.** Tokens the Control UI theme also defines are not redeclared, so the page
  follows light, dark and custom themes. FlowBoard-only tokens (status, note hues, charts) keep
  their values. The page paints no background of its own.

Earlier iterations of this page — a framed copy of the dashboard, then a hand-written board with
framed tabs beside it — were built and removed before any release. What they proved is why the
page is built this way: an iframe needs Gateway-wide sandbox changes or loses its cookies, and a
second, hand-written UI means every feature is built twice.

### How the page reaches FlowBoard: the API passthrough

Two raw Gateway methods, `flowboard.api.read` (`operator.read`) and `flowboard.api.write`
(`operator.write`), forward one dashboard API request each
([ADR-0042](../adr/0042-gateway-api-passthrough-for-native-dashboard.md)). They are raw methods
rather than feature-contract operations because a contract payload is capped at 256 KiB, which a
real board exceeds.

A generic forwarder is only acceptable with a closed list in front of it. `openclaw/api-passthrough.js`
allow-lists method and path, and leaves out what an operator session in a browser should not
drive: self-update, the dashboard's own auth, webhooks, deleting agent rows, agent context,
workflow and heal endpoints, and governance mode switches. Requests and responses are limited to
16 MiB, reads time out after 15 s and writes after 30 s, and only a fixed set of content types and
response headers passes. The caller's identity is never taken from the request: it is the profile
the Gateway attested for that connection.

### Widget and session panel (T-515-6)

The same bundle registers two more views. The **"Needs me" widget** renders the `tasks.needing-me`
query on a session dashboard; the host shows it only because the backend also registers a Control UI
descriptor with `surface: "widget"` and the same id, which is how the Gateway advertises the kind
`flowboard:needs-me` for a connection's scopes. The **task panel** is a session panel: it resolves
the project from the session's binding (falling back to the agent's), lists the tasks that agent
holds in progress or in review, and writes comments and approvals through the API passthrough
(ADR-0042), so they carry the Gateway-verified operator like every other write. Both open the page
through `host.navigation.openPage` with `project` / `task` parameters. Claims are per agent, not per
session, so the panel cannot tell two sessions of one agent apart.

### Checkpoint discipline hooks (T-521)

Two typed host hooks (`openclaw/task-discipline.js`) nudge task hygiene without
touching the injected project context. That constraint is the point: the
context sits in the stable part of the system prompt, and a reminder that
appears and disappears there would re-send the conversation uncached (T-512).

- `after_tool_call`, matched to `exec`, observes a successful `git commit`. If
  the subject names a task that the calling agent holds in the project its
  session resolves to, the plugin records a checkpoint. It is an observation
  hook: no model tokens, no conversation access.
- `before_agent_finalize` is opt-in (`finalizeReminder`) and needs the
  operator's `hooks.allowConversationAccess`. When the agent has a stale or
  lease-expired claim, it returns `revise` with a retry capped at one attempt;
  the instruction is appended to the end of the conversation.

Both swallow their own failures, and a host that lacks either hook simply does
not register it. These writes carry no Gateway connection, so FlowBoard
attributes the checkpoint to the agent id and resolves the local operator as
principal.

### The attribution boundary

Every write from the page, the widget and the panel goes through the passthrough and carries the
Gateway-verified principal under the service credential
([ADR-0040](../adr/0040-gateway-verified-principal-via-service-credential.md)). It is recorded
against the signed-in OpenClaw profile; without a service token it is recorded as the local
operator. Nothing in the browser can name a different actor.

## The contract surface

What FlowBoard exposes through the Gateway. Reads require `operator.read`, writes `operator.write`;
FlowBoard authorizes every write itself.

| Name | Kind | Scope | What it is |
|---|---|---|---|
| `flowboard.api.read` | Gateway method | `operator.read` | One allow-listed `GET` against the dashboard API |
| `flowboard.api.write` | Gateway method | `operator.write` | One allow-listed `PUT`/`POST`/`DELETE` against the dashboard API |
| `flowboard.ui.identity` | Gateway method | `operator.read` | Binds the connection's attested profile for later calls (ADR-0040) |
| `tasks.needing-me` | contract query | `operator.read` | `GET /api/tasks/stuck` + `GET …/tasks?status=review`, merged and bounded |
| `ui.focus` | contract action | `operator.write` | Per-connection state in the Gateway; writes nothing to FlowBoard |
| `tasks-changed`, `projects-changed` | contract events | — | Emitted by the change poll |

The feature contract is deliberately small. The typed transport is worth having where the host
adds something: `feature.watch` re-runs the "needs me" query when an event arrives, and the events
themselves are how a change reaches an open page. Everything else is the dashboard's own REST API
behind the passthrough, so there is one definition of each operation, not two.

`ui.focus` records, per Gateway connection, which project a page is looking at, so the background
poll watches that board and only that board. It is an action rather than a query because it
mutates server-side state, and it is bounded: 64 connections, at most 8 distinct boards watched,
most recently focused first.

### No `tool:` declarations

The contract operations are **not** exposed as agent tools, and `contracts.tools` in the generated
manifest stays empty. Agents keep using FlowBoard's REST API, which is the project rule and already
carries their identity. Declaring tools would change what the operator consents to when installing
or updating the plugin — the capability consent prompt and the release canary matrix (T-487-1) —
and that is a decision about the plugin's trust surface, not about the page. It is worth
revisiting as its own task if agent-facing tools are ever wanted.

### How a native view stays fresh

`feature.watch` refreshes on contract events and never polls, and FlowBoard's dashboard cannot push
into the Gateway, so the plugin polls FlowBoard — server-side, and only while a Control UI client
is registered. The `flowboard:change-poll` service (its id must differ from the
`<pluginId>:feature-events` service the feature SDK registers for the event emitter) runs two lanes
on one timer:

- every 10 s, one `GET /api/projects` fingerprinted per project as lifecycle status plus the review
  and blocked counts — what keeps the switcher badges live everywhere;
- every 5 s, `GET /api/projects/:project/tasks` for each focused project, digested per task over
  status, work state, blocking reason, assignee, `enteredStatusAt`, title, manual rank, priority
  and tags. A change
  emits `tasks-changed { project, ids }` naming the cards that moved; a diff larger than 50 ids is
  emitted without `ids`, which means "refetch the list".

The first read of a board is a baseline and never an event, focus moving off a board drops its
baseline, and an idle Gateway makes no request at all. Worst case is 8 boards at 12 reads a minute
plus 6 for the project lane; FlowBoard exempts loopback from its rate-limit lanes, so that budget is
politeness rather than a cap, and it still sits well inside the 300/min read lane a non-loopback
caller would get. Deliberately *not* digested: the stuck indicator, which FlowBoard re-stamps on
every evaluation, and the lease, which expires on a clock — either would wake every open page on a
timer instead of on a change.

The React page (T-515-8) uses the same events without `feature.watch`: it subscribes to
`tasks-changed` and `projects-changed`, reloads its snapshot when one arrives, and reports the board
on screen through `ui.focus`. Its own poll stays only as a safety net at the 30 s ceiling, for
changes the digest above deliberately ignores. The standalone dashboard has no push source and keeps
its adaptive 5–30 s poll.

## What the operator is trusting

A native plugin bundle runs unsandboxed in the Control UI origin with the signed-in operator's
Gateway authority — the host documents this plainly, and there is no iframe to fall back on. So the
bundle is a trust decision, not a technical boundary, and FlowBoard treats it as one: no third-party
scripts, no remote code loading, pinned and lock-filed dependencies, a reproducible content-hash
bundle built from the reviewed repository, and two off-switches that belong to the operator (the
Gateway lab flag and disabling the plugin).

Two consequences follow for identity. First, the Gateway's operator scopes are a *ceiling* on what
a connection may reach, not FlowBoard's authorization: a registered scope is a requirement, and a
handler still sees the caller's full connection, so FlowBoard authorizes every write itself,
server-side. Second, a Gateway-verified human profile is a genuinely new and stronger attribution
signal than anything FlowBoard had — but it reaches FlowBoard's server only through the plugin
adapter over loopback under a service credential, never from the browser.

## Workboard coexistence

OpenClaw bundles its own Kanban-style board, **Workboard** — disabled by default, enabled per
Gateway, reached at `/workboard`, with its own plugin-owned store. Once FlowBoard has a native page,
the two boards sit one sidebar entry apart, and the tempting move is to mirror FlowBoard tasks into
Workboard cards so that everything shows up in one place.

FlowBoard does not do that, and the reason is a gap rather than a preference. As of OpenClaw 2026.9.5
there is no external card source, provider interface, importer, webhook or synchronisation contract
for Workboard; a card's only outward hook is its optional Workboard-owned *linked refs* (task, run,
session, or source URL). Nothing defines who wins a concurrent edit, what a deleted source means, or
how a drifted card is reconciled — so mirroring would mean inventing a private protocol on a surface
whose owner has not specified one, and re-inventing it on every Workboard release. Two stores with
no conflict rule is how a task ends up with two different statuses and no way to tell which is true.

The contract, decided in [ADR-0038](../adr/0038-workboard-coexistence-flowboard-canonical.md):

- **FlowBoard is the state of record** for FlowBoard projects and tasks — identity, status, claims,
  history.
- **Workboard keeps two honest roles:** stable *links* to FlowBoard tasks, and a bounded
  OpenClaw-native execution view for Gateway-local operating work that is not FlowBoard work.
- **No status mirroring, no bidirectional sync**, until OpenClaw ships a stable external
  source/provider contract *with* conflict semantics.
- **One canonical owner per task**, and **agents never auto-create Workboard cards** for FlowBoard
  tasks. A human may create a card and paste a link; automation may not manufacture a second copy.
- A card that references a FlowBoard task **carries the link and defers**: its column is a local
  note, never evidence about the task, and FlowBoard never reads it back.
- **Link shape** (T-487-8): the Control UI deep link
  `/plugin?plugin=flowboard&id=flowboard&p.project=<name>&p.task=<id>`, or the standalone dashboard
  URL where the native page is unavailable. The page reads `p.project` and `p.task` and opens that
  task. The standalone SPA has no URL routing for a task, so the standalone dashboard URL opens
  FlowBoard without preselecting it.

## Compatibility

| Situation | What happens |
|---|---|
| Host < 2026.9.2 | The `controlUi` manifest field is additive and ignored; hook and standalone dashboard work normally |
| Host ≥ 2026.9.2, lab flag off (the default) | No sidebar entry. Plugin backend and standalone dashboard are unaffected |
| Host ≥ 2026.9.2, lab flag on | Native page, widget and session panel appear; they need `dashboardBaseUrl` to reach the dashboard |
| Plugin disabled, or FlowBoard run without OpenClaw | Standalone dashboard only; external agents keep using REST |

`gateway.controlUi.experimental.customPlugins` is server-enforced and defaults to off. Hosts from
2026.9.6 apply it through live config reload; 2026.9.2–2026.9.5 need a Gateway restart. OpenClaw's plugin APIs are experimental, so FlowBoard pins and tests a host version
rather than assuming forward compatibility.

### The supported host matrix

"Supported" means a release has installed the packed artifact on that host and watched the hook come
back. `scripts/release-host-matrix.mjs` runs `scripts/release-install-canary.mjs` against each CLI
and prints the table; CI runs the two ends of it on every push (Node 22 + 2026.6.6, Node 24 +
2026.9.6). What differs between hosts is the *install lifecycle*, not FlowBoard's behaviour:

| | 2026.6.6 | 2026.7.1-2 | ≥ 2026.9.2 (verified on 2026.9.5 and 2026.9.6) |
|---|---|---|---|
| `agent:bootstrap` hook + standalone dashboard | yes | yes | yes |
| Plugin shape reported by the host | `hook-only`, info-level note | `hook-only`, info-level note | `non-capability`, with feature services |
| Feature contract, `flowboard.ui.identity`, native page | no — SDK subpaths do not exist | no | yes |
| Capability consent (`--accept-capabilities`) | no such concept | no such concept (`--acknowledge-clawhub-risk` is *source* trust, not consent) | required; re-asked when the plugin changes |
| `plugins doctor --json`, `plugins reload`, `plugins pack` | no | no | yes |
| Node the CLI accepts | 22+ | 22+ | ≥ 24.16 |

Two consequences cost real debugging time, so they are encoded in the tooling rather than in a
maintainer's memory:

- **Capabilities are detected, never inferred from a version string.** Passing
  `--accept-capabilities` to 2026.6.6 aborts with "unknown option", so a canary that hard-codes it
  reports a healthy old host as broken. `scripts/lib/openclaw-host.mjs` reads the CLI's own `--help`
  instead. `plugins build --check` is the trap: all three hosts have that flag, but the old ones only
  understand tool plugins with it, so the feature-plugin marker is `plugins validate --json` plus the
  `plugins pack` subcommand.
- **The native bundle is generated, and `dist/` is gitignored.** On a feature-plugin host a packed
  artifact without `dist/control-ui/<hash>/` cannot render the page; on an older host the same
  artifact is fine, because `controlUi` is ignored there. The canary therefore asserts the bundle
  only on hosts that would load it.

On hosts ≥ 2026.9.x the install is hot: installing over a running Gateway applies in the next runtime
generation, and `plugins reload flowboard` picks up changed plugin code — including newly added
feature-contract operations and newly registered Gateway methods — with `restartRequired: false`
(measured 2026-09-20 against an isolated 2026.9.5 Gateway; supersedes the T-487-4 note that new
Gateway methods needed a restart). FlowBoard does not depend on that: the hook and the dashboard
behave the same whether the Gateway was reloaded or restarted.

FlowBoard is distributed as **source** — ClawHub package, npm tarball, or `--link`. `openclaw plugins
pack` is never used: bundling the backend hoists the `openclaw/plugin-sdk/feature-*` imports into the
entry, which would make the entry fail to load on every host below 2026.9.2 and unregister the hook
(ADR-0040).

## Where this is decided

- [ADR-0037](../adr/0037-trusted-collaborators-and-native-control-ui.md) — trusted collaborators,
  the four identities, the scope mapping, and the obligations that come with unsandboxed native code.
- [ADR-0038](../adr/0038-workboard-coexistence-flowboard-canonical.md) — Workboard coexistence:
  FlowBoard stays canonical, links instead of mirroring, and the task link contract.
- **ADR-0039** — session-scoped project binding (`sessionKey` as context, never authorization).
- **ADR-0040** — the Gateway-verified principal relayed under a service credential, in full.
- `SECURITY.md` § *OpenClaw Control UI integration (native plugin UI)* — the operator-facing threat
  statement and how to turn the surface off.

## See also

- [Hook Architecture](hook-architecture.md) — the `agent:bootstrap` subscription itself
- [Auth Model](auth-model.md) — how a principal is established on FlowBoard's own server
- [Agent Identity](agent-identity.md) — why `agentId` is attribution and not a principal
- [Governance Trust Contract](governance-trust-contract.md) — what FlowBoard does with a resolved principal
- [Environment Variables](../reference/env-vars.md) — `FLOWBOARD_SERVICE_TOKEN` and the rest
