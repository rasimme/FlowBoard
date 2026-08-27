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

async function dragBundle(page, body, filename) {
  const payload = { body, filename };
  await page.evaluate(({ body: value, filename: name }) => {
    const zone = document.querySelector('[data-testid="import-dropzone"]');
    const data = new DataTransfer();
    data.items.add(new File([value], name, { type: 'application/json' }));
    for (const type of ['dragenter', 'dragover']) {
      zone.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }));
    }
  }, payload);
  await page.waitForFunction(() => document.querySelector('[data-testid="import-dropzone"]')?.dataset.dragActive === 'true');
  await page.evaluate(({ body: value, filename: name }) => {
    const zone = document.querySelector('[data-testid="import-dropzone"]');
    const data = new DataTransfer();
    data.items.add(new File([value], name, { type: 'application/json' }));
    zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
  }, payload);
  return true;
}

(async () => {
  const result = await withDashboard(async ({ api, page, base }) => {
    const created = await api('POST', '/projects', { name: 'ui-source', displayName: 'UI Source' });
    r.ok([200, 201].includes(created.status), 'fixture project created');

    await page.goto(`${base}/?agentId=bundle-ui-e2e`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('.project-item');

    // Existing entry points.
    await page.click('.row-kebab');
    r.ok((await text(page)).includes('Export project'), 'project actions menu exposes Export project');
    await page.evaluate(() => [...document.querySelectorAll('button')].find((button) => button.textContent.includes('Export project'))?.click());
    await page.waitForSelector('#include-task-history');
    r.ok((await text(page)).toLowerCase().includes('included') && (await text(page)).toLowerCase().includes('not included'), 'export ready state renders included and excluded scope');
    r.ok((await page.$$('[data-testid="bundle-counts"]')) .length > 0, 'export renders server counts before download');
    let historyRequest = false;
    page.on('request', (request) => {
      if (request.url().includes('/export?includeHistory=true')) historyRequest = true;
    });
    let blockHistory = true;
    await page.setRequestInterception(true);
    const exportIntercept = async (request) => {
      const url = new URL(request.url());
      if (request.method() === 'GET' && url.pathname.endsWith('/export') && url.searchParams.get('includeHistory') === 'true' && blockHistory) {
        blockHistory = false;
        await request.respond({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic history export block', code: 'HISTORY_BLOCKED' }) });
        return;
      }
      await request.continue();
    };
    page.on('request', exportIntercept);
    await page.click('#include-task-history');
    await page.waitForSelector('[data-testid="export-error"]');
    r.ok(historyRequest, 'history opt-in refetches export with includeHistory=true');
    r.ok((await text(page)).includes('Continue without history'), 'blocked history export offers a safe fallback');
    await page.evaluate(() => [...document.querySelectorAll('button')].find((button) => button.textContent.includes('Continue without history'))?.click());
    await page.waitForSelector('#include-task-history');
    r.ok(!(await page.$eval('#include-task-history', (input) => input.checked)), 'safe fallback refetches with history disabled');
    page.off('request', exportIntercept);
    await page.setRequestInterception(false);
    await page.click('button[aria-label="Close"]');

    // A stale linked spec gets an actionable recovery surface without
    // exposing the raw filesystem path from the server diagnostic.
    let staleSpecFirst = true;
    await page.setRequestInterception(true);
    const staleSpecIntercept = async (request) => {
      const url = new URL(request.url());
      if (request.method() === 'GET' && url.pathname.endsWith('/export') && staleSpecFirst) {
        staleSpecFirst = false;
        await request.respond({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 'Linked spec /Users/private/project/specs/T-999-secret.md is not readable',
            code: 'SPEC_READ_FAILED',
            diagnostics: [{
              code: 'SPEC_READ_FAILED',
              taskId: 'T-999',
              path: '/Users/private/project/specs/T-999-secret.md',
              message: 'Raw path must never be rendered in the recovery UI.',
              action: 'Raw path must never be rendered in the recovery UI.',
            }],
          }),
        });
        return;
      }
      await request.continue();
    };
    page.on('request', staleSpecIntercept);
    await page.click('.row-kebab');
    await page.evaluate(() => [...document.querySelectorAll('button')].find((button) => button.textContent.includes('Export project'))?.click());
    await page.waitForSelector('[data-testid="export-diagnostics"]');
    const staleSpecText = await text(page);
    r.ok(staleSpecText.includes('Task T-999') && staleSpecText.includes('missing or unreadable'), 'SPEC_READ_FAILED renders task and categorical recovery reason');
    r.ok(!staleSpecText.includes('/Users/private/project/specs/T-999-secret.md') && !staleSpecText.includes('Raw path must never be rendered'), 'SPEC_READ_FAILED recovery UI hides raw diagnostic paths and messages');
    await page.evaluate(() => [...document.querySelectorAll('button')].find((button) => button.textContent.includes('Try again'))?.click());
    await page.waitForSelector('#include-task-history');
    r.ok(!staleSpecFirst, 'SPEC_READ_FAILED recovery Try again refetches the export');
    page.off('request', staleSpecIntercept);
    await page.setRequestInterception(false);
    await page.click('button[aria-label="Close"]');

    // Legacy parent/spec references produce a typed recovery surface rather
    // than the generic HTTP 500 fallback. Raw validator paths remain hidden.
    let invalidBundleFirst = true;
    await page.setRequestInterception(true);
    const invalidBundleIntercept = async (request) => {
      const url = new URL(request.url());
      if (request.method() === 'GET' && url.pathname.endsWith('/export') && invalidBundleFirst) {
        invalidBundleFirst = false;
        await request.respond({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 'Generated project bundle failed schema validation',
            code: 'BUNDLE_INVALID',
            diagnostics: [{
              code: 'REFERENCE_MISSING',
              section: 'task',
              action: 'REPAIR_OR_CLEAR_PARENT_REFERENCE',
              taskId: 'T-152-1',
              field: 'parentId',
              path: 'tasks.T-152-1.parentId',
              message: 'Raw validator details must never be rendered.',
            }],
          }),
        });
        return;
      }
      await request.continue();
    };
    page.on('request', invalidBundleIntercept);
    await page.click('.row-kebab');
    await page.evaluate(() => [...document.querySelectorAll('button')].find((button) => button.textContent.includes('Export project'))?.click());
    await page.waitForSelector('[data-testid="export-recovery-guidance"]');
    const invalidBundleText = await text(page);
    r.ok(invalidBundleText.includes('inconsistent task or spec references'), 'BUNDLE_INVALID has a typed export error message');
    r.ok(invalidBundleText.includes('Task T-152-1') && invalidBundleText.includes('Field parentId'), 'BUNDLE_INVALID renders safe task reference context');
    r.ok(invalidBundleText.includes('Repair or clear this task parent reference'), 'BUNDLE_INVALID renders actionable recovery guidance');
    r.ok(!invalidBundleText.includes('HTTP 500') && !invalidBundleText.includes('tasks.T-152-1.parentId') && !invalidBundleText.includes('Raw validator details'), 'BUNDLE_INVALID recovery UI hides generic/raw diagnostics');
    await page.evaluate(() => [...document.querySelectorAll('button')].find((button) => button.textContent.includes('Try again'))?.click());
    await page.waitForSelector('#include-task-history');
    r.ok(!invalidBundleFirst, 'BUNDLE_INVALID recovery Try again refetches the export');
    page.off('request', invalidBundleIntercept);
    await page.setRequestInterception(false);
    await page.click('button[aria-label="Close"]');

    await page.click('.sidebar-new');
    r.ok((await text(page)).includes('Import project'), 'New menu exposes Import project');
    await page.evaluate(() => [...document.querySelectorAll('button')].find((button) => button.textContent.includes('Import project'))?.click());
    await page.waitForSelector('#project-bundle-file');
    const exported = await fetch(`${base}/api/projects/ui-source/export`).then((response) => response.json());
    const historyExported = await fetch(`${base}/api/projects/ui-source/export?includeHistory=true`).then((response) => response.json());
    const validFile = jsonFile('ui-source.flowboard.json', exported);
    r.ok(await dragBundle(page, JSON.stringify(exported), 'ui-source.flowboard.json'), 'dropzone accepts a dragged bundle through the same preview path');
    await page.waitForSelector('#import-target');
    r.ok((await text(page)).includes('Review before importing'), 'file selection reaches server preview review');
    r.ok((await text(page)).includes('Project name is already in use'), 'existing target is shown as a conflict');
    r.ok((await page.$('[data-testid="bundle-scope"]')) !== null, 'import review renders included and excluded scope');
    r.ok(await page.evaluate(() => document.activeElement?.id === 'import-target'), 'conflict review focuses the destination input');
    await page.evaluate(() => [...document.querySelectorAll('button')].find((button) => button.textContent.includes('Use ui-source-copy'))?.click());
    await page.waitForFunction(() => {
      const button = document.querySelector('[data-testid="import-submit"]');
      return button && !button.disabled;
    });
    r.ok((await page.$eval('[data-testid="import-submit"]', (button) => button.textContent)).includes('Import as new project'), 'primary import CTA uses the explicit create-only wording');
    await page.click('[data-testid="import-submit"]');
    await page.waitForSelector('[data-testid="import-success"]');
    r.ok((await text(page)).includes('No agents were activated'), 'success explicitly says agents were not activated');
    r.ok((await page.$('[data-testid="import-success"] [data-testid="bundle-counts"]')) !== null, 'success renders imported counts');
    r.ok((await text(page)).includes('Open project'), 'success offers explicit Open project action');
    const viewedAfterImport = await page.evaluate(() => window.appState?.viewedProject);
    r.ok(viewedAfterImport === 'ui-source', 'successful import does not auto-open the new project');
    await page.evaluate(() => [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Done')?.click());

    // History-enabled previews reuse the same scope component and expose the
    // optional history rows before the user confirms the create-only import.
    await page.click('.sidebar-new');
    await page.evaluate(() => [...document.querySelectorAll('button')].find((button) => button.textContent.includes('Import project'))?.click());
    await page.waitForSelector('#project-bundle-file');
    const historyFile = jsonFile('ui-source-history.flowboard.json', historyExported);
    await (await page.$('#project-bundle-file')).uploadFile(historyFile);
    await page.waitForSelector('#import-target');
    r.ok((await text(page)).includes('Task comments and checkpoints'), 'history-enabled import review shows history scope');
    await page.click('button[aria-label="Close"]');

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
        await new Promise((resolve) => setTimeout(resolve, 500));
        await request.continue({ headers: { ...request.headers(), 'x-flowboard-test-import-failure': 'finalize' } });
      } else {
        await request.continue();
      }
    };
    page.on('request', intercept);
    await page.click('[data-testid="import-submit"]');
    await page.waitForSelector('[data-testid="import-phases"]');
    const phaseText = await page.$eval('[data-testid="import-phases"]', (list) => list.innerText);
    r.ok(['Validating bundle', 'Staging files', 'Creating project', 'Importing tasks', 'Importing files and specs', 'Restoring canvas', 'Verifying project'].every((phase) => phaseText.includes(phase)), 'import progress renders all named indeterminate phases');
    await page.waitForSelector('[data-testid="import-failure"]');
    r.ok((await text(page)).includes('Import ID:') && (await text(page)).includes('Retry import'), 'recoverable failure provides import ID and retry');
    await page.evaluate(() => [...document.querySelectorAll('button')].find((button) => button.textContent.includes('Retry import'))?.click());
    await page.waitForSelector('[data-testid="import-success"]');
    r.ok(true, 'retry completes the recoverable import');
    page.off('request', intercept);
    await page.setRequestInterception(false);

    // Sensitive canonical content has a separate, typed recovery action. The
    // intercepted GET keeps this browser test independent of fixture secrets;
    // the POST must carry the exact acknowledgement and return to ready state.
    await page.evaluate(() => [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Done')?.click());
    let sensitivePost = false;
    await page.setRequestInterception(true);
    const sensitiveIntercept = async (request) => {
      const url = new URL(request.url());
      if (request.method() === 'GET' && url.pathname.endsWith('/export')) {
        await request.respond({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Project export failed', code: 'SENSITIVE_CONTENT_DETECTED' }),
        });
        return;
      }
      if (request.method() === 'POST' && url.pathname.endsWith('/export')) {
        sensitivePost = request.postData() === JSON.stringify({ confirmation: 'export-sensitive-project' });
        await request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(exported) });
        return;
      }
      await request.continue();
    };
    page.on('request', sensitiveIntercept);
    await page.click('.row-kebab');
    await page.evaluate(() => [...document.querySelectorAll('button')].find((button) => button.textContent.includes('Export project'))?.click());
    await page.waitForSelector('[data-testid="sensitive-export-recovery"]');
    r.ok((await text(page)).includes('export-sensitive-project'), 'sensitive export recovery displays typed confirmation guidance');
    await page.type('#sensitive-export-confirmation', 'export-sensitive-project');
    await page.evaluate(() => [...document.querySelectorAll('button')].find((button) => button.textContent.includes('Confirm and export sensitive content'))?.click());
    await page.waitForSelector('#include-task-history');
    r.ok(sensitivePost, 'sensitive export recovery sends the typed confirmation via POST');
    page.off('request', sensitiveIntercept);
    await page.setRequestInterception(false);
    await page.click('button[aria-label="Close"]');

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
