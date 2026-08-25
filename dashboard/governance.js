'use strict';

/**
 * T-447-1 trust contract.
 *
 * A principal is resolved from server-verified request state only. Fields in
 * the request body (including agentId, human, origin and approved) describe
 * the caller's claim but never grant authority. Loopback admission is a
 * transport convenience for local agents, not proof of a human Dashboard
 * actor; an unauthenticated request is attributed to the local operator only
 * when it arrived over the loopback transport.
 */

const crypto = require('crypto');

const GOVERNANCE_MODES = ['compat', 'enforce'];
const DEFAULT_GOVERNANCE_MODE = 'compat';
const SETTING_KEY_MODE = 'governance_mode';

function projectSettingKey(project, suffix = '') {
  if (project === undefined || project === null || project === '') {
    return `${SETTING_KEY_MODE}${suffix}`;
  }
  const name = String(project).trim();
  if (!name) return `${SETTING_KEY_MODE}${suffix}`;
  // Project names are validated at the HTTP boundary. Keep the key format
  // explicit so a project-scoped setting can never collide with the legacy
  // instance-wide key.
  return `${SETTING_KEY_MODE}:${name}${suffix}`;
}

function scopedProjectSettingKey(project, suffix = '') {
  if (project === undefined || project === null || project === '') return null;
  const name = String(project).trim();
  return name ? projectSettingKey(name, suffix) : null;
}
const CONFIRMATION_MAX_AGE_MS =
  (parseInt(process.env.FLOWBOARD_CONFIRM_MAX_AGE_MIN, 10) || 30) * 60 * 1000;

function descriptiveClaims(req) {
  const body = req?.body && typeof req.body === 'object' ? req.body : {};
  return {
    agent: body.agent ?? body.agentId ?? null,
    human: body.human ?? null,
    origin: body.origin ?? null,
    approved: body.approved ?? body.userApproval ?? null,
  };
}

