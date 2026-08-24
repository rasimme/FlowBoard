'use strict';

/** T-447-4 — enforce recovery, Specify context, and exception review API. */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const jwt = require('jsonwebtoken');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 18798;
const workspace = path.join(__dirname, 'test-workspace');
const project = 'test-t447-4-enforce';
const db = path.join(workspace, '.hzl', 'flowboard-t447-4.db');
const cache = db.replace(/\.db$/, '-cache.db');
const jwtSecret = 't447-4-test-jwt-secret-long-enough';
const humanCookie = `flowboard_session=${jwt.sign({ id: 42, username: 'reviewer', agentId: 'main' }, jwtSecret, { algorithm: 'HS256' })}`;

for (const file of [db, `${db}-wal`, `${db}-shm`, cache, `${cache}-wal`, `${cache}-shm`]) {
  try { fs.unlinkSync(file); } catch {}
}
fs.rmSync(path.join(workspace, 'projects', project), { recursive: true, force: true });
fs.mkdirSync(path.join(workspace, 'projects'), { recursive: true });

function request(method, pathname, body = null, cookie = null) {
  return new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/json' };
    if (cookie) headers.cookie = cookie;
    const req = http.request({ hostname: '127.0.0.1', port: PORT, path: pathname, method, headers }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        let parsed = text;
        try { parsed = text ? JSON.parse(text) : null; } catch {}
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (body !== null) req.end(JSON.stringify(body));
    else req.end();
  });
}

