# ADR-0030: Multi-bot identities are ordered and fresh init-data rebinds sessions

## Status
Accepted

## Date
2026-08-17

## Source
Private FlowBoard spec `specs/T-441-multi-bot-telegram-auth-vollstndig-konfi.md`.

## Context

FlowBoard can verify Telegram Mini App init-data against more than one bot token,
but the old configuration treated the token list and agent-id list as loosely
related optional values. Empty entries were filtered, counts were not checked,
and duplicate or invalid agent IDs were accepted. That made a positional mapping
silently shift or disappear.

All bots use the same dashboard origin and therefore share the same
`flowboard_session` cookie. The middleware previously accepted that cookie before
looking at supplied init-data. Opening one correctly configured bot could thus
make another bot appear authenticated even when its fresh init-data was signed by
an unsupported token or had no agent mapping.

Telegram init-data is intentionally short-lived (five minutes), while the JWT
session lasts eight hours. FlowBoard must distinguish a fresh credential exchange
from steady-state requests after the original WebApp payload naturally ages.

## Decision

1. Model Telegram auth configuration as an ordered list of bot identities.
   Position 1 combines `TELEGRAM_BOT_TOKEN` with the first
   `FLOWBOARD_TELEGRAM_AGENT_IDS` entry; later positions combine
   `TELEGRAM_BOT_TOKENS` entries with later agent IDs.
2. Require exactly one unique, valid FlowBoard agent ID per configured token
   before auth can enable. Empty entries, duplicate tokens or agent IDs, missing
   primary tokens, invalid agent IDs, and count mismatches fail startup when the
   auth stack is otherwise configured (or an explicit mapping is malformed).
   A lone token may remain in an unfinished non-production local setup with auth
   disabled; production still fails closed. Diagnostics identify codes and
   positions but never include token values.
3. Treat supplied fresh init-data as authoritative over a JWT cookie. Successful
   verification issues or rebinds the cookie to the matched, server-confirmed
   agent ID.
4. Treat `POST /api/auth` as a strict credential exchange. Invalid,
   unsupported-bot, future-dated, or expired supplied init-data rejects and
   clears any existing session instead of falling back to it.
5. Allow non-auth API requests to use an existing valid cookie after otherwise
   valid init-data has merely aged beyond five minutes. This preserves the
   eight-hour session contract without weakening a fresh exchange.
6. Evaluate the HMAC against every configured token and return typed,
   secret-safe failures. Do not disclose token values or the matching token's
   secret material in responses or logs.

## Consequences

- Every configured bot can authenticate independently and returns a deterministic,
  server-confirmed agent ID.
- A cookie created through one bot cannot hide invalid fresh init-data from
  another bot on the same origin.
- Existing single-bot installations must add one
  `FLOWBOARD_TELEGRAM_AGENT_IDS` entry before the service will start with auth
  enabled for that token.
- Operators must preserve the order of all three environment-variable lists;
  startup validation catches structural ambiguity but cannot infer whether a
  syntactically valid agent ID was placed at the intended position.
- The strict `/api/auth` exchange can clear a previously valid cookie after an
  invalid Mini App launch. Reopening a correctly configured bot creates a new
  session.
- This hardens bot-to-agent attribution; it does not change ADR-0003's broader
  rule that agent IDs on local API actions are attribution rather than RBAC.
