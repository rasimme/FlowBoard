'use strict';

// T-456: the served bundle can silently lag the source it was built from.
// The check warns and never builds — see bundle-freshness.js for why.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { checkBundleFreshness, describeStaleBundle } = require('./bundle-freshness.js');

const checks = [];
function ok(cond, label) {
  checks.push(label);
  assert.ok(cond, label);
}

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fb-bundle-'));
}

function write(file, contents, mtimeMs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  if (mtimeMs) fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
}

const now = Date.now();

// ── stale: a source edited after the last build ──────────────────────────
{
  const root = scratch();
  const srcDir = path.join(root, 'src');
  const distDir = path.join(root, 'dist');
  write(path.join(distDir, 'index.html'), '<html></html>', now - 3600_000);
  write(path.join(srcDir, 'thing.jsx'), 'export const x = 1;', now - 600_000);

  const r = checkBundleFreshness({ srcDir, distDir });
  ok(r.applicable, 'a tree with both sources and a build is comparable');
  ok(r.stale, 'a source newer than the build reads as stale');
  // dist at now-3600s, source at now-600s → exactly 3000s apart.
  ok(Math.abs(r.staleBySeconds - 3000) <= 2, 'the gap is reported in seconds');
  const message = describeStaleBundle(r);
  ok(typeof message === 'string' && message.includes('vite build'),
    'the warning names the command that fixes it');
  ok(message.includes('restart alone does'),
    'and says a restart will not help, which is the trap this came from');
  fs.rmSync(root, { recursive: true, force: true });
}

// ── fresh: built after the last source edit ──────────────────────────────
{
  const root = scratch();
  const srcDir = path.join(root, 'src');
  const distDir = path.join(root, 'dist');
  write(path.join(srcDir, 'thing.jsx'), 'export const x = 1;', now - 3600_000);
  write(path.join(distDir, 'index.html'), '<html></html>', now - 600_000);

  const r = checkBundleFreshness({ srcDir, distDir });
  ok(r.applicable && !r.stale, 'a build newer than every source reads as fresh');
  ok(describeStaleBundle(r) === null, 'and says nothing at all');
  fs.rmSync(root, { recursive: true, force: true });
}

// ── a published install ships no sources ─────────────────────────────────
{
  const root = scratch();
  const distDir = path.join(root, 'dist');
  write(path.join(distDir, 'index.html'), '<html></html>', now);

  const r = checkBundleFreshness({ srcDir: path.join(root, 'src'), distDir });
  ok(!r.applicable && r.reason === 'no-sources',
    'without sources there is nothing to compare — not a warning, not applicable');
  ok(!r.stale, 'and it is certainly not stale');
  fs.rmSync(root, { recursive: true, force: true });
}

// ── never built: the existing DIST_BUILT warning owns that case ──────────
{
  const root = scratch();
  const srcDir = path.join(root, 'src');
  write(path.join(srcDir, 'thing.jsx'), 'export const x = 1;', now);

  const r = checkBundleFreshness({ srcDir, distDir: path.join(root, 'dist') });
  ok(!r.applicable && r.reason === 'not-built',
    'an unbuilt frontend is not reported as stale — a separate warning says something useful');
  fs.rmSync(root, { recursive: true, force: true });
}

// ── build outputs and dependencies are not sources ───────────────────────
{
  const root = scratch();
  const srcDir = path.join(root, 'src');
  const distDir = path.join(root, 'dist');
  write(path.join(srcDir, 'thing.jsx'), 'export const x = 1;', now - 3600_000);
  write(path.join(distDir, 'index.html'), '<html></html>', now - 600_000);
  // A dependency touched a minute ago must not make the bundle look stale.
  write(path.join(srcDir, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;', now);
  // Neither should a non-source file.
  write(path.join(srcDir, 'notes.txt'), 'scratch', now);

  const r = checkBundleFreshness({ srcDir, distDir });
  ok(!r.stale, 'node_modules and non-source files are ignored');
  fs.rmSync(root, { recursive: true, force: true });
}

for (const label of checks) console.log(`  ok - ${label}`);
console.log(`\n✅ Bundle freshness warning (T-456): all ${checks.length} checks passed`);
