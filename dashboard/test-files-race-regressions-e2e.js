'use strict';

// T-445: Files read responses must not publish after the project or
// includeHidden target changes, even when the old response is released later.

const { withDashboard, reporter } = require('./test-support/browser-harness.js');

const OLD_PROJECT = 'files-race-old';
const NEW_PROJECT = 'files-race-new';
const r = reporter('Files target race regressions (T-445)');

async function main() {
  const result = await withDashboard(async ({ api, page, base }) => {
    await api('POST', '/projects', { name: OLD_PROJECT });
    await api('POST', '/projects', { name: NEW_PROJECT });
    await api('POST', `/projects/${OLD_PROJECT}/files/context`, {
      filename: 'old.md', content: '# Old file',
    });
    await api('POST', `/projects/${NEW_PROJECT}/files/context`, {
      filename: 'new.md', content: '# New file',
    });

    let holdPath = null;
    let heldRequest = null;
    let heldStartedResolve = null;
    let heldStarted = Promise.resolve();
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (request.method() === 'GET' && url.pathname === holdPath && !heldRequest) {
        heldRequest = request;
        heldStartedResolve?.();
        return;
      }
      request.continue().catch(() => null);
    });

    const holdNextRead = (path) => {
      holdPath = path;
      heldRequest = null;
      heldStarted = new Promise((resolve) => { heldStartedResolve = resolve; });
      return heldStarted;
    };
    const releaseHeldRead = async (body) => {
      const request = heldRequest;
      heldRequest = null;
      holdPath = null;
      if (!request) return;
      await request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      }).catch(() => null);
    };

    await page.goto(`${base}/?agentId=e2e`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('.app', { timeout: 8000 });
    if (await page.evaluate((project) => window.appState?.viewedProject !== project, OLD_PROJECT)) {
      await page.click(`[data-project="${OLD_PROJECT}"]`);
    }
    await page.waitForFunction((project) => window.appState?.viewedProject === project,
      { timeout: 8000 }, OLD_PROJECT);
    await page.click('#tabBar .tab[data-tab="files"]');
    await page.waitForFunction(() => /\bfiles\b/i.test(
      document.querySelector('.file-tree-footer')?.textContent || '',
    ), { timeout: 8000 });

    const oldPath = `/api/projects/${OLD_PROJECT}/files/context/old.md`;
    const oldReadStarted = holdNextRead(oldPath);
    await page.evaluate(() => {
      const item = [...document.querySelectorAll('.tree-item')]
        .find((entry) => entry.textContent.includes('old.md'));
      item?.click();
    });
    await oldReadStarted;

    await page.click(`[data-project="${NEW_PROJECT}"]`);
    await page.waitForFunction((project) => window.appState?.viewedProject === project,
      { timeout: 8000 }, NEW_PROJECT);
    await page.waitForFunction(() => /\bfiles\b/i.test(
      document.querySelector('.file-tree-footer')?.textContent || '',
    ), { timeout: 8000 });
    await releaseHeldRead({
      path: 'context/old.md', content: '# Old late response', size: 20,
      modified: '2026-08-24T08:00:00.000Z', category: 'optional',
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    r.ok(!(await page.$eval('.file-preview', (element) => element.textContent.includes('Old late response'))),
      'late read from the former project cannot publish into the new project');

    const newPath = `/api/projects/${NEW_PROJECT}/files/context/new.md`;
    const newReadStarted = holdNextRead(newPath);
    await page.evaluate(() => {
      const item = [...document.querySelectorAll('.tree-item')]
        .find((entry) => entry.textContent.includes('new.md'));
      item?.click();
    });
    await newReadStarted;
    await page.click('.file-tree-footer button');
    await releaseHeldRead({
      path: 'context/new.md', content: '# New late response', size: 20,
      modified: '2026-08-24T08:00:00.000Z', category: 'optional',
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    r.ok(!(await page.$eval('.file-preview', (element) => element.textContent.includes('New late response'))),
      'late read from the visible target cannot publish after includeHidden changes');
  });

  if (result?.skipped) r.skip(result.reason);
  r.done();
}

main().catch((error) => { console.error(error); process.exit(1); });
