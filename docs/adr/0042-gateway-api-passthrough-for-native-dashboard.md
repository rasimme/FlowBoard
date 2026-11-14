# ADR-0042: Gateway API passthrough for the native React dashboard

## Status
Accepted (2026-11-14, T-515-1)

## Date
2026-11-14

## Source
- Task: **T-515-1** ("Gateway transport for the React API client, with path allow-list and ADR"), subtask of **T-515** (run the React dashboard natively in the OpenClaw Control UI). Builds on the T-514 spike.
- Code: `openclaw/api-passthrough.js`, `passthrough()` in `openclaw/adapter.js`, the two method registrations in `openclaw/feature-entry.js`, `openclaw/native-ui/gateway-transport.js`, `setApiTransport()` in `dashboard/src/utils/apiFetch.js`, `dashboard/test-api-passthrough.js`.
- Extends [ADR-0040](0040-gateway-verified-principal-via-service-credential.md). Trust model: [ADR-0037](0037-trusted-collaborators-and-native-control-ui.md).

## Context
The native Control UI page is to run the same React client as the standalone
dashboard. That client speaks the dashboard's REST API. Inside the Control UI
it cannot: the host's CSP blocks requests to the dashboard port, and the
dashboard does not accept the Control UI origin. Every call therefore has to
travel through the Gateway.

The existing feature contract exposes one typed operation per board action.
The React client uses about 80 endpoints, and the host bounds every feature
operation in both directions (measured on OpenClaw 2026.10.9: 64 KiB per
string, 256 KiB per payload, 4096 nodes). A task list of a real project is
several megabytes, so even a generic feature operation cannot carry it.

Raw Gateway methods (`api.registerGatewayMethod`) do not have that bound. The
host checks the operator scope and passes the params through; it does not
validate them against a schema.

## Decision
1. **Two raw Gateway methods replay dashboard-client requests.**
   `flowboard.api.read` (`operator.read`) can only issue `GET`.
   `flowboard.api.write` (`operator.write`) issues `POST`, `PUT` or `DELETE`.
   Both require a profile-bearing connection (`profileAccess: 'required'`).
2. **FlowBoard owns the validation the host does not do.** A request is
   forwarded only if its method and canonical pathname match an explicit rule
   in `openclaw/api-passthrough.js`. Paths with dot segments, encoded
   separators, backslashes, control characters, fragments or a foreign origin
   are refused before matching. The query string is forwarded, never matched.
3. **The list is what the dashboard client calls, not what the API offers.**
   Excluded on purpose: self-update, dashboard sign-in, webhooks, agent-row
   deletion, agent context and workflow endpoints, repair endpoints. A test
   requires every endpoint in `docs/reference/api-manifest.json` to be either
   forwarded or named in an exclusion list with a reason.
4. **Identity is never caller-supplied.** The adapter adds the service
   credential and the `X-FlowBoard-Gateway-*` headers from the Gateway
   connection, as in ADR-0040. From the caller it accepts only path, method,
   a string body, one of two content types, the sensitive-data confirmation
   and `If-None-Match`.
5. **Both directions are bounded.** Request and response bodies are capped at
   16 MiB, paths at 2048 characters, reads at 15 s and writes at 30 s. Only
   `content-type`, `etag`, `retry-after` and `content-disposition` are
   returned to the browser.
6. **The client gets one seam.** `setApiTransport()` replaces the network call
   inside `apiFetch`; deadlines, auth classification and error mapping stay in
   the client. Status and body are returned verbatim, so FlowBoard's own
   refusals reach the UI unchanged. The standalone dashboard never sets a
   transport and behaves as before.

## Alternatives considered
- **One typed feature operation per endpoint.** Validated by the host, but
  about 80 operations to mirror and maintain, and still subject to the 256 KiB
  bound.
- **A generic feature operation.** Built in the spike; a 309-task board did
  not load and exports failed at the host's payload bound.
- **A plugin HTTP route as a reverse proxy.** Keeps HTTP semantics, but
  Gateway-authenticated plugin routes grant browser access for `GET`/`HEAD`
  only; writes would need a second mechanism.
- **Direct browser access with CORS on the dashboard.** Requires the dashboard
  to trust the Control UI origin and the host CSP to allow the port. It also
  bypasses the Gateway profile, so writes lose their attribution.

## Consequences
- A new endpoint used by the React client needs an allow-list rule, or the
  native page gets `403 GATEWAY_PATH_NOT_ALLOWED`. The manifest test makes the
  decision explicit for every new endpoint.
- An operator with `operator.write` on the Gateway can perform every forwarded
  write. This matches ADR-0037: one Gateway is one trust domain. FlowBoard's
  own rules (review gate, ownership, confirmations) still apply, because the
  dashboard evaluates the request as usual.
- The passthrough depends on a host API that is not schema-checked and may
  change between releases. It is covered by the host matrix.
- Payloads above 16 MiB are refused. The largest measured transfer on
  2026.10.9 was 5.1 MB; the host's own upper bound has not been measured.
- The typed feature operations stay until the vanilla Control UI is removed
  (T-515-7).

## See also
- [ADR-0029](0029-local-first-single-operator-security-boundary.md) — local-first, single operator
- [ADR-0033](0033-server-authoritative-principal-and-specify-confirmation.md) — server-authoritative principal