function isLoopbackRequest(req) {
  const ip = req?.ip || req?.connection?.remoteAddress || req?.socket?.remoteAddress;
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

/** Resolve a principal from middleware-owned state, never caller claims. */
function resolvePrincipal(req) {
  const descriptive = descriptiveClaims(req);
  const user = req?.user;
  if (user && user.id !== undefined && user.id !== null) {
    return {
      kind: 'human',
      verified: true,
      actor: `session:${String(user.id)}`,
      humanId: String(user.id),
      // This is the verified bot/session mapping available in the current
      // auth contract.  It is audit context, not an authorization input.
      authSessionId: user.agentId == null ? null : String(user.agentId),
      descriptive,
    };
  }

  if (isLoopbackRequest(req)) {
    return {
      kind: 'agent', verified: false, actor: 'local:operator',
      humanId: null, authSessionId: null, descriptive,
    };
  }

  return {
    kind: 'agent', verified: false, actor: 'agent:unverified',
    humanId: null, authSessionId: null, descriptive,
  };
}

function isVerifiedHuman(principal) {
  return principal?.kind === 'human' && principal.verified === true;
}

const CONFIRM_REJECT = Object.freeze({
  NOT_HUMAN: 'confirmation_requires_verified_human',
  AGENT_SELF_CONFIRM: 'agent_self_confirmation_forbidden',
  NO_PROPOSAL: 'no_proposal_to_confirm',
  SESSION_MISMATCH: 'session_binding_mismatch',
  PRINCIPAL_MISMATCH: 'confirmation_principal_mismatch',
  STALE: 'confirmation_binding_stale',
});

function proposalIdentityOf(proposal) {
  if (!proposal || typeof proposal !== 'object') return null;
  const normalized = {
    summary: typeof proposal.summary === 'string' ? proposal.summary.trim() : '',
    taskStructure: typeof proposal.taskStructure === 'string' ? proposal.taskStructure : '',
    specContent: typeof proposal.specContent === 'string' ? proposal.specContent : '',
    taskBreakdown: Array.isArray(proposal.taskBreakdown) ? proposal.taskBreakdown : [],
  };
  const digest = crypto.createHash('sha256')
    .update(JSON.stringify(normalized))
    .digest('hex');
  const titles = normalized.taskBreakdown.map((item) =>
    typeof item === 'string' ? item : item?.title || item?.name || '').filter(Boolean);
  return {
    digest,
    summary: normalized.summary.slice(0, 200),
    taskCount: titles.length,
    titles: titles.slice(0, 20),
  };
}

/**
 * Verify a confirmation against the server-owned Specify session and return
 * the audit record that must be persisted with the session.
 */
function verifyHumanConfirmation({ principal, session, expectedSessionId, now = Date.now() }) {
  if (!isVerifiedHuman(principal)) {
    return { ok: false, code: CONFIRM_REJECT.NOT_HUMAN,
      reason: 'Confirmation requires a verified human principal.' };
  }
  if (!session) {
    return { ok: false, code: CONFIRM_REJECT.SESSION_MISMATCH,
      reason: 'No Specify session bound to this confirmation.' };
  }
  if (expectedSessionId != null && session.id !== expectedSessionId) {
    return { ok: false, code: CONFIRM_REJECT.SESSION_MISMATCH,
      reason: 'Confirmation route does not match the bound Specify session.' };
  }
  // Only a session created for the dashboard human stepper can be confirmed
  // as human.  Chat/API sessions remain agent-originated even if a human later
  // supplies a forged body claim.
  if (session.transport !== 'dashboard' || session.agentId !== 'human') {
    return { ok: false, code: CONFIRM_REJECT.AGENT_SELF_CONFIRM,
      reason: 'Only a Dashboard-human Specify session can be human-confirmed.' };
  }
  const binding = session.principalBinding;
  if (!binding || binding.sessionId !== session.id) {
    return { ok: false, code: CONFIRM_REJECT.SESSION_MISMATCH,
      reason: 'Specify session has no valid principal binding.' };
  }
  if (binding.actor !== principal.actor || binding.humanId !== principal.humanId) {
    return { ok: false, code: CONFIRM_REJECT.PRINCIPAL_MISMATCH,
      reason: 'Confirmation principal does not match the Dashboard-human session binding.' };
  }
  if (!session.draftProposal) {
    return { ok: false, code: CONFIRM_REJECT.NO_PROPOSAL,
      reason: 'Session has no draft proposal to confirm.' };
  }
  const proposalIdentity = proposalIdentityOf(session.draftProposal);
  const boundIdentity = binding.proposalIdentity;
  const proposalBoundAt = Number(binding.proposalBoundAt || 0);
  const proposalAge = proposalBoundAt > now ? 0 : now - proposalBoundAt;
  if (!boundIdentity || boundIdentity.digest !== proposalIdentity.digest ||
      !Number.isInteger(binding.proposalVersion) || binding.proposalVersion < 1 ||
      !proposalBoundAt || proposalBoundAt > now || proposalAge > CONFIRMATION_MAX_AGE_MS) {
    return { ok: false, code: CONFIRM_REJECT.STALE,
      reason: 'Specify proposal binding is stale; reopen the proposal and confirm again.' };
  }
  return {
    ok: true,
    record: {
      actor: principal.actor,
      humanId: principal.humanId,
      authSessionId: principal.authSessionId,
      confirmedAt: new Date(now).toISOString(),
      specifySessionId: session.id,
      proposalIdentity,
      proposalVersion: binding.proposalVersion,
      proposalBoundAt: new Date(proposalBoundAt).toISOString(),
    },
  };
}

function getGovernanceMode(store, project = null) {
  try {
    const key = scopedProjectSettingKey(project);
    if (!key) return DEFAULT_GOVERNANCE_MODE;
    const scoped = store?.getSetting?.(key);
    if (GOVERNANCE_MODES.includes(scoped)) return scoped;
    // The former instance-wide setting is deliberately not a fallback. A
    // legacy enforce value must never leak into a new or unscoped project;
    // migration is an explicit, verified-human project switch.
    return DEFAULT_GOVERNANCE_MODE;
  } catch { return DEFAULT_GOVERNANCE_MODE; }
}

function getGovernanceModeAudit(store, project = null) {
  try {
    const key = scopedProjectSettingKey(project, '__last_change');
    if (!key) return null;
    const value = store?.getSetting?.(key);
    if (!value) return null;
    const audit = JSON.parse(value);
    if (!audit || typeof audit !== 'object' || Array.isArray(audit)) return null;
    return audit;
  } catch { return null; }
}

function setGovernanceMode({ store, project = null, principal, nextMode, now = Date.now() }) {
  if (!GOVERNANCE_MODES.includes(nextMode)) {
    return { ok: false, code: 'invalid_governance_mode',
      reason: `mode must be one of ${GOVERNANCE_MODES.join('|')}` };
  }
  const modeKey = scopedProjectSettingKey(project);
  if (!modeKey) {
    return { ok: false, code: 'project_required_for_governance_mode',
      reason: 'Governance mode changes must target an explicit project.' };
  }
  const record = { actor: principal.actor, humanId: principal.humanId,
    changedAt: new Date(now).toISOString(), mode: nextMode };
  store.setSetting(modeKey, nextMode);
  store.setSetting(`${modeKey}__last_change`, JSON.stringify(record));
  return { ok: true, mode: nextMode, record };
}

module.exports = {
  CONFIRMATION_MAX_AGE_MS, GOVERNANCE_MODES, DEFAULT_GOVERNANCE_MODE, CONFIRM_REJECT,
  resolvePrincipal, isVerifiedHuman, proposalIdentityOf, verifyHumanConfirmation,
  getGovernanceMode, getGovernanceModeAudit, setGovernanceMode,
  projectSettingKey, scopedProjectSettingKey,
};
