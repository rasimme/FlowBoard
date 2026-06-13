/**
 * DOM-less smoke tests for the Canvas migration UI (T-344-4).
 *
 * Pattern: test-v5-components-smoke.mjs — no browser, no jsdom. The .jsx
 * component is loaded through a sucrase-based node module hook (sucrase ships
 * with the dashboard dependency tree), so the real exports are tested:
 *
 *   1. Banner visibility logic (shouldShowBanner)
 *   2. "Later" session flag (sessionStorage contract, fake storage)
 *   3. Status fetch + run request against a mocked fetch (URL/method/body)
 *   4. Result mapping from a mocked run response (applyRunResults)
 *   5. SSR render of the banner (react-dom/server, no DOM needed)
 *   6. Source assertions (App.jsx mount, library components, English strings)
 *
 * Run: node test-canvas-migration-ui.mjs
 */

import assert from 'node:assert/strict';
import { register, createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

// -----------------------------------------------------------------------------
// JSX loader hook: transform .jsx files with sucrase on import.
// -----------------------------------------------------------------------------

const hooksSource = `
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(${JSON.stringify(import.meta.url)});
const { transform } = require('sucrase');
export async function load(url, context, nextLoad) {
  if (url.endsWith('.jsx')) {
    const source = readFileSync(new URL(url), 'utf8');
    const { code } = transform(source, {
      transforms: ['jsx'],
      jsxRuntime: 'automatic',
      production: true,
      filePath: url,
    });
    return { format: 'module', source: code, shortCircuit: true };
  }
  return nextLoad(url, context);
}
`;
register('data:text/javascript;base64,' + Buffer.from(hooksSource).toString('base64'));

// Sanity: sucrase must be resolvable for the hook above.
const requireHere = createRequire(import.meta.url);
requireHere.resolve('sucrase');

const mod = await import('./src/components/CanvasMigrationBanner.jsx');
const {
  default: CanvasMigrationBanner,
  CANVAS_MIGRATION_DISMISS_KEY,
  CANVAS_MIGRATION_STATUS_PATH,
  CANVAS_MIGRATION_RUN_PATH,
  isDismissedForSession,
  dismissForSession,
  shouldShowBanner,
  fetchCanvasMigrationStatus,
  runCanvasMigration,
  applyRunResults,
  formatBytes,
} = mod;

// -----------------------------------------------------------------------------
// Test 1: Exports
// -----------------------------------------------------------------------------

section('Module exports');

ok(typeof CanvasMigrationBanner === 'function', 'default export is a component function');
ok(typeof shouldShowBanner === 'function', 'shouldShowBanner is exported');
ok(typeof isDismissedForSession === 'function', 'isDismissedForSession is exported');
ok(typeof dismissForSession === 'function', 'dismissForSession is exported');
ok(typeof fetchCanvasMigrationStatus === 'function', 'fetchCanvasMigrationStatus is exported');
ok(typeof runCanvasMigration === 'function', 'runCanvasMigration is exported');
ok(typeof applyRunResults === 'function', 'applyRunResults is exported');
ok(typeof CANVAS_MIGRATION_DISMISS_KEY === 'string' && CANVAS_MIGRATION_DISMISS_KEY.length > 0,
  'session dismiss key constant is exported');
ok(CANVAS_MIGRATION_STATUS_PATH === '/api/migrations/canvas/status',
  'status path matches the T-344-3 contract');
ok(CANVAS_MIGRATION_RUN_PATH === '/api/migrations/canvas/run',
  'run path matches the T-344-3 contract');

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const pendingStatus = {
  pending: [
    { project: 'alpha', displayName: 'Alpha', notes: 12, connections: 4, bytes: 34567 },
    { project: 'beta', displayName: 'Beta', notes: 0, connections: 0, bytes: 39 },
    { project: 'gamma', displayName: 'Gamma', notes: 7, connections: 2, bytes: 120000 },
  ],
  migrated: [{ project: 'done-project', migratedAt: '2026-06-10T10:00:00Z' }],
  total: 4,
};

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    _map: map,
  };
}

// -----------------------------------------------------------------------------
// Test 2: Banner visibility logic
// -----------------------------------------------------------------------------

section('shouldShowBanner — visibility logic');

ok(shouldShowBanner(null, false) === false, 'null status (fetch failed / API missing) hides banner');
ok(shouldShowBanner(undefined, false) === false, 'undefined status hides banner');
ok(shouldShowBanner({ pending: [], migrated: [], total: 0 }, false) === false, 'empty pending hides banner');
ok(shouldShowBanner({ total: 3 }, false) === false, 'status without pending array hides banner');
ok(shouldShowBanner(pendingStatus, false) === true, 'pending > 0 shows banner');
ok(shouldShowBanner(pendingStatus, true) === false, 'session dismissal wins over pending > 0');
ok(shouldShowBanner({ pending: [pendingStatus.pending[1]] }, false) === true,
  'empty-canvas project (notes: 0) still counts as pending');

