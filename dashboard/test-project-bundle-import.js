'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('libsql');
const {
  createBundle,
  canonicalJson,
  payloadForChecksum,
  sha256,
} = require('./project-bundle-schema.js');
const { withIsolatedDashboard } = require('./test-support/server-harness.js');

const DETAILS = Object.freeze({
  reason: 'Imported review state',
  waitingFor: null,
  responsible: null,
  checkAgainAt: null,
  setAt: '2026-08-01T10:00:00.000Z',
});

function fixture(bundleId = 'import-fixture') {
  return createBundle({
    project: {
      slug: 'review-fixture',
      displayName: 'Review Fixture',
      description: 'Generic review fixture.',
      group: 'Review',
      taskDiscipline: 'development',
    },
    tasks: [
      {
        id: 'T-001', title: 'Review the fixture', status: 'open', priority: 'high',
        description: 'Portable parent task.', tags: ['review'], links: ['docs/example'],
        created: '2026-08-01', completed: null,
        enteredStatusAt: '2026-08-01T10:00:00.000Z', order: 2,
        workState: 'waiting', workStateDetails: DETAILS,
        specFile: 'specs/T-001-review-the-fixture.md',
      },
      {
        id: 'T-001-1', title: 'Verify the fixture', status: 'done', priority: 'medium',
        description: 'Portable child task.', parentId: 'T-001', dependsOn: ['T-001'],
        created: '2026-08-02', completed: '2026-08-03',
        enteredStatusAt: '2026-08-02T10:00:00.000Z', order: null,
        workState: 'working', workStateDetails: {
          reason: null, waitingFor: null, responsible: null, checkAgainAt: null, setAt: null,
        },
      },
    ],
    specs: [{
      path: 'specs/T-001-review-the-fixture.md',
      taskId: 'T-001',
      content: '# Review Fixture\n\n## Done When\n- [ ] reviewed\n',
    }],
    canvas: {
      version: 1,
      notes: [
        { id: 'N-001', text: 'First review idea', x: 10, y: 20, color: 'yellow', size: 'small', created: '2026-08-01' },
        { id: 'N-002', text: 'Second review idea', x: 200, y: 20, color: 'blue', size: 'medium', created: '2026-08-01' },
      ],
      connections: [{ from: 'N-001', to: 'N-002', fromPort: 'right', toPort: 'left' }],
    },
    overview: {
      version: 1,
      layout: 'grid',
      widgets: [{ id: 'w-review', type: 'task-stats', grid: { x: 0, y: 0, w: 4, h: 2 } }],
    },
    files: [
      { path: 'PROJECT.md', content: '# Review Fixture\n' },
      { path: 'DECISIONS.md', content: '# Decisions\n' },
      { path: 'context/REVIEW.md', content: '# Review context\n' },
    ],
  }, {
    bundleId,
    producerName: 'FlowBoard',
    producerVersion: '1.0.0',
    createdAt: '2026-08-26T10:00:00.000Z',
  });
}

