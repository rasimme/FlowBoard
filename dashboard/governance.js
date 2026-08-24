'use strict';

/**
 * governance.js — T-447-1: Authoritative principal resolution and the small
 * trust contract behind Specify confirmation, exception review, and
 * governance-mode changes.
 *
 * Scope (deliberately small — see spec T-447-1 / parent T-447):
 *   - Resolve the effective principal (human vs agent) on the SERVER, from
 *     verified auth/session/transport context. Never from caller-supplied
 *     `human`, `agent`, `agentId`, origin, exception, or approval fields.
 *   - Verify a human actor before persisting a Specify confirmation, and
 *     persist actor + timestamp + Specify session ID + proposal identity.
 *   - Reject agent self-confirmation and missing / stale / mismatched bindings.
 *   - Provide the same resolver to the exception-review and governance-mode
 *     mutations, persisting actor + time for each.
 *
 * NON-scope (later subtasks T-447-2..5): the generic `createTaskWithPolicy()`
 * wrapper, the four operational exceptions' creation predicates, the SPECIFY_
 * REQUIRED 409 recovery flow, and any generic policy engine / roles matrix.
 * This module only supplies the trust primitives those tasks will consume.
 *
 * =====================================================================
 * TRUST BOUNDARY — exact principal sources
 * =====================================================================
 * The single authoritative signal for a *verified human* is `req.user`,
 * populated by `telegramAuthMiddleware` -> `authenticateOrChallenge` in
 * server.js from either:
 *   (a) fresh, HMAC-verified Telegram Mini App init-data, or
 *   (b) a server-signed session cookie (`flowboard_session`) whose JWT was
 *       minted from a prior (a).
 * In both cases the FlowBoard server itself has cryptographically verified the
 * identity; the client cannot forge it. `req.user.id` is the Telegram user id
 * and `req.user.agentId` is the *bot mapping*, not an authorization claim.
 *
 * Everything the CLIENT puts in the request BODY or in custom headers is
 * DESCRIPTIVE ONLY and MUST NOT be used for authorization:
 *   - body.agent / body.agentId / body.human / body.approved / body.origin
 *   - body.exception / body.principal / any "I am a human" flag
 *   - session.agentId ('human' for the dashboard stepper) is a routing hint
 *     supplied at session creation; it is NOT proof of a human.
 *
 * Requests that reach a route WITHOUT `req.user` are, by default, not a
 * verified human. That covers scripted agents, chat webhooks, and the OpenClaw
 * worker. We classify all of these as `agent`.
 *
 * ONE narrow exception: on a deployment where Telegram auth is NOT configured
 * (`AUTH_ENABLED === false`), FlowBoard is a single-operator localhost tool and
 * the auth middleware already grants a direct loopback caller full access. For
 * exactly that request the middleware stamps `req.localOperator = true` (never
 * for cf-ray/tunnel or LAN-bypass requests). We treat that local operator as
 * the verified human, because it is the same actor the loopback bypass already
 * trusts for every other mutation. When Telegram auth IS configured, this flag
 * is never set and only a real `req.user` qualifies as human.
 *
 * Therefore the trust boundary is: "did the FlowBoard server verify a human for
 * THIS request?" — a Telegram `req.user`, or (auth-disabled only) the trusted
 * loopback operator. Everything else -> agent principal. Body/header claims are
 * never part of this decision.
 * =====================================================================
 */

// A verified human Specify confirmation must arrive while the proposal is still
// fresh. A dashboard stepper that has been left open for hours is stale and
// must be re-confirmed. Tunable; default 30 minutes.
const CONFIRMATION_MAX_AGE_MS =
  (parseInt(process.env.FLOWBOARD_CONFIRM_MAX_AGE_MIN, 10) || 30) * 60 * 1000;

const GOVERNANCE_MODES = ['compat', 'enforce'];
const DEFAULT_GOVERNANCE_MODE = 'compat';

const SETTING_KEY_MODE = 'governance_mode';

// ---------------------------------------------------------------------------
// Principal resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the effective principal for a request.
 *
 * @param {object} req - Express request. Only `req.user` (server-verified) is
 *   trusted. Body/header fields are ignored for the kind decision.
 * @returns {{
 *   kind: 'human'|'agent',
 *   actor: string,          // stable audit identity
 *   humanId: (string|null), // Telegram user id when kind==='human'
 *   authSessionId: (string|null), // bot mapping / auth binding, when human
 *   verified: boolean,      // true only for a server-verified human
 *   descriptive: object     // echoed caller-supplied claims (NEVER authoritative)
 * }}
 */
