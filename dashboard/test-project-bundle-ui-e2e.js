'use strict';

// T-468-7: rendered browser coverage for the project bundle workflows. This
// intentionally uses the real dashboard server and the built UI; API-only
// bundle contract tests live beside it, but cannot prove menu placement,
// focusable controls, mobile layout or the explicit post-import transition.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBundle } = require('./project-bundle-schema.js');
const { withDashboard, reporter } = require('./test-support/browser-harness.js');

const r = reporter('T-468-7 project bundle UI E2E');

function jsonFile(name, value) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-bundle-ui-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
  return file;
}

function securityFixture() {
  return createBundle({
    project: { slug: 'unsafe-source', displayName: 'Unsafe source', description: 'token=AAAAAAAAAAAAAAAAAAAA', group: null, taskDiscipline: 'list', github: null, createdAt: '2026-08-01T00:00:00.000Z' },
    tasks: [], specs: [], canvas: { version: 1, notes: [], connections: [] },
    overview: { version: 1, layout: 'grid', widgets: [] },
    files: [{ path: 'PROJECT.md', content: '# Unsafe source\n' }],
  }, { bundleId: 'ui-security-fixture', createdAt: '2026-08-26T00:00:00.000Z', producerName: 'FlowBoard', producerVersion: 'test' });
}

async function text(page) {
  return page.evaluate(() => document.body.innerText);
}

