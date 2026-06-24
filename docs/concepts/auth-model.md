# Auth Model

## What

FlowBoard's auth model is a single middleware on `/api/` that decides per-request: *block, pass, or require credentials*. The decision uses three signals — request origin (loopback / Cloudflare-tunnel / LAN), credentials presented (Telegram init-data or JWT cookie), and configuration state (`AUTH_ENABLED`, `AUTH_ALWAYS`, `LOCAL_HOSTNAME`). There is no user database, no role model, no per-endpoint authorization. Once a request is admitted, every endpoint trusts the caller equally.

The model is designed for a *personal coordination tool* — one operator (the human), zero or more bot tokens (Telegram), zero or more agent identities (per ADR-0003) — running on a single machine, optionally exposed via a Cloudflare Tunnel for mobile access.

## Why

Auth on FlowBoard solves three problems with three different mechanisms, by design.

**Local development should work without ceremony.** Setting up Telegram bots, JWT secrets, and allowed user lists just to poke the API on `localhost` is hostile to dogfooding. The default fail-closed behavior allows `127.0.0.1` requests through unauthenticated when auth is unconfigured. In production (`NODE_ENV=production`) this fails the boot — you cannot start the server in production with auth off.

**Mobile access via Telegram Mini App needs identity.** The dashboard works as a Telegram Mini App: the user opens it inside Telegram, Telegram embeds an HMAC-signed `initData` payload, FlowBoard verifies the HMAC against the bot's secret token and admits the request if the embedded user-id is in `ALLOWED_USER_IDS`. This gives strong identity proof — only Telegram can produce a valid HMAC for a given bot — without FlowBoard running its own auth UI.

**External agents trust each other inside the local operator boundary.** Agents on
the same machine talking to each other (the project-context hook, cron sweepers,
CLI tools) all hit `localhost` and need no credentials. Trust-on-write of the
`agentId` field is acceptable only in this single-operator deployment model —
see ADR-0003 for the explicit reasoning.

The system is *not* designed for multi-tenant deployment, untrusted networks, or hostile environments. It is appropriate for a single operator's machine plus a Cloudflare Tunnel.

## How

The middleware on `/api/` runs this decision tree in order:

```
incoming request to /api/<path>
  │
  ├─ path is /api/health or /api/info?
  │     yes → pass (public discovery endpoints)
  │
  ├─ has 'cf-ray' header? (set by Cloudflare edge — request came via tunnel)
  │     yes:
  │        ├─ AUTH_ENABLED?
  │        │     no  → 403 (tunnel access without auth is forbidden)
  │        │     yes → require valid JWT cookie OR valid Telegram init-data
  │        │            (success → set cookie, pass)
  │
  ├─ AUTH_ENABLED is false?
  │     yes:
  │        ├─ source IP is loopback (127.0.0.1, ::1)?
  │        │     yes → pass (local dev access)
  │        │     no  → 403
  │
  ├─ AUTH_ENABLED is true, AUTH_ALWAYS is false:
  │     ├─ source IP is loopback?
  │     │     yes → pass (local ops access)
  │     ├─ LOCAL_HOSTNAME bypass:
  │     │   request Host header equals LOCAL_HOSTNAME AND
  │     │   source IP is in private range (192.168.x, 10.x, loopback)?
  │     │     yes → pass (LAN access via friendly hostname)
  │
  └─ require valid JWT cookie OR valid Telegram init-data
       (success → set cookie, pass)
       (failure → 403)
```

**Three credential paths.**

The first two are pre-decided by environment variables: a request that passes the IP/origin checks is admitted with no credentials. The third path is the credential path itself.

1. **JWT cookie (`flowboard_session`).** Once a request has authenticated, the response sets an `httpOnly`, `secure`, `sameSite=none` cookie with an 8-hour JWT. Subsequent requests with the cookie skip the Telegram check entirely. This is the steady-state path for the Mini App after first load.

2. **Telegram init-data.** First request from a fresh Mini App session sends `x-telegram-init-data` header — Telegram's signed user payload. The middleware HMAC-verifies it against every configured bot token (S-01 timing-safe), checks the `auth_date` is within 5 minutes, parses the `user` payload, and rejects if the user id is not in `ALLOWED_USER_IDS`. On success, a cookie is issued.

3. **Hooks token** for `POST /api/hooks/task-complete`. Distinct from user auth — a server-side shared secret in `x-hooks-token` header (`OPENCLAW_HOOKS_TOKEN`). Used by HZL's hook drain service to call back into FlowBoard. Not part of the user middleware.

**`AUTH_ENABLED` is a derived flag.** It is true if and only if all three of `TELEGRAM_BOT_TOKEN(S)`, `JWT_SECRET` (≥ 32 chars), and `ALLOWED_USER_IDS` are set. Setting only one or two does not partially enable auth — you have all three or none. The 32-char minimum on `JWT_SECRET` is enforced at boot (S-03); a weaker secret fails the process startup.

