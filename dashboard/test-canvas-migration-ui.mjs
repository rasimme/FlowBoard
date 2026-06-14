/**
 * DOM-less smoke tests for the Canvas migration UI (T-344-9).
 *
 * The separate bottom banner (CanvasMigrationBanner.jsx) was removed; the
 * canvas migration now lives in the existing SnippetUpgrade header-chip + modal
 * as one unified update center. This test was rebuilt accordingly:
 *
 *   1. Helper module exports (src/utils/canvasMigration.mjs)
 *   2. Status fetch + run request against a mocked fetch (URL/method/body)
 *   3. Result mapping from a mocked run response (applyRunResults)
 *   4. formatBytes / countsLine / projectLabel formatting helpers
 *   5. resolveChip — combined snippet + canvas chip logic (SnippetUpgrade)
 *   6. Source assertions — banner gone, App.jsx no longer mounts it, the
 *      SnippetUpgrade modal renders the Canvas group + conflict block and
 *      Apply additionally calls the canvas run endpoint, English strings.
 *
 * Pattern: sucrase-based node module hook (no browser / jsdom), same as before.
 *
 * Run: node test-canvas-migration-ui.mjs
 */

import assert from 'node:assert/strict';
import { register, createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
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

const helpers = await import('./src/utils/canvasMigration.mjs');
const {
  CANVAS_MIGRATION_STATUS_PATH,
  CANVAS_MIGRATION_RUN_PATH,
  CANVAS_MIGRATION_BACKUP_FILE,
  fetchCanvasMigrationStatus,
  runCanvasMigration,
  applyRunResults,
  formatBytes,
  countsLine,
  projectLabel,
  pendingProjects,
  conflictProjects,
  hasPendingCanvasMigration,
} = helpers;

const snippetMod = await import('./src/components/SnippetUpgrade.jsx');
const { default: SnippetUpgrade, resolveChip } = snippetMod;

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
  conflicts: [{ project: 'delta', displayName: 'Delta', bytes: 500, migratedAt: '2026-06-09T09:00:00Z' }],
  total: 5,
};

// -----------------------------------------------------------------------------
// Test 1: Module exports
// -----------------------------------------------------------------------------

section('Helper module exports');

ok(typeof fetchCanvasMigrationStatus === 'function', 'fetchCanvasMigrationStatus is exported');
ok(typeof runCanvasMigration === 'function', 'runCanvasMigration is exported');
ok(typeof applyRunResults === 'function', 'applyRunResults is exported');
ok(typeof formatBytes === 'function', 'formatBytes is exported');
ok(typeof countsLine === 'function', 'countsLine is exported');
ok(typeof projectLabel === 'function', 'projectLabel is exported');
ok(typeof pendingProjects === 'function', 'pendingProjects is exported');
ok(typeof conflictProjects === 'function', 'conflictProjects is exported');
ok(typeof hasPendingCanvasMigration === 'function', 'hasPendingCanvasMigration is exported');
ok(CANVAS_MIGRATION_STATUS_PATH === '/api/migrations/canvas/status',
  'status path matches the T-344-3 contract');
ok(CANVAS_MIGRATION_RUN_PATH === '/api/migrations/canvas/run',
  'run path matches the T-344-3 contract');
ok(CANVAS_MIGRATION_BACKUP_FILE === 'canvas.json.pre-db.bak',
  'backup file constant matches the contract');
ok(typeof SnippetUpgrade === 'function', 'SnippetUpgrade default export is a component');
ok(typeof resolveChip === 'function', 'resolveChip is exported from SnippetUpgrade');

// -----------------------------------------------------------------------------
// Test 2: Status fetch with mocked fetch
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
  ok(status === null, 'non-OK response yields null (chip stays hidden)');
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
// Test 3: Run request with mocked fetch
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
// Test 4: Result mapping (applyRunResults)
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
    'chip keeps only the remaining (failed) project pending');
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
  ok(nextStatus.pending.length === 0, 'full success empties pending (chip drops the canvas count)');
  ok(hasPendingCanvasMigration(nextStatus) === false, 'no pending canvas migration after full success');
}

{
  const { nextStatus, succeeded, failed } = applyRunResults(pendingStatus, { garbage: true });
  ok(succeeded.length === 0 && failed.length === 0, 'garbage response maps to empty result lists');
  ok(nextStatus.pending.length === 3, 'garbage response leaves pending unchanged');
}

// -----------------------------------------------------------------------------
// Test 5: Formatting helpers
// -----------------------------------------------------------------------------

section('formatBytes / countsLine / projectLabel / selectors');

ok(formatBytes(39) === '39 B', 'small sizes render as bytes');
ok(formatBytes(34567) === '33.8 KB', 'larger sizes render as KB');
ok(formatBytes(undefined) === null, 'missing bytes render as null (omitted)');

ok(countsLine({ notes: 1, connections: 1, bytes: 39 }) === '1 note · 1 connection · 39 B',
  'singular note/connection wording + size');
ok(countsLine({ notes: 12, connections: 4, bytes: 34567 }) === '12 notes · 4 connections · 33.8 KB',
  'plural wording + KB size');
ok(countsLine({ notes: 0, connections: 0 }) === '0 notes · 0 connections',
  'omits size when bytes missing');

