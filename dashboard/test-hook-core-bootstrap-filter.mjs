/**
 * T-501 — the project-context entry survives OpenClaw core's BOOTSTRAP.md rules.
 *
 * OpenClaw owns the name `BOOTSTRAP.md` for its one-shot onboarding file and
 * applies two rules that silently dropped FlowBoard's injected context while
 * it used that name:
 *
 *   1. Setup-completed filter. `filterCompletedWorkspaceBootstrapFile` in
 *      `src/agents/bootstrap-files.ts` drops an entry whose `name` is
 *      "BOOTSTRAP.md" and whose resolved path is `<workspaceDir>/BOOTSTRAP.md`
 *      once the workspace is setup-completed. `resolveBootstrapFiles` (same
 *      file) runs it again AFTER the `agent:bootstrap` hooks
 *      (`applyBootstrapHookOverrides`, `src/agents/bootstrap-hooks.ts`).
 *   2. Basename strip. `src/agents/system-prompt-context-files.ts`
 *      (`isBootstrapContextFile`), `src/agents/cli-runner/prepare.ts` and
 *      `src/agents/embedded-agent-runner/run/attempt-bootstrap-prepare.ts`
 *      remove every context file matching /(^|[\\/])BOOTSTRAP\.md$/i unless
 *      bootstrap mode is "full" — and treat a non-empty one as "onboarding
 *      pending".
 *
 * Verified against OpenClaw 2026.7.1 and 2026.9.6. This test re-implements
 * both rules and proves the FlowBoard entry passes them, and that a user's
 * real BOOTSTRAP.md entry is left exactly as the loader built it.
 *
 * Run: node test-hook-core-bootstrap-filter.mjs
 */
import path from 'node:path';
import {
  createProjectContextHandler,
  FLOWBOARD_CONTEXT_FILENAME,
} from '../hooks/project-context/handler.js';

let passed = 0;
let failed = 0;
const failures = [];

function check(cond, msg) {
  if (cond) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; failures.push(msg); console.error(`  ❌ ${msg}`); }
}

function section(name) { console.log(`\n## ${name}`); }

const BASE = 'http://127.0.0.1:19999';
const WORKSPACE = '/home/op/.openclaw/workspace-probe';

