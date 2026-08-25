'use strict';

// T-447-1: the caller cannot mint a human by posting identity-shaped fields;
// only middleware-owned verification can authorize the Dashboard-human path.
const assert = require('assert');
const governance = require('./governance');

const agent = (body = {}) => ({ body });
const telegramHuman = (body = {}) => ({ body, ip: '127.0.0.1',
  user: { id: 42, agentId: 'bot-session' } });
const proposal = { summary: 'Bound proposal', taskStructure: 'Single task',
  specContent: '# Proposal', taskBreakdown: [{ title: 'Task' }] };
const proposalIdentity = governance.proposalIdentityOf(proposal);
const proposalBoundAt = Date.now();

const session = {
  id: 'specify-test-1', transport: 'dashboard', agentId: 'human',
  principalBinding: { sessionId: 'specify-test-1', actor: 'session:42', humanId: '42',
    proposalVersion: 1, proposalIdentity, proposalBoundAt },
  createdAt: proposalBoundAt, lastActivity: proposalBoundAt + 999999,
  draftProposal: proposal,
};

assert.equal(governance.resolvePrincipal(agent({ human: 'Ada', agentId: 'human' })).kind, 'agent');
assert.equal(governance.resolvePrincipal(agent({ localOperator: true })).kind, 'agent');
assert.equal(governance.resolvePrincipal({ localDashboardEvidence: true }).kind, 'agent');
assert.equal(governance.resolvePrincipal({ query: { transport: 'dashboard', agentId: 'human' } }).kind, 'agent');
assert.equal(governance.resolvePrincipal(agent({ transport: 'dashboard', agentId: 'human' })).kind, 'agent');
assert.equal(governance.resolvePrincipal(telegramHuman()).actor, 'session:42');
assert.equal(governance.resolvePrincipal({ ip: '127.0.0.1' }).actor, 'local:operator');

let result = governance.verifyHumanConfirmation({
  principal: governance.resolvePrincipal(telegramHuman()), session: {
    ...session,
    principalBinding: { ...session.principalBinding, actor: 'session:42', humanId: '42' },
  },
  expectedSessionId: session.id,
});
assert.equal(result.ok, true);
assert.equal(result.record.specifySessionId, session.id);
assert.equal(result.record.actor, 'session:42');
assert.ok(result.record.confirmedAt);
assert.ok(result.record.proposalIdentity.digest);

result = governance.verifyHumanConfirmation({
  principal: governance.resolvePrincipal(agent({ approved: true, human: 'Ada' })),
  session, expectedSessionId: session.id,
});
assert.equal(result.ok, false);
assert.equal(result.code, governance.CONFIRM_REJECT.NOT_HUMAN);

result = governance.verifyHumanConfirmation({
  principal: governance.resolvePrincipal(telegramHuman()),
  session: { ...session, id: 'agent-session', transport: 'chat', agentId: 'worker', principalBinding: null },
  expectedSessionId: 'agent-session',
});
assert.equal(result.code, governance.CONFIRM_REJECT.AGENT_SELF_CONFIRM);

result = governance.verifyHumanConfirmation({
  principal: governance.resolvePrincipal(telegramHuman()), session,
  expectedSessionId: 'other-session',
});
assert.equal(result.code, governance.CONFIRM_REJECT.SESSION_MISMATCH);

const changedProposal = { ...session, draftProposal: {
  ...session.draftProposal, summary: 'Changed after binding',
} };
result = governance.verifyHumanConfirmation({
  principal: governance.resolvePrincipal(telegramHuman()), session: {
    ...changedProposal,
    principalBinding: { ...changedProposal.principalBinding, actor: 'session:42', humanId: '42' },
  },
  expectedSessionId: session.id,
});
assert.equal(result.code, governance.CONFIRM_REJECT.STALE);

result = governance.verifyHumanConfirmation({
  principal: governance.resolvePrincipal(telegramHuman()), session: {
    ...session,
    principalBinding: { ...session.principalBinding, actor: 'telegram:99', humanId: '99' },
  },
  expectedSessionId: session.id,
});
assert.equal(result.code, governance.CONFIRM_REJECT.PRINCIPAL_MISMATCH);

const stale = { ...session, principalBinding: {
  ...session.principalBinding,
  proposalBoundAt: Date.now() - governance.CONFIRMATION_MAX_AGE_MS - 1,
} };
result = governance.verifyHumanConfirmation({
  principal: governance.resolvePrincipal(telegramHuman()), session: {
    ...stale,
    principalBinding: { ...stale.principalBinding, actor: 'session:42', humanId: '42' },
  },
  expectedSessionId: session.id,
});
assert.equal(result.code, governance.CONFIRM_REJECT.STALE);

const future = { ...session, principalBinding: {
  ...session.principalBinding,
  proposalBoundAt: Date.now() + 1000,
} };
result = governance.verifyHumanConfirmation({
  principal: governance.resolvePrincipal(telegramHuman()), session: {
    ...future,
    principalBinding: { ...future.principalBinding, actor: 'session:42', humanId: '42' },
  },
  expectedSessionId: session.id,
});
assert.equal(result.code, governance.CONFIRM_REJECT.STALE);

console.log('T-447-1 governance trust tests: all passed');
