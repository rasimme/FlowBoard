'use strict';

/**
 * Integration tests for T-168 (project-context hook live-inject)
 * and T-177 (per-agent API hardening).
 *
 * Runs against the live FlowBoard dashboard on the configured port.
 * Uses a dedicated synthetic agent identity ("test-agent-suite") so it
 * does not pollute production state. Cleans up by setting that agent's
 * active_project back to null at the end (the row remains for visibility
 * but is "no active project").
 *
 * Prerequisites:
 *   - Dashboard running on http://localhost:18790 (or FLOWBOARD_API env)
 *   - HZL_ENABLED=true on the server
 *
 * Run: node test-t168-t177-integration.js
 */

const path = require('path');
const fs = require('fs');

const API_BASE = process.env.FLOWBOARD_API || 'http://localhost:18790';
const TEST_AGENT = 'test-agent-suite';
const PROJECT_FOR_TESTS = 'flowboard';

const HOOK_HANDLER_PATH = path.resolve(__dirname, '..', 'hooks', 'project-context', 'handler.js');

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
  try { body = await res.json(); } catch { /* non-json (e.g. 400 with html) — leave null */ }
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// T-177: per-agent API hardening
// ---------------------------------------------------------------------------

async function testStatusGetRequiresAgentId() {
  section('T-177: GET /api/status requires agentId');

  const r1 = await fetchJson('GET', '/api/status');
  ok(r1.status === 400, `GET without agentId returns 400 (got ${r1.status})`);
  ok(r1.body && /agentId/i.test(r1.body.error || ''), `400 message mentions agentId`);

  const r2 = await fetchJson('GET', `/api/status?agentId=${TEST_AGENT}`);
  ok(r2.status === 200, `GET with ?agentId returns 200`);
  ok(r2.body && r2.body.agentId === TEST_AGENT, `response.agentId echoes the requested agent`);

  const r3 = await fetchJson('GET', '/api/status', {
    headers: { 'x-openclaw-agent-id': TEST_AGENT },
  });
  ok(r3.status === 200, `GET with x-openclaw-agent-id header returns 200`);
  ok(r3.body && r3.body.agentId === TEST_AGENT, `header path echoes agentId correctly`);
}

async function testStatusPutRequiresAgentId() {
  section('T-177: PUT /api/status requires agentId in body');

  const r1 = await fetchJson('PUT', '/api/status', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: PROJECT_FOR_TESTS }),
  });
  ok(r1.status === 400, `PUT without agentId returns 400 (got ${r1.status})`);

  const r2 = await fetchJson('PUT', '/api/status', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: PROJECT_FOR_TESTS, agentId: TEST_AGENT }),
  });
  ok(r2.status === 200, `PUT with body.agentId returns 200`);
  ok(r2.body && r2.body.activeProject === PROJECT_FOR_TESTS, `PUT response reflects activated project`);

  // Verify via GET that the state was actually written
  const r3 = await fetchJson('GET', `/api/status?agentId=${TEST_AGENT}`);
  ok(r3.body && r3.body.activeProject === PROJECT_FOR_TESTS, `GET shows the activated project after PUT`);
}

async function testProjectsResponseShape() {
  section('T-177: GET /api/projects has no activeProject field');

  const r = await fetchJson('GET', '/api/projects');
  ok(r.status === 200, `GET /api/projects returns 200`);
  ok(r.body && Array.isArray(r.body.projects), `response has projects array`);
  ok(r.body && !('activeProject' in r.body), `response has NO activeProject field (multi-agent: read /api/agents instead)`);
}

async function testAgentsListing() {
  section('T-177: /api/agents shows lazy-registered test agent');

  const r = await fetchJson('GET', '/api/agents');
  ok(r.status === 200, `GET /api/agents returns 200`);
  const agents = r.body?.agents || [];
  const testAgentRow = agents.find(a => a.agent_id === TEST_AGENT);
  ok(testAgentRow, `${TEST_AGENT} is registered (lazy-registered via PUT /api/status)`);
  ok(testAgentRow && testAgentRow.active_project === PROJECT_FOR_TESTS,
    `${TEST_AGENT}.active_project = ${PROJECT_FOR_TESTS}`);
}

