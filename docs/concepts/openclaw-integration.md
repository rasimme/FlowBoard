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
| Native Control UI page | FlowBoard as a page in the Control UI sidebar | 2026.9.2 + lab flag | Lab flag, or disable the plugin |

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

### Native Control UI page — staged

A feature plugin ships a compiled browser bundle that the Control UI imports same-origin and mounts
as a real sidebar destination. Reached at `/plugin?plugin=flowboard&id=flowboard`. It is built in
stages so that each one is independently useful and independently revertible:

- **Stage 0 — frame the SPA.** The native page mounts the existing dashboard in the plugin's own
  iframe. The SPA is unchanged; the only FlowBoard-side requirement is `FLOWBOARD_FRAME_ANCESTORS`
  (T-487-10), which adds the Control UI origin to the CSP `frame-ancestors` directive and omits
  `X-Frame-Options`, since that header cannot express more than one allowed ancestor. This gets
  FlowBoard into the sidebar without touching the data layer.
- **Stages 1–3 — move the data layer onto the Gateway.** Native views replace framed ones, view by
  view: first read-only strips and widgets, then the Kanban with writes, then canvas, files and
  Specify. They talk to FlowBoard through plugin-owned feature-contract operations rather than
  through the browser, because the Control UI's `connect-src` policy does not allow the page to
  `fetch()` FlowBoard's own port. That indirection is not a workaround — it is what lets a native
  view carry the operator's verified identity into FlowBoard's attribution instead of relying on a
  cookie the frame may not even be allowed to send.

The iframe disappears when nothing depends on it, not before.

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

## Compatibility

| Situation | What happens |
|---|---|
| Host < 2026.9.2 | The `controlUi` manifest field is additive and ignored; hook and standalone dashboard work normally |
| Host ≥ 2026.9.2, lab flag off (the default) | No sidebar entry. Plugin backend and standalone dashboard are unaffected |
| Host ≥ 2026.9.2, lab flag on | Native page appears; stage-0 framing additionally needs `FLOWBOARD_FRAME_ANCESTORS` |
| Plugin disabled, or FlowBoard run without OpenClaw | Standalone dashboard only; external agents keep using REST |

`gateway.controlUi.experimental.customPlugins` is server-enforced, defaults to off, and needs a
Gateway restart. OpenClaw's plugin APIs are experimental, so FlowBoard pins and tests a host version
rather than assuming forward compatibility.

## Where this is decided

- [ADR-0037](../adr/0037-trusted-collaborators-and-native-control-ui.md) — trusted collaborators,
  the four identities, the scope mapping, and the obligations that come with unsandboxed native code.
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
