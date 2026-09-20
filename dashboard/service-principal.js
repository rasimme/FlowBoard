'use strict';

/**
 * T-487-7 / ADR-0040 — service-credential principal for the OpenClaw Gateway.
 *
 * The Gateway's FlowBoard plugin runs in another process on the same machine.
 * It authenticates with a shared service token and states, in headers, which
 * Gateway-verified operator profile it is acting for. The headers carry no
 * authority of their own: they are read **only** after the bearer token
 * matched and the peer was accepted, and they are dropped entirely otherwise.
 * That is the same rule ADR-0033 applies to body claims — the server decides
 * who is acting, the caller only describes it.
 *
 * Env parsing lives in server.js (the docs-drift test scans that file for
 * `process.env.*`); this module owns the rules and stays pure and testable.
 */

const crypto = require('crypto');

/** Below this a shared secret is guessable; a short token is ignored, not used. */
const MIN_SERVICE_TOKEN_LENGTH = 32;
const MAX_SERVICE_TOKEN_LENGTH = 512;

const MAX_PROFILE_ID = 128;
const MAX_DISPLAY_NAME = 128;
const MAX_AGENT_ID = 64;
const MAX_SESSION_KEY = 256;
const MAX_SCOPES = 16;
const MAX_SCOPE_LENGTH = 64;

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

const HEADER_PROFILE_ID = 'x-flowboard-gateway-profile-id';
const HEADER_PROFILE_NAME = 'x-flowboard-gateway-profile-name';
const HEADER_SCOPES = 'x-flowboard-gateway-scopes';
const HEADER_AGENT_ID = 'x-flowboard-gateway-agent-id';
const HEADER_SESSION_KEY = 'x-flowboard-gateway-session-key';

/**
 * Normalize the configured token.
 *
 * Returns `{ token, warning }`. A token that is set but too short is ignored
 * with a named warning rather than silently weakening the boundary — a short
 * secret that "works" is worse than none, because nobody looks again.
 */
function parseServiceToken(rawValue) {
  const candidate = typeof rawValue === 'string' ? rawValue.trim() : '';
  if (!candidate) return { token: null, warning: null };
  if (candidate.length < MIN_SERVICE_TOKEN_LENGTH) {
    return {
      token: null,
      warning:
        `⚠️  FLOWBOARD_SERVICE_TOKEN is shorter than ${MIN_SERVICE_TOKEN_LENGTH} characters and is IGNORED. ` +
        'Generate one with `openssl rand -hex 32`; the OpenClaw Gateway facade stays disabled until then.',
    };
  }
  if (candidate.length > MAX_SERVICE_TOKEN_LENGTH) {
    return {
      token: null,
      warning:
        `⚠️  FLOWBOARD_SERVICE_TOKEN is longer than ${MAX_SERVICE_TOKEN_LENGTH} characters and is IGNORED.`,
    };
  }
  return { token: candidate, warning: null };
}

/** Length-independent comparison; a mismatch must not leak where it differed. */
function timingSafeEqualString(left, right) {
  const a = Buffer.from(String(left), 'utf8');
  const b = Buffer.from(String(right), 'utf8');
  const digestA = crypto.createHash('sha256').update(a).digest();
  const digestB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(digestA, digestB) && a.length === b.length;
}

function readBearerToken(req) {
  const header = req?.headers?.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer[ ]+(\S+)$/.exec(header.trim());
  return match ? match[1] : null;
}

function remoteAddressOf(req) {
  return req?.ip || req?.connection?.remoteAddress || req?.socket?.remoteAddress || '';
}

function isLoopbackAddress(address) {
  return LOOPBACK_ADDRESSES.has(String(address || ''));
}

function boundedHeader(value, maxLength) {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim();
  if (!cleaned || cleaned.length > maxLength) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F]/.test(cleaned)) return null;
  return cleaned;
}

function parseScopes(value) {
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0 && scope.length <= MAX_SCOPE_LENGTH && /^[A-Za-z][A-Za-z0-9._-]*$/.test(scope))
    .slice(0, MAX_SCOPES);
}

/**
 * Resolve the service caller for one request.
 *
 * `{ ok: false, reason }` when the request is not a valid service call; the
 * caller then continues through the normal auth path with the headers ignored.
 */
function resolveServiceCaller(req, options = {}) {
  const expectedToken = typeof options.token === 'string' && options.token ? options.token : null;
  if (!expectedToken) return { ok: false, reason: 'not_configured' };

  const presented = readBearerToken(req);
  if (!presented) return { ok: false, reason: 'no_bearer' };
  if (!timingSafeEqualString(presented, expectedToken)) return { ok: false, reason: 'token_mismatch' };

  const allowRemote = options.allowRemote === true;
  if (!allowRemote && !isLoopbackAddress(remoteAddressOf(req))) {
    return { ok: false, reason: 'remote_not_allowed' };
  }
  // A tunnel marker means the request did not originate on this machine even
  // though cloudflared connects from loopback. Same fail-closed rule the
  // Telegram middleware applies (S-13).
  if (!allowRemote && req?.headers?.['cf-ray']) return { ok: false, reason: 'remote_not_allowed' };

  const headers = req?.headers || {};
  const profileId = boundedHeader(headers[HEADER_PROFILE_ID], MAX_PROFILE_ID);
  return {
    ok: true,
    caller: {
      source: 'openclaw-gateway',
      profileId,
      displayName: profileId ? boundedHeader(headers[HEADER_PROFILE_NAME], MAX_DISPLAY_NAME) : null,
      scopes: parseScopes(headers[HEADER_SCOPES]),
      agentId: boundedHeader(headers[HEADER_AGENT_ID], MAX_AGENT_ID),
      sessionKey: boundedHeader(headers[HEADER_SESSION_KEY], MAX_SESSION_KEY),
    },
  };
}

module.exports = {
  MIN_SERVICE_TOKEN_LENGTH,
  MAX_SERVICE_TOKEN_LENGTH,
  SERVICE_PRINCIPAL_HEADERS: {
    profileId: HEADER_PROFILE_ID,
    profileName: HEADER_PROFILE_NAME,
    scopes: HEADER_SCOPES,
    agentId: HEADER_AGENT_ID,
    sessionKey: HEADER_SESSION_KEY,
  },
  isLoopbackAddress,
  parseScopes,
  parseServiceToken,
  readBearerToken,
  resolveServiceCaller,
  timingSafeEqualString,
};