**`AUTH_ALWAYS` overrides the loopback bypass.** Default false: loopback always passes. Setting `AUTH_ALWAYS=true` removes the loopback shortcut so even local requests must authenticate. Use case: exposing the dashboard via a non-Cloudflare tunnel where the operator wants every request authenticated.

**`LOCAL_HOSTNAME` enables LAN bypass.** Setting `LOCAL_HOSTNAME=flowboard.lan` allows requests where `Host: flowboard.lan` is sent *and* the source IP is in `192.168.0.0/16`, `10.0.0.0/8`, or loopback. This is a deliberately narrow bypass for trusted home-LAN access via a friendly hostname. **Only effective when the server binds `0.0.0.0`** — the default `FLOWBOARD_HOST=127.0.0.1` makes the bypass unreachable from LAN clients.

**Cloudflare Tunnel detection is via `cf-ray`.** The tunnel client (`cloudflared`) connects from `127.0.0.1`, so source IP cannot distinguish "local" from "tunneled-in." Cloudflare's edge sets `cf-ray` on every request it forwards; absence of `cf-ray` proves the request did not transit Cloudflare. The middleware uses `cf-ray` presence to flip from "loopback bypass eligible" to "must authenticate."

**Failed auth is logged.** Every failed credential check writes a warning line with `cf-connecting-ip` (or `req.ip`) and timestamp. There is no automatic rate-limit, no exponential backoff, no IP block. Express-rate-limit middleware is configured globally on `/api/` for general DOS protection but does not specifically target auth failures.

## Consequences

- **Localhost is trusted by default.** A process running on the same machine as the dashboard can hit any endpoint without credentials. The project-context hook, cron jobs, and ad-hoc `curl` from the terminal all rely on this. The trade-off is that any local process — *any* — can act as any agent. This is acceptable for a single-operator machine and would not be acceptable for multi-tenant.
- **`agentId` is attribution, not identity.** Auth admits the request; the
  `agentId` in request bodies, headers, and query parameters routes per-agent
  state and records *who the caller says is doing what*. There is no check that
  an authenticated user is allowed to act as `agentId=X`. ADR-0003 documents
  this explicitly. This is an accepted local-first trade-off, not a
  cryptographic identity boundary; remote/multi-user deployments should use
  `AUTH_ALWAYS=true`, keep the server loopback-bound behind an authenticated
  tunnel, and treat full agent-identity binding as future hardening.
- **External access without Telegram is hard.** The Mini App is the *only* supported client identity outside of loopback. CLI tools running on a different machine can use the API only via Cloudflare Tunnel + a valid Telegram init-data once (then cookie-based). There is no API key, no service account, no per-tool credential.
- **JWT cookies cannot be revoked.** Once issued, an 8-hour JWT is valid until expiry. There is no allowlist check on cookie validation — only signature + expiry. Removing a Telegram user id from `ALLOWED_USER_IDS` does not invalidate their existing cookies. Workaround: rotate `JWT_SECRET`, which invalidates *every* outstanding cookie.
- **Auth-disabled is a hard production failure.** Booting in `NODE_ENV=production` without a fully-configured auth stack exits the process. This is the right safety net but means production environments must always have all three vars set, even on a single-user deployment.
- **Cloudflare Tunnel is the canonical remote-access path.** The middleware's tunnel-detection (`cf-ray`) is hard-coded; using a different reverse proxy (ngrok, Tailscale Funnel, vanilla nginx) means the proxy must inject `cf-ray` to be treated as external, or the operator must use `AUTH_ALWAYS=true` to force authentication on every path.
- **Hooks-token endpoint is a separate trust boundary.** `POST /api/hooks/task-complete` does *not* go through `telegramAuthMiddleware`. It validates `OPENCLAW_HOOKS_TOKEN` independently with a timing-safe comparison. This separation is intentional — the hook drain service has no Telegram identity and shouldn't need one.

## Code

- `dashboard/server.js` lines 55–204 — the entire auth surface: env-var parsing, `validateTelegramWebApp()`, `telegramAuthMiddleware()`, the `/api/` middleware mount.
- `dashboard/server.js` line 640 — `POST /api/auth` endpoint (explicit credential exchange path).
- `dashboard/server.js` line 2228 — `POST /api/hooks/task-complete` and its independent token check.
- `templates/dashboard.service` — example systemd unit; expects auth env vars set per operator.
- `~/.openclaw/credentials/` (per ADR-0003 / convention) — where bot tokens live on the operator's machine.

## See also

- [Agent Identity](agent-identity.md) — `agentId` is attribution within the auth boundary, not the auth boundary itself. Note that while *which* agent-id a local caller asserts is trust-on-write, **lease ownership of lifecycle operations is enforced server-side** (`NOT_OWNER` / `ALREADY_CLAIMED`): asserting another agent's id does not let a caller override that agent's active claim.
- [ADR-0003](../adr/0003-dashboard-has-no-agent-identity.md) — the dashboard's no-identity decision is what makes trust-on-write of `agentId` acceptable here
- [Environment Variables](../reference/env-vars.md#authentication) — the auth-related env vars in one table
