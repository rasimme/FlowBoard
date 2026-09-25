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
| Native Control UI page | FlowBoard as a page in the Control UI sidebar: native board, framed single surfaces | 2026.9.2 + lab flag | Lab flag, or disable the plugin |

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

### Native Control UI page — stages 0–3

A feature plugin ships a compiled browser bundle that the Control UI imports same-origin and mounts
as a real sidebar destination. Reached at `/plugin?plugin=flowboard&id=flowboard`. It is built in
stages so that each one is independently useful and independently revertible:

- **Stage 0 — frame the SPA (retired in T-499).** The native page mounted the existing dashboard in
  the plugin's own iframe, with the SPA unchanged. The FlowBoard-side requirement it introduced,
  `FLOWBOARD_FRAME_ANCESTORS` (T-487-10), stays: it adds the Control UI origin to the CSP
  `frame-ancestors` directive and omits `X-Frame-Options`, since that header cannot express more
  than one allowed ancestor, and since T-499 it also gates the dashboard's embed mode.
- **Stages 1–3 — move the data layer onto the Gateway.** Native views replace framed ones, view by
  view: first read-only strips and widgets, then the Kanban with writes, then a decision per
  remaining surface (stage 3, below). Native views talk to FlowBoard through plugin-owned
  feature-contract operations rather than through the browser, because the Control UI's
  `connect-src` policy does not allow the page to `fetch()` FlowBoard's own port. That indirection is not a workaround — it is what lets a native
  view carry the operator's verified identity into FlowBoard's attribution instead of relying on a
  cookie the frame may not even be allowed to send.

The whole-SPA iframe was to disappear once nothing depended on it, not before — which is what
stage 3 did.

Stage 1 (T-487-8) shipped the read-only rail. **Stage 2 (T-498) is the board itself**: `tasks.list`
carries a whole card instead of five fields, `task.get` adds the detail read, and three write
actions — `task.update`, `task.approve`, `task.reject` — move work from the Control UI.

**Stage 3 (T-499) is done, and the whole-SPA iframe is retired.** Every FlowBoard surface in the
Control UI is now either native on the feature contract or an explicitly bounded framed view:

- **Native:** the rail and the board, with the everyday actions — move, work state, approve gate,
  in-column reorder, archive and trash with undo, "New task", and a panel that edits title,
  description, priority and tags and takes comments.
- **Framed, one surface at a time:** *Ideas*, *Files* and *Projects*, loaded from the dashboard in
  embed mode (below) without its chrome, for the project the native page is on. *Specify* is a
  dialog rather than a surface: it works inside framed Ideas, and a native "New task" refused with
  `SPECIFY_REQUIRED` opens a transient framed Specify view.
- **Standalone only:** the Overview.

