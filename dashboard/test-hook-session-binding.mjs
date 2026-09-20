/**
 * T-487-2 — the project-context hook forwards the OpenClaw session key and
 * renders the resolved binding (ADR-0039).
 *
 * `agent:bootstrap` carries an optional `sessionKey`. The hook must pass it to
 * `GET /api/status` so a session-scoped activation reaches the run that made
 * it, render `Binding: session|agent` in the injected bootstrap, and never
 * print the raw session key into model context. The T-168 workspace-first
 * agentId precedence must stay exactly as it is.
 *
 * Run: node test-hook-session-binding.mjs
 */
import { createProjectContextHandler } from '../hooks/project-context/handler.js';

let passed = 0;
let failed = 0;
const failures = [];

function check(cond, msg) {
  if (cond) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; failures.push(msg); console.error(`  ❌ ${msg}`); }
}

function section(name) { console.log(`\n## ${name}`); }

const BASE = 'http://127.0.0.1:19999';
const SESSION_KEY = 'agent:dev-botti:telegram:4711';

/**
 * Run the hook against a stubbed FlowBoard API.
 * Returns { content, urls } — the injected BOOTSTRAP.md body and every URL the
 * hook requested.
 */
async function runHook({ context, status }) {
  const urls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    if (String(url).includes('/api/status')) {
      return { ok: true, status: 200, json: async () => status };
    }
    if (String(url).includes('/tasks')) {
      return { ok: true, status: 200, json: async () => ({ tasks: [] }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  try {
    const handler = createProjectContextHandler({ dashboardBaseUrl: BASE });
    const event = {
      type: 'agent',
      action: 'bootstrap',
      context: { bootstrapFiles: [], ...context },
    };
    await handler(event);
    const entry = event.context.bootstrapFiles.find(f => f?.name === 'BOOTSTRAP.md');
    return { content: entry?.content || '', urls };
  } finally {
    globalThis.fetch = realFetch;
  }
}

const statusUrl = (urls) => urls.find(u => u.includes('/api/status')) || '';

// ---------------------------------------------------------------------------
section('no sessionKey in context — today\'s request, unchanged');
// ---------------------------------------------------------------------------
{
  const { content, urls } = await runHook({
    context: { workspaceDir: '/home/op/.openclaw/workspace' },
    status: { activeProject: 'flowboard', agentId: 'main', binding: 'agent', contextReady: true },
  });
  const url = statusUrl(urls);
  check(url.includes('agentId=main'), 'status request carries the agentId');
  check(!url.includes('sessionKey'), 'no sessionKey parameter when the context has none');
  check(content.includes('# Active Project: flowboard'), 'active project header is rendered');
  check(content.includes('Binding: agent'), 'agent binding is rendered');
}

// ---------------------------------------------------------------------------
section('sessionKey in context — forwarded and encoded');
// ---------------------------------------------------------------------------
{
  const { content, urls } = await runHook({
    context: { workspaceDir: '/home/op/.openclaw/workspace-dev-botti', sessionKey: SESSION_KEY },
    status: { activeProject: 'creon', agentId: 'dev-botti', binding: 'session', sessionKey: SESSION_KEY, contextReady: true },
  });
  const url = statusUrl(urls);
  check(url.includes(`sessionKey=${encodeURIComponent(SESSION_KEY)}`), 'sessionKey is appended URL-encoded');
  check(url.includes('agentId=dev-botti'), 'agentId is still the workspace-derived id');
  check(content.includes('Binding: session'), 'session binding is rendered');
  check(!content.includes(SESSION_KEY), 'the raw session key is NOT printed into the bootstrap text');
  check(!content.includes('4711'), 'no fragment of the session key leaks into the bootstrap text');
}

// ---------------------------------------------------------------------------
section('agentId precedence stays workspace-first (T-168)');
// ---------------------------------------------------------------------------
{
  const { content, urls } = await runHook({
    context: { workspaceDir: '/home/op/.openclaw/workspace-dev-botti', agentId: 'main', sessionKey: SESSION_KEY },
    status: { activeProject: 'creon', agentId: 'dev-botti', binding: 'session', contextReady: true },
  });
  check(statusUrl(urls).includes('agentId=dev-botti'), 'workspace-derived agentId still wins over context.agentId');
  check(content.includes('`dev-botti`'), 'the Identity section shows the workspace-derived id');
}
{
  const { urls } = await runHook({
    context: { agentId: 'claude-code', sessionKey: SESSION_KEY },
    status: { activeProject: null, binding: null, contextReady: false },
  });
  check(statusUrl(urls).includes('agentId=claude-code'), 'context.agentId is used when no workspace id can be derived');
}

// ---------------------------------------------------------------------------
section('invalid / absent session keys are not forwarded');
// ---------------------------------------------------------------------------
{
  for (const [value, label] of [[42, 'non-string'], ['', 'empty string'], ['   ', 'whitespace only'], ['a\u0000b', 'control character']]) {
    const { urls } = await runHook({
      context: { workspaceDir: '/home/op/.openclaw/workspace', sessionKey: value },
      status: { activeProject: 'flowboard', agentId: 'main', binding: 'agent', contextReady: true },
    });
    check(!statusUrl(urls).includes('sessionKey'), `${label} sessionKey is dropped instead of forwarded`);
  }
}

// ---------------------------------------------------------------------------
section('no active project / legacy server without binding');
// ---------------------------------------------------------------------------
{
  const { content } = await runHook({
    context: { workspaceDir: '/home/op/.openclaw/workspace', sessionKey: SESSION_KEY },
    status: { activeProject: null, agentId: 'main', binding: null, contextReady: false },
  });
  check(content.includes('# No Active Project'), 'no-project header is unchanged');
  check(!content.includes('Binding:'), 'no binding line without an active project');
}
{
  // A FlowBoard server from before T-487-2 answers without `binding`.
  const { content } = await runHook({
    context: { workspaceDir: '/home/op/.openclaw/workspace' },
    status: { activeProject: 'flowboard', agentId: 'main', contextReady: true },
  });
  check(content.includes('# Active Project: flowboard'), 'legacy status response still injects the project');
  check(!content.includes('Binding:'), 'no binding line when the server does not report one');
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failed > 0) failures.forEach(f => console.log(`  - ${f}`));
process.exit(failed === 0 ? 0 : 1);