async function testForeignAgentIsolation() {
  section('T-177: Foreign-agent isolation (no cross-pollination)');

  // Each agent's status is independent. Activate flowboard for TEST_AGENT,
  // verify other-agent queries don't see TEST_AGENT's state spilling over.
  const otherAgent = 'test-agent-isolation-probe';

  const r1 = await fetchJson('GET', `/api/status?agentId=${otherAgent}`);
  ok(r1.status === 200, `GET for unknown agent returns 200`);
  ok(r1.body && r1.body.activeProject === null,
    `Unknown agent has activeProject=null (no fallback to other agent's state)`);
  ok(r1.body && r1.body.agentId === otherAgent,
    `Response echoes the requested agentId, not a default`);

  // Cross-check: TEST_AGENT still has its own state untouched
  const r2 = await fetchJson('GET', `/api/status?agentId=${TEST_AGENT}`);
  ok(r2.body && r2.body.activeProject === PROJECT_FOR_TESTS,
    `TEST_AGENT state unaffected by foreign-agent query`);
}

// ---------------------------------------------------------------------------
// T-179: External-Agent Discovery — /api/info endpoint
// ---------------------------------------------------------------------------

async function testInfoEndpointPublic() {
  section('T-179-2: GET /api/info is public (no auth)');

  const r = await fetchJson('GET', '/api/info');
  ok(r.status === 200, `GET /api/info returns 200 without auth (got ${r.status})`);

  const d = r.body || {};
  ok(d.service === 'FlowBoard', `service field is "FlowBoard" (got ${d.service})`);
  ok(typeof d.version === 'string' && d.version.length > 0, `version is non-empty string`);
  ok(typeof d.api_base === 'string' && d.api_base.includes('://'), `api_base looks like a URL`);

  ok(d.endpoints && typeof d.endpoints === 'object', `endpoints object is present`);
  for (const key of ['health', 'info', 'agents', 'status', 'projects', 'bootstrap', 'rules', 'tasks']) {
    ok(d.endpoints && key in d.endpoints, `endpoints.${key} is documented`);
  }

  ok(typeof d.agent_id_convention === 'string' && d.agent_id_convention.length > 20,
    `agent_id_convention guidance is present`);
  ok(typeof d.anti_trust_rule === 'string' && d.anti_trust_rule.length > 20,
    `anti_trust_rule guidance is present`);
  ok(typeof d.trigger_snippet === 'string' && d.trigger_snippet.length > 1000,
    `trigger_snippet is embedded (got ${d.trigger_snippet?.length || 0} bytes)`);
  ok(d.trigger_snippet && d.trigger_snippet.includes('FlowBoard external trigger'),
    `trigger_snippet contains the expected marker`);
}

// ---------------------------------------------------------------------------
// T-168: project-context hook live-inject
// ---------------------------------------------------------------------------

async function loadHandler() {
  // Dynamic import (handler is ESM)
  const mod = await import(HOOK_HANDLER_PATH);
  return mod.default;
}

function makeBootstrapEvent({ agentId, workspaceDir, existingFiles = [] }) {
  return {
    type: 'agent',
    action: 'bootstrap',
    sessionKey: `agent:${agentId}:main`,
    context: {
      agentId,
      workspaceDir,
      bootstrapFiles: existingFiles,
    },
  };
}

function getBootstrapEntry(event) {
  return event.context.bootstrapFiles.find(f => f && f.name === 'BOOTSTRAP.md') || null;
}