async function runHook(bootstrapFiles, { workspaceDir = WORKSPACE } = {}) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/api/status')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ activeProject: 'demo', agentId: 'probe', binding: 'agent', contextReady: true }),
      };
    }
    if (String(url).includes('/tasks')) {
      return { ok: true, status: 200, json: async () => ({ tasks: [] }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  try {
    const handler = createProjectContextHandler({ dashboardBaseUrl: BASE, projectsDir: '/nonexistent-flowboard-projects' });
    const event = { type: 'agent', action: 'bootstrap', context: { workspaceDir, bootstrapFiles } };
    await handler(event);
    return event.context.bootstrapFiles;
  } finally {
    globalThis.fetch = realFetch;
  }
}

// --- Re-implementation of the two core rules (see header for sources) ------

function resolveEntryPath(pathValue, workspaceRoot) {
  return path.isAbsolute(pathValue) ? path.resolve(pathValue) : path.resolve(workspaceRoot, pathValue);
}

function coreSetupCompletedFilter(files, workspaceDir) {
  const workspaceRoot = path.resolve(workspaceDir);
  const rootBootstrapPath = path.join(workspaceRoot, 'BOOTSTRAP.md');
  return files.filter((file) => {
    if (file.name !== 'BOOTSTRAP.md') return true;
    const pathValue = typeof file.path === 'string' ? file.path.trim() : '';
    if (!pathValue) return true;
    return resolveEntryPath(pathValue, workspaceRoot) !== rootBootstrapPath;
  });
}

function coreBasenameStrip(files) {
  return files.filter((file) => !/(^|[\\/])BOOTSTRAP\.md$/iu.test(String(file.path).trim()));
}

const isFlowBoard = (f) => f && f.name === FLOWBOARD_CONTEXT_FILENAME;

// ---------------------------------------------------------------------------
section('the injected entry does not use the core-owned BOOTSTRAP.md name');
// ---------------------------------------------------------------------------
{
  const files = await runHook([]);
  const entry = files.find(isFlowBoard);
  check(Boolean(entry), `an entry named ${FLOWBOARD_CONTEXT_FILENAME} is injected`);
  check(entry && entry.name.toLowerCase() !== 'bootstrap.md', 'entry name is not BOOTSTRAP.md (any case)');
  check(entry && path.basename(entry.path).toLowerCase() !== 'bootstrap.md', 'entry path basename is not BOOTSTRAP.md (any case)');
  check(entry && path.dirname(entry.path) === WORKSPACE, 'entry path lives directly inside workspaceDir');
  check(entry && entry.missing === false, 'entry is marked missing:false');
  check(entry && entry.content.startsWith('# Active Project: demo'), 'entry carries the live project context');
}

// ---------------------------------------------------------------------------
section('a real BOOTSTRAP.md entry is left untouched');
// ---------------------------------------------------------------------------
{
  const userBootstrap = { name: 'BOOTSTRAP.md', path: path.join(WORKSPACE, 'BOOTSTRAP.md'), content: 'onboarding', missing: false };
  const agents = { name: 'AGENTS.md', path: path.join(WORKSPACE, 'AGENTS.md'), content: 'agents', missing: false };
  const files = await runHook([agents, userBootstrap]);
  const stillThere = files.find(f => f.name === 'BOOTSTRAP.md');
  check(stillThere === userBootstrap, 'the original BOOTSTRAP.md entry object is still in bootstrapFiles');
  check(stillThere && stillThere.content === 'onboarding', 'its content is unchanged');
  check(files.find(f => f.name === 'AGENTS.md') === agents, 'AGENTS.md is untouched');
  check(files.filter(isFlowBoard).length === 1, 'exactly one FlowBoard entry is added next to it');
  check(files.length === 3, `bootstrapFiles grew by one (got ${files.length})`);
}

// ---------------------------------------------------------------------------
section('an existing FlowBoard-named or FlowBoard-path entry is replaced, not duplicated');
// ---------------------------------------------------------------------------
{
  const onDisk = { name: FLOWBOARD_CONTEXT_FILENAME, path: path.join(WORKSPACE, FLOWBOARD_CONTEXT_FILENAME), content: 'STALE', missing: false };
  const files = await runHook([onDisk]);
  check(files.filter(isFlowBoard).length === 1, 'a same-name entry is replaced in place');
  check(!files.some(f => f.content === 'STALE'), 'stale content is gone');

  const samePath = { name: 'other-label', path: path.join(WORKSPACE, FLOWBOARD_CONTEXT_FILENAME), content: 'STALE', missing: false };
  const files2 = await runHook([samePath]);
  check(files2.length === 1 && isFlowBoard(files2[0]), 'a same-path entry is replaced (core would dedupe by path anyway)');
}

// ---------------------------------------------------------------------------
section('the FlowBoard entry survives both core rules');
// ---------------------------------------------------------------------------
{
  const userBootstrap = { name: 'BOOTSTRAP.md', path: path.join(WORKSPACE, 'BOOTSTRAP.md'), content: 'onboarding', missing: false };
  const files = await runHook([userBootstrap]);

  const afterSetup = coreSetupCompletedFilter(files, WORKSPACE);
  check(afterSetup.some(isFlowBoard), 'kept by the setup-completed filter');
  check(!afterSetup.some(f => f.name === 'BOOTSTRAP.md'), 'sanity: the filter still drops the real BOOTSTRAP.md');

  const afterStrip = coreBasenameStrip(afterSetup);
  check(afterStrip.some(isFlowBoard), 'kept by the BOOTSTRAP.md basename strip');

  const relative = await runHook([], { workspaceDir: 'relative-ws' });
  check(coreBasenameStrip(coreSetupCompletedFilter(relative, 'relative-ws')).some(isFlowBoard),
    'kept for a relative workspaceDir too');

  // Guard the rules themselves: the old entry shape is exactly what core drops.
  const legacyShape = { name: 'BOOTSTRAP.md', path: path.join(WORKSPACE, 'BOOTSTRAP.md'), content: 'x', missing: false };
  check(coreSetupCompletedFilter([legacyShape], WORKSPACE).length === 0, 'sanity: the pre-T-501 entry shape is dropped by the setup filter');
  check(coreBasenameStrip([{ ...legacyShape, path: '/elsewhere/bootstrap.MD' }]).length === 0, 'sanity: the strip is case-insensitive and directory-independent');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('Failures:\n' + failures.map(f => `  - ${f}`).join('\n'));
  process.exit(1);
}
