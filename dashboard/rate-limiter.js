'use strict';

const net = require('net');

/**
 * Simple in-memory rate limiter for auth endpoints (T-441-3).
 * Tracks requests per IP address with sliding window.
 * This is app-level defense; expect additional reverse-proxy rate limiting in production.
 */

const DEFAULT_WINDOW_MS = 60 * 1000; // 1 minute
const DEFAULT_MAX_REQUESTS = 60; // max 60 requests per minute per IP

class RateLimiter {
  constructor({
    windowMs = DEFAULT_WINDOW_MS,
    maxRequests = DEFAULT_MAX_REQUESTS,
    trustedProxyIps = [],
  } = {}) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    // Forwarded client addresses are only useful when the immediate socket
    // peer is an explicitly configured proxy/tunnel. An empty list is the
    // deliberate fail-safe: every request is keyed by its transport socket.
    this.trustedProxyIps = parseTrustedProxyIps(trustedProxyIps);
    this.requests = new Map(); // Map<ip, Array<timestamps>>

    // Cleanup old entries every 10 windows. Do not keep short-lived test
    // processes alive solely for maintenance of this in-memory limiter.
    this.cleanupInterval = setInterval(() => this.cleanup(), windowMs * 10);
    if (this.cleanupInterval.unref) this.cleanupInterval.unref();
  }

  getClientIp(req) {
    return getClientIp(req, this.trustedProxyIps);
  }

  check(req) {
    const ip = this.getClientIp(req);
    const now = Date.now();
    const windowStart = now - this.windowMs;

    if (!this.requests.has(ip)) {
      this.requests.set(ip, []);
    }

    const timestamps = this.requests.get(ip);
    // Remove timestamps outside the current window
    const validTimestamps = timestamps.filter(ts => ts > windowStart);
    this.requests.set(ip, validTimestamps);

    if (validTimestamps.length >= this.maxRequests) {
      const resetTime = Math.ceil((validTimestamps[0] + this.windowMs - now) / 1000);
      return {
        ok: false,
        status: 429,
        resetSeconds: resetTime,
        message: `Rate limit exceeded. Retry after ${resetTime} seconds.`,
      };
    }

    validTimestamps.push(now);
    return { ok: true };
  }

  cleanup() {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    for (const [ip, timestamps] of this.requests.entries()) {
      const valid = timestamps.filter(ts => ts > windowStart);
      if (valid.length === 0) {
        this.requests.delete(ip);
      } else {
        this.requests.set(ip, valid);
      }
    }
  }

  close() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}

function socketIp(req) {
  return req?.socket?.remoteAddress
    || req?.connection?.remoteAddress
    || req?.ip
    || 'unknown';
}

/**
 * Parse an IPv4/IPv6 address into a comparable integer representation.
 * IPv4-mapped IPv6 socket addresses are normalized to IPv4 so a configured
 * `127.0.0.1` also matches Node's `::ffff:127.0.0.1` representation.
 */