ok(projectLabel({ project: 'alpha', displayName: 'Alpha' }) === 'Alpha', 'prefers displayName');
ok(projectLabel({ project: 'alpha' }) === 'alpha', 'falls back to project name');

ok(pendingProjects(pendingStatus).length === 3, 'pendingProjects reads the pending array');
ok(pendingProjects(null).length === 0, 'pendingProjects safe on null');
ok(conflictProjects(pendingStatus).length === 1, 'conflictProjects reads the conflicts array');
ok(conflictProjects(null).length === 0, 'conflictProjects safe on null');
ok(hasPendingCanvasMigration(pendingStatus) === true, 'hasPendingCanvasMigration true with pending');
ok(hasPendingCanvasMigration({ pending: [] }) === false, 'hasPendingCanvasMigration false with empty pending');

// -----------------------------------------------------------------------------
// Test 6: resolveChip — combined snippet + canvas chip logic
// -----------------------------------------------------------------------------

section('resolveChip — header chip logic');

const snippetChip = { text: 'Migration required', variant: 'warn' };

ok(resolveChip(null, null) === null, 'no snippet chip + no canvas status → no chip');
ok(resolveChip(null, { pending: [] }) === null, 'no snippet chip + empty canvas pending → no chip');

{
  const chip = resolveChip(snippetChip, { pending: [] });
  ok(chip === snippetChip, 'snippet chip only → server chip unchanged');
}
{
  const chip = resolveChip(null, pendingStatus);
  ok(chip && chip.text === 'Migration required' && chip.variant === 'warn',
    'canvas pending only → synthetic warn "Migration required" chip');
}
{
  const chip = resolveChip(snippetChip, pendingStatus);
  ok(chip && chip.variant === 'warn', 'both → warn chip');
  ok(/3 canvas projects/.test(chip.text), 'both → combined text mentions the pending canvas count');
}
{
  const chip = resolveChip(null, { pending: [pendingStatus.pending[0]] });
  ok(chip && chip.variant === 'warn', 'single canvas project still yields a warn chip');
}
// T-345-11 (DB review M1): conflict-only — no snippet, nothing pending, but a
// canvas.json re-appeared for a migrated project → must still surface a chip.
{
  const conflictOnly = { pending: [], conflicts: [{ project: 'x', displayName: 'X', bytes: 5, migratedAt: 'z' }] };
  const chip = resolveChip(null, conflictOnly);
  ok(chip && chip.variant === 'warn' && /conflict/i.test(chip.text),
    'conflict-only (no snippet, no pending) → warn "Canvas data conflict" chip');
  ok(resolveChip(null, { pending: [], conflicts: [] }) === null,
    'no snippet, no pending, no conflict → still no chip');
}

// -----------------------------------------------------------------------------
// Test 7: Source assertions
// -----------------------------------------------------------------------------

section('Source assertions');

const here = fileURLToPath(new URL('.', import.meta.url));
const appSrc = readFileSync(`${here}/src/App.jsx`, 'utf8');
const snippetSrc = readFileSync(`${here}/src/components/SnippetUpgrade.jsx`, 'utf8');
const helperSrc = readFileSync(`${here}/src/utils/canvasMigration.mjs`, 'utf8');

ok(!existsSync(`${here}/src/components/CanvasMigrationBanner.jsx`),
  'CanvasMigrationBanner.jsx is deleted');
ok(!/CanvasMigrationBanner/.test(appSrc), 'App.jsx no longer imports or mounts the banner');
ok(!/fixed bottom-4 right-4/.test(snippetSrc), 'no bottom-anchored banner markup remains');

ok(/from '\.\.\/utils\/canvasMigration\.mjs'/.test(snippetSrc),
  'SnippetUpgrade imports the canvas migration helper module');
ok(/fetchCanvasMigrationStatus\(\)/.test(snippetSrc),
  'SnippetUpgrade fetches the canvas status on mount');
ok(/Promise\.all/.test(snippetSrc),
  'snippet + canvas status are fetched in parallel');
ok(/Canvas data migration/.test(snippetSrc),
  'modal renders the "Canvas data migration" group');
ok(/Canvas data conflict — resolve manually/.test(snippetSrc),
  'modal renders the conflict advisory block');
ok(/runCanvasMigration\(/.test(snippetSrc),
  'Apply additionally calls runCanvasMigration (POST run endpoint)');
ok(/onApplied\?\.\(\)/.test(snippetSrc),
  'status is reloaded after apply (chip disappears on success)');
ok(/CANVAS_MIGRATION_BACKUP_FILE/.test(snippetSrc),
  'modal references the backup file constant');
ok(/className="group"/.test(snippetSrc),
  'canvas sections reuse the existing .group structure (no new CSS)');

ok(helperSrc.includes('canvas.json.pre-db.bak'), 'helper exposes the backup file name');
ok(!/[äöüÄÖÜß]/.test(snippetSrc), 'SnippetUpgrade: UI strings are English (no umlauts)');
ok(!/[äöüÄÖÜß]/.test(helperSrc), 'helper module: English only (no umlauts)');
ok(!/setInterval|setTimeout\s*\(\s*.*fetchCanvasMigrationStatus/s.test(snippetSrc),
  'no polling of the canvas status endpoint');

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
