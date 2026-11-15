'use strict';

// T-519 — a token GitHub rejects (401) is reported with its own error code so
// the UI can offer a replacement. Runs github.js in-process with fetch stubbed.

process.env.FLOWBOARD_GITHUB_TOKEN = '';
process.env.GITHUB_TOKEN = '';
const github = require('./github.js');

let pass = 0;
let fail = 0;
function ok(condition, message) {
  if (condition) { pass++; console.log(`  ok - ${message}`); } else { fail++; console.log(`  not ok - ${message}`); }
}

let token = '';
let status = 200;
let sawAuth = null;
github.setTokenProvider(() => token);
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  sawAuth = opts.headers?.Authorization || null;
  if (status !== 200) return { ok: false, status, json: async () => ({}) };
  const body = String(url).includes('/commits?') || String(url).includes('/pulls') || String(url).includes('/branches') ? [] : { default_branch: 'main', check_runs: [] };
  return { ok: true, status: 200, json: async () => body };
};

async function attempt(fn) {
  try { await fn(); return null; } catch (err) { return err; }
}

(async () => {
  console.log('# GitHub token rejected (T-519)');
  const TOKEN = 'x'.repeat(40);

  token = ''; status = 401; github.clearCache();
  let err = await attempt(() => github.fetchRepoStatus('owner/name'));
  ok(err && err.code === undefined, '401 without a token is not a rejected-token error');
  ok(github.tokenRejected() === false, 'no token: tokenRejected stays false');

  token = TOKEN; status = 401; github.clearCache();
  err = await attempt(() => github.fetchRepoStatus('owner/name'));
  ok(err && err.code === github.TOKEN_REJECTED, 'repo-status: 401 with a token carries the rejected code');
  ok(sawAuth === `Bearer ${TOKEN}`, 'the request carried the token');
  ok(!String(err && err.message).includes(TOKEN), 'the error message never contains the token');
  ok(github.tokenRejected() === true, 'tokenRejected is true after a 401');
  err = await attempt(() => github.fetchRepoStatus('owner/name'));
  ok(err && err.code === github.TOKEN_REJECTED, 'the cached error keeps the code');
  err = await attempt(() => github.fetchInsight('owner/name', 'pulls'));
  ok(err && err.code === github.TOKEN_REJECTED, 'insight: 401 with a token carries the rejected code');

  status = 403; github.clearCache();
  ok(github.tokenRejected() === false, 'clearCache (token saved or removed) resets the flag');
  err = await attempt(() => github.fetchRepoStatus('owner/name'));
  ok(err && err.code === undefined && github.tokenRejected() === false, '403 is not a rejected token');

  status = 200; github.clearCache();
  err = await attempt(() => github.fetchRepoStatus('owner/name'));
  ok(err === null, 'a working token fetches');
  status = 401;
  github.clearCache(); status = 200; await attempt(() => github.fetchRepoStatus('owner/name'));
  status = 401;
  // expire nothing: a fresh cache entry is served, so force a miss with another branch
  err = await attempt(() => github.fetchRepoStatus('owner/name', 'dev'));
  ok(err && err.code === github.TOKEN_REJECTED, 'a rejected token is reported even when older data exists');
  token = ''; 
  ok(github.tokenRejected() === false, 'removing the token clears the rejected state');

  globalThis.fetch = realFetch;
  console.log(`\n# results: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
