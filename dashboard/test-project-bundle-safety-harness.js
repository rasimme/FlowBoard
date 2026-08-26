'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { isolatedEnvironment, withIsolatedDashboard } = require('./test-support/server-harness.js');

async function main() {
  const liveWorkspace = process.env.OPENCLAW_WORKSPACE || '';
  let tempRoot = null;

  const environment = isolatedEnvironment({
    ...process.env,
    TEST_PARENT_SECRET: 'must-not-cross-the-boundary',
    TELEGRAM_BOT_TOKEN: 'must-not-cross-the-boundary',
  }, {
    workspace: '/tmp/test-workspace',
    projectsDir: '/tmp/test-projects',
    dbPath: '/tmp/test-flowboard.db',
    policyDir: '/tmp/test-policy',
  }, 19000);
  assert.equal(environment.TEST_PARENT_SECRET, undefined);
  assert.equal(environment.TELEGRAM_BOT_TOKEN, '');
  assert.equal(environment.OPENCLAW_WORKSPACE, '/tmp/test-workspace');

  await withIsolatedDashboard(async (ctx) => {
    tempRoot = ctx.tempRoot;
    assert.ok(tempRoot.startsWith(require('node:os').tmpdir() + path.sep));
    assert.notEqual(ctx.workspace, liveWorkspace);
    assert.equal(fs.existsSync(path.join(ctx.workspace, 'projects')), true);
    assert.equal(fs.existsSync(ctx.projectsDir), true);

    const health = await ctx.api('GET', '/health');
    assert.equal(health.status, 200);
    assert.deepEqual(health.body, { ok: true });

    const created = await ctx.api('POST', '/projects', {
      name: 'portable-review-fixture',
      displayName: 'Portable Review Fixture',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const listed = await ctx.api('GET', '/projects');
    assert.equal(listed.status, 200);
    assert.equal(listed.body.projects.some((project) => project.name === 'portable-review-fixture'), true);
    assert.equal(fs.existsSync(ctx.dbPath), true);
    assert.equal(fs.existsSync(ctx.cacheDbPath), true);

    const logs = ctx.readLogs();
    assert.equal(logs.includes('test-parent-secret-must-not-leak'), false);
  }, {
    prefix: 'flowboard-t468-safety-',
    parentEnv: {
      ...process.env,
      TELEGRAM_BOT_TOKEN: 'test-parent-secret-must-not-leak',
    },
  });

  assert.ok(tempRoot);
  assert.equal(fs.existsSync(tempRoot), false, 'isolated workspace is removed after shutdown');
  console.log('T-468 isolated dashboard safety harness tests passed');
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
