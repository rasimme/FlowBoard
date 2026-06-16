# ADR-0028: Auth model — one `/api/` middleware gated on origin + credentials + config

## Status
Accepted (retroactive 2026-06-16, T-402-4)

## Date
2026-06-16

## Source
- Code: `dashboard/server.js` — the single `/api/` authentication middleware (origin / credential / config decision tree).
- Concept: `docs/concepts/auth-model.md`; env contract in `docs/reference/env-vars.md`.

## Context
FlowBoard exposes one REST surface used by local agents, the dashboard UI, and a Telegram Mini App reached over a tunnel. It must be frictionless on `localhost` (dogfooding) yet safe when exposed — without standing up a user database, a role model, or per-endpoint authorization.

## Decision
A single middleware on `/api/` decides each request — **block, pass, or require credentials** — from three signals:

- **Origin** — loopback (`127.0.0.1`/`::1`), Cloudflare tunnel (the `cf-ray` edge header), or LAN/other.
- **Credentials** — a valid Telegram `initData` HMAC (verified against the bot token; the embedded user-id must be in `ALLOWED_USER_IDS`) **or** a valid JWT cookie.
- **Config** — `AUTH_ENABLED`, `AUTH_ALWAYS`, `LOCAL_HOSTNAME`.

Loopback is trusted by default so unconfigured local use just works. Production (`NODE_ENV=production`) **fails closed**: the server refuses to boot with auth disabled. There is no user DB and no role model — once a request is admitted, every endpoint trusts the caller equally; `agentId` is attribution, not authorization (see [ADR-0003](0003-dashboard-has-no-agent-identity.md)).

## Consequences
- Local dogfooding needs zero auth setup; exposure requires explicit configuration, or the server won't start in production.
- Telegram init-data gives strong identity (only Telegram can sign for the bot) without FlowBoard running its own login UI.
- The security boundary is **origin + admission**, not per-endpoint authorization. Tunnel detection relies on the Cloudflare-specific `cf-ray` header; JWT cookies cannot be revoked except by rotating `JWT_SECRET`.
- This is the **foundation ADR** for the Auth Model surface; the full decision tree and operational gotchas live in `docs/concepts/auth-model.md`.
