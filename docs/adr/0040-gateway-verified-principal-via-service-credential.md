# ADR-0040: Gateway-verified principal via a loopback service credential

## Status
Accepted (2026-09-20, T-487-7)

## Date
2026-09-20

## Source
- Task: **T-487-7** ("Implement scope-checked Gateway facade and FlowBoard adapter"), subtask of epic **T-487** (FlowBoard as a native OpenClaw Control UI surface). Builds on the T-487-4 spike.
- Code: `openclaw/contract.js`, `openclaw/adapter.js`, `openclaw/feature-entry.js` (loaded lazily by `openclaw/flowboard-plugin.js`), `dashboard/service-principal.js`, the service-caller middleware in `dashboard/server.js`, `governance.resolvePrincipal()`.
- Extends [ADR-0033](0033-server-authoritative-principal-and-specify-confirmation.md) (server-authoritative principal). Related: [ADR-0028](0028-auth-model-middleware.md) (auth middleware), [ADR-0029](0029-local-first-single-operator-security-boundary.md) (local-first boundary), [ADR-0003](0003-dashboard-has-no-agent-identity.md) (`agentId` is attribution, not identity), [ADR-0013](0013-x-openclaw-agent-id-header-dual-acceptance.md) (an existing descriptive header).
- The trust model that this decision instantiates, including the precedence order between a FlowBoard session and a Gateway credential, is stated in ADR-0037.

## Context
FlowBoard now runs as an OpenClaw *feature plugin*: a native Control UI page in
the Gateway calls contract operations, the plugin backend calls the FlowBoard
dashboard over loopback HTTP, and the dashboard does the work. That inserts a
second process between the human and the task record.

[ADR-0033](0033-server-authoritative-principal-and-specify-confirmation.md) says
FlowBoard resolves the principal itself and treats every caller-supplied
identity field as descriptive. FlowBoard's only verified human signal is
`req.user` from Telegram init-data or a FlowBoard JWT session. The Gateway
operator has neither: they are signed in to OpenClaw, not to FlowBoard.

Without a bridge, every write from the native UI collapses to the anonymous
loopback operator. The Gateway's own Control UI would be the *least*
attributable way to use FlowBoard, which is backwards — the Gateway knows
exactly who is signed in (`authenticatedUserProfile` on the connection).

Two constraints shaped the solution:

- **The Gateway's bearer token is not FlowBoard's to accept.** It authorizes
  the *Gateway's* API and is held by every connected operator surface.
  Forwarding it would make FlowBoard a second validator for a credential it
  cannot revoke, scope, or reason about.
- **The feature transport drops the profile.** A feature operation runs as a
  plugin session action, and that handler context carries only
  `client: { connId, scopes }` — not `connect.authenticatedUserProfile`
  (OpenClaw 2026.9.5: `dist/agent-harness-runtime-*.d.ts:4704-4714`,
  `dist/plugin-host-hooks-*.mjs:113-123`). A plugin Gateway *method* does
  receive the full client, so the profile must be captured there.

## Decision
FlowBoard accepts a **service credential** plus a **header-stated principal**,
and keeps deciding who is acting.

- **Credential.** `FLOWBOARD_SERVICE_TOKEN` (server) / the `serviceToken` plugin
  config (Gateway) is a shared secret of at least 32 characters. A token that
  is set but shorter is ignored with a named startup warning — a weak secret
  that appears to work is worse than none.
- **Peer.** A service call is accepted only from a loopback peer and without a
  tunnel marker (`cf-ray`). `FLOWBOARD_SERVICE_TOKEN_ALLOW_REMOTE=true` lifts
  that for a trusted TLS front-end and logs a loud warning.
- **Principal headers.** `X-FlowBoard-Gateway-Profile-Id`,
  `-Profile-Name`, `-Scopes`, `-Agent-Id`, `-Session-Key`. They are read **only**
  after the token matched and the peer was accepted; on any other request they
  are ignored completely, exactly like a body claim under ADR-0033. Each value
  is bounded and rejected if it carries control characters.
- **Resolution.** `governance.resolvePrincipal()` returns, in order: the
  FlowBoard Telegram/JWT human (unchanged — FlowBoard's own verification of
  *this* request wins); then, for a valid service caller, a verified human with
  `source: 'openclaw-gateway'`, `actor: gateway:<profileId>` when a profile id
  is present; otherwise the trusted `local:operator` principal. A Gateway call
  never invents a human.
- **Admission.** A valid service credential satisfies `/api/` auth on its own,
  including under `AUTH_ALWAYS=true`. Unlike the loopback bypass it is a
  credential the operator installed on both sides.
- **CSRF (S-06) is unchanged.** The Origin check still applies to every request
  that carries an Origin. A Node client sends none and holds no ambient cookie,
  so there is nothing for a hostile page to ride on; requiring an Origin would
  block non-browser callers without removing an attack.
- **Capture.** The plugin's `flowboard.ui.identity` Gateway method records the
  host-attested profile of the calling connection, keyed by `connId`, and the
  feature operations look it up. The browser triggers the capture; it never
  supplies the identity.
- **Older hosts are unaffected.** The whole facade lives in the feature layer
  the entry loads only when the host has the feature SDK (≥ 2026.9.2). On
  2026.6.6 / 2026.7.x FlowBoard stays hook-only, no credential is read, and the
  service token is inert — progressive enhancement per ADR-0037 rule 4.

## Consequences
- A task created from the native FlowBoard page carries
  `creationAudit.principal = { kind: 'human', verified: true, actor:
  'gateway:<profileId>', source: 'openclaw-gateway', displayName }`. The
  operator is answerable for it without a Telegram login.
- FlowBoard gains one credential to manage. It is per-installation, loopback-only
  by default, and revoked by changing one value on both sides. It does not
  replace or weaken the Telegram/JWT path, which still takes precedence.
- Scopes arrive as context, not as authorization. The Gateway already enforces
  `operator.read` / `operator.write` on the contract before the adapter runs;
  FlowBoard records what it was told and keeps authorizing with its own rules
  (ADR-0033, ADR-0035).
- The per-connection identity cache is a workaround for a host gap, not a
  design goal. If a future OpenClaw release carries the authenticated profile
  into the session-action context, the capture method and the cache are deleted
  and nothing else changes.
- **Rejected — forwarding the Gateway bearer token.** FlowBoard would have to
  validate a credential it does not own, cannot scope down, and cannot revoke,
  and every FlowBoard install would become a place where Gateway tokens are
  replayable.
- **Deferred — mTLS.** The right answer for a non-loopback deployment and
  strictly better than a shared secret, but it needs certificate issuance and
  rotation that FlowBoard's single-operator install story does not have yet.
- **Deferred — a Unix domain socket.** Removes the token entirely by making
  filesystem permissions the boundary. It is the preferred successor for
  same-host deployments; it needs a second listener and a Windows story.
