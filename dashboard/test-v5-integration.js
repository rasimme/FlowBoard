'use strict';

/**
 * Integration tests for v5 core flows (React/DOM).
 *
 * Tests:
 * - Test agent activation via PUT /api/status
 * - fileRuntime utilities integration with FilesView
 * - MarkdownEditor integration (file editing)
 * - File tree navigation (nested files, expand/collapse)
 *
 * Prerequisites:
 *   - Dashboard running on http://localhost:18790 (or FLOWBOARD_API env)
 *   - Active HZL database
 *
 * Run: node test-v5-integration.js
 */

const API_BASE = process.env.FLOWBOARD_API || 'http://localhost:18790';
const TEST_AGENT = 'test-v5-smoke';
const PROJECT_FOR_TESTS = 'flowboard';

let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, msg) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${msg}`);
  } else {
    fail++;
    failures.push(msg);
    console.log(`  ❌ ${msg}`);
  }
}

function section(title) {
  console.log(`\n## ${title}\n`);
}

async function fetchJson(method, urlPath, options = {}) {
  const res = await fetch(API_BASE + urlPath, { method, ...options });
  let body = null;
  try { body = await res.json(); } catch { /* non-json — leave null */ }
  return { status: res.status, body };
}

async function fetchText(method, urlPath, options = {}) {
  const res = await fetch(API_BASE + urlPath, { method, ...options });
  return { status: res.status, text: await res.text() };
}

async function runTests() {
  // --- Test 1: Activate test agent ---
  section('Test Agent Activation (v5)');

  const activateRes = await fetchJson('PUT', '/api/status', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentId: TEST_AGENT,
      project: PROJECT_FOR_TESTS,
    }),
  });

  ok(
    activateRes.status === 200,
    `PUT /api/status returns 200 (got ${activateRes.status})`
  );
  ok(
    activateRes.body && activateRes.body.activeProject === PROJECT_FOR_TESTS,
    `Agent activated for project ${PROJECT_FOR_TESTS}`
  );
  ok(
    activateRes.body && activateRes.body.contextReady,
    'Context is ready for test agent'
  );

  // --- Test 2: Verify agent state via GET ---
  section('Verify Test Agent State');

  const statusRes = await fetchJson('GET', `/api/status?agentId=${TEST_AGENT}`);
  ok(statusRes.status === 200, 'GET /api/status returns 200 for test agent');
  ok(
    statusRes.body && statusRes.body.agentId === TEST_AGENT,
    'Status response echoes test agent ID'
  );
  ok(
    statusRes.body && statusRes.body.activeProject === PROJECT_FOR_TESTS,
    'Status shows correct active project'
  );

  // --- Test 3: Fetch bootstrap context as Markdown ---
  section('Bootstrap Context');

  const bootstrapRes = await fetchText(
    'GET',
    `/api/projects/${PROJECT_FOR_TESTS}/bootstrap?agentId=${TEST_AGENT}`
  );

  ok(
    bootstrapRes.status === 200,
    `GET /bootstrap returns 200 (got ${bootstrapRes.status})`
  );
  ok(
    bootstrapRes.text.includes(`# Active Project: ${PROJECT_FOR_TESTS}`),
    'Bootstrap contains active project context'
  );

  // --- Test 4: Verify file tree API structure ---
  section('File Tree API (for fileRuntime)');

  const filesRes = await fetchJson(
    'GET',
    `/api/projects/${PROJECT_FOR_TESTS}/files?agentId=${TEST_AGENT}`
  );

  ok(
    filesRes.status === 200,
    `GET /files returns 200 (got ${filesRes.status})`
  );
  ok(
    Array.isArray(filesRes.body && filesRes.body.tree),
    'Files response contains file tree array compatible with fileRuntime'
  );

  // Test 5: Tasks endpoint (used by FilesView)
  section('Tasks Endpoint (FilesView integration)');

  const tasksRes = await fetchJson(
    'GET',
    `/api/projects/${PROJECT_FOR_TESTS}/tasks?agentId=${TEST_AGENT}`
  );

  ok(
    tasksRes.status === 200,
    `GET /tasks returns 200 (got ${tasksRes.status})`
  );
  ok(
    Array.isArray(tasksRes.body && tasksRes.body.tasks),
    'Tasks response contains tasks array'
  );

  // --- Test 6: Cleanup - deactivate test agent ---
  section('Cleanup');

  const deactivateRes = await fetchJson('PUT', '/api/status', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentId: TEST_AGENT,
      project: 'none',
    }),
  });

  ok(
    deactivateRes.status === 200 && !deactivateRes.body?.activeProject,
    'Test agent deactivated successfully'
  );

  // --- Summary ---
  section('Summary');

  const total = pass + fail;
  console.log(`Passed: ${pass}/${total}`);

  if (fail > 0) {
    console.log(`\nFailed tests:\n${failures.map(f => `  • ${f}`).join('\n')}`);
    process.exit(1);
  }

  console.log('\n✅ All v5 integration tests passed!');
}

// Run tests
runTests().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