// -----------------------------------------------------------------------------
// Test 3: "Later" session flag
// -----------------------------------------------------------------------------

section('Later — sessionStorage flag');

{
  const storage = fakeStorage();
  ok(isDismissedForSession(storage) === false, 'fresh session is not dismissed');
  dismissForSession(storage);
  ok(storage._map.get(CANVAS_MIGRATION_DISMISS_KEY) === '1', 'dismiss writes "1" under the exported key');
  ok(isDismissedForSession(storage) === true, 'dismissed flag is read back');
}

{
  ok(isDismissedForSession(null) === false, 'missing storage reads as not dismissed');
  const throwing = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
  };
  ok(isDismissedForSession(throwing) === false, 'throwing storage reads as not dismissed');
  let threw = false;
  try { dismissForSession(throwing); } catch { threw = true; }
  ok(threw === false, 'dismiss swallows storage errors (private mode)');
}

// -----------------------------------------------------------------------------
// Test 4: Status fetch with mocked fetch
// -----------------------------------------------------------------------------

section('fetchCanvasMigrationStatus — mocked fetch');

{
  const calls = [];
  const fetchImpl = async (path, opts) => {
    calls.push({ path, opts });
    return { ok: true, json: async () => pendingStatus };
  };
  const status = await fetchCanvasMigrationStatus({ fetchImpl });
  ok(calls.length === 1, 'exactly one status request (no polling)');
  ok(calls[0].path === '/api/migrations/canvas/status', 'GETs the contract status path');
  ok(status?.pending?.length === 3, 'returns parsed status with pending list');
}

{
  const status = await fetchCanvasMigrationStatus({ fetchImpl: async () => ({ ok: false, json: async () => ({}) }) });
  ok(status === null, 'non-OK response yields null (banner stays hidden)');
}
{
  const status = await fetchCanvasMigrationStatus({ fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  ok(status === null, 'network error yields null instead of throwing');
}
{
  const status = await fetchCanvasMigrationStatus({ fetchImpl: async () => ({ ok: true, json: async () => ({ nope: 1 }) }) });
  ok(status === null, 'malformed payload (no pending array) yields null');
}

// -----------------------------------------------------------------------------
// Test 5: Run request with mocked fetch
// -----------------------------------------------------------------------------

section('runCanvasMigration — mocked fetch');

{
  const calls = [];
  const runResponse = {
    results: [
      { project: 'alpha', ok: true, notes: 12, connections: 4 },
      { project: 'beta', ok: true, notes: 0, connections: 0 },
    ],
    failed: 0,
  };
  const fetchImpl = async (path, opts) => {
    calls.push({ path, opts });
    return { ok: true, json: async () => runResponse };
  };
  const data = await runCanvasMigration(['alpha', 'beta'], { fetchImpl });
  ok(calls[0].path === '/api/migrations/canvas/run', 'POSTs the contract run path');
  ok(calls[0].opts?.method === 'POST', 'uses POST');
  const body = JSON.parse(calls[0].opts.body);
  ok(Array.isArray(body.projects) && body.projects.join(',') === 'alpha,beta',
    'sends explicit projects list in the body');
  ok(data.results.length === 2, 'returns parsed run response');
}

{
  const calls = [];
  const fetchImpl = async (path, opts) => {
    calls.push({ path, opts });
    return { ok: true, json: async () => ({ results: [], failed: 0 }) };
  };
  await runCanvasMigration([], { fetchImpl });
  ok(JSON.parse(calls[0].opts.body).projects === undefined,
    'empty selection sends {} (server default: all pending)');
}

{
  let err = null;
  try {
    await runCanvasMigration(['alpha'], {
      fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({ error: 'db locked' }) }),
    });
  } catch (e) { err = e; }
  ok(err?.message === 'db locked', 'HTTP error surfaces server error message');
}

{
  let err = null;
  try {
    await runCanvasMigration(['alpha'], {
      fetchImpl: async () => ({ ok: true, json: async () => ({ weird: true }) }),
    });
  } catch (e) { err = e; }
  ok(!!err, 'malformed run response (no results array) throws');
}

// -----------------------------------------------------------------------------
// Test 6: Result mapping (applyRunResults)
// -----------------------------------------------------------------------------

section('applyRunResults — result mapping');

{
  const response = {
    results: [
      { project: 'alpha', ok: true, notes: 12, connections: 4 },
      { project: 'beta', ok: true, notes: 0, connections: 0 },
      { project: 'gamma', ok: false, error: 'Invalid JSON in canvas.json' },
    ],
    failed: 1,
  };
  const { nextStatus, succeeded, failed } = applyRunResults(pendingStatus, response);
  ok(succeeded.length === 2, 'two successes mapped');
  ok(failed.length === 1 && failed[0].project === 'gamma', 'one failure mapped with project name');
  ok(failed[0].error === 'Invalid JSON in canvas.json', 'failure keeps the server error message');
  ok(nextStatus.pending.length === 1 && nextStatus.pending[0].project === 'gamma',
    'banner keeps only the remaining (failed) project pending');
  ok(pendingStatus.pending.length === 3, 'input status is not mutated');
}

