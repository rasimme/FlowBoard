'use strict';

/**
 * test-t447-1-principal.js — T-447-1
 *
 * Unit tests for the authoritative principal resolver and the trust contract
 * behind Specify confirmation, exception review, and governance-mode changes.
 *
 * Positive: verified Dashboard-human direct creation / confirmation /
 * exception-review / mode-change.
 * Negative (spoofing / stale / mismatch): forged caller fields, agent
 * self-confirmation, stale proposal binding, session mismatch, missing human.
 */

const governance = require('./governance');

let pass = 0, fail = 0;
const failures = [];

function ok(cond, msg) {
  if (cond) { pass++; console.log(`  \u2705 ${msg}`); }
  else { fail++; failures.push(msg); console.log(`  \u274C ${msg}`); }
}
function section(title) { console.log(`\n## ${title}\n`); }

// --- Fixtures ---------------------------------------------------------------

// A server-verified human request: req.user is populated by the auth middleware
// from HMAC-verified Telegram init-data or a signed session cookie.
function humanReq(overrides = {}) {
  return {
    user: { id: 15707748, agentId: 'dev-botti-main', first_name: 'Simeon' },
    body: {},
    ...overrides,
  };
}

// An agent / ops / script / worker request: NO req.user (localhost bypass,
// chat webhook, or the OpenClaw worker). Body may carry forged claims.
function agentReq(body = {}) {
  return { body };
}

function dashboardHumanSession(overrides = {}) {
  const now = Date.now();
  return {
    id: 'specify-100-1',
    project: 'flowboard',
    origin: 'canvas',
    transport: 'dashboard',
    agentId: 'human',
    status: 'proposal-ready',
    draftProposal: {
      summary: 'Add a lunch poll feature',
      taskBreakdown: [
        { title: 'Parent: Build lunch poll', role: 'parent' },
        { title: 'Define poll data', role: 'subtask' },
      ],
    },
    createdAt: now,
    lastActivity: now,
    ...overrides,
  };
}

// --- resolvePrincipal -------------------------------------------------------
section('resolvePrincipal — server-authoritative kind');

{
  const p = governance.resolvePrincipal(humanReq());
  ok(p.kind === 'human', 'verified req.user resolves to human');
  ok(p.verified === true, 'verified human is marked verified');
  ok(p.actor === 'telegram:15707748', 'human actor is telegram:<id>');
  ok(p.humanId === '15707748', 'humanId captured from verified user');
  ok(governance.isVerifiedHuman(p), 'isVerifiedHuman true for verified human');
}

{
  const p = governance.resolvePrincipal(agentReq());
  ok(p.kind === 'agent', 'request without req.user resolves to agent');
  ok(p.verified === false, 'agent principal is not verified');
  ok(!governance.isVerifiedHuman(p), 'isVerifiedHuman false for agent');
}

{
  // Auth-disabled deployment: trusted loopback operator (stamped by the auth
  // middleware, NEVER by client body) is the verified human.
  const p = governance.resolvePrincipal({ localOperator: true, body: {} });
  ok(p.kind === 'human', 'auth-disabled loopback operator resolves to human');
  ok(p.verified === true && p.actor === 'local-operator', 'local operator is verified human');
  // A client cannot forge localOperator via the body — only the middleware
  // sets req.localOperator. A body-level claim is ignored (still agent).
  const spoof = governance.resolvePrincipal(agentReq({ localOperator: true }));
  ok(spoof.kind === 'agent', 'body.localOperator claim does not mint a human');
}

section('resolvePrincipal — caller fields are DESCRIPTIVE only (spoof)');

{
  // The classic spoof: an agent claims to be a human via body fields.
  const spoof = governance.resolvePrincipal(agentReq({
    human: 'Simeon', agent: 'dev-botti', approved: true, origin: 'dashboard',
    principal: 'human', userApproval: true,
  }));
  ok(spoof.kind === 'agent', 'forged human/approved/origin body cannot mint a human');
  ok(spoof.verified === false, 'forged body stays unverified');
  ok(spoof.descriptive.human === 'Simeon', 'forged claim is echoed as descriptive only');
  ok(spoof.descriptive.approved === true, 'forged approval echoed descriptively');
  ok(!governance.isVerifiedHuman(spoof), 'spoofed human is rejected by isVerifiedHuman');
}

{
  // A human request must NOT be downgraded by body claims either.
  const p = governance.resolvePrincipal(humanReq({ body: { agent: 'evil', human: null } }));
  ok(p.kind === 'human', 'verified human not downgraded by body.agent');
}

// --- verifyHumanConfirmation ------------------------------------------------
section('verifyHumanConfirmation — positive Dashboard-human');

{
  const session = dashboardHumanSession();
  const res = governance.verifyHumanConfirmation({
    principal: governance.resolvePrincipal(humanReq()),
    session,
    expectedSessionId: session.id,
  });
  ok(res.ok, 'verified human confirms a fresh dashboard proposal');
  ok(res.record.actor === 'telegram:15707748', 'record persists actor');
  ok(typeof res.record.confirmedAt === 'string', 'record persists timestamp');
  ok(res.record.specifySessionId === 'specify-100-1', 'record persists Specify session ID');
  ok(res.record.proposalIdentity && res.record.proposalIdentity.taskCount === 2,
    'record persists proposal identity (task count)');
  ok(res.record.proposalIdentity.summary === 'Add a lunch poll feature',
    'record persists proposal identity (summary)');
}

section('verifyHumanConfirmation — negative: agent self-confirmation');