async function testHookActiveProject() {
  section('T-168: agent:bootstrap with active project produces full content');

  const handler = await loadHandler();
  // Use TEST_AGENT — it has flowboard active per the previous T-177 PUT test.
  // We pretend it has a workspace at workspace-test-agent-suite (doesn't need
  // to exist — the hook only uses workspaceDir to derive agentId).
  const fakeWorkspace = '/home/jetson/.openclaw/workspace-' + TEST_AGENT;
  const event = makeBootstrapEvent({
    agentId: TEST_AGENT,
    workspaceDir: fakeWorkspace,
    existingFiles: [
      { name: 'BOOTSTRAP.md', path: `${fakeWorkspace}/BOOTSTRAP.md`, content: 'STALE', missing: false },
      { name: 'AGENTS.md', path: `${fakeWorkspace}/AGENTS.md`, content: 'unrelated', missing: false },
    ],
  });

  await handler(event);
  const bs = getBootstrapEntry(event);

  ok(bs, `BOOTSTRAP.md entry exists in bootstrapFiles`);
  ok(bs && bs.content && bs.content.length > 1000, `Content is substantial (>1000 B), got ${bs?.content?.length}`);
  ok(bs && bs.content.startsWith(`# Active Project: ${PROJECT_FOR_TESTS}`),
    `Content starts with "# Active Project: ${PROJECT_FOR_TESTS}"`);
  ok(bs && bs.content.includes(`agentId\` is: \`${TEST_AGENT}\``),
    `Identity section names ${TEST_AGENT}`);
  ok(bs && bs.content.includes('## Project Rules (lazy-load)'),
    `Rules manifest is included`);
  ok(bs && !bs.content.includes('STALE'),
    `Stale content from existing entry is replaced (not appended)`);

  const agentsEntry = event.context.bootstrapFiles.find(f => f && f.name === 'AGENTS.md');
  ok(agentsEntry && agentsEntry.content === 'unrelated',
    `Other bootstrap files (AGENTS.md) untouched`);
}

async function testHookNoActiveProject() {
  section('T-168/T-168-5: agent:bootstrap without active project — explicit "No Active Project"');

  const handler = await loadHandler();
  // Use a brand-new agent that has no row yet → activeProject = null
  const freshAgent = 'test-agent-no-project-' + Date.now();
  const fakeWorkspace = `/home/jetson/.openclaw/workspace-${freshAgent}`;
  const event = makeBootstrapEvent({
    agentId: freshAgent,
    workspaceDir: fakeWorkspace,
    existingFiles: [
      { name: 'BOOTSTRAP.md', path: `${fakeWorkspace}/BOOTSTRAP.md`, content: 'STALE', missing: false },
    ],
  });

  await handler(event);
  const bs = getBootstrapEntry(event);

  ok(bs, `BOOTSTRAP.md entry exists`);
  ok(bs && bs.content.startsWith('# No Active Project'),
    `Content starts with "# No Active Project" header (T-168-5 anti-inference)`);
  ok(bs && bs.content.includes('Do **not** infer'),
    `Anti-inference rule text is present`);
  ok(bs && bs.content.includes(`agentId\` is: \`${freshAgent}\``),
    `Identity section still names ${freshAgent}`);
  // Content may MENTION "# Active Project: <name>" inside the anti-inference
  // explanation (referencing the header as a string literal); but it must NOT
  // start with that header — that would be an actual active-project claim.
  ok(bs && !bs.content.startsWith('# Active Project:'),
    `Content does not start with "# Active Project:" (no actual active-project claim)`);
  ok(bs && bs.content.length < 2000,
    `Content is small (~795B for no-project case, got ${bs?.content?.length})`);
}