function parseIpAddress(rawValue) {
  if (typeof rawValue !== 'string') return null;
  let value = rawValue.trim();
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  if (!value || value.includes('%')) return null;

  const family = net.isIP(value);
  if (family === 4) {
    const octets = value.split('.').map(Number);
    if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
      return null;
    }
    return {
      family: 4,
      bits: 32,
      value: octets.reduce((result, octet) => (result << 8n) | BigInt(octet), 0n),
    };
  }
  if (family !== 6) return null;

  // Expand an IPv4 suffix before splitting IPv6 hextets.
  if (value.includes('.')) {
    const lastColon = value.lastIndexOf(':');
    const dotted = parseIpAddress(value.slice(lastColon + 1));
    if (!dotted || dotted.family !== 4) return null;
    const high = (dotted.value >> 16n).toString(16);
    const low = (dotted.value & 0xffffn).toString(16);
    value = `${value.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const halves = value.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':').filter(Boolean) : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':').filter(Boolean) : [];
  if (halves.length === 1 && left.length !== 8) return null;
  if (halves.length === 2 && left.length + right.length >= 8) return null;

  const hextets = halves.length === 2
    ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
    : left;
  if (hextets.length !== 8 || hextets.some(part => !/^[0-9a-f]{1,4}$/i.test(part))) return null;

  const valueAsBigInt = hextets.reduce(
    (result, part) => (result << 16n) | BigInt(parseInt(part, 16)),
    0n,
  );
  // Treat IPv4-mapped IPv6 values as the IPv4 address they represent. This
  // keeps loopback proxy configuration stable across Node/socket formats.
  if ((valueAsBigInt >> 32n) === 0xffffn) {
    return { family: 4, bits: 32, value: valueAsBigInt & 0xffffffffn };
  }
  return { family: 6, bits: 128, value: valueAsBigInt };
}

function parseTrustedProxyEntry(rawValue) {
  if (rawValue && typeof rawValue === 'object' && rawValue.value !== undefined) return rawValue;
  if (typeof rawValue !== 'string') return null;
  const value = rawValue.trim();
  if (!value) return null;

  const slash = value.indexOf('/');
  if (slash !== -1 && slash !== value.lastIndexOf('/')) return null;
  const address = slash === -1 ? value : value.slice(0, slash);
  const parsed = parseIpAddress(address);
  if (!parsed) return null;

  let prefixLength = parsed.bits;
  if (slash !== -1) {
    const prefix = Number(value.slice(slash + 1));
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > parsed.bits) return null;
    prefixLength = prefix;
  }
  return { ...parsed, prefixLength, source: value };
}

function trustedProxyValues(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  return value.split(',').map(entry => entry.trim()).filter(Boolean);
}

function parseTrustedProxyConfig(value) {
  const entries = [];
  const invalid = [];
  for (const rawValue of trustedProxyValues(value)) {
    const entry = parseTrustedProxyEntry(rawValue);
    if (entry) entries.push(entry);
    else invalid.push(typeof rawValue === 'string' ? rawValue : String(rawValue));
  }
  return { entries, invalid };
}

function parseTrustedProxyIps(value) {
  return parseTrustedProxyConfig(value).entries;
}

function ipMatchesTrustedProxy(socketAddress, trustedProxy) {
  const socket = parseIpAddress(socketAddress);
  if (!socket || !trustedProxy || socket.family !== trustedProxy.family) return false;
  const prefixLength = Number.isInteger(trustedProxy.prefixLength)
    ? trustedProxy.prefixLength
    : trustedProxy.bits;
  if (prefixLength === 0) return true;
  const shift = BigInt(socket.bits - prefixLength);
  return (socket.value >> shift) === (trustedProxy.value >> shift);
}

function headerString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isTrustedCloudflareRequestWithProxies(req, trustedProxyIps) {
  const headers = req?.headers || {};
  const cloudflareRay = headerString(headers['cf-ray']);
  const cloudflareIp = headerString(headers['cf-connecting-ip']);
  if (!cloudflareRay || !parseIpAddress(cloudflareIp)) return false;

  const socketAddress = req?.socket?.remoteAddress || req?.connection?.remoteAddress;
  if (!socketAddress) return false;
  const proxies = parseTrustedProxyIps(trustedProxyIps);
  return proxies.some(proxy => ipMatchesTrustedProxy(socketAddress, proxy));
}

function isTrustedCloudflareRequest(req, options = {}) {
  const trustedProxyIps = Array.isArray(options)
    ? options
    : options?.trustedProxyIps || [];
  return isTrustedCloudflareRequestWithProxies(req, trustedProxyIps);
}

function getClientIp(req, options = {}) {
  if (isTrustedCloudflareRequest(req, options)) {
    // The forwarded value was parsed above; return the original textual IP so
    // the limiter key stays readable in diagnostics and tests.
    return req.headers['cf-connecting-ip'].trim();
  }
  // Header values from direct/unconfigured requests are untrusted. In
  // particular, a forged cf-ray plus rotating cf-connecting-ip must remain on
  // the one transport-socket key instead of opening a new bucket per header.
  return socketIp(req);
}

module.exports = {
  RateLimiter,
  DEFAULT_WINDOW_MS,
  DEFAULT_MAX_REQUESTS,
  getClientIp,
  isTrustedCloudflareRequest,
  parseTrustedProxyIps,
  parseTrustedProxyConfig,
  socketIp,
};
