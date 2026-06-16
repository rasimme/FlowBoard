# Telegram Mini App

## What it is

FlowBoard reachable from a phone as a Telegram Mini App: the same dashboard, opened inside Telegram, authenticated by Telegram's signed user data and served through a tunnel.

## Why it exists

The dashboard normally lives on `localhost`. To check the board on the go, it needs to be reachable remotely *and* safely identified — without FlowBoard building its own login/account system. Telegram already authenticates the user and can vouch for them cryptographically, so it doubles as the remote-access identity layer.

## How it works

- **Identity via HMAC:** when opened in Telegram, the client carries an `initData` payload that Telegram signs (HMAC-SHA256) with the bot's token. FlowBoard verifies that signature server-side and admits the request only if the embedded user-id is in `ALLOWED_USER_IDS` (see [Auth Model](auth-model.md), [ADR-0028](../adr/0028-auth-model-middleware.md)). A valid session is then carried by a JWT cookie.
- **Tunnel:** any tunnel works (Cloudflare Tunnel recommended; ngrok/Tailscale too) to expose the local service at a public URL; production refuses to boot with auth off.
- **Mobile shell:** the UI is the responsive dashboard ([Mobile & Touch](mobile-and-touch.md)) with light haptic feedback; opened outside Telegram, the Mini App URL shows an "open via Telegram" notice.

## Consequences

- Remote access requires explicit setup (bot token, `JWT_SECRET`, `ALLOWED_USER_IDS`, `DASHBOARD_ORIGIN`); a missing value fails closed.
- Identity is as strong as Telegram's signing — only Telegram can mint a valid `initData` for the bot — with no FlowBoard-side password store.

## Where the code lives

- `dashboard/server.js` — `initData` HMAC verification + the auth middleware.
- `dashboard/index.html` + mobile UI — the Mini App shell.
- Setup: README *Remote Access*; env contract in `docs/reference/env-vars.md`.
- Related: [ADR-0028](../adr/0028-auth-model-middleware.md).