function resolvePrincipal(req) {
  const body = (req && req.body) || {};
  const descriptive = {
    agent: body.agent ?? body.agentId ?? null,
    human: body.human ?? null,
    origin: body.origin ?? null,
    approved: body.approved ?? body.userApproval ?? null,
  };

  const user = req && req.user;
  if (user && (user.id !== undefined && user.id !== null)) {
    return {
      kind: 'human',
      actor: `telegram:${user.id}`,
      humanId: String(user.id),
      // The bot mapping is the closest thing to an auth-session binding we have
      // for a Telegram identity; it lets a confirmation record which verified
      // channel produced it. Not an authorization input.
      authSessionId: user.agentId != null ? String(user.agentId) : null,
      verified: true,
      descriptive,
    };
  }

  // Auth-disabled single-operator deployment: the trusted loopback operator,
  // stamped by the auth middleware (never by client input), is the human.
  if (req && req.localOperator === true) {
    return {
      kind: 'human',
      actor: 'local-operator',
      humanId: 'local-operator',
      authSessionId: 'loopback',
      verified: true,
      descriptive,
    };
  }

  // No server-verified human on this request -> agent / ops / script / worker.
  return {
    kind: 'agent',
    actor: 'agent:unverified',
    humanId: null,
    authSessionId: null,
    verified: false,
    descriptive,
  };
}

/**
 * True only when the request carries a server-verified human principal.
 */
function isVerifiedHuman(principal) {
  return !!principal && principal.kind === 'human' && principal.verified === true;
}

// ---------------------------------------------------------------------------
// Verified human Specify confirmation
// ---------------------------------------------------------------------------

/**
 * Reason codes for a rejected confirmation. Stable strings so tests and the
 * API layer can assert on them.
 */
const CONFIRM_REJECT = {
  NOT_HUMAN: 'confirmation_requires_verified_human',
  AGENT_SELF_CONFIRM: 'agent_self_confirmation_forbidden',
  NO_PROPOSAL: 'no_proposal_to_confirm',
  SESSION_MISMATCH: 'session_binding_mismatch',
  STALE: 'confirmation_binding_stale',
};

/**
 * Verify that a human may confirm this Specify proposal, and — on success —
 * produce the confirmation record to persist.
 *
 * Authoritative inputs:
 *   - `principal` from resolvePrincipal(req) (server-verified).
 *   - `session` the in-memory Specify session (server-owned state machine).
 *   - `expectedSessionId` the session id from the ROUTE (`:id`), which the
 *     client cannot substitute for another session's proposal.
 *
 * Rejects:
 *   - non-human principal (missing verified human)            -> NOT_HUMAN
 *   - a session that is an agent/chat session (self-confirm)  -> AGENT_SELF_CONFIRM
 *   - a session with no draft proposal                        -> NO_PROPOSAL
 *   - session id / proposal identity mismatch                 -> SESSION_MISMATCH
 *   - a proposal older than CONFIRMATION_MAX_AGE_MS           -> STALE
 *
 * @returns {{ ok: true, record: object } | { ok: false, code: string, reason: string }}
 */
function verifyHumanConfirmation({ principal, session, expectedSessionId, now = Date.now() }) {
  if (!isVerifiedHuman(principal)) {
    return {
      ok: false,
      code: CONFIRM_REJECT.NOT_HUMAN,
      reason: 'Specify confirmation requires a server-verified human principal.',
    };
  }

  if (!session) {
    return {
      ok: false,
      code: CONFIRM_REJECT.SESSION_MISMATCH,
      reason: 'No Specify session bound to this confirmation.',
    };
  }

  // Session binding: the route id must be the session we verify against. This
  // prevents confirming session A's proposal while pointing at session B.
  if (expectedSessionId != null && session.id !== expectedSessionId) {
    return {
      ok: false,
      code: CONFIRM_REJECT.SESSION_MISMATCH,
      reason: `Confirmation session ${expectedSessionId} does not match bound session ${session.id}.`,
    };
  }

  // Agent self-confirmation: a session that Specify ran on an agent's behalf
  // (chat/api transport, or any non-'human' agentId) cannot be human-confirmed.
  // Only the dashboard human stepper (transport 'dashboard', agentId 'human')
  // is a legitimate human confirmation channel. Even a verified human may not
  // rubber-stamp an agent-driven session — that would let an agent originate
  // work and have it counted as human-confirmed.
  const isDashboardHumanSession =
    session.transport === 'dashboard' && session.agentId === 'human';
  if (!isDashboardHumanSession) {
    return {
      ok: false,
      code: CONFIRM_REJECT.AGENT_SELF_CONFIRM,
      reason: 'Only the Dashboard human Specify session can be human-confirmed; ' +
        `session transport=${session.transport} agentId=${session.agentId} is agent-originated.`,
    };
  }

  const proposal = session.draftProposal;
  if (!proposal) {
    return {
      ok: false,
      code: CONFIRM_REJECT.NO_PROPOSAL,
      reason: 'Session has no draft proposal to confirm.',
    };
  }

  // Stale: the proposal must be recent. Use the session's most recent activity
  // (proposal generation / revision updates lastActivity) as the freshness
  // anchor; fall back to createdAt.
  const anchor = Number(session.lastActivity || session.createdAt || 0);
  if (!anchor || now - anchor > CONFIRMATION_MAX_AGE_MS) {
    return {
      ok: false,
      code: CONFIRM_REJECT.STALE,
      reason: `Proposal is stale (age ${anchor ? now - anchor : 'unknown'}ms > ` +
        `${CONFIRMATION_MAX_AGE_MS}ms); re-open Specify to confirm.`,
    };
  }

  const proposalIdentity = proposalIdentityOf(proposal);

  return {
    ok: true,
    record: {
      actor: principal.actor,
      humanId: principal.humanId,
      authSessionId: principal.authSessionId,
      confirmedAt: new Date(now).toISOString(),
      specifySessionId: session.id,
      proposalIdentity,
    },
  };
}

