'use strict';

/**
 * T-422-3 / T-422-5: host classification for the S-24 boot bind guard.
 *
 * The local-first trust model is "loopback == the operator". The boot guard
 * refuses to bind a NON-loopback interface while auth is disabled, so this
 * predicate must fail-closed: anything that is not unambiguously a loopback
 * address is treated as non-loopback (so the guard fires). That includes the
 * bind-all literals (0.0.0.0, ::), routable hosts, and an empty/whitespace
 * host — which Node binds to ALL interfaces, the opposite of loopback.
 */

const IPV4_LOOPBACK = /^127(\.\d{1,3}){1,3}$/;            // 127.0.0.0/8, incl. shorthand like 127.1
const IPV4_MAPPED_LOOPBACK = /^::ffff:127(\.\d{1,3}){1,3}$/; // IPv4-mapped IPv6 loopback

function isLoopbackHost(host) {
  if (typeof host !== 'string') return false;
  const h = host.trim().toLowerCase();
  if (h === '') return false; // empty/whitespace => Node binds all interfaces => NOT loopback
  if (h === 'localhost' || h === '::1') return true;
  if (IPV4_LOOPBACK.test(h)) return true;
  if (IPV4_MAPPED_LOOPBACK.test(h)) return true;
  return false;
}

// A loopback socket is not enough to establish that a request reached the
// dashboard directly. Reverse proxies and tunnels commonly connect to the
// local listener and preserve their routing metadata in headers. There is no
// reliable finite denylist for that metadata: for example, Envoy can use
// X-Envoy-External-Address, while another proxy can choose an entirely new
// X-* name. Sensitive local-only actions therefore use a positive allowlist of
// headers a browser (and FlowBoard's browser client) may normally send.
//
// This is intentionally an allowlist of names, not values. A header that is
// absent is harmless; an unknown header is enough to make provenance
// ambiguous, even when its value is empty or otherwise looks benign.
const DIRECT_SENSITIVE_EXPORT_ALLOWED_HEADERS = new Set([
  // HTTP/browser request headers.
  'accept',
  'accept-charset',
  'accept-encoding',
  'accept-language',
  'authorization',
  'cache-control',
  'connection',
  'content-length',
  'content-type',
  'cookie',
  'dnt',
  'host',
  'if-match',
  'if-modified-since',
  'if-none-match',
  'if-unmodified-since',
  'origin',
  'pragma',
  'priority',
  'range',
  'referer',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  'sec-gpc',
  'upgrade-insecure-requests',
  'user-agent',
  // FlowBoard browser-client headers. These are client metadata, not trust
  // signals; allowing them does not make either header proof of provenance.
  'x-flowboard-client',
  'x-requested-with',
  'x-telegram-init-data',
]);

function headerNames(headers) {
  if (!headers) return [];
  if (typeof headers.keys === 'function') return [...headers.keys()];
  return Object.keys(headers);
}

function hasDisallowedSensitiveRequestHeaders(headers) {
  return headerNames(headers).some((header) => {
    const name = String(header).trim().toLowerCase();
    return !DIRECT_SENSITIVE_EXPORT_ALLOWED_HEADERS.has(name);
  });
}

// Keep the old helper name for callers/tests that used the original
// denylist-era predicate. Its semantics are deliberately broader now: every
// header outside the strict direct-request allowlist is treated as possible
// forwarding/proxy metadata.
function hasForwardedOrTunnelHeaders(headers) {
  return hasDisallowedSensitiveRequestHeaders(headers);
}

function isDirectLoopbackRequest(req) {
  // Use the socket peer, never req.ip or forwarding headers. A proxy can make
  // a remote client appear local at the Express layer; sensitive export
  // recovery must be reachable only from a direct loopback connection.
  const socketAddress = req?.socket?.remoteAddress || req?.connection?.remoteAddress || '';
  return isLoopbackHost(socketAddress) && !hasForwardedOrTunnelHeaders(req?.headers);
}

module.exports = {
  DIRECT_SENSITIVE_EXPORT_ALLOWED_HEADERS,
  hasDisallowedSensitiveRequestHeaders,
  hasForwardedOrTunnelHeaders,
  isDirectLoopbackRequest,
  isLoopbackHost,
};
