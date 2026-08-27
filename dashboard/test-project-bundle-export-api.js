'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { withIsolatedDashboard } = require('./test-support/server-harness.js');
const { validateBundle } = require('./project-bundle-validator.js');
const { SENSITIVE_EXPORT_CONFIRMATION } = require('./project-bundle-export.js');

async function main() {
  await withIsolatedDashboard(async (ctx) => {
    const created = await ctx.api('POST', '/projects', {
      name: 'portable-review-fixture',
      displayName: 'Portable Review Fixture',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const unrelated = await ctx.api('POST', '/projects', {
      name: 'unrelated-project',
      displayName: 'Unrelated Project',
    });
    assert.equal(unrelated.status, 201, JSON.stringify(unrelated.body));

    const contextWrite = await ctx.api('PUT', '/projects/portable-review-fixture/files/context/REVIEW.md', {
      content: 'Safe review context.\n',
    });
    assert.equal(contextWrite.status, 200, JSON.stringify(contextWrite.body));
    fs.writeFileSync(path.join(ctx.projectsDir, 'portable-review-fixture', 'SESSIONS.md'), 'private session history\n');
    fs.writeFileSync(path.join(ctx.projectsDir, 'portable-review-fixture', 'context', 'secrets.md'), 'must not export\n');
    fs.mkdirSync(path.join(ctx.projectsDir, 'portable-review-fixture', 'context', '.private'), { recursive: true });
    fs.writeFileSync(path.join(ctx.projectsDir, 'portable-review-fixture', 'context', '.private', 'hidden.md'), 'must not export\n');

    const parent = await ctx.api('POST', '/projects/portable-review-fixture/tasks', {
      title: 'Review the portable fixture',
      description: 'Parent review task.',
      priority: 'high',
      status: 'in-progress',
    });
    assert.equal(parent.status, 200, JSON.stringify(parent.body));
    const parentId = parent.body.task.id;
    const child = await ctx.api('POST', '/projects/portable-review-fixture/tasks', {
      title: 'Archive the fixture child',
      description: 'Archived child task.',
      parentId,
      status: 'archived',
    });
    assert.equal(child.status, 200, JSON.stringify(child.body));
    const childId = child.body.task.id;
    const spec = await ctx.api('POST', `/projects/portable-review-fixture/specs/${parentId}`, {
      content: '# Portable fixture review\n\nReview the export boundary.\n',
    });
    assert.equal(spec.status, 200, JSON.stringify(spec.body));
    const contextSpecWrite = await ctx.api('PUT', '/projects/portable-review-fixture/files/context/CONTEXT-SPEC.md', {
      content: '# Context-linked fixture spec\n\nThis is canonical spec content.\n',
    });
    assert.equal(contextSpecWrite.status, 200, JSON.stringify(contextSpecWrite.body));
    const contextSpecLink = await ctx.api('PUT', `/projects/portable-review-fixture/tasks/${childId}`, {
      specFile: 'context/CONTEXT-SPEC.md',
    });
    assert.equal(contextSpecLink.status, 200, JSON.stringify(contextSpecLink.body));

    const canvas = await ctx.api('POST', '/projects/portable-review-fixture/canvas/notes', {
      text: 'Review canvas idea', x: 10, y: 20, color: 'yellow', size: 'small',
    });
    assert.equal(canvas.status, 200, JSON.stringify(canvas.body));

    const unrelatedTask = await ctx.api('POST', '/projects/unrelated-project/tasks', {
      title: 'Unrelated secret task', description: 'Must not cross boundary.', status: 'done',
    });
    assert.equal(unrelatedTask.status, 200, JSON.stringify(unrelatedTask.body));

    const beforeTasks = await ctx.api('GET', '/projects/portable-review-fixture/tasks?includeArchived=true');
    const beforeFiles = await ctx.api('GET', '/projects/portable-review-fixture/files');
    assert.equal(beforeTasks.status, 200);
    assert.equal(beforeFiles.status, 200);

    const response = await ctx.api('GET', '/projects/portable-review-fixture/export');
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.match(response.contentType, /^application\/json/i);
    assert.match(response.headers.get('content-disposition') || '', /attachment; filename="flowboard-portable-review-fixture\.flowboard\.json"/);
    const result = validateBundle(response.body);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(response.body.project.slug, 'portable-review-fixture');
    assert.equal(response.body.tasks.some((task) => task.id === childId && task.status === 'archived'), true);
    assert.equal(response.body.specs.length, 2);
    assert.equal(response.body.specs.some((spec) => spec.path === 'specs/T-001-review-the-portable-fixture.md'), true);
    assert.equal(response.body.specs.some((spec) => spec.path === 'context/CONTEXT-SPEC.md'), true);
    assert.equal(response.body.files.some((file) => file.path === 'context/CONTEXT-SPEC.md'), false);
    assert.equal(response.body.files.some((file) => file.path === 'SESSIONS.md'), false);
    assert.equal(response.body.files.some((file) => file.path.includes('secret')), false);
    assert.equal(response.body.tasks.some((task) => task.title === 'Unrelated secret task'), false);
    assert.equal(JSON.stringify(response.body).includes('leaseUntil'), false);
    assert.equal(JSON.stringify(response.body).includes('claimedBy'), false);
    assert.equal(JSON.stringify(response.body).includes('flowboard.db'), false);
    assert.ok(response.body.manifest.warnings.some((item) => item.code === 'EXCLUDED_FILE'));

    const afterTasks = await ctx.api('GET', '/projects/portable-review-fixture/tasks?includeArchived=true');
    const afterFiles = await ctx.api('GET', '/projects/portable-review-fixture/files');
    assert.deepEqual(afterTasks.body.tasks, beforeTasks.body.tasks, 'export does not mutate task projection');
    assert.deepEqual(afterFiles.body, beforeFiles.body, 'export does not mutate project files');
    const auditFile = path.join(ctx.projectsDir, '.audit', 'destructive.log');
    assert.equal(fs.existsSync(auditFile), true);
    assert.match(fs.readFileSync(auditFile, 'utf8'), /"action":"project\.export"/);

    // Legacy imports could attach one shared spec to several tasks. The
    // exporter must report the invalid task/spec reference in typed form,
    // without returning the source filename or validator message.
    const legacyProject = await ctx.api('POST', '/projects', {
      name: 'legacy-reference-fixture',
      displayName: 'Legacy Reference Fixture',
    });
    assert.equal(legacyProject.status, 201, JSON.stringify(legacyProject.body));
    const legacyFirst = await ctx.api('POST', '/projects/legacy-reference-fixture/tasks', {
      title: 'Legacy parent task', status: 'backlog', description: 'Fixture task.',
    });
    const legacySecond = await ctx.api('POST', '/projects/legacy-reference-fixture/tasks', {
      title: 'Legacy child task', status: 'backlog', description: 'Fixture task.',
    });
    assert.equal(legacyFirst.status, 200, JSON.stringify(legacyFirst.body));
    assert.equal(legacySecond.status, 200, JSON.stringify(legacySecond.body));
    const legacyFirstId = legacyFirst.body.task.id;
    const legacySecondId = legacySecond.body.task.id;
    const legacySpec = await ctx.api('PUT', '/projects/legacy-reference-fixture/files/context/SHARED.md', {
      content: '# Shared legacy spec\n\nThis source file must not be disclosed by diagnostics.\n',
    });
    assert.equal(legacySpec.status, 200, JSON.stringify(legacySpec.body));
    for (const taskId of [legacyFirstId, legacySecondId]) {
      const link = await ctx.api('PUT', `/projects/legacy-reference-fixture/tasks/${taskId}`, {
        specFile: 'context/SHARED.md',
      });
      assert.equal(link.status, 200, JSON.stringify(link.body));
    }
    const invalidLegacyExport = await ctx.api('GET', '/projects/legacy-reference-fixture/export');
    assert.equal(invalidLegacyExport.status, 500, JSON.stringify(invalidLegacyExport.body));
    assert.equal(invalidLegacyExport.body.code, 'BUNDLE_INVALID');
    assert.ok(invalidLegacyExport.body.diagnostics.some((item) => (
      item.code === 'REFERENCE_INVALID'
      && item.section === 'task'
      && item.taskId === legacySecondId
      && item.field === 'specFile'
      && item.action === 'RELINK_OR_CLEAR_SPEC_REFERENCE'
    )));
    assert.equal(JSON.stringify(invalidLegacyExport.body).includes('context/SHARED.md'), false);
    assert.equal(JSON.stringify(invalidLegacyExport.body).includes('different task'), false);

    const fakeOptionalSecret = 'sk-review-api-fake-value-1234567890';
    const secretFileWrite = await ctx.api('PUT', '/projects/portable-review-fixture/files/context/REVIEW.md', {
      content: `Review-only note with apiKey: ${fakeOptionalSecret}\n`,
    });
    assert.equal(secretFileWrite.status, 200, JSON.stringify(secretFileWrite.body));
    const redactedResponse = await ctx.api('GET', '/projects/portable-review-fixture/export');
    assert.equal(redactedResponse.status, 200, JSON.stringify(redactedResponse.body));
    assert.equal(JSON.stringify(redactedResponse.body).includes(fakeOptionalSecret), false);
    assert.equal(redactedResponse.body.files.some((file) => file.path === 'context/REVIEW.md'), false);
    assert.ok(redactedResponse.body.manifest.warnings.some((item) => item.code === 'SENSITIVE_CONTENT_EXCLUDED'));

    // A missing linked context spec is reported with only the safe task id and
    // categorical reason; neither the response nor logs reflect paths/content.
    const contextSpecPath = path.join(ctx.projectsDir, 'portable-review-fixture', 'context', 'CONTEXT-SPEC.md');
    fs.unlinkSync(contextSpecPath);
    const staleSpec = await ctx.api('GET', '/projects/portable-review-fixture/export');
    assert.equal(staleSpec.status, 500, JSON.stringify(staleSpec.body));
    assert.equal(staleSpec.body.code, 'SPEC_READ_FAILED');
    assert.deepEqual(staleSpec.body.diagnostics, [{
      code: 'SPEC_READ_FAILED',
      taskId: childId,
    }]);
    assert.equal(JSON.stringify(staleSpec.body).includes('CONTEXT-SPEC.md'), false);
    assert.equal(JSON.stringify(staleSpec.body).includes('canonical spec content'), false);
    assert.equal(ctx.readLogs().includes('canonical spec content'), false);

    // Controlled file deletion also clears a context-linked spec reference so
    // future exports cannot retain the stale link.
    fs.writeFileSync(contextSpecPath, '# Context-linked fixture spec\n\nThis is canonical spec content.\n');
    const deleteContextSpec = await ctx.api('DELETE', '/projects/portable-review-fixture/files/context/CONTEXT-SPEC.md');
    assert.equal(deleteContextSpec.status, 200, JSON.stringify(deleteContextSpec.body));
    const unlinkedTasks = await ctx.api('GET', '/projects/portable-review-fixture/tasks?includeArchived=true');
    assert.equal(unlinkedTasks.body.tasks.find((task) => task.id === childId).specFile, null);
    assert.equal(unlinkedTasks.body.tasks.find((task) => task.id === childId).specExists, false);

    // The override is always separately confirmed, rejects tunnel/proxy-marked
    // requests, and returns the intentionally reviewed canonical content.
    const confirmationRequired = await ctx.api('POST', '/projects/portable-review-fixture/export', {});
    assert.equal(confirmationRequired.status, 400, JSON.stringify(confirmationRequired.body));
    assert.equal(confirmationRequired.body.code, 'CONFIRMATION_REQUIRED');
    assert.equal(JSON.stringify(confirmationRequired.body).includes('canonical spec content'), false);

    for (const header of [
      'X-Forwarded-For', 'X-Forwarded-Host', 'X-Forwarded-Proto', 'Forwarded',
      'Via', 'X-Real-IP', 'CF-Ray', 'CF-Connecting-IP', 'CF-Visitor', 'X-Tunnel-ID',
      'X-Envoy-External-Address', 'X-Envoy-Original-Path', 'X-Proxy-Client-IP',
      'X-Original-URL', 'X-Forwarding-Chain', 'X-Request-ID',
    ]) {
      const markedRequest = await fetch(`${ctx.base}/api/projects/portable-review-fixture/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [header]: 'synthetic-tunnel' },
        body: JSON.stringify({ confirmation: SENSITIVE_EXPORT_CONFIRMATION }),
      });
      const markedBody = await markedRequest.json();
      assert.equal(markedRequest.status, 403, `${header}: ${JSON.stringify(markedBody)}`);
      assert.equal(JSON.stringify(markedBody).includes('canonical spec content'), false);
      assert.equal(JSON.stringify(markedBody).includes('CONTEXT-SPEC.md'), false);
    }

    // A browser-shaped direct request still reaches the confirmation guard.
    // This proves the positive allowlist preserves normal dashboard POSTs
    // while the proxy/unknown-header cases above are rejected first.
    const browserRequest = await fetch(`${ctx.base}/api/projects/portable-review-fixture/export`, {
      method: 'POST',
      headers: {
        Accept: '*/*',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'en-US,en;q=0.9',
        'Content-Type': 'application/json',
        Origin: ctx.base,
        Priority: 'u=1, i',
        Referer: `${ctx.base}/`,
        'Sec-CH-UA': '"Chromium";v="1"',
        'Sec-CH-UA-Mobile': '?0',
        'Sec-CH-UA-Platform': '"macOS"',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'X-FlowBoard-Client': 'dashboard',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: JSON.stringify({}),
    });
    const browserBody = await browserRequest.json();
    assert.equal(browserRequest.status, 400, JSON.stringify(browserBody));
    assert.equal(browserBody.code, 'CONFIRMATION_REQUIRED');

    const fakeCanonicalSecret = 'ghp_review_api_fake_value_1234567890';
    const canonicalSecretWrite = await ctx.api('PUT', `/projects/portable-review-fixture/tasks/${parentId}`, {
      description: `token: ${fakeCanonicalSecret}`,
    });
    assert.equal(canonicalSecretWrite.status, 200, JSON.stringify(canonicalSecretWrite.body));
    const blocked = await ctx.api('GET', '/projects/portable-review-fixture/export');
    assert.equal(blocked.status, 500, JSON.stringify(blocked.body));
    assert.deepEqual(blocked.body, { error: 'Project export failed', code: 'SENSITIVE_CONTENT_DETECTED' });
    assert.equal(JSON.stringify(blocked.body).includes(fakeCanonicalSecret), false);

    const recovered = await ctx.api('POST', '/projects/portable-review-fixture/export', {
      confirmation: SENSITIVE_EXPORT_CONFIRMATION,
    });
    assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
    assert.equal(recovered.body.tasks.find((task) => task.id === parentId).description.includes(fakeCanonicalSecret), true);
    assert.equal(ctx.readLogs().includes(fakeCanonicalSecret), false);
    assert.match(fs.readFileSync(auditFile, 'utf8'), /"action":"project\.export\.sensitive-override"/);

    const missing = await ctx.api('GET', '/projects/does-not-exist/export');
    assert.equal(missing.status, 404);
  }, { prefix: 'flowboard-t468-export-api-' });
  console.log('T-468-3 project bundle export API tests passed');
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