async function testHookWorkspaceWinsOverContextAgentId() {
  section('T-168 review-finding: workspace-derived agentId beats context.agentId');

  const handler = await loadHandler();
  // Wrong agentId in event context, correct workspace dir for an active
  // OpenClaw agent. The hook must derive from the workspace, not trust the
  // (potentially stale/mis-routed) context field.
  const ev = makeBootstrapEvent({
    agentId: 'wrong-agent-suite',                                    // wrong/stale
    workspaceDir: '/home/jetson/.openclaw/workspace-' + TEST_AGENT,  // canonical
    existingFiles: [],
  });
  await handler(ev);
  const bs = getBootstrapEntry(ev);
  ok(bs && bs.content.includes(`agentId\` is: \`${TEST_AGENT}\``),
    `Identity uses workspace-derived "${TEST_AGENT}", not context.agentId "wrong-agent-suite"`);
  ok(bs && !bs.content.includes('wrong-agent-suite'),
    `Wrong agentId from context never leaks into the bootstrap content`);
}

async function testHookWorkspaceConvention() {
  section('T-168: agentId is derived from workspace dir name');

  const handler = await loadHandler();

  // workspace-foo → agentId "foo"
  const ev1 = makeBootstrapEvent({
    agentId: undefined,  // omit; handler must derive from workspaceDir
    workspaceDir: '/home/jetson/.openclaw/workspace-fresh-derived-test',
    existingFiles: [],
  });
  await handler(ev1);
  const bs1 = getBootstrapEntry(ev1);
  ok(bs1 && bs1.content.includes(`agentId\` is: \`fresh-derived-test\``),
    `workspace-X → derived agentId "X"`);

  // bare "workspace" → agentId "main"
  const ev2 = makeBootstrapEvent({
    agentId: undefined,
    workspaceDir: '/home/jetson/.openclaw/workspace',
    existingFiles: [],
  });
  await handler(ev2);
  const bs2 = getBootstrapEntry(ev2);
  ok(bs2 && bs2.content.includes(`agentId\` is: \`main\``),
    `bare "workspace" → derived agentId "main"`);
}

async function testHookIgnoresOtherEvents() {
  section('T-168: handler returns silently for non-bootstrap events');

  const handler = await loadHandler();
  const event = {
    type: 'command',
    action: 'new',
    sessionKey: 'agent:test:main',
    context: {
      agentId: TEST_AGENT,
      workspaceDir: '/home/jetson/.openclaw/workspace-test',
      bootstrapFiles: [],
    },
  };
  await handler(event);
  ok(event.context.bootstrapFiles.length === 0,
    `command:new event leaves bootstrapFiles untouched`);

  const event2 = {
    type: 'agent',
    action: 'something-else',
    sessionKey: 'agent:test:main',
    context: { bootstrapFiles: [] },
  };
  await handler(event2);
  ok(event2.context.bootstrapFiles.length === 0,
    `agent:something-else event leaves bootstrapFiles untouched`);
}

