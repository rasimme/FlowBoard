'use strict';

/**
 * High-confidence, value-blind credential scanner for review bundles.
 *
 * This module intentionally returns only stable finding codes and line
 * numbers. It never returns a match, source snippet or captured value, so a
 * caller can safely use a finding in an export warning or server log.
 */

const RULES = Object.freeze([
  {
    code: 'PEM_PRIVATE_KEY',
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]{20,}?-----END [A-Z0-9 ]*PRIVATE KEY-----/m,
  },
  {
    code: 'BEARER_TOKEN',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/i,
  },
  {
    code: 'JWT',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
  {
    code: 'OPENAI_STYLE_TOKEN',
    // Modern OpenAI/Anthropic keys carry a provider marker and may use either
    // hyphens or underscores in the value. Keep the minimum long enough that
    // documentation prose such as "sk-proj-token format" remains harmless.
    pattern: /\bsk-(?:(?:proj|ant)[-_][A-Za-z0-9][A-Za-z0-9_-]{20,}|[A-Za-z0-9]{16,})\b/,
  },
  {
    code: 'GITHUB_TOKEN',
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  },
  {
    code: 'TELEGRAM_BOT_TOKEN',
    pattern: /\b\d{5,12}:[A-Za-z0-9_-]{20,}\b/,
  },
  {
    code: 'COMMON_API_TOKEN',
    pattern: /\b(?:AIza)[A-Za-z0-9_-]{20,}\b|\bAKIA[0-9A-Z]{16}\b|\b(?:xoxb|xoxp)-[A-Za-z0-9-]{20,}\b|\bnpm_[A-Za-z0-9]{20,}\b|\bpypi-[A-Za-z0-9_-]{20,}\b/,
  },
  {
    code: 'URL_CREDENTIALS',
    pattern: /https?:\/\/[^\s/@:]+:[^\s/@]+@/i,
  },
  {
    code: 'CREDENTIAL_ASSIGNMENT',
    // Deliberately require a long non-placeholder value. This keeps prose
    // such as "token handling" and examples like "token: <redacted>" safe.
    pattern: /\b(?:api[_-]?key|access[_-]?key|auth[_-]?token|client[_-]?secret|password|passwd|pwd|private[_-]?key|secret|token)\b\s*[:=]\s*["']?(?!redacted\b|replace(?:[-_ ]?me)?\b|example\b|changeme\b|placeholder\b)[A-Za-z0-9_./+=:-]{20,}/i,
  },
]);

function lineNumber(value, index) {
  return String(value).slice(0, index).split('\n').length;
}

function scanSensitiveContent(value) {
  if (value === null || value === undefined) return [];
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (typeof text !== 'string' || text.length === 0) return [];
  const findings = [];
  for (const rule of RULES) {
    const match = rule.pattern.exec(text);
    rule.pattern.lastIndex = 0;
    if (!match) continue;
    findings.push({ code: rule.code, line: lineNumber(text, match.index) });
  }
  return findings;
}

function containsSensitiveContent(value) {
  return scanSensitiveContent(value).length > 0;
}

module.exports = {
  RULES,
  containsSensitiveContent,
  scanSensitiveContent,
};