The layout is one sidebar entry, "FlowBoard", with FlowBoard's own tabs (`Board | Ideas | Files |
Projects`). Framing surfaces is the cheap, reversible choice: one codebase and every dashboard
feature today, at the cost of the limits listed under the attribution boundary below. Porting a
framed surface natively later stays possible surface by surface, and so does one sidebar entry per
surface.

### Embed protocol v1

The dashboard serves a single surface at
`/?embed=<ideas|files|projects|specify>&project=<p>[&task][&file][&title&priority]&host=<Control UI
origin>`. Embed mode is active only when the page is actually framed, `embed` names a known surface
and `host` is an origin in the dashboard's `FLOWBOARD_FRAME_ANCESTORS` (injected into the page;
where the browser exposes `location.ancestorOrigins`, the direct parent must match it too).
Anything else — opened directly, top-level `?embed=`, no allow-list — is the unchanged standalone
app, and an embed never stores an agent id.

Page and frame talk through `postMessage` only, with one envelope:
`{ type: 'flowboard:embed', v: 1, kind, ...payload }`.

| Direction | `kind` | Payload | Effect |
|---|---|---|---|
| frame → host | `ready` | `surface` | Clears the ready clock; the host may now steer instead of reload |
| frame → host | `open-task` | `project`, `task` | Native board, panel on that task |
| frame → host | `open-surface` | `surface`, `project?`, `file?` | Switch tab (`tasks`/`board` = native board); a file opens Files at it |
| frame → host | `open-project` | `project` | The native page shows that project (no agent rebinding) |
| frame → host | `specify-closed` | `project?`, `task?` / `tasks[]` | Leave Specify; a created task opens on the board |
| host → frame | `context` | `surface`, `project`, `file?` | Move the loaded frame without a reload |

Both sides check `event.source` (the one owned iframe, respectively the parent window) *and*
`event.origin` (the configured dashboard origin, respectively the verified host origin), and post
with that exact origin as `targetOrigin`, never `'*'`. Every payload field is an identifier —
bounded, pattern-checked project names, task ids and workspace-relative paths without traversal —
never markup or a URL, so a compromised frame can at most select a project or task by name. A frame
that has not said `ready` is steered by re-pointing `src` instead (an older dashboard ignores
`context`), and after 8 seconds without `ready` the page shows a notice with a link to the full
dashboard instead of an empty box. The frame is created lazily, once, and hidden rather than
destroyed while the board is up.

### The attribution boundary

Where a write comes from decides who it is recorded against:

- **Native actions** go through the feature contract and carry the Gateway-verified principal under
  the service credential (ADR-0040): moves, edits, comments, archive and trash are recorded against
  the signed-in OpenClaw profile.
- **Framed writes** are the dashboard's own requests from inside the iframe, so they are attributed
  to the dashboard session the frame signed in with, not to the OpenClaw profile. ADR-0040 does not
  reach into the frame.

The same boundary explains the other framed limits: the frame keeps the dashboard's theme inside
the host theme, a hidden frame keeps its own polling, and a cross-site dashboard that signs in only
through Telegram cannot be embedded at all (a third-party frame gets no cookie, and the Telegram
gate cannot run there) — the host shows its ready-timeout notice. Loopback and same-site
dashboards work.

## The contract surface

Everything FlowBoard exposes through the Gateway, and the FlowBoard endpoint behind it. Queries
require `operator.read`, actions `operator.write`; every one of them relays the Gateway-verified
principal under the service credential (ADR-0040), and FlowBoard authorizes the write itself.

| Operation | Kind | Scope | FlowBoard endpoint |
|---|---|---|---|
| `ui.config` | query | `operator.read` | — (resolves the configured dashboard URL) |
| `projects.list` | query | `operator.read` | `GET /api/projects` |
| `status.get` | query | `operator.read` | `GET /api/status` |
| `tasks.list` | query | `operator.read` | `GET /api/projects/:project/tasks` |
| `task.get` | query | `operator.read` | `GET …/tasks/:id` + `…/comments` + `…/checkpoints` |
| `tasks.needing-me` | query | `operator.read` | `GET /api/tasks/stuck` + `GET …/tasks?status=review` |
| `status.set` | action | `operator.write` | `PUT /api/status` |
| `task.create` | action | `operator.write` | `POST /api/projects/:project/tasks` |
| `task.update` | action | `operator.write` | `PUT …/tasks/:id` |
| `task.comment` | action | `operator.write` | `POST …/tasks/:id/comment` |
| `task.trash` | action | `operator.write` | `PUT …/tasks/:id` (`trashedAt`) |
| `task.approve` | action | `operator.write` | `POST …/tasks/:id/approve` |
| `task.reject` | action | `operator.write` | `POST …/tasks/:id/reject` |
| `ui.focus` | action | `operator.write` | — (per-connection state in the Gateway) |

Four things about that table are decisions rather than mechanics:

- **`task.update` is additive, and the new actions are narrow (T-499).** Besides `status`,
  `workState` and `workStateDetails`, `task.update` accepts `title` (1–200), `description` (up to
  16384, the same bound `task.get` now returns, so an edit round-trips losslessly), `priority`,
  `tags` (bounded) and `order` (a number, or null to unrank). Archiving is `status: 'archived'`
  from done, unarchiving `status: 'done'`. `task.comment { project, id, message }` (1–2000
  characters) signs the comment with the Gateway principal, never with an author from the input.
  `task.trash { project, id, restore? }` sets or clears `trashedAt` with a timestamp made in the
  Gateway; hard delete, cascades and emptying the Trash are not exposed. `tasks.list` drops trashed
  tasks, and every action emits `tasks-changed`.
- **The write actions are thin on purpose.** `task.update` is the generic update path and is
  refused by FlowBoard for exactly the transitions that have their own endpoints — review → done
  goes through `task.approve` (ADR-0022). A status move carries no `actor`, so FlowBoard treats it
  as the trusted operator, exactly like a drag on the standalone board: moving a task another agent
  actively holds is allowed and, into review or done, releases that claim (ADR-0029). The Gateway
  does not pre-judge any of that; it relays FlowBoard's refusal, message and error code unchanged
  as a `{ ok: false, error, code }` result (T-504) — the feature SDK would otherwise report every
  refusal as "plugin session action failed".
- **Approve, reject and comment name the operator, and the browser cannot.** Those endpoints read
  the actor from their request *body*, not from the principal headers, so the plugin composes it in the
  Gateway process from the connection's host-attested profile (`<display name> (gateway:<profile
  id>)`, or `local:operator` for a CLI or token-only caller) and ignores anything the caller sent.
  A status move through `task.update` carries no actor field at all: on that path `actor` is a
  lease-ownership assertion, so sending one would refuse moves the dashboard itself allows.
- **`ui.focus` writes nothing to FlowBoard.** It records, per Gateway connection, which project a
  page is looking at, so the background poll watches that board and only that board. It is an
  action rather than a query because it mutates server-side state, and it is bounded: 64
  connections, at most 8 distinct boards watched, most recently focused first.

### No `tool:` declarations (T-498, T-499)

The contract operations are **not** exposed as agent tools, and `contracts.tools` in the generated
manifest stays empty. Agents keep using FlowBoard's REST API, which is the project rule and already
carries their identity. Declaring tools would change what the operator consents to when installing
or updating the plugin — the capability consent prompt and the release canary matrix (T-487-1) —
and that is a decision about the plugin's trust surface, not about the Kanban board. It is worth
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
  URL where the native page is unavailable. The `p.*` names were fixed in stage 1 so links created
  then keep working; the native board reads them (stage 2), and since T-499 `p.tab` and `p.file`
  can add a framed tab and a file. The standalone SPA still has no URL routing for a task, so the
  standalone dashboard URL opens FlowBoard without preselecting it.

## Compatibility

| Situation | What happens |
|---|---|
| Host < 2026.9.2 | The `controlUi` manifest field is additive and ignored; hook and standalone dashboard work normally |
| Host ≥ 2026.9.2, lab flag off (the default) | No sidebar entry. Plugin backend and standalone dashboard are unaffected |
| Host ≥ 2026.9.2, lab flag on | Native page appears; the framed Ideas/Files/Projects tabs additionally need `FLOWBOARD_FRAME_ANCESTORS` listing the Control UI origin |
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
- [Environment Variables](../reference/env-vars.md) — `FLOWBOARD_FRAME_ANCESTORS` and the rest
