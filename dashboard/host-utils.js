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
// local listener and preserve their routing metadata in headers. Sensitive
// local-only actions must reject the presence of those markers altogether;
// their values are not useful for proving provenance and are easy to forge.
function hasForwardedOrTunnelHeaders(headers) {
  return Object.keys(headers || {}).some((header) => {
    const name = String(header).trim().toLowerCase();
    return name === 'forwarded'
      || name === 'via'
      || name === 'cdn-loop'
      || name === 'x-forwarded'
      || name.startsWith('x-forwarded-')
      || name.startsWith('cf-')
      || name.startsWith('cloudflare-')
      || name.startsWith('x-proxy-')
      || name.startsWith('proxy-')
      || name.startsWith('x-tunnel-')
      || name.startsWith('tunnel-')
      || name === 'x-real-ip'
      || name === 'true-client-ip'
      || name === 'x-client-ip'
      || name === 'fly-client-ip';
  });
}

function isDirectLoopbackRequest(req) {
  // Use the socket peer, never req.ip or forwarding headers. A proxy can make
  // a remote client appear local at the Express layer; sensitive export
  // recovery must be reachable only from a direct loopback connection.
  const socketAddress = req?.socket?.remoteAddress || req?.connection?.remoteAddress || '';
  return isLoopbackHost(socketAddress) && !hasForwardedOrTunnelHeaders(req?.headers);
}

module.exports = { hasForwardedOrTunnelHeaders, isDirectLoopbackRequest, isLoopbackHost };