async function testHookDoesNotWriteToDisk() {
  section('T-181-3: hook never creates BOOTSTRAP.md (or any other file) on disk');

  const handler = await loadHandler();
  const tmpRoot = fs.mkdtempSync(path.join(require('os').tmpdir(), 'fb-hook-test-'));
  // Make the basename match the workspace-<id> convention so derive works
  const tmpWorkspace = path.join(tmpRoot, 'workspace-anti-stale-probe');
  fs.mkdirSync(tmpWorkspace, { recursive: true });

  // Pre-condition: empty workspace dir
  const beforeFiles = fs.readdirSync(tmpWorkspace);
  ok(beforeFiles.length === 0, `tmp workspace starts empty (got ${beforeFiles.length} entries)`);

  const event = makeBootstrapEvent({
    agentId: undefined,
    workspaceDir: tmpWorkspace,
    existingFiles: [
      { name: 'BOOTSTRAP.md', path: path.join(tmpWorkspace, 'BOOTSTRAP.md'), content: 'STALE', missing: false },
    ],
  });

  await handler(event);

  // Post-condition: still no files written to the workspace
  const afterFiles = fs.readdirSync(tmpWorkspace);
  ok(afterFiles.length === 0, `tmp workspace still empty after handler (got ${afterFiles.length} entries: ${afterFiles.join(',')})`);

  // The bootstrap content should however be in the in-memory array
  const bs = getBootstrapEntry(event);
  ok(bs && bs.content && bs.content.length > 100,
    `in-memory bootstrap entry was populated (${bs?.content?.length || 0} bytes)`);

  // Cleanup
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

async function testHookSourceHasNoWritePatterns() {
  section('T-181-3: regression guard — handler.js source must not contain fs.write* patterns');

  const src = fs.readFileSync(HOOK_HANDLER_PATH, 'utf8');

  // Block any future re-introduction of disk writes via the obvious APIs
  const writePatterns = [
    /writeFileSync\s*\(/,
    /writeFile\s*\(/,
    /appendFileSync\s*\(/,
    /appendFile\s*\(/,
    /createWriteStream\s*\(/,
  ];
  for (const pat of writePatterns) {
    ok(!pat.test(src), `handler source has no ${pat.source} pattern`);
  }

  // The fs import line itself should be read-only (readFileSync, existsSync, readdirSync — no write).
  const importLine = src.match(/import\s+\{([^}]+)\}\s+from\s+["']node:fs["']/)?.[1] || '';
  ok(!/write|append|createWriteStream/i.test(importLine),
    `fs imports are read-only only (import line: "${importLine.trim()}")`);
}

async function testHookHandlesMissingBootstrapFiles() {
  section('T-168: handler is robust when context.bootstrapFiles is missing/invalid');

  const handler = await loadHandler();
  // No bootstrapFiles at all
  const event = {
    type: 'agent',
    action: 'bootstrap',
    sessionKey: 'agent:test:main',
    context: {
      agentId: TEST_AGENT,
      workspaceDir: '/home/jetson/.openclaw/workspace-test',
      // bootstrapFiles intentionally missing
    },
  };
  let threw = false;
  try { await handler(event); } catch { threw = true; }
  ok(!threw, `handler does not throw on missing bootstrapFiles`);
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

async function cleanup() {
  section('Cleanup (zero-footprint via T-180 DELETE)');
  // Drop TEST_AGENT entirely from flowboard_agents — keeps the test suite
  // zero-footprint instead of leaving an inert row behind.
  const r = await fetchJson('DELETE', `/api/agents/${TEST_AGENT}`);
  ok(r.status === 200 && r.body?.deleted === true,
    `DELETE /api/agents/${TEST_AGENT} → deleted: true`);

  // Verify the row really is gone
  const list = await fetchJson('GET', '/api/agents');
  const stillThere = (list.body?.agents || []).some(a => a.agent_id === TEST_AGENT);
  ok(!stillThere, `${TEST_AGENT} no longer present in /api/agents`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`# T-168 + T-177 Integration Tests`);
  console.log(`API base: ${API_BASE}`);
  console.log(`Handler:  ${HOOK_HANDLER_PATH}`);

  // Sanity-check: dashboard reachable
  const health = await fetchJson('GET', '/api/health');
  if (health.status !== 200) {
    console.error(`\n❌ Dashboard not reachable at ${API_BASE} (got ${health.status})`);
    process.exit(2);
  }

  try {
    await testStatusGetRequiresAgentId();
    await testStatusPutRequiresAgentId();
    await testProjectsResponseShape();
    await testAgentsListing();
    await testForeignAgentIsolation();
    await testInfoEndpointPublic();
    await testHookActiveProject();
    await testHookNoActiveProject();
    await testHookWorkspaceWinsOverContextAgentId();
    await testHookWorkspaceConvention();
    await testHookIgnoresOtherEvents();
    await testHookDoesNotWriteToDisk();
    await testHookSourceHasNoWritePatterns();
    await testHookHandlesMissingBootstrapFiles();
  } finally {
    await cleanup();
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  if (fail > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('\n❌ FATAL:', err);
  process.exit(2);
});
