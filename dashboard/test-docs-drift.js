'use strict';

/**
 * Mechanical drift tests for the documentation reference layer (T-197-8).
 *
 *   1. Manifest coverage — every app.<verb>('/api/...') in dashboard/server.js
 *      has a matching entry in docs/reference/api-manifest.json, and vice versa.
 *
 *   2. Env-var coverage — every process.env.<NAME> lookup in dashboard/server.js
 *      and hooks/project-context/handler.js has a backticked entry in
 *      docs/reference/env-vars.md, and vice versa.
 *
 * The test fails loudly with actionable lists ("missing in manifest", "stale in
 * docs") so a contributor can fix drift without hunting.
 *
 * Run: node test-docs-drift.js
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT      = path.resolve(__dirname, '..');
const SERVER_PATH    = path.join(REPO_ROOT, 'dashboard', 'server.js');
const HOOK_PATH      = path.join(REPO_ROOT, 'hooks', 'project-context', 'handler.js');
const TOOL_PATHS     = [
  path.join(REPO_ROOT, 'dashboard', 'snippets-doctor.js'),
  path.join(REPO_ROOT, 'dashboard', 'install-trigger.mjs'),
  path.join(REPO_ROOT, 'dashboard', 'migrate-tasks.js'),
  path.join(REPO_ROOT, 'dashboard', 'hzl-service.js'),
  path.join(REPO_ROOT, 'dashboard', 'flowboard-metadata.js'),
  path.join(REPO_ROOT, 'dashboard', 'agent-identity.js'),
];
const MANIFEST_PATH  = path.join(REPO_ROOT, 'docs', 'reference', 'api-manifest.json');
const ENV_DOCS_PATH  = path.join(REPO_ROOT, 'docs', 'reference', 'env-vars.md');

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✅ ${msg}`); }
  else           { failed++; console.error(`  ❌ ${msg}`); }
}

function section(name) { console.log(`\n## ${name}`); }

// ----------------------------------------------------------------------------
// Manifest coverage
// ----------------------------------------------------------------------------

function extractEndpointsFromServer(source) {
  // Match: app.get('/api/...', ...), app.post('/api/...', ...), etc.
  // Path is in single or double quotes. Only /api/ paths are in scope —
  // non-API routes (/, /*path, static fallthroughs) belong to the SPA shell.
  const re = /\bapp\.(get|post|put|delete|patch)\(\s*['"](\/api\/[^'"]*)['"]/g;
  const found = [];
  let m;
  while ((m = re.exec(source)) !== null) {
    found.push({ method: m[1].toUpperCase(), path: m[2] });
  }
  // Dedupe (a path can appear in code comments — but the regex requires the
  // app.<verb>( prefix so this is mostly defensive).
  const seen = new Set();
  return found.filter(({ method, path }) => {
    const key = `${method} ${path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function loadManifestEndpoints() {
  const raw = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  return raw.endpoints.map(e => ({ method: e.method, path: e.path }));
}

section('manifest coverage — server.js ↔ api-manifest.json');
{
  const server   = fs.readFileSync(SERVER_PATH, 'utf8');
  const inCode   = extractEndpointsFromServer(server);
  const inDocs   = loadManifestEndpoints();

  const codeKeys = new Set(inCode.map(e => `${e.method} ${e.path}`));
  const docsKeys = new Set(inDocs.map(e => `${e.method} ${e.path}`));

  const missingInDocs = [...codeKeys].filter(k => !docsKeys.has(k)).sort();
  const missingInCode = [...docsKeys].filter(k => !codeKeys.has(k)).sort();

  if (missingInDocs.length > 0) {
    console.error('    Endpoints present in server.js but missing in api-manifest.json:');
    for (const k of missingInDocs) console.error(`      - ${k}`);
  }
  if (missingInCode.length > 0) {
    console.error('    Endpoints present in api-manifest.json but missing in server.js:');
    for (const k of missingInCode) console.error(`      - ${k}`);
  }

  assert(missingInDocs.length === 0, `every code endpoint is in the manifest (${codeKeys.size} endpoints)`);
  assert(missingInCode.length === 0, `every manifest endpoint exists in code (${docsKeys.size} entries)`);

  // Sanity: the manifest is non-trivial — guards against an empty file silently
  // satisfying "every code endpoint is in the manifest" if the regex misses too.
  assert(docsKeys.size >= 30, `manifest has at least 30 entries (got ${docsKeys.size})`);
  assert(codeKeys.size >= 30, `code has at least 30 /api/ endpoints (got ${codeKeys.size})`);
}

// ----------------------------------------------------------------------------
// Env-var coverage
// ----------------------------------------------------------------------------

// Env vars that belong to the Node runtime / shell, always present, intentionally
// not tied to FlowBoard config. They are referenced in env-vars.md "Node defaults"
// but do not need to appear in every individual table — exclude from the strict
// "documented" parse to avoid a false-positive.
const NODE_BUILTINS = new Set(['HOME', 'NODE_ENV', 'PATH', 'USER']);

// Env vars used purely as low-level toggles in code we don't want to lock down.
// Empty for now — every var the server/hook reads should be documented.
const ALLOW_UNDOCUMENTED = new Set([]);

function extractEnvVarsFromSource(source) {
  // Match process.env.NAME — the dot form. NAME is uppercase letters, digits,
  // underscores, starts with a letter or underscore, length > 1.
  const re = /\bprocess\.env\.([A-Z_][A-Z0-9_]*)/g;
  const found = new Set();
  let m;
  while ((m = re.exec(source)) !== null) {
    found.add(m[1]);
  }
  return found;
}

function extractDocumentedEnvVars(markdown) {
  // env-vars.md lists every var as a backticked all-caps token in the leftmost
  // column of a table row, e.g. `| `FLOWBOARD_PORT` | 18790 | ... |`. Backticked
  // tokens elsewhere (in prose, in alias notes) are also valid documentation —
  // we just collect all backticked all-caps tokens of length >= 3.
  const re = /`([A-Z][A-Z0-9_]{2,})`/g;
  const found = new Set();
  let m;
  while ((m = re.exec(markdown)) !== null) {
    found.add(m[1]);
  }
  return found;
}

section('env-var coverage — server.js + handler.js + tooling ↔ env-vars.md');
{
  const server   = fs.readFileSync(SERVER_PATH, 'utf8');
  const hook     = fs.readFileSync(HOOK_PATH, 'utf8');
  const toolSrcs = TOOL_PATHS
    .filter(p => fs.existsSync(p))
    .map(p => fs.readFileSync(p, 'utf8'));
  const docs     = fs.readFileSync(ENV_DOCS_PATH, 'utf8');

  const codeVars = new Set([
    ...extractEnvVarsFromSource(server),
    ...extractEnvVarsFromSource(hook),
    ...toolSrcs.flatMap(s => [...extractEnvVarsFromSource(s)]),
  ]);
  const docVars  = extractDocumentedEnvVars(docs);

  const undocumented = [...codeVars]
    .filter(v => !NODE_BUILTINS.has(v))
    .filter(v => !ALLOW_UNDOCUMENTED.has(v))
    .filter(v => !docVars.has(v))
    .sort();

  // "Stale in docs" = a backticked all-caps token in env-vars.md that the code
  // never reads. This catches the common drift mode where an env var is renamed
  // or removed from code but stays in the doc. We exclude obvious non-env
  // tokens (acronyms, status words) by requiring the token to look like a real
  // env var name (>=2 underscores or matching FLOWBOARD_/OPENCLAW_/HZL_/TELEGRAM_
  // /JWT_ prefix, or being on a known list of standalone names).
  const KNOWN_STANDALONE = new Set(['HOME', 'NODE_ENV', 'PORT', 'DEBUG', 'JWT_SECRET']);
  function looksLikeEnvVar(name) {
    if (KNOWN_STANDALONE.has(name)) return true;
    if (name.startsWith('FLOWBOARD_'))  return true;
    if (name.startsWith('OPENCLAW_'))   return true;
    if (name.startsWith('HZL_'))        return true;
    if (name.startsWith('TELEGRAM_'))   return true;
    if (name.startsWith('GATEWAY_'))    return true;
    if (name.startsWith('AUTH_'))       return true;
    if (name.startsWith('LOG_'))        return true;
    if (name.startsWith('LOCAL_'))      return true;
    if (name.startsWith('STALE_'))      return true;
    if (name.startsWith('HOOKS_'))      return true;
    if (name.startsWith('DASHBOARD_'))  return true;
    if (name.startsWith('ALLOWED_'))    return true;
    return false;
  }

  const stale = [...docVars]
    .filter(v => looksLikeEnvVar(v))
    .filter(v => !codeVars.has(v))
    .filter(v => !NODE_BUILTINS.has(v))
    .sort();

  if (undocumented.length > 0) {
    console.error('    Env vars used in code but missing in env-vars.md:');
    for (const v of undocumented) console.error(`      - ${v}`);
  }
  if (stale.length > 0) {
    console.error('    Env vars documented in env-vars.md but never read in code:');
    for (const v of stale) console.error(`      - ${v}`);
  }

  assert(undocumented.length === 0, `every env var the runtime reads is in env-vars.md (${codeVars.size} vars in code)`);
  assert(stale.length === 0, `every documented env var is read by server or hook (or excluded as a builtin)`);
  assert(docVars.size >= 15, `env-vars.md documents at least 15 vars (got ${docVars.size})`);
}

// ----------------------------------------------------------------------------
// Summary
// ----------------------------------------------------------------------------

console.log(`\n## Summary\n  passed: ${passed}\n  failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
