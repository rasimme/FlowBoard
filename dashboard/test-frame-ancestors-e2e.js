'use strict';

// T-487-10 — real-browser proof that FLOWBOARD_FRAME_ANCESTORS actually
// changes what a browser lets embed the dashboard, not just what header
// string the server emits (that contract is pinned in test-frame-ancestors.js).
//
// A tiny static page on its own local origin embeds the dashboard in an
// <iframe>. When that origin is allow-listed via FLOWBOARD_FRAME_ANCESTORS,
// the iframe navigates to the dashboard and the app shell renders. When it
// is not allow-listed (default config), CSP frame-ancestors blocks the
// subframe navigation — the iframe never commits to the dashboard URL and
// stays empty.

const http = require('node:http');
const { withDashboard, reporter } = require('./test-support/browser-harness.js');
const { reservePort } = require('./test-support/server-harness.js');

const r = reporter('FLOWBOARD_FRAME_ANCESTORS browser E2E (T-487-10)');

function startHostPage(port, dashboardBase) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        '<!DOCTYPE html><html><body>' +
        `<iframe id="frame" src="${dashboardBase}/?agentId=e2e-frame-ancestors"></iframe>` +
        '</body></html>'
      );
    });
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function readIframeState(page) {
  const handle = await page.$('#frame');
  const frame = handle ? await handle.contentFrame() : null;
  if (!frame) return { url: null, hasApp: false };
  const url = frame.url();
  const hasApp = !!(await frame.$('.app').catch(() => null));
  return { url, hasApp };
}

// Returns true if the run was skipped (no browser/dist), so main() can bail.
async function runAllowedCase() {
  const dashboardPort = await reservePort();
  const dashboardBase = `http://127.0.0.1:${dashboardPort}`;
  const hostPort = await reservePort();
  const hostOrigin = `http://127.0.0.1:${hostPort}`;
  const hostServer = await startHostPage(hostPort, dashboardBase);
  try {
    const res = await withDashboard(async ({ page }) => {
      await page.goto(hostOrigin, { waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const { url, hasApp } = await readIframeState(page);
      r.ok(!!url && url.startsWith(dashboardBase),
        `allow-listed origin: iframe navigates to the dashboard (url=${url})`);
      r.ok(hasApp, 'allow-listed origin: dashboard app root renders inside the iframe');
    }, { port: dashboardPort, env: { FLOWBOARD_FRAME_ANCESTORS: hostOrigin } });
    if (res?.skipped) { r.skip(res.reason); return true; }
  } finally {
    await closeServer(hostServer);
  }
  return false;
}

async function runBlockedCase() {
  const dashboardPort = await reservePort();
  const dashboardBase = `http://127.0.0.1:${dashboardPort}`;
  const hostPort = await reservePort();
  const hostOrigin = `http://127.0.0.1:${hostPort}`;
  // Not allow-listed anywhere — default CSP frame-ancestors is 'self'
  // https://web.telegram.org only.
  const hostServer = await startHostPage(hostPort, dashboardBase);
  try {
    const res = await withDashboard(async ({ page }) => {
      await page.goto(hostOrigin, { waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const { url, hasApp } = await readIframeState(page);
      r.ok(!(url && url.startsWith(dashboardBase)),
        `non-allow-listed origin: iframe never commits to the dashboard URL (url=${url})`);
      r.ok(!hasApp, 'non-allow-listed origin: dashboard app root does not render inside the iframe (CSP frame-ancestors blocked it)');
    }, { port: dashboardPort });
    if (res?.skipped) { r.skip(res.reason); return true; }
  } finally {
    await closeServer(hostServer);
  }
  return false;
}

async function main() {
  if (await runAllowedCase()) return;
  if (await runBlockedCase()) return;
  r.done();
}

main().catch((error) => { console.error(error); process.exit(1); });