(async () => {
  const result = await withDashboard(async ({ api, page, base }) => {
    const created = await api('POST', '/projects', { name: 'ui-source', displayName: 'UI Source' });
    r.ok([200, 201].includes(created.status), 'fixture project created');

    await page.goto(`${base}/?agentId=bundle-ui-e2e`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('.project-item');

    // Existing entry points.
    await page.click('.row-kebab');
    r.ok((await text(page)).includes('Export snapshot…'), 'project actions menu exposes Export snapshot');
    await page.evaluate(() => [...document.querySelectorAll('button')].find((button) => button.textContent.includes('Export snapshot'))?.click());
    await page.waitForSelector('#include-task-history');
    r.ok((await text(page)).toLowerCase().includes('included') && (await text(page)).toLowerCase().includes('not included'), 'export ready state renders included and excluded scope');
    r.ok((await page.$$('[data-testid="bundle-counts"]')) .length > 0, 'export renders server counts before download');
    let historyRequest = false;
    page.on('request', (request) => {
      if (request.url().includes('/export?includeHistory=true')) historyRequest = true;
    });
    await page.click('#include-task-history');
    await page.waitForFunction(() => document.body.innerText.includes('History may contain sensitive context'));
    r.ok(historyRequest, 'history opt-in refetches export with includeHistory=true');
    await page.click('button[aria-label="Close"]');

    await page.click('.sidebar-new');
    r.ok((await text(page)).includes('Import project…'), 'New menu exposes Import project');
    await page.evaluate(() => [...document.querySelectorAll('button')].find((button) => button.textContent.includes('Import project'))?.click());
    await page.waitForSelector('#project-bundle-file');
    const exported = await fetch(`${base}/api/projects/ui-source/export`).then((response) => response.json());
    const validFile = jsonFile('ui-source.flowboard.json', exported);
    await (await page.$('#project-bundle-file')).uploadFile(validFile);
    await page.waitForSelector('#import-target');
    r.ok((await text(page)).includes('Review before importing'), 'file selection reaches server preview review');
    r.ok((await text(page)).includes('Project name is already in use'), 'existing target is shown as a conflict');
    await page.evaluate(() => [...document.querySelectorAll('button')].find((button) => button.textContent.includes('Use ui-source-copy'))?.click());
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((button) => button.textContent.includes('Import project') && !button.disabled));
    await page.evaluate(() => [...document.querySelectorAll('button')].find((button) => button.textContent.includes('Import project') && !button.disabled)?.click());
    await page.waitForSelector('[data-testid="import-success"]');
    r.ok((await text(page)).includes('No agents were activated'), 'success explicitly says agents were not activated');
    const viewedAfterImport = await page.evaluate(() => window.appState?.viewedProject);
    r.ok(viewedAfterImport === 'ui-source', 'successful import does not auto-open the new project');
    await page.evaluate(() => [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Done')?.click());

    // Invalid local file is actionable without reaching the server.
    await page.click('.sidebar-new');
    await page.evaluate(() => [...document.querySelectorAll('button')].find((button) => button.textContent.includes('Import project'))?.click());
    await page.waitForSelector('#project-bundle-file');
    const invalidFile = jsonFile('invalid.json', '{not-json');
    await (await page.$('#project-bundle-file')).uploadFile(invalidFile);
    await page.waitForSelector('[data-testid="import-file-error"]');
    r.ok((await text(page)).includes('not valid JSON'), 'invalid JSON file has an actionable error');
    await page.click('button[aria-label="Close"]');

    // Security findings come from the real preview response and block the CTA.
    await page.click('.sidebar-new');
    await page.evaluate(() => [...document.querySelectorAll('button')].find((button) => button.textContent.includes('Import project'))?.click());
    await page.waitForSelector('#project-bundle-file');
    const unsafeFile = jsonFile('unsafe.flowboard.json', securityFixture());
    await (await page.$('#project-bundle-file')).uploadFile(unsafeFile);
    await page.waitForSelector('[data-testid="import-preview-error"]');
    r.ok((await text(page)).includes('Import blocked'), 'security findings block import in review');
    await page.click('button[aria-label="Close"]');

    // Recoverable failure exposes an import ID and the retry returns to the
    // success state. The test-only server hook is scoped to NODE_ENV=test.
    await page.click('.sidebar-new');
    await page.evaluate(() => [...document.querySelectorAll('button')].find((button) => button.textContent.includes('Import project'))?.click());
    await page.waitForSelector('#project-bundle-file');
    await (await page.$('#project-bundle-file')).uploadFile(validFile);
    await page.waitForSelector('#import-target');
    await page.click('#import-target', { clickCount: 3 });
    await page.type('#import-target', 'retry-copy');
    await new Promise((resolve) => setTimeout(resolve, 350));
    let failOnce = true;
    await page.setRequestInterception(true);
    const intercept = async (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/projects/import' && failOnce) {
        failOnce = false;
        await request.continue({ headers: { ...request.headers(), 'x-flowboard-test-import-failure': 'finalize' } });
      } else {
        await request.continue();
      }
    };
    page.on('request', intercept);
    await page.evaluate(() => [...document.querySelectorAll('button')].find((button) => button.textContent.includes('Import project') && !button.disabled)?.click());
    await page.waitForSelector('[data-testid="import-failure"]');
    r.ok((await text(page)).includes('Import ID:') && (await text(page)).includes('Retry import'), 'recoverable failure provides import ID and retry');
    await page.evaluate(() => [...document.querySelectorAll('button')].find((button) => button.textContent.includes('Retry import'))?.click());
    await page.waitForSelector('[data-testid="import-success"]');
    r.ok(true, 'retry completes the recoverable import');
    page.off('request', intercept);
    await page.setRequestInterception(false);

    // Mobile dialog is almost fullscreen and keeps a large action target.
    await page.evaluate(() => [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Done')?.click());
    await page.setViewport({ width: 390, height: 844 });
    await page.click('.sidebar-new');
    await page.evaluate(() => [...document.querySelectorAll('button')].find((button) => button.textContent.includes('Import project'))?.click());
    const modalHeight = await page.$eval('#modalRoot [role="dialog"]', (dialog) => dialog.getBoundingClientRect().height);
    r.ok(modalHeight >= 800, 'mobile bundle dialog uses near-fullscreen layout');
    await page.click('button[aria-label="Close"]');
  }, { port: 18862, viewport: { width: 1400, height: 900 } });

  if (result?.skipped) r.skip(result.reason);
  r.done();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