async function waitReady(child) {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('server exited before readiness');
    try {
      if ((await request('GET', '/api/health')).status === 200) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('server readiness timeout');
}

async function main() {
  const child = spawn('node', ['server.js'], {
    cwd: __dirname,
    stdio: 'ignore',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      FLOWBOARD_PORT: String(PORT),
      OPENCLAW_WORKSPACE: workspace,
      FLOWBOARD_PROJECTS_DIR: path.join(workspace, 'projects'),
      HZL_DB_PATH: db,
      FLOWBOARD_POLICY_LEDGER_DIR: path.join(workspace, '.audit-t447-4'),
      JWT_SECRET: jwtSecret,
      ALLOWED_USER_IDS: '42',
      AUTH_ALWAYS: 'false',
      TELEGRAM_BOT_TOKEN: '123456:t447-4-test-bot',
      FLOWBOARD_TELEGRAM_AGENT_IDS: 'main',
    },
  });
  try {
    await waitReady(child);
    assert.equal((await request('POST', '/api/projects', { name: project })).status, 201);
    assert.equal((await request('PUT', `/api/projects/${project}/governance/mode`, { mode: 'enforce' }, humanCookie)).status, 200);

    const beforeSessions = await request('GET', `/api/specify/sessions?project=${project}`);
    const beforeTasks = await request('GET', `/api/projects/${project}/tasks`);
    const structuredDecisions = {
      scope: 'single backlog task',
      behavior: 'create after approval',
      constraints: 'preserve request context',
      resolved: true,
    };
    const blocked = await request('POST', `/api/projects/${project}/tasks`, {
      title: 'Recovered task',
      description: 'Created from a rejected direct request',
      priority: 'high',
      sourceContext: { channel: 'chat', requestId: 'req-447-4' },
      structuredDecisions,
    });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, 'SPECIFY_REQUIRED');
    assert.equal(blocked.body.specifyRequest.title, 'Recovered task');
    assert.equal(blocked.body.specifyRequest.description, 'Created from a rejected direct request');
    assert.equal(blocked.body.specifyRequest.priority, 'high');
    assert.deepEqual(blocked.body.specifyRequest.sourceContext, { channel: 'chat', requestId: 'req-447-4' });
    assert.deepEqual(blocked.body.specifyRequest.structuredDecisions, structuredDecisions);
    assert.equal(blocked.body.specifyRequest.creatorIdentity.kind, 'agent');
    const afterTasks = await request('GET', `/api/projects/${project}/tasks`);
    assert.equal(afterTasks.body.tasks.length, beforeTasks.body.tasks.length, 'enforce rejection creates zero tasks');
    const afterSessions = await request('GET', `/api/specify/sessions?project=${project}`);
    assert.equal(afterSessions.body.length, beforeSessions.body.length, 'rejection does not auto-create a Specify session');

    const createdSession = await request('POST', '/api/specify/sessions', {
      agentId: 'human', transport: 'dashboard', origin: 'chat',
      specifyRequest: blocked.body.specifyRequest,
    }, humanCookie);
    assert.equal(createdSession.status, 201);
    const session = createdSession.body.session;
    assert.deepEqual(session.specifyRequest, blocked.body.specifyRequest, 'reusable request is accepted unchanged');
    assert.deepEqual(session.structuredDecisions, structuredDecisions);

    const proposal = await request('POST', `/api/specify/sessions/${session.id}/answer`, {
      action: 'proposal',
      specContent: '# Recovered task\n\nApproved recovery.',
      taskBreakdown: [{ title: 'Recovered task', description: 'Approved recovery', priority: 'high' }],
    }, humanCookie);
    assert.equal(proposal.status, 200);
    const confirmed = await request('POST', `/api/specify/sessions/${session.id}/confirm`, { approved: true }, humanCookie);
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.createdTasks.length, 1);
    const persisted = await request('GET', `/api/projects/${project}/tasks`);
    const recovered = persisted.body.tasks.find(task => task.id === confirmed.body.createdTasks[0]);
    assert.equal(recovered.creationAudit.origin, 'specify');
    assert.deepEqual(recovered.creationAudit.structuredDecisions, structuredDecisions);
    assert.deepEqual(recovered.creationAudit.specifyRequest, blocked.body.specifyRequest);

    // Exception-created work is visible in the inbox and can only be closed
    // by the authenticated human principal.
    assert.equal((await request('PUT', `/api/projects/${project}/governance/mode`, { mode: 'compat' }, humanCookie)).status, 200);
    const source = await request('POST', `/api/projects/${project}/tasks`, { title: 'Delegation source', status: 'open' });
    assert.equal(source.status, 200);
    assert.equal((await request('POST', `/api/projects/${project}/tasks/${source.body.task.id}/claim`, { agent: 'worker-one' })).status, 200);
    assert.equal((await request('PUT', `/api/projects/${project}/governance/mode`, { mode: 'enforce' }, humanCookie)).status, 200);
    const delegated = await request('POST', '/api/workflows/delegate', {
      project, fromTaskId: source.body.task.id, title: 'Delegated exception', agent: 'worker-two',
    });
    assert.equal(delegated.status, 200);
    const exceptionTaskId = delegated.body.delegatedTask.id;
    const inbox = await request('GET', `/api/projects/${project}/exceptions?status=pending`);
    assert.ok(inbox.body.tasks.some(task => task.id === exceptionTaskId));
    const forgedReview = await request('POST', `/api/projects/${project}/tasks/${exceptionTaskId}/exception-review`);
    assert.equal(forgedReview.status, 403);
    const humanReview = await request('POST', `/api/projects/${project}/tasks/${exceptionTaskId}/exception-review`, { reviewer: 'forged', reviewedAt: '2000-01-01T00:00:00.000Z' }, humanCookie);
    assert.equal(humanReview.status, 200);
    assert.equal(humanReview.body.task.exceptionReview.status, 'reviewed');
    assert.equal(humanReview.body.task.exceptionReview.reviewer, 'telegram:42');
    const secondReview = await request('POST', `/api/projects/${project}/tasks/${exceptionTaskId}/exception-review`, null, humanCookie);
    assert.equal(secondReview.status, 409);

    console.log('T-447-4 enforce recovery tests: all passed');
  } finally {
    child.kill();
    // Keep the isolated test workspace clean so a later server boot cannot
    // report this fixture as project/filesystem drift.
    fs.rmSync(path.join(workspace, 'projects', project), { recursive: true, force: true });
    fs.rmSync(path.join(workspace, '.audit-t447-4'), { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