async function postImport(ctx, bundle, targetName, failure, lock = false) {
  const response = await fetch(`${ctx.base}/api/projects/import?targetName=${encodeURIComponent(targetName)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/vnd.flowboard.project+json',
      ...(failure ? { 'X-FlowBoard-Test-Import-Failure': failure } : {}),
      ...(lock ? { 'X-FlowBoard-Test-Import-Lock': 'true' } : {}),
    },
    body: JSON.stringify(bundle),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

function eventWatermark(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare('SELECT COUNT(*) AS count, MAX(id) AS maxId FROM events').get();
    return { count: Number(row.count), maxId: row.maxId === null ? null : Number(row.maxId) };
  } finally { db.close(); }
}

async function main() {
  await withIsolatedDashboard(async (ctx) => {
    const bundle = fixture();

    // The full semantic round trip uses fresh HZL ULIDs while preserving the
    // portable FlowBoard ids, hierarchy, dependencies, specs, files, canvas
    // and overview.  No runtime ownership is carried across.
    const imported = await postImport(ctx, bundle, 'review-copy');
    assert.equal(imported.status, 201, JSON.stringify(imported.body));
    assert.equal(imported.body.state, 'committed');
    assert.equal(imported.body.counts.tasks, 2);
    const projects = await ctx.api('GET', '/projects');
    assert.equal(projects.body.projects.some(project => project.name === 'review-copy'), true);
    const tasks = await ctx.api('GET', '/projects/review-copy/tasks?includeArchived=true');
    assert.equal(tasks.status, 200, JSON.stringify(tasks.body));
    assert.deepEqual(tasks.body.tasks.map(task => task.id), ['T-001', 'T-001-1']);
    const child = tasks.body.tasks.find(task => task.id === 'T-001-1');
    assert.equal(child.parentId, 'T-001');
    assert.deepEqual(child.dependsOn, ['T-001']);
    assert.equal(child.status, 'done');
    assert.equal(child.agent, null);
    assert.equal(child.claimedAt, null);
    assert.equal(child.leaseUntil, null);
    assert.equal(child.routedAgent, null);
    assert.equal(child.checkpointCount, 0);
    assert.equal(child.stuckIndicator, null);
    assert.deepEqual(tasks.body.tasks[0].workStateDetails, DETAILS);

    const cacheDb = new Database(ctx.cacheDbPath, { readonly: true });
    try {
      const rows = cacheDb.prepare('SELECT task_id FROM tasks_current WHERE project = ? ORDER BY task_id').all('review-copy');
      assert.equal(rows.length, 2);
      assert.ok(rows.every(row => row.task_id !== 'T-001' && row.task_id !== 'T-001-1'));
      const deps = cacheDb.prepare(`
        SELECT d.task_id, d.depends_on_id
          FROM task_dependencies d
          JOIN tasks_current t ON t.task_id = d.task_id
         WHERE t.project = ?
      `).all('review-copy');
      assert.equal(deps.length, 1);
    } finally { cacheDb.close(); }

    const files = await ctx.api('GET', '/projects/review-copy/files');
    assert.equal(files.status, 200);
    const filePaths = JSON.stringify(files.body);
    assert.match(filePaths, /context\/REVIEW\.md/);
    assert.match(filePaths, /specs\/T-001-review-the-fixture\.md/);
    assert.doesNotMatch(filePaths, /SESSIONS\.md.*Review context/);
    const canvas = await ctx.api('GET', '/projects/review-copy/canvas');
    assert.equal(canvas.status, 200);
    assert.equal(canvas.body.notes.length, 2);
    assert.equal(canvas.body.connections.length, 1);
    const overview = await ctx.api('GET', '/projects/review-copy/overview');
    assert.equal(overview.status, 200);
    assert.equal(overview.body.overview.widgets.length, 1);

    // A second completed import is a no-op conflict; no new journal/event is
    // created and the existing target remains unchanged.
    const beforeSecond = eventWatermark(ctx.dbPath);
    const second = await postImport(ctx, bundle, 'review-copy');
    assert.equal(second.status, 409, JSON.stringify(second.body));
    assert.equal(second.body.code, 'IMPORT_TARGET_CONFLICT');
    assert.deepEqual(eventWatermark(ctx.dbPath), beforeSecond);

    // Invalid/sensitive input is rejected before a journal, HZL event or
    // target directory exists.
    const secret = fixture('secret-fixture');
    secret.tasks[0].description = 'apiKey: ghp_fake_review_value_1234567890';
    secret.manifest.checksums.payload = sha256(payloadForChecksum(secret));
    const beforeInvalid = eventWatermark(ctx.dbPath);
    const invalid = await postImport(ctx, secret, 'secret-copy');
    assert.equal(invalid.status, 422, JSON.stringify(invalid.body));
    assert.equal(invalid.body.code, 'BUNDLE_PREVIEW_INVALID');
    assert.equal((await ctx.api('GET', '/projects/import/status?targetName=secret-copy')).body.journals.length, 0);
    assert.equal(fs.existsSync(path.join(ctx.projectsDir, 'secret-copy')), false);
    assert.deepEqual(eventWatermark(ctx.dbPath), beforeInvalid);

    const reserved = fixture('reserved-fixture');
    const reservedResult = await postImport(ctx, reserved, '.trash');
    assert.equal(reservedResult.status, 409);
    assert.equal(reservedResult.body.code, 'TARGET_RESERVED');

    // A process-local lock is observable as a conflict and does not create a
    // journal.  This simulates a concurrent request while the first worker is
    // in a mutation phase.
    const locked = await postImport(ctx, fixture('locked-fixture'), 'locked-copy', null, true);
    assert.equal(locked.status, 409);
    assert.equal(locked.body.code, 'IMPORT_IN_PROGRESS');
    assert.equal((await ctx.api('GET', '/projects/import/status?targetName=locked-copy')).body.journals.length, 0);

    // Every mutation phase leaves a recoverable, hidden journal and the same
    // target+digest resumes idempotently once the injected test dependency is
    // removed.  This covers project/task/file/canvas/finalize boundaries.
    for (const [index, phase] of ['project', 'task', 'file', 'canvas', 'finalize'].entries()) {
      const target = `resume-${phase}`;
      const failure = await postImport(ctx, fixture(`resume-${phase}-fixture`), target, phase);
      assert.equal(failure.status, 500, `${phase}: ${JSON.stringify(failure.body)}`);
      assert.equal(failure.body.state, 'failed');
      assert.equal(failure.body.recoverable, true);
      assert.equal((await ctx.api('GET', '/projects')).body.projects.some(project => project.name === target), false);
      assert.equal((await ctx.api('GET', `/projects/${target}/tasks`)).status, 404);
      const resumed = await postImport(ctx, fixture(`resume-${phase}-fixture`), target);
      assert.equal(resumed.status, 201, `${phase} resume: ${JSON.stringify(resumed.body)}`);
      assert.equal((await ctx.api('GET', `/projects/import/${resumed.body.importId}`)).body.journal.state, 'committed');
      assert.equal(index >= 0, true);
    }
  }, { prefix: 'flowboard-t468-import-api-' });

  // A journal left active by a stopped process is marked failed/recoverable
  // on startup and can resume with the identical digest.
  const recoveryBundle = fixture('restart-recovery-fixture');
  const recoveryDigest = sha256(canonicalJson(recoveryBundle));
  await withIsolatedDashboard(async (ctx) => {
    const status = await ctx.api('GET', '/projects/import/status?targetName=recovered-copy');
    assert.equal(status.status, 200);
    assert.equal(status.body.journals[0].state, 'failed');
    assert.equal(status.body.journals[0].errorCode, 'IMPORT_INTERRUPTED');
    assert.equal((await ctx.api('GET', '/projects')).body.projects.some(project => project.name === 'recovered-copy'), false);
    const resumed = await postImport(ctx, recoveryBundle, 'recovered-copy');
    assert.equal(resumed.status, 201, JSON.stringify(resumed.body));
  }, {
    prefix: 'flowboard-t468-import-recovery-',
    prepare: async (paths) => {
      const db = new Database(paths.cacheDbPath);
      db.exec(`
        CREATE TABLE IF NOT EXISTS flowboard_project_imports (
          import_id TEXT PRIMARY KEY, target_name TEXT NOT NULL, bundle_digest TEXT NOT NULL,
          state TEXT NOT NULL, progress TEXT NOT NULL DEFAULT '{}', error_code TEXT,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
      `);
      db.prepare(`
        INSERT INTO flowboard_project_imports
          (import_id, target_name, bundle_digest, state, progress, created_at, updated_at)
        VALUES (?, ?, ?, 'importing-tasks', ?, ?, ?)
      `).run(
        'restart-recovery-import', 'recovered-copy', recoveryDigest,
        JSON.stringify({ phase: 'importing-tasks', tasksImported: 0 }),
        '2026-08-26T09:00:00.000Z', '2026-08-26T09:00:00.000Z',
      );
      db.close();
    },
  });
  console.log('T-468-5 project bundle importer tests passed');
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