{
  const response = {
    results: [
      { project: 'alpha', ok: true, notes: 12, connections: 4 },
      { project: 'beta', ok: true, notes: 0, connections: 0 },
      { project: 'gamma', ok: true, notes: 7, connections: 2 },
    ],
    failed: 0,
  };
  const { nextStatus, succeeded, failed } = applyRunResults(pendingStatus, response);
  ok(failed.length === 0 && succeeded.length === 3, 'full success mapped');
  ok(nextStatus.pending.length === 0, 'full success empties pending (banner disappears)');
  ok(shouldShowBanner(nextStatus, false) === false, 'banner logic confirms: no banner after full success');
}

{
  const { nextStatus, succeeded, failed } = applyRunResults(pendingStatus, { garbage: true });
  ok(succeeded.length === 0 && failed.length === 0, 'garbage response maps to empty result lists');
  ok(nextStatus.pending.length === 3, 'garbage response leaves pending unchanged (banner stays)');
}

section('formatBytes');

ok(formatBytes(39) === '39 B', 'small sizes render as bytes');
ok(formatBytes(34567) === '33.8 KB', 'larger sizes render as KB');
ok(formatBytes(undefined) === null, 'missing bytes render as null (omitted)');

// -----------------------------------------------------------------------------
// Test 7: SSR render (no DOM)
// -----------------------------------------------------------------------------

section('SSR render — banner markup');

const { renderToStaticMarkup } = await import('react-dom/server');
const { createElement: h } = await import('react');

{
  const html = renderToStaticMarkup(
    h(CanvasMigrationBanner, { initialStatus: pendingStatus, storage: fakeStorage() }),
  );
  ok(html.includes('Update available'), 'banner renders "Update available" title');
  ok(html.includes('Canvas data migration pending for 3 projects.'), 'banner renders pending count');
  ok(html.includes('Review'), 'banner has a Review button');
  ok(html.includes('Later'), 'banner has a Later button');
  ok(!html.includes('role="dialog"'), 'modal is closed initially');
}

{
  const html = renderToStaticMarkup(
    h(CanvasMigrationBanner, { initialStatus: { ...pendingStatus, pending: [pendingStatus.pending[0]] }, storage: fakeStorage() }),
  );
  ok(html.includes('pending for 1 project.'), 'singular wording for one project');
}

{
  const html = renderToStaticMarkup(
    h(CanvasMigrationBanner, { initialStatus: { pending: [], migrated: [], total: 0 }, storage: fakeStorage() }),
  );
  ok(html === '', 'nothing rendered when pending is empty');
}

{
  const storage = fakeStorage({ [CANVAS_MIGRATION_DISMISS_KEY]: '1' });
  const html = renderToStaticMarkup(
    h(CanvasMigrationBanner, { initialStatus: pendingStatus, storage }),
  );
  ok(html === '', 'nothing rendered when session-dismissed, even with pending projects');
}

// -----------------------------------------------------------------------------
// Test 8: Source assertions
// -----------------------------------------------------------------------------

section('Source assertions');

const here = fileURLToPath(new URL('.', import.meta.url));
const componentSrc = readFileSync(`${here}/src/components/CanvasMigrationBanner.jsx`, 'utf8');
const appSrc = readFileSync(`${here}/src/App.jsx`, 'utf8');

ok(appSrc.includes("from './components/CanvasMigrationBanner.jsx'"), 'App.jsx imports the banner');
ok(appSrc.includes('<CanvasMigrationBanner />'), 'App.jsx mounts the banner inside DashboardProvider');
for (const lib of ['Modal', 'Button', 'Alert', 'Spinner', 'DataList']) {
  ok(new RegExp(`import ${lib} from './${lib}\\.jsx'`).test(componentSrc), `uses library component ${lib}`);
}
ok(componentSrc.includes('canvas.json.pre-db.bak'), 'modal mentions the automatic backup file');
ok(componentSrc.includes('window.showToast'), 'success toast goes through window.showToast');
ok(!/[äöüÄÖÜß]/.test(componentSrc), 'no German umlauts — UI strings are English');
ok(!/setInterval|setTimeout\s*\(\s*.*fetchCanvasMigrationStatus/s.test(componentSrc), 'no polling of the status endpoint');

// -----------------------------------------------------------------------------
// Results
// -----------------------------------------------------------------------------

section('Test Summary');
console.log(`\nPassed: ${pass}`);
console.log(`Failed: ${fail}`);

if (fail > 0) {
  console.log('\nFailures:');
  failures.forEach((msg) => console.log(`  - ${msg}`));
  process.exit(1);
}

console.log('\n✅ All canvas migration UI tests passed!');
