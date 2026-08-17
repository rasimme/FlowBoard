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
    
    // Cleanup old entries every 10 windows
    setInterval(() => this.cleanup(), windowMs * 10);
  }

  getClientIp(req) {
    // Trust CF-Connecting-IP from reverse proxy if present, otherwise use req.ip
    return req.headers['cf-connecting-ip'] || req.ip || '127.0.0.1';
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
}

module.exports = { RateLimiter, DEFAULT_WINDOW_MS, DEFAULT_MAX_REQUESTS };