{
  // Agent-driven chat session: even a verified human may not confirm it.
  const chatSession = dashboardHumanSession({
    id: 'specify-200-1', transport: 'chat', agentId: 'dev-botti',
  });
  const res = governance.verifyHumanConfirmation({
    principal: governance.resolvePrincipal(humanReq()),
    session: chatSession,
    expectedSessionId: chatSession.id,
  });
  ok(!res.ok, 'agent-originated (chat) session cannot be human-confirmed');
  ok(res.code === governance.CONFIRM_REJECT.AGENT_SELF_CONFIRM, 'reason is agent_self_confirmation_forbidden');
}

{
  // Non-human principal confirming a legit dashboard session.
  const session = dashboardHumanSession({ id: 'specify-201-1' });
  const res = governance.verifyHumanConfirmation({
    principal: governance.resolvePrincipal(agentReq({ approved: true })),
    session,
    expectedSessionId: session.id,
  });
  ok(!res.ok, 'agent principal cannot confirm even a dashboard session');
  ok(res.code === governance.CONFIRM_REJECT.NOT_HUMAN, 'reason is confirmation_requires_verified_human');
}

section('verifyHumanConfirmation — negative: stale binding');

{
  const stale = dashboardHumanSession({
    id: 'specify-300-1',
    lastActivity: Date.now() - (governance.CONFIRMATION_MAX_AGE_MS + 60_000),
    createdAt: Date.now() - (governance.CONFIRMATION_MAX_AGE_MS + 120_000),
  });
  const res = governance.verifyHumanConfirmation({
    principal: governance.resolvePrincipal(humanReq()),
    session: stale,
    expectedSessionId: stale.id,
  });
  ok(!res.ok, 'a stale proposal cannot be confirmed');
  ok(res.code === governance.CONFIRM_REJECT.STALE, 'reason is confirmation_binding_stale');
}

section('verifyHumanConfirmation — negative: session mismatch');

{
  const session = dashboardHumanSession({ id: 'specify-400-1' });
  const res = governance.verifyHumanConfirmation({
    principal: governance.resolvePrincipal(humanReq()),
    session,
    expectedSessionId: 'specify-999-9', // route points at a different session
  });
  ok(!res.ok, 'confirmation route id must match the bound session');
  ok(res.code === governance.CONFIRM_REJECT.SESSION_MISMATCH, 'reason is session_binding_mismatch');
}

section('verifyHumanConfirmation — negative: missing proposal / missing session');

{
  const noProposal = dashboardHumanSession({ id: 'specify-500-1', draftProposal: null });
  const res = governance.verifyHumanConfirmation({
    principal: governance.resolvePrincipal(humanReq()),
    session: noProposal,
    expectedSessionId: noProposal.id,
  });
  ok(!res.ok && res.code === governance.CONFIRM_REJECT.NO_PROPOSAL, 'no draft proposal rejected');

  const res2 = governance.verifyHumanConfirmation({
    principal: governance.resolvePrincipal(humanReq()),
    session: null,
    expectedSessionId: 'specify-x',
  });
  ok(!res2.ok && res2.code === governance.CONFIRM_REJECT.SESSION_MISMATCH, 'missing session rejected');
}

// --- Governance mode --------------------------------------------------------
section('governance mode — persistent human-only switch');

function memStore() {
  const kv = new Map();
  return {
    getSetting: (k) => (kv.has(k) ? kv.get(k) : null),
    setSetting: (k, v) => { if (v == null || v === '') kv.delete(k); else kv.set(k, String(v)); },
    _kv: kv,
  };
}

{
  const store = memStore();
  ok(governance.getGovernanceMode(store) === 'compat', 'default mode is compat');

  const bad = governance.setGovernanceMode({ store, principal: governance.resolvePrincipal(agentReq({ human: 'x' })), nextMode: 'enforce' });
  ok(!bad.ok && bad.code === 'mode_change_requires_verified_human', 'agent cannot change mode (spoof body ignored)');
  ok(governance.getGovernanceMode(store) === 'compat', 'mode unchanged after rejected agent switch');

  const good = governance.setGovernanceMode({ store, principal: governance.resolvePrincipal(humanReq()), nextMode: 'enforce' });
  ok(good.ok && good.mode === 'enforce', 'verified human switches to enforce');
  ok(governance.getGovernanceMode(store) === 'enforce', 'mode persisted');
  const audit = governance.getGovernanceModeAudit(store);
  ok(audit && audit.actor === 'telegram:15707748' && audit.mode === 'enforce', 'mode change audits actor + time');

  // rollback
  const back = governance.setGovernanceMode({ store, principal: governance.resolvePrincipal(humanReq()), nextMode: 'compat' });
  ok(back.ok && governance.getGovernanceMode(store) === 'compat', 'human can roll back to compat');

  const invalid = governance.setGovernanceMode({ store, principal: governance.resolvePrincipal(humanReq()), nextMode: 'yolo' });
  ok(!invalid.ok && invalid.code === 'invalid_governance_mode', 'invalid mode rejected');
}

// --- Exception review -------------------------------------------------------
section('exception review — verified human only');

{
  const bad = governance.authorizeExceptionReview({ principal: governance.resolvePrincipal(agentReq({ human: 'Simeon' })) });
  ok(!bad.ok && bad.code === 'exception_review_requires_verified_human', 'agent cannot mark exception reviewed (spoof ignored)');

  const good = governance.authorizeExceptionReview({ principal: governance.resolvePrincipal(humanReq()) });
  ok(good.ok, 'verified human marks exception reviewed');
  ok(good.record.state === 'reviewed', 'review record state is reviewed');
  ok(good.record.reviewer === 'telegram:15707748', 'review record persists reviewer actor');
  ok(typeof good.record.reviewedAt === 'string', 'review record persists timestamp');
}

// --- Summary ----------------------------------------------------------------
console.log(`\n${'='.repeat(60)}`);
console.log(`T-447-1 principal/trust tests: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('All T-447-1 trust-contract tests passed.');
