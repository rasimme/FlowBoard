'use strict';

/**
 * Tests for FlowBoard-native workflow helpers.
 * Run: node test-workflows.js
 */

const fs = require('fs');
const hzl = require('./hzl-service.js');

const DB_PATH = '/tmp/flowboard-workflows-test.db';
const CACHE_PATH = DB_PATH.replace(/\.db$/, '-cache.db');
const PROJECT = 'workflow-test';

let passed = 0;
let failed = 0;

function ok(cond, msg) {
  if (cond) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); }
}

function eq(actual, expected, msg) {
  ok(actual === expected, `${msg} (got ${JSON.stringify(actual)})`);
}

function clean() {
  for (const f of [DB_PATH, CACHE_PATH]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

(async function main() {
  clean();
  await hzl.init(DB_PATH);

  console.log('\n## workflowStart()');
  const low = hzl.createTask(PROJECT, { title: 'Low backlog', priority: 'low', status: 'backlog' });
  const high = hzl.createTask(PROJECT, { title: 'High open', priority: 'high', status: 'open' });
  const start = hzl.workflowStart(PROJECT, { agent: 'dev-botti', lease: 15 });
  eq(start.mode, 'claim_next', 'claims next task when none is in progress');
  eq(start.claimed.id, high.id, 'claims highest-priority eligible task');
  eq(start.claimed.status, 'in-progress', 'claimed task is in progress');
  eq(start.claimed.agent, 'dev-botti', 'claimed task has agent');

  const resume = hzl.workflowStart(PROJECT, { agent: 'dev-botti', lease: 15 });
  eq(resume.mode, 'resume', 'resumes existing in-progress work');
  eq(resume.resumed.id, high.id, 'resumes same task');
  ok(resume.alternates.length === 0, 'no resume alternates');

  console.log('\n## workflowDelegate()');
  const delegated = hzl.workflowDelegate(PROJECT, {
    fromTaskId: high.id,
    title: 'Delegated work',
    agent: 'claude-code',
    pauseParent: true,
    checkpoint: 'Split out delegated work.',
    opId: 'delegate-once',
  });
  eq(delegated.workflow, 'delegate', 'delegate workflow returned');
  eq(delegated.delegatedTask.parentId, high.id, 'delegated task is child of source');
  eq(delegated.delegatedTask.routedAgent, 'claude-code', 'delegated task is routed');
  eq(delegated.sourceTask.blocked, true, 'pauseParent blocks source task');
  eq(delegated.checkpointAdded, true, 'checkpoint was added');
  const delegateReplay = hzl.workflowDelegate(PROJECT, {
    fromTaskId: high.id,
    title: 'Delegated work replay must not create another task',
    agent: 'claude-code',
    opId: 'delegate-once',
  });
  eq(delegateReplay.delegatedTask.id, delegated.delegatedTask.id, 'delegate opId replay returns same child');

  console.log('\n## workflowHandoff()');
  hzl.updateTask(PROJECT, high.id, { blocked: false });
  const handoff = hzl.workflowHandoff(PROJECT, {
    fromTaskId: high.id,
    title: 'Follow-on work',
    agent: 'design-botti',
    opId: 'handoff-once',
  });
  eq(handoff.workflow, 'handoff', 'handoff workflow returned');
  eq(handoff.completedTask.status, 'review', 'source moved to review');
  eq(handoff.followOnTask.status, 'open', 'follow-on is open');
  eq(handoff.followOnTask.routedAgent, 'design-botti', 'follow-on is routed');
  ok(handoff.followOnTask.id !== high.id, 'follow-on has distinct FlowBoard ID');
  const handoffReplay = hzl.workflowHandoff(PROJECT, {
    fromTaskId: high.id,
    title: 'Follow-on replay must not create another task',
    agent: 'design-botti',
    opId: 'handoff-once',
  });
  eq(handoffReplay.followOnTask.id, handoff.followOnTask.id, 'handoff opId replay returns same follow-on');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
