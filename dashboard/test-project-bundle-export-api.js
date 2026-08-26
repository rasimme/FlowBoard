'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { withIsolatedDashboard } = require('./test-support/server-harness.js');
const { validateBundle } = require('./project-bundle-validator.js');

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
    assert.equal(response.body.specs.length, 1);
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

    const missing = await ctx.api('GET', '/projects/does-not-exist/export');
    assert.equal(missing.status, 404);
  }, { prefix: 'flowboard-t468-export-api-' });
  console.log('T-468-3 project bundle export API tests passed');
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
