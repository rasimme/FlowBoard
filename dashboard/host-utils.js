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

module.exports = { isLoopbackHost };
