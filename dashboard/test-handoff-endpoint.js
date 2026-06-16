'use strict';

/**
 * Integration test for the handoff endpoint (T-263, rewired in T-296).
 * Exercises the REAL server.js route (spawned), not a reimplementation —
 * the previous version defined its own express route, which is how the
 * markdown-vs-JSON drift went unnoticed.
 *
 * Run: node test-handoff-endpoint.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

let pass = 0, fail = 0;
const failures = [];
const ok = (c, m) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; failures.push(m); console.log(`  ❌ ${m}`); } };
const section = (t) => console.log(`\n## ${t}\n`);

const TEST_PROJECT = 'test-endpoint-handoff';
const TEST_ROOT = path.join(__dirname, 'test-workspace-endpoint');
const HZL_DB_PATH = path.join(TEST_ROOT, '.hzl', 'flowboard-test-endpoint.db');
const PORT = 18791;

if (fs.existsSync(HZL_DB_PATH)) { try { fs.unlinkSync(HZL_DB_PATH); } catch {} }
fs.mkdirSync(path.join(TEST_ROOT, 'projects'), { recursive: true });

function makeRequest(method, p, body = null) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ hostname: '127.0.0.1', port: PORT, path: p, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} },
      (res) => { let raw = ''; res.on('data', c => raw += c); res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: raw })); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

async function waitForServer() {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try { const r = await makeRequest('GET', '/api/projects'); if (r.statusCode === 200) return; } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('server did not start');
}

async function run() {
  const server = spawn('node', ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, HZL_DB_PATH, FLOWBOARD_PORT: PORT, OPENCLAW_WORKSPACE: TEST_ROOT,
      FLOWBOARD_PROJECTS_DIR: path.join(TEST_ROOT, 'projects'), NODE_ENV: 'test' },
    stdio: 'pipe',
  });
  await waitForServer();

  try {
    section('Test Handoff Endpoint (real server route)');

    await makeRequest('POST', '/api/projects', { name: TEST_PROJECT, displayName: 'Handoff endpoint test' });
    const created = await makeRequest('POST', `/api/projects/${TEST_PROJECT}/tasks`, {
      title: 'Test Task', priority: 'high', status: 'in-progress',
    });
    const taskId = JSON.parse(created.body).task.id;
    ok(!!taskId, `created task ${taskId}`);

    // Test 1: markdown by default
    const md = await makeRequest('GET', `/api/projects/${TEST_PROJECT}/tasks/${taskId}/handoff`);
    ok(md.statusCode === 200, `markdown request returns 200 (got ${md.statusCode})`);
    ok((md.headers['content-type'] || '').includes('text/markdown'), 'markdown request returns text/markdown content-type');

    // Test 2: contract marker + concrete target agent
    const md2 = await makeRequest('GET', `/api/projects/${TEST_PROJECT}/tasks/${taskId}/handoff?agentId=test-target-agent`);
    ok(md2.body.includes('flowboard-handoff-contract: v1'), 'markdown response includes contract marker');
    ok(md2.body.includes('test-target-agent'), 'markdown response embeds the concrete target agent');

    // Test 3: ?format=json backward compatibility
    const js = await makeRequest('GET', `/api/projects/${TEST_PROJECT}/tasks/${taskId}/handoff?format=json`);
    ok(js.statusCode === 200, `JSON request returns 200 (got ${js.statusCode})`);
    ok((js.headers['content-type'] || '').includes('application/json'), 'JSON request returns application/json content-type');
    const json = JSON.parse(js.body);
    ok(json.ok === true, 'JSON response has ok: true');
    ok('taskId' in json, 'JSON response includes taskId');

    // Test 4: 400 for non-existent task
    const missing = await makeRequest('GET', `/api/projects/${TEST_PROJECT}/tasks/T-999999/handoff`);
    ok(missing.statusCode === 400, `non-existent task returns 400 (got ${missing.statusCode})`);
  } catch (e) {
    fail++; console.error('Test error:', e.message);
  } finally {
    server.kill();
    console.log(`\n${'='.repeat(60)}\nPassed: ${pass}/${pass + fail}`);
    if (fail > 0) { console.log('Failures:'); failures.forEach(f => console.log(`  - ${f}`)); process.exit(1); }
    process.exit(0);
  }
}
run().catch(e => { console.error(e); process.exit(1); });
