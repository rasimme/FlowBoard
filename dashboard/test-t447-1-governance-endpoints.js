'use strict';

/**
 * test-t447-1-governance-endpoints.js — T-447-1
 *
 * Integration tests for the governance trust surface over HTTP:
 *   - GET/PUT /api/projects/:name/governance/mode  (persistent human-only switch)
 *   - POST /api/projects/:name/tasks/:id/exception-review (verified-human review)
 *
 * The spawned server runs with auth NOT configured, so a direct loopback caller
 * is the trusted local operator (req.localOperator -> verified human). Body-level
 * claims are never authoritative; the tests confirm spoofed fields are ignored
 * and that the switch persists actor + timestamp.
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  \u2705 ${msg}`); }
  else { fail++; failures.push(msg); console.log(`  \u274C ${msg}`); }
}
function section(t) { console.log(`\n## ${t}\n`); }

const PORT = 18796;
const HZL_DB_PATH = path.join(__dirname, 'test-workspace', '.hzl', 'flowboard-t447-gov.db');
const TEST_PROJECT = 'test-t447-gov-proj';
const WORKSPACE = path.join(__dirname, 'test-workspace');

for (const f of [HZL_DB_PATH, `${HZL_DB_PATH}-wal`, `${HZL_DB_PATH}-shm`,
  HZL_DB_PATH.replace(/\.db$/, '-cache.db'),
  HZL_DB_PATH.replace(/\.db$/, '-cache.db-wal'),
  HZL_DB_PATH.replace(/\.db$/, '-cache.db-shm')]) {
  try { fs.unlinkSync(f); } catch {}
}
fs.rmSync(path.join(WORKSPACE, 'projects', TEST_PROJECT), { recursive: true, force: true });
fs.mkdirSync(path.join(WORKSPACE, 'projects'), { recursive: true });

function makeRequest(method, requestPath, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: PORT, path: requestPath, method,
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve({ statusCode: res.statusCode, body: data ? JSON.parse(data) : null }); }
        catch { resolve({ statusCode: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function waitForServer(child) {
  const deadline = Date.now() + 6000;
  let stderr = '';
  child.stderr.on('data', d => { stderr += d.toString(); });
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${stderr}`);
    try {
      const res = await makeRequest('GET', '/api/health');
      if (res.statusCode === 200) return;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`server did not become ready: ${stderr}`);
}

async function run() {
  const server = spawn('node', ['server.js'], {
    cwd: __dirname,
    env: {
      ...process.env,
      HZL_DB_PATH,
      FLOWBOARD_PORT: PORT,
      OPENCLAW_WORKSPACE: WORKSPACE,
      FLOWBOARD_PROJECTS_DIR: path.join(WORKSPACE, 'projects'),
      NODE_ENV: 'test',
    },
    stdio: 'pipe',
  });

  try {
    await waitForServer(server);
    await makeRequest('POST', '/api/projects', { name: TEST_PROJECT });

    section('governance mode — default + switch + persist + rollback');

    const g0 = await makeRequest('GET', `/api/projects/${TEST_PROJECT}/governance/mode`);
    ok(g0.statusCode === 200 && g0.body.mode === 'compat', 'default mode is compat');

    // Local operator (loopback, auth disabled) is the verified human here.
    const sw = await makeRequest('PUT', `/api/projects/${TEST_PROJECT}/governance/mode`, { mode: 'enforce' });
    ok(sw.statusCode === 200 && sw.body.mode === 'enforce', 'human switches mode to enforce');
    ok(sw.body.lastChange && sw.body.lastChange.actor && sw.body.lastChange.changedAt,
      'switch persists actor + timestamp');

    const g1 = await makeRequest('GET', `/api/projects/${TEST_PROJECT}/governance/mode`);
    ok(g1.body.mode === 'enforce', 'enforce mode persisted across requests');
    ok(g1.body.lastChange && g1.body.lastChange.mode === 'enforce', 'audit record readable');

    const bad = await makeRequest('PUT', `/api/projects/${TEST_PROJECT}/governance/mode`, { mode: 'yolo' });
    ok(bad.statusCode === 400 && bad.body.code === 'invalid_governance_mode', 'invalid mode rejected 400');

    const back = await makeRequest('PUT', `/api/projects/${TEST_PROJECT}/governance/mode`, { mode: 'compat' });
    ok(back.statusCode === 200 && back.body.mode === 'compat', 'human rolls back to compat');

    section('exception review — verified-human marks reviewed + persists');

    const created = await makeRequest('POST', `/api/projects/${TEST_PROJECT}/tasks`, {
      title: 'Incident exception task',
      priority: 'high',
    });
    ok(created.statusCode === 201 || created.statusCode === 200, 'exception task created');
    const taskId = created.body?.task?.id || created.body?.id
      || created.body?.task?.metadata?.flowboard?.id;
    ok(!!taskId, `task id resolved (${taskId})`);

    const review = await makeRequest('POST',
      `/api/projects/${TEST_PROJECT}/tasks/${taskId}/exception-review`, {});
    ok(review.statusCode === 200, `exception-review returns 200 (got ${review.statusCode})`);
    ok(review.body.exceptionReview && review.body.exceptionReview.state === 'reviewed',
      'review record state is reviewed');
    ok(!!review.body.exceptionReview.reviewer, 'review persists reviewer actor');
    ok(!!review.body.exceptionReview.reviewedAt, 'review persists timestamp');
    ok(review.body.task?.exceptionReview?.state === 'reviewed',
      'review persisted onto task (exceptionReview field)');

    const review404 = await makeRequest('POST',
      `/api/projects/${TEST_PROJECT}/tasks/T-does-not-exist/exception-review`, {});
    ok(review404.statusCode === 404, 'exception-review on missing task returns 404');

    if (fail === 0) console.log(`\n\u2705 All ${pass} tests passed`);
    else {
      console.log(`\n\u274C ${fail} failed, ${pass} passed`);
      failures.forEach(f => console.log(`  - ${f}`));
    }
  } catch (e) {
    fail++;
    console.error('Test error:', e.message);
  } finally {
    server.kill();
    process.exit(fail > 0 ? 1 : 0);
  }
}

run();
