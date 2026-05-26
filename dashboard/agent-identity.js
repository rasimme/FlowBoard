'use strict';

const DEFAULT_KNOWN_AGENT_IDS = [
  'main',
  'botti',
  'dev-botti',
  'design-botti',
  'claude-code',
  'human',
  'codex',
  'cursor',
  'cron-nightly',
];

const RESERVED_BAD_IDS = new Set([
  'agent',
  'default',
  'none',
  'null',
  'unknown',
]);

function envList(name) {
  return (process.env[name] || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function knownAgentIds() {
  return new Set([
    ...DEFAULT_KNOWN_AGENT_IDS,
    ...envList('FLOWBOARD_KNOWN_AGENT_IDS'),
  ]);
}

function normalizeAgentId(value) {
  return String(value || '').trim();
}

function isEphemeralAgentId(id) {
  if (!id) return false;
  if (id === 'workspace' || id.startsWith('workspace-')) return true;
  if (id.endsWith('-workspace')) return true;
  if (/^t\d+-replay-\d+$/i.test(id)) return true;
  if (/(^|-)replay-\d{8,}$/i.test(id)) return true;
  return false;
}

function classifyAgentId(value) {
  const id = normalizeAgentId(value);
  if (!id) return { ok: false, id, error: 'agentId is required' };

  if (id.includes('<') || id.includes('>')) {
    return { ok: false, id, error: 'agentId must be a real stable id, not a placeholder' };
  }
  if (id.length > 64) {
    return { ok: false, id, error: 'agentId must be <= 64 characters' };
  }
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id)) {
    return { ok: false, id, error: 'agentId must be lowercase kebab-case (a-z, 0-9, hyphen)' };
  }
  if (RESERVED_BAD_IDS.has(id)) {
    return { ok: false, id, error: `agentId "${id}" is reserved and not a stable agent identity` };
  }

  const known = knownAgentIds().has(id);
  const test = /^test-[a-z0-9-]+$/.test(id);
  if (!known && !test && isEphemeralAgentId(id)) {
    return {
      ok: false,
      id,
      error: `agentId "${id}" looks generated or workspace-derived; use the stable bootstrap/runtime id instead`,
    };
  }

  return {
    ok: true,
    id,
    kind: known ? 'known' : test ? 'test' : 'external',
    warning: known || test ? null : `Unknown external agentId "${id}" will be lazy-registered; keep it stable across runs.`,
  };
}

function validateAgentId(value, label = 'agentId') {
  const result = classifyAgentId(value);
  if (result.ok) return result;
  return { ...result, error: result.error.replace(/^agentId/, label) };
}

function responseMeta(identity) {
  if (!identity?.ok) return undefined;
  return {
    kind: identity.kind,
    ...(identity.warning ? { warning: identity.warning } : {}),
  };
}

module.exports = {
  DEFAULT_KNOWN_AGENT_IDS,
  classifyAgentId,
  validateAgentId,
  responseMeta,
  normalizeAgentId,
  isEphemeralAgentId,
};
