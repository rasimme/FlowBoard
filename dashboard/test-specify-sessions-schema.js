'use strict';

const specifySession = require('./specify-sessions');

let pass = 0, fail = 0, failures = [];

function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✅ ${msg}`); }
  else { fail++; failures.push(msg); console.log(`  ❌ ${msg}`); }
}

function section(title) { console.log(`\n## ${title}\n`); }

// Test new session includes all schema fields
section('Session Schema Tests');

const session = specifySession.createSession({
  project: 'test-proj',
  origin: 'canvas',
  agentId: 'test-agent',
  sourceNoteIds: ['note-1', 'note-2'],
  sourceDescription: 'User draft notes',
  transport: 'dashboard',
});

ok(session.id && session.id.startsWith('specify-'), 'Session has ID');
ok(session.status === 'created', 'Initial status is "created"');
ok(Array.isArray(session.clarifications) && session.clarifications.length === 0, 'Clarifications is empty array');
ok(session.draftProposal === null, 'draftProposal initially null');
ok(session.createdArtifacts && Array.isArray(session.createdArtifacts.specFiles) && Array.isArray(session.createdArtifacts.taskIds) && Array.isArray(session.createdArtifacts.cleanedNoteIds), 'createdArtifacts has spec/task/cleanup arrays');
ok(session.failureState === null, 'failureState initially null');
ok(session.transport === 'dashboard', 'transport field present');
ok(session.sourceDescription === 'User draft notes', 'sourceDescription field present');
ok(session.agentId === 'test-agent', 'agentId field present');
ok(session.sourceNoteIds.length === 2, 'sourceNoteIds preserved');
ok(session.project === 'test-proj', 'project field present');
ok(session.origin === 'canvas', 'origin field present');
ok(typeof session.createdAt === 'number', 'createdAt is timestamp');
ok(typeof session.lastActivity === 'number', 'lastActivity is timestamp');

// Test state machine validity
section('State Machine Validity Tests');

const sess = specifySession.createSession({
  project: 'test',
  agentId: 'agent-1',
});

ok(specifySession.canTransition(sess.status, 'analyzing'), 'created → analyzing valid');
ok(specifySession.canTransition('analyzing', 'clarifying'), 'analyzing → clarifying valid');
ok(specifySession.canTransition('clarifying', 'proposal-ready'), 'clarifying → proposal-ready valid');
ok(specifySession.canTransition('proposal-ready', 'confirmed'), 'proposal-ready → confirmed valid');
ok(specifySession.canTransition('confirmed', 'persisting'), 'confirmed → persisting valid');
ok(specifySession.canTransition('persisting', 'done'), 'persisting → done valid');

ok(specifySession.canTransition('created', 'done') === false, 'created → done invalid');
ok(specifySession.canTransition('analyzing', 'created') === false, 'backward transitions invalid');

ok(specifySession.canTransition('analyzing', 'error'), 'analyzing → error valid (from any state)');
ok(specifySession.canTransition('persisting', 'error'), 'persisting → error valid (from any state)');

ok(specifySession.canTransition('error', 'done') === false, 'error terminal (not → done)');
ok(specifySession.canTransition('aborted', 'done') === false, 'aborted terminal (not → done)');

// Test terminal state detection
section('Terminal State Tests');

ok(specifySession.isTerminal('done'), 'done is terminal');
ok(specifySession.isTerminal('error'), 'error is terminal');
ok(specifySession.isTerminal('aborted'), 'aborted is terminal');
ok(!specifySession.isTerminal('analyzing'), 'analyzing is not terminal');
ok(!specifySession.isTerminal('proposal-ready'), 'proposal-ready is not terminal');

// Test update preserves all fields
section('Session Update Tests');

const updated = specifySession.updateSession(sess.id, {
  status: 'analyzing',
  clarifications: [{ id: 'q1', question: 'What is X?' }],
});

ok(updated.status === 'analyzing', 'Status updated');
ok(updated.clarifications.length === 1, 'Clarifications updated');
ok(updated.agentId === 'agent-1', 'Other fields preserved');
ok(updated.lastActivity > sess.lastActivity, 'lastActivity bumped');

if (fail === 0) {
  console.log(`\n✅ All ${pass} tests passed`);
  process.exit(0);
} else {
  console.log(`\n❌ ${fail} failed, ${pass} passed`);
  failures.forEach(f => console.log(`  - ${f}`));
  process.exit(1);
}
