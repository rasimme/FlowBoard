'use strict';

/**
 * T-456: is the bundle we serve older than the source it was built from?
 *
 * The incident: an archived task showed as an active claim in the Overview.
 * The filter that excludes archived claims had landed in `src/` the day
 * before — but `dist/` had not been rebuilt, so the running UI kept the old
 * behaviour. The fix was committed, tested and green, and still was not what
 * the operator saw. Restarting the service did not help either: a restart
 * replaces the process, not the JavaScript a loaded page is already running.
 *
 * This only warns. It deliberately does not build:
 *
 *  - A server that silently builds on start surprises the operator and makes
 *    startup depend on a toolchain being present.
 *  - The published package ships runtime files only (see the artifact
 *    boundary in PROJECT.md), so an installed instance has no `src/` at all.
 *    There the check simply does not apply rather than failing.
 *
 * So this is a development-instance guard, which is where the problem lives.
 */

const fs = require('fs');
const path = require('path');

// Build outputs, dependencies and the odd editor artefact are not sources.
const IGNORED_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage']);
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.ts', '.tsx', '.css', '.html', '.json', '.svg']);

/**
 * Newest mtime under `dir`, or null when the directory does not exist.
 * Walks rather than globs so this stays dependency-free at boot.
 */
function newestMtime(dir, budget = { files: 20000 }) {
  let newest = null;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (budget.files <= 0) break;
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      const nested = newestMtime(full, budget);
      if (nested !== null && (newest === null || nested > newest)) newest = nested;
      continue;
    }
    if (!entry.isFile()) continue;
    if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
    budget.files -= 1;
    try {
      const { mtimeMs } = fs.statSync(full);
      if (newest === null || mtimeMs > newest) newest = mtimeMs;
    } catch { /* vanished mid-walk — not our problem */ }
  }
  return newest;
}

/**
 * @returns {{applicable: boolean, stale: boolean, reason: string,
 *            newestSourceAt: string|null, builtAt: string|null,
 *            staleBySeconds: number|null}}
 *
 * `applicable: false` means there is nothing to compare and nothing is wrong:
 * either this install ships no sources, or the frontend was never built (the
 * separate DIST_BUILT warning covers that case and says something useful).
 */
function checkBundleFreshness({ srcDir, distDir } = {}) {
  const absent = {
    applicable: false, stale: false, newestSourceAt: null, builtAt: null, staleBySeconds: null,
  };
  const builtIndex = path.join(distDir, 'index.html');
  if (!fs.existsSync(srcDir)) return { ...absent, reason: 'no-sources' };
  if (!fs.existsSync(builtIndex)) return { ...absent, reason: 'not-built' };

  const newestSource = newestMtime(srcDir);
  let builtAt = null;
  try { builtAt = fs.statSync(builtIndex).mtimeMs; } catch { /* raced */ }
  if (newestSource === null || builtAt === null) return { ...absent, reason: 'unreadable' };

  const stale = newestSource > builtAt;
  return {
    applicable: true,
    stale,
    reason: stale ? 'stale' : 'fresh',
    newestSourceAt: new Date(newestSource).toISOString(),
    builtAt: new Date(builtAt).toISOString(),
    staleBySeconds: stale ? Math.round((newestSource - builtAt) / 1000) : 0,
  };
}

function describeStaleBundle(result) {
  if (!result?.stale) return null;
  const minutes = Math.max(1, Math.round(result.staleBySeconds / 60));
  return [
    `[startup] ⚠️  dashboard/dist is ${minutes} minute(s) older than dashboard/src —`,
    '[startup] ⚠️  the UI being served does not include the newest frontend changes.',
    '[startup] ⚠️  Run "npx vite build" in dashboard/. Note that a restart alone does',
    '[startup] ⚠️  not help: an already-open browser tab keeps the script it loaded.',
  ].join('\n');
}

module.exports = { checkBundleFreshness, describeStaleBundle, newestMtime };
