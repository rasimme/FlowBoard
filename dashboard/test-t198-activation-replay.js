#!/usr/bin/env node
'use strict';

const http = require('http');

const BASE = process.env.FLOWBOARD_TEST_BASE || 'http://127.0.0.1:18790';
const AGENT_ID = process.env.TEST_AGENT || `test-t198-replay-${Date.now()}`;
const PROJECT = process.env.PROJECT_FOR_TESTS || 'flowboard';

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); }
}
function assertEqual(actual, expected, msg) {
  assert(actual === expected, `${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function request(method, path, body) {
  const url = new URL(path, BASE);
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method,
      headers: payload ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      } : {},
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        contentType: res.headers['content-type'] || '',
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function parseByContract(res) {
  if (res.contentType.includes('application/json')) {
    return { kind: 'json', value: JSON.parse(res.text) };
  }
  if (res.contentType.includes('text/markdown') || res.contentType.includes('text/plain')) {
    return { kind: 'text', value: res.text };
  }
  return { kind: 'text', value: res.text };
}

async function pollReady() {
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await request('GET', `/api/status?agentId=${encodeURIComponent(AGENT_ID)}`);
    assert(res.contentType.includes('application/json'), `status poll ${attempt} returns JSON`);
    const parsed = parseByContract(res);
    assertEqual(parsed.kind, 'json', `status poll ${attempt} parsed as JSON`);
    last = parsed.value;
    if (last.contextReady === true) return last;
    if (attempt < 3) await new Promise(r => setTimeout(r, 500));
  }
  return last;
}

(async () => {
  console.log('## T-198 activation replay');
  try {
    // Start from inactive for this synthetic agent. This must not affect other agents.
    let res = await request('PUT', '/api/status', { agentId: AGENT_ID, project: null });
    assertEqual(res.status, 200, 'deactivate synthetic agent succeeds');
    assert(res.contentType.includes('application/json'), 'PUT /api/status success is JSON');
    let parsed = parseByContract(res);
    assertEqual(parsed.kind, 'json', 'deactivate parsed as JSON');
    assertEqual(parsed.value.agentId, AGENT_ID, 'deactivate echoes same agentId');
    assertEqual(parsed.value.activeProject, null, 'synthetic agent starts inactive');

    // Explicit activation path. It must not be swallowed by passive startup null state.
    res = await request('PUT', '/api/status', { agentId: AGENT_ID, project: PROJECT });
    assertEqual(res.status, 200, 'explicit activation succeeds');
    assert(res.contentType.includes('application/json'), 'PUT /api/status activation success is JSON');
    parsed = parseByContract(res);
    assertEqual(parsed.kind, 'json', 'activation parsed as JSON');
    assertEqual(parsed.value.agentId, AGENT_ID, 'activation echoes same agentId');
    assertEqual(parsed.value.activeProject, PROJECT, 'activation stores requested project');

    const ready = await pollReady();
    assertEqual(ready.agentId, AGENT_ID, 'status verification uses same agentId');
    assertEqual(ready.activeProject, PROJECT, 'status verification sees activated project');
    assertEqual(ready.contextReady, true, 'contextReady becomes true within bounded poll');

    res = await request('GET', `/api/projects/${encodeURIComponent(PROJECT)}/bootstrap`);
    assertEqual(res.status, 200, 'project context fetch succeeds');
    assert(res.contentType.includes('text/markdown') || res.contentType.includes('text/plain'), 'project context success is Markdown/plain text');
    parsed = parseByContract(res);
    assertEqual(parsed.kind, 'text', 'project context parsed as text, not JSON');
    assert(parsed.value.startsWith(`# Active Project: ${PROJECT}`), 'project context starts with active-project header');
    assert(parsed.value.trim().length > 1000, 'project context is non-empty/substantial');

    // Re-check without reactivating: same state, no activation loop required.
    res = await request('GET', `/api/status?agentId=${encodeURIComponent(AGENT_ID)}`);
    parsed = parseByContract(res);
    assertEqual(parsed.value.activeProject, PROJECT, 'final status remains active without reactivation loop');
  } catch (err) {
    failed++;
    console.error('  ❌ replay threw:', err && err.stack || err);
  } finally {
    try { await request('PUT', '/api/status', { agentId: AGENT_ID, project: null }); } catch {}
    console.log(`\n=== ${passed} passed, ${failed} failed ===`);
    process.exit(failed === 0 ? 0 : 1);
  }
})();
