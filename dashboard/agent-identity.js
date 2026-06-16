'use strict';

const DEFAULT_KNOWN_AGENT_IDS = [
  'main',
  'human',
  'claude-code',
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

function envList(value) {
  return (value || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function knownAgentIds() {
  return new Set([
    ...DEFAULT_KNOWN_AGENT_IDS,
    ...envList(process.env.FLOWBOARD_KNOWN_AGENT_IDS),
    ...managedAgentIds(),
  ]);
}

function managedAgentIds() {
  return new Set(envList(process.env.FLOWBOARD_MANAGED_AGENT_IDS));
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

function findManagedNearCollision(id) {
  for (const managedId of managedAgentIds()) {
    if (id === managedId) continue;
    if (id.startsWith(`${managedId}-`) || id.endsWith(`-${managedId}`)) {
      return managedId;
    }
  }
  return null;
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

  const managedCollision = findManagedNearCollision(id);
  if (managedCollision) {
    return {
      ok: false,
      id,
      error: `agentId "${id}" looks like a variant of managed agent "${managedCollision}"; use the canonical managed id or choose a distinct external id`,
    };
  }

  const known = knownAgentIds().has(id);
  const managed = managedAgentIds().has(id);
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
    kind: managed ? 'managed' : known ? 'known' : test ? 'test' : 'external',
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

/**
 * T-232: resolve the author for an activity entry (comment). The comment
 * endpoint historically took only a free-form `author` (the UI's human display
 * name), so a machine posting with `agent` — the field every sibling endpoint
 * (checkpoint/claim/complete) uses — was silently dropped and the entry stored
 * with a null author (rendered as "flowboard"). Accept both: a provided `agent`
 * is validated and wins; otherwise the free-form `author` (or null) is used.
 * Returns { ok, author } or { ok:false, error }.
 */
function resolveActivityAuthor({ agent, author } = {}) {
  if (agent !== undefined && agent !== null && String(agent).trim() !== '') {
    const result = validateAgentId(agent, 'agent');
    if (!result.ok) return { ok: false, error: result.error };
    return { ok: true, author: result.id };
  }
  return { ok: true, author: author || null };
}

module.exports = {
  DEFAULT_KNOWN_AGENT_IDS,
  classifyAgentId,
  validateAgentId,
  responseMeta,
  resolveActivityAuthor,
  normalizeAgentId,
  isEphemeralAgentId,
  managedAgentIds,
  findManagedNearCollision,
};
