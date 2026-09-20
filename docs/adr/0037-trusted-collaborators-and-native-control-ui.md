# ADR-0037: Trusted collaborators and a native Control UI that runs with operator authority

## Status

Accepted (2026-09-20, T-487-3)

## Date

2026-09-20

## Source

- Private spec `specs/T-487-make-flowboard-first-class-on-openclaw-2.md` (v3 — sections
  "Security boundaries", "Target architecture", "Spike findings that bind later stages") in the
  operator's local FlowBoard project, and the T-487-4 spike record it cites.
- OpenClaw documentation: [/plugins/feature-plugins](https://docs.openclaw.ai/plugins/feature-plugins),
  [/gateway/operator-scopes](https://docs.openclaw.ai/gateway/operator-scopes),
  [/concepts/multi-user](https://docs.openclaw.ai/concepts/multi-user).
- Amends the factual premise of [ADR-0029](0029-local-first-single-operator-security-boundary.md)
  and extends [ADR-0033](0033-server-authoritative-principal-and-specify-confirmation.md).
  Builds on [ADR-0003](0003-dashboard-has-no-agent-identity.md),
  [ADR-0013](0013-x-openclaw-agent-id-header-dual-acceptance.md),
  [ADR-0028](0028-auth-model-middleware.md), [ADR-0030](0030-multi-bot-identity-and-session-rebinding.md)
  and [ADR-0035](0035-task-form-not-authorization.md).
- Concept: [OpenClaw Integration](../concepts/openclaw-integration.md). Threat model: `SECURITY.md`.

## Context

[ADR-0029](0029-local-first-single-operator-security-boundary.md) declined a multi-user model on a
factual premise: the host OpenClaw was single-user by design, so there was *no second human
principal inside the product's model* to authorize against. Two host changes make that premise
partially false, and a third changes where FlowBoard's own code runs.

**1. The host grew durable human profiles.** Since OpenClaw 2026.8 a Gateway has durable profiles,
roles with a scope ceiling, and session owner/participant metadata. A second verified human can now
exist on the same Gateway. The host is explicit that this is *not* isolation:

> "Everyone who can operate an agent can make it do anything that agent can do. Session ownership,
> visibility in the sidebar, and presence indicators are usability features, not security
> boundaries." — [/concepts/multi-user](https://docs.openclaw.ai/concepts/multi-user)

So a Gateway is one trust domain with *several named, verifiable humans* in it — not a tenant
boundary. That is a real change for attribution and review, and no change at all for isolation.

**2. Feature plugins run plugin JavaScript inside the Control UI.** Since OpenClaw 2026.9.2 a
plugin may ship a compiled browser bundle that the Control UI imports same-origin:

> "Native UI runs trusted JavaScript in the Control UI origin. Install it only from authors you
> trust. Native modules share the signed-in operator's Gateway authority: `host.request` can call
> any method that connection's scopes allow, including administrative methods for administrators."
> — [/plugins/feature-plugins](https://docs.openclaw.ai/plugins/feature-plugins)

There is no iframe and no sandbox. Whatever FlowBoard ships in that bundle can do whatever the
signed-in operator can do. The surface is gated (`gateway.controlUi.experimental.customPlugins`,
default off, server-enforced) and the APIs are experimental, but the gate is an *install* decision,
not a runtime confinement.

**3. A registered scope is a requirement, not a narrowing.** The T-487-4 spike measured what a
plugin-registered Gateway method handler actually receives. Declaring `{ scope: 'operator.read' }`
means "the caller must hold at least this"; the handler still sees the operator's full connection —
for an administrator that includes `operator.admin`. `authenticatedUserProfile` is present only for
browser-originated calls; CLI and agent calls carry no profile and no browser origin. A Gateway
facade therefore cannot delegate authorization to the scope declaration.

FlowBoard must say plainly which deployments it supports, which identities it keeps apart, and what
the operator is trusting when they enable the native page.

## Decision

### 1. Two supported deployment modes; hostile multi-tenancy stays out of scope

- **Mode A — local single operator.** The [ADR-0029](0029-local-first-single-operator-security-boundary.md)
  baseline, unchanged: loopback is the operator, attribution is not authorization, the defences are
  accidental-damage invariants plus an audit log.
- **Mode B — trusted collaborators on one Gateway.** Several verified humans operate the same
  Gateway and therefore the same FlowBoard. They are colleagues, not adversaries: FlowBoard records
  *who did what* and can later apply project policy, but it does not pretend to isolate them from
  each other. It cannot, because the host does not.
- **Out of scope: hostile multi-tenancy.** One FlowBoard service and one FlowBoard state directory
  per Gateway trust domain. Separate organisations, separate clients, or any pair of humans who must
  not be able to read or damage each other's work get **separate Gateways with separate FlowBoards**.
  Nothing in this ADR should be read as a tenant boundary.

### 2. Four identities, kept apart

| Identity | Owner | What it means | What it never means |
|---|---|---|---|
| Human profile | OpenClaw Gateway | A verified person on this Gateway (profile id + display name) | Isolation from other profiles |
| Worker `agentId` | The caller | Attribution hint for automated work ([ADR-0013](0013-x-openclaw-agent-id-header-dual-acceptance.md), [ADR-0030](0030-multi-bot-identity-and-session-rebinding.md)) | An authenticated principal ([ADR-0003](0003-dashboard-has-no-agent-identity.md)) |
| Session owner / `sessionKey` | OpenClaw Gateway | Context: which conversation the work came from | Authorization of any kind |
| FlowBoard project role | FlowBoard | Future FlowBoard-side policy about a project | A host concept; the Gateway knows nothing about it |

**Attribution precedence** — the server picks the most strongly verified signal available and
records it, highest first:

1. Gateway-verified human profile (relayed by the plugin adapter, rule 5),
2. Telegram init-data / JWT-verified human ([ADR-0033](0033-server-authoritative-principal-and-specify-confirmation.md)),
3. trusted operator (loopback admission, [ADR-0028](0028-auth-model-middleware.md)),
4. agent hint (`agentId`), which is descriptive only.

Browser-supplied identity headers are **never** authoritative. A principal is only ever established
by something the FlowBoard server itself verified: an HMAC, its own signature, the transport it
trusts, or a service credential it issued.

### 3. Scope mapping — Gateway scopes are a ceiling, not FlowBoard's authorization

| FlowBoard operation | Required Gateway scope | Plus |
|---|---|---|
| Reads (projects, tasks, files, bootstrap) | `operator.read` | — |
| FlowBoard mutations, including FlowBoard review decisions (approve/reject) | `operator.write` | FlowBoard policy, server-side |
| Administration (service configuration, destructive maintenance) | `operator.admin` | FlowBoard policy, server-side |
| Genuine OpenClaw approvals | `operator.approvals` | never used as a stand-in for a FlowBoard decision |

A FlowBoard "review" is a FlowBoard state transition, not an OpenClaw exec/plugin approval. Mapping
it to `operator.approvals` would borrow authority from an unrelated subsystem, so it maps to
`operator.write` and is then decided by FlowBoard.

Because a declared scope is a requirement and not a narrowing (Context 3), the scope check only
proves the *connection* was allowed to reach FlowBoard at all. **Every FlowBoard authorization
decision stays server-side inside FlowBoard and is independent of the Gateway's answer.**
[ADR-0035](0035-task-form-not-authorization.md) is unchanged: task-shape checks remain form checks,
not authorization, and nothing here turns `structureReview` into a permission.

### 4. The native Control UI bundle is trusted code — the obligations that follow

FlowBoard's browser bundle runs unsandboxed in the Control UI origin with the signed-in operator's
Gateway authority. FlowBoard accepts that and takes on the obligations that make it defensible:

- **No third-party scripts and no remote code loading.** The bundle loads nothing at runtime from a
  CDN or any other origin — no remote fonts, no analytics, no dynamic `import()` of a URL that is
  not a plugin asset served by the connected Gateway. Fonts and images are inlined.
- **Pinned, lock-filed dependencies.** Every dependency that reaches the bundle is pinned and
  covered by the committed lockfile. Bundle content is reproducible, and the Gateway addresses each
  build by a content-hash revision, so a published revision is a fixed artefact.
- **Built from the reviewed repository only.** The bundle is produced from tagged FlowBoard source
  by the documented build, never assembled on the operator's machine from unreviewed inputs.
- **Two kill switches, both outside FlowBoard's control.** The operator can turn off the Gateway lab
  flag (`gateway.controlUi.experimental.customPlugins: false`) or disable the plugin entirely.
  Either one removes the native page.
- **Progressive enhancement.** The native page requires host ≥ 2026.9.2 and the lab flag. The
  `agent:bootstrap` hook and the standalone dashboard remain the baseline and keep working on older
  hosts, with the lab off, and when the bundle fails to activate.
- **Residual risk, stated honestly.** These are supply-chain and review commitments, not a
  technical confinement. A malicious FlowBoard release, or a compromise of the release pipeline,
  would execute with the operator's full Gateway authority. The operator's real protection is that
  the code is open, the build is reproducible, the surface is off by default, and both kill switches
  are theirs. Anyone who does not want to extend that trust should run FlowBoard standalone.

### 5. Principal sources for FlowBoard's server, and the new Gateway-relay contract

FlowBoard's server accepts three sources for a principal:

1. Telegram init-data / JWT session ([ADR-0033](0033-server-authoritative-principal-and-specify-confirmation.md)) — unchanged.
2. Trusted operator via loopback admission ([ADR-0028](0028-auth-model-middleware.md)) — unchanged.
3. **New:** a Gateway-verified human profile, relayed over loopback by the FlowBoard plugin adapter
   under a service credential.

The relay contract — the wire shape T-487-7 implements and ADR-0040 specifies in full:

- **Transport.** Loopback only. Remote use requires the explicit opt-in
  `FLOWBOARD_SERVICE_TOKEN_ALLOW_REMOTE=true`; without it a non-loopback caller is rejected even
  with a valid token.
- **Credential.** `Authorization: Bearer <FLOWBOARD_SERVICE_TOKEN>`, minimum 32 characters,
  compared in constant time. The token authenticates the *adapter*, not the human.
- **Relayed headers**, meaningful only on a request that already carries a valid service token:

  | Header | Meaning |
  |---|---|
  | `X-FlowBoard-Gateway-Profile-Id` | Gateway profile id of the verified human |
  | `X-FlowBoard-Gateway-Profile-Name` | Display name, for attribution text only |
  | `X-FlowBoard-Gateway-Scopes` | Comma-separated operator scopes of that connection |
  | `X-FlowBoard-Gateway-Agent-Id` | Optional worker hint |
  | `X-FlowBoard-Gateway-Session-Key` | Optional session context |

- **Resolution.** With a valid service token and a profile id present, the principal is `human` with
  source `openclaw-gateway`. With a valid service token and no profile id (a CLI or agent call,
  which carries no profile), the principal is a trusted `operator`.
- **Without a valid service token every one of these headers is ignored**, exactly as any other
  caller-supplied identity field is ignored today. They are never read from a browser request, and
  the service token is never sent to a browser.

### 6. Threat model and residual risk

| Threat | Mitigation | Residual risk |
|---|---|---|
| Malicious or compromised plugin update | Open source; pinned, lock-filed dependencies; reproducible content-hash bundle built from tagged source; publishing requires the maintainer's release path; operator consents to plugin install and update | Full operator Gateway authority if the release pipeline itself is compromised. No sandbox exists to fall back on |
| Stolen service token | Loopback-only by default; ≥ 32 chars; constant-time compare; never in the browser bundle, URLs, DOM or logs; rotatable by restart | A local process running as the same OS user can read the environment and impersonate the adapter — the OS boundary, per ADR-0029 |
| XSS in the native page | No third-party scripts, no remote code, no `dangerouslySetInnerHTML`; FlowBoard content is rendered through the existing allowlisted Markdown path; Control UI CSP applies | Injected script in the Control UI origin inherits the operator's Gateway authority; there is no origin boundary left to contain it |
| Confused deputy via agent-supplied identity headers | Relay headers are honoured only behind a valid service token; browser-supplied identity is never authoritative; precedence in rule 2 is server-side | An agent that already holds the service token is the adapter by definition |
| Co-hosting untrusted services on the Gateway hostname | Documented posture: the Gateway hostname is single-purpose. Cookies are scoped by hostname, not port, so a different service on another port of the same host shares the cookie boundary | An operator who ignores this can leak or receive cookies across ports; FlowBoard cannot detect it |
| Untrusted collaborator on a shared Gateway | Out of scope by rule 1 — separate Gateways. FlowBoard records attribution and audits destructive actions | Anyone who can operate the Gateway can operate FlowBoard through it. Attribution is evidence after the fact, not prevention |

## Consequences

- **[ADR-0029](0029-local-first-single-operator-security-boundary.md) is amended, not replaced.** Its
  factual premise — "no second human principal inside the product's model" — no longer holds on a
  Gateway with several verified profiles, so that premise is superseded in part. Its *decision*
  stands: FlowBoard still does not build RBAC, tenants or capability tiers, and the local
  single-operator mode is exactly as it was. What changes is that FlowBoard can now record a
  verified human where one exists, instead of having none to record.
- **[ADR-0033](0033-server-authoritative-principal-and-specify-confirmation.md) is extended by one
  source.** Its rule is unchanged and reinforced: the server decides who is acting. The
  Gateway-verified profile becomes a third way for the server to establish a human principal, on top
  of Telegram init-data and the JWT session, and it is authoritative for the same reason those are —
  FlowBoard verified something itself, in this case the service credential of the adapter it issued
  the token to.
- **[ADR-0035](0035-task-form-not-authorization.md) is unchanged.** Task bodies remain form, not
  authorization; scopes and profiles change who is *recorded*, not what shape a task must have.
- **The trust bar for the project rises.** Shipping unsandboxed browser code into someone else's
  Control UI is a different promise than shipping a local Express service. The obligations in rule 4
  are now release obligations, and `SECURITY.md` states the boundary plainly for the ClawHub audit
  and for operators.
- **Detailed contracts land elsewhere on purpose.** Session-scoped project binding is
  **ADR-0039**; the full Gateway-verified-principal mechanism, including error codes and the adapter's
  own boundaries, is **ADR-0040**. This ADR fixes the trust model those two implement.
- **Nothing here weakens the standalone deployment.** FlowBoard without OpenClaw, and FlowBoard on a
  host older than 2026.9.2, keep exactly the ADR-0029 posture.