/**
 * Derive a stable-ish identity for a draft proposal so a persisted confirmation
 * names WHAT was confirmed (not just that something was). The proposal object
 * is worker-generated and has no id, so we fingerprint its summary + task
 * breakdown shape. Deterministic for a given proposal snapshot.
 */
function proposalIdentityOf(proposal) {
  if (!proposal || typeof proposal !== 'object') return null;
  const summary = typeof proposal.summary === 'string' ? proposal.summary.trim() : '';
  const breakdown = Array.isArray(proposal.taskBreakdown) ? proposal.taskBreakdown : [];
  const titles = breakdown
    .map((t) => (typeof t === 'string' ? t : t && t.title) || '')
    .filter(Boolean);
  return {
    summary: summary.slice(0, 200),
    taskCount: titles.length,
    titles: titles.slice(0, 20),
  };
}

// ---------------------------------------------------------------------------
// Governance mode (compat | enforce) — persistent, human-only switch
// ---------------------------------------------------------------------------

/**
 * Read the persisted governance mode via a metadata store that exposes
 * getSetting(key). Defaults to 'compat' when unset or unreadable.
 * @param {{ getSetting: (k:string)=>string|null }} store
 */
function getGovernanceMode(store) {
  try {
    const raw = store && typeof store.getSetting === 'function'
      ? store.getSetting(SETTING_KEY_MODE)
      : null;
    if (raw && GOVERNANCE_MODES.includes(raw)) return raw;
  } catch { /* fall through to default */ }
  return DEFAULT_GOVERNANCE_MODE;
}

/**
 * Change the governance mode. Server-authoritative: requires a verified human
 * principal (the resolver decides, never a caller flag). Persists actor + time.
 *
 * @returns {{ ok: true, mode: string, record: object } |
 *            { ok: false, code: string, reason: string }}
 */
function setGovernanceMode({ store, principal, nextMode, now = Date.now() }) {
  if (!GOVERNANCE_MODES.includes(nextMode)) {
    return {
      ok: false,
      code: 'invalid_governance_mode',
      reason: `mode must be one of ${GOVERNANCE_MODES.join('|')}`,
    };
  }
  if (!isVerifiedHuman(principal)) {
    return {
      ok: false,
      code: 'mode_change_requires_verified_human',
      reason: 'Changing governance mode requires a server-verified human principal.',
    };
  }
  const record = {
    actor: principal.actor,
    humanId: principal.humanId,
    changedAt: new Date(now).toISOString(),
    mode: nextMode,
  };
  store.setSetting(SETTING_KEY_MODE, nextMode);
  store.setSetting(`${SETTING_KEY_MODE}__last_change`, JSON.stringify(record));
  return { ok: true, mode: nextMode, record };
}

/**
 * Read the last mode-change audit record, or null.
 */
function getGovernanceModeAudit(store) {
  try {
    const raw = store && typeof store.getSetting === 'function'
      ? store.getSetting(`${SETTING_KEY_MODE}__last_change`)
      : null;
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Exception review — verified human marks an exception task reviewed
// ---------------------------------------------------------------------------

/**
 * Authorize marking an exception task as reviewed. Server-authoritative: the
 * reviewer must be a verified human. Produces the review record to persist
 * (actor + timestamp). Does NOT itself mutate storage — the API layer writes
 * the returned record onto the task metadata so persistence stays in one place.
 *
 * @returns {{ ok: true, record: object } |
 *            { ok: false, code: string, reason: string }}
 */
function authorizeExceptionReview({ principal, now = Date.now() }) {
  if (!isVerifiedHuman(principal)) {
    return {
      ok: false,
      code: 'exception_review_requires_verified_human',
      reason: 'Marking an exception reviewed requires a server-verified human principal.',
    };
  }
  return {
    ok: true,
    record: {
      state: 'reviewed',
      reviewer: principal.actor,
      reviewerHumanId: principal.humanId,
      reviewedAt: new Date(now).toISOString(),
    },
  };
}

module.exports = {
  // constants
  CONFIRMATION_MAX_AGE_MS,
  GOVERNANCE_MODES,
  DEFAULT_GOVERNANCE_MODE,
  CONFIRM_REJECT,
  // principal
  resolvePrincipal,
  isVerifiedHuman,
  // confirmation
  verifyHumanConfirmation,
  proposalIdentityOf,
  // governance mode
  getGovernanceMode,
  setGovernanceMode,
  getGovernanceModeAudit,
  // exception review
  authorizeExceptionReview,
};
