'use strict';

/**
 * Simple in-memory rate limiter for auth endpoints (T-441-3).
 * Tracks requests per IP address with sliding window.
 * This is app-level defense; expect additional reverse-proxy rate limiting in production.
 */

const DEFAULT_WINDOW_MS = 60 * 1000; // 1 minute
const DEFAULT_MAX_REQUESTS = 60; // max 60 requests per minute per IP

class RateLimiter {
  constructor({ windowMs = DEFAULT_WINDOW_MS, maxRequests = DEFAULT_MAX_REQUESTS } = {}) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    this.requests = new Map(); // Map<ip, Array<timestamps>>

    // Cleanup old entries every 10 windows. Do not keep short-lived test
    // processes alive solely for maintenance of this in-memory limiter.
    this.cleanupInterval = setInterval(() => this.cleanup(), windowMs * 10);
    if (this.cleanupInterval.unref) this.cleanupInterval.unref();
  }

  getClientIp(req) {
    return getClientIp(req);
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

function isTrustedCloudflareRequest(req) {
  // cf-ray is the existing FlowBoard tunnel contract: cloudflared forwards it
  // from the Cloudflare edge, while direct requests have no tunnel marker.
  return typeof req?.headers?.['cf-ray'] === 'string'
    && req.headers['cf-ray'].trim().length > 0;
}

function socketIp(req) {
  return req?.socket?.remoteAddress
    || req?.connection?.remoteAddress
    || req?.ip
    || 'unknown';
}

function getClientIp(req) {
  if (isTrustedCloudflareRequest(req)) {
    const cloudflareIp = req.headers['cf-connecting-ip'];
    if (typeof cloudflareIp === 'string' && cloudflareIp.trim()) return cloudflareIp.trim();
  }
  // Do not let a client rotate cf-connecting-ip on a direct request to evade
  // the limiter. The transport-level socket address is the fallback key.
  return socketIp(req);
}

module.exports = {
  RateLimiter,
  DEFAULT_WINDOW_MS,
  DEFAULT_MAX_REQUESTS,
  getClientIp,
  isTrustedCloudflareRequest,
};
