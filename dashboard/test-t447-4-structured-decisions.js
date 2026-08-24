'use strict';

const assert = require('assert');
const specifySession = require('./specify-sessions');
const bridge = require('./specify-worker-bridge');

async function main() {
  const worker = bridge.createFakeWorkerAdapter();
  bridge.setWorkerAdapter(worker);

  const resolved = {
    project: 'structured-decisions',
    title: 'Resolved request',
    structuredDecisions: { scope: 'one task', behavior: 'confirm', resolved: true },
  };
  const session = specifySession.createSession({
    project: 'structured-decisions', agentId: 't447-4-resolved',
    specifyRequest: resolved,
    structuredDecisions: resolved.structuredDecisions,
  });
  worker.setResponses(session.id, [
    { action: 'question', workerRequest: { question: 'Repeat scope?', affectedFields: ['scope'] } },
    { action: 'proposal', workerRequest: {
      summary: 'Resolved proposal', specContent: '# Resolved', taskBreakdown: [{ title: 'Resolved task' }],
    } },
  ]);
  const result = await bridge.requestNext(session.id);
  assert.equal(result.action, 'proposal', 'covered worker question is suppressed in favor of proposal');
  const calls = worker.getRequests(session.id);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].input.specifyRequest, resolved);
  assert.deepEqual(calls[0].input.structuredDecisions, resolved.structuredDecisions);
  assert.equal(specifySession.getSession(session.id).clarifications.length, 0);

  const partial = specifySession.createSession({
    project: 'structured-decisions', agentId: 't447-4-partial',
    structuredDecisions: { scope: 'one task' },
  });
  worker.setResponses(partial.id, [
    { action: 'question', workerRequest: { question: 'What behavior?', affectedFields: ['behavior'] } },
  ]);
  const partialResult = await bridge.requestNext(partial.id);
  assert.equal(partialResult.action, 'question', 'uncovered worker fields remain eligible for clarification');

  console.log('T-447-4 structured decision tests: all passed');
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
