'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('libsql');
const { createBundle, payloadForChecksum, sha256 } = require('./project-bundle-schema.js');
const {
  RAW_BODY_LIMIT,
  collectSensitiveFindings,
  parseJsonBody,
  previewBundle,
} = require('./project-bundle-import-preview.js');
const { withIsolatedDashboard } = require('./test-support/server-harness.js');

function fixture(overrides = {}) {
  return createBundle({
    project: {
      slug: 'review-fixture', displayName: 'Review Fixture', description: 'Generic fixture.',
      taskDiscipline: 'development', group: 'review',
    },
    tasks: [{
      id: 'T-001', title: 'Review the fixture', status: 'open', priority: 'medium',
      description: 'Portable review task.', created: '2026-08-01', completed: null,
      enteredStatusAt: '2026-08-01T10:00:00.000Z', order: null, workStateDetails: {},
    }],
    specs: [],
    canvas: { version: 1, notes: [], connections: [] },
    overview: { version: 1, layout: 'grid', widgets: [] },
    files: [{ path: 'PROJECT.md', content: '# Review Fixture\n' }],
  }, {
    bundleId: 'preview-fixture', createdAt: '2026-08-26T10:00:00.000Z',
    producerName: 'FlowBoard', producerVersion: '1.0.0',
    ...overrides,
  });
}

function refreshPayloadChecksum(bundle) {
  bundle.manifest.checksums.payload = sha256(payloadForChecksum(bundle));
  return bundle;
}

function codes(result) {
  return [...(result.errors || []), ...(result.securityWarnings || [])].map((item) => item.code);
}

// Pure preview is deterministic and never needs a database or filesystem.
{
  const first = previewBundle(fixture(), { targetName: 'review-copy' });
  const second = previewBundle(fixture(), { targetName: 'review-copy' });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.preview.canImport, true);
  assert.equal(first.preview.bundleDigest, second.preview.bundleDigest);
  assert.equal(first.preview.source.producer.name, 'FlowBoard');
  assert.deepEqual(first.preview.counts, second.preview.counts);
  assert.deepEqual(first.preview.redactions, second.preview.redactions);

  const conflict = previewBundle(fixture(), {
    targetName: 'review-copy', existingProjects: ['review-copy'],
  });
  assert.equal(conflict.ok, true);
  assert.equal(conflict.preview.target.availability, 'conflict');
  assert.equal(conflict.preview.canImport, false);
  assert.deepEqual(conflict.preview.target.conflicts, ['existing-project']);

  const deleted = previewBundle(fixture(), {
    targetName: 'review-copy', deletedProjects: [{ name: 'review-copy' }],
  });
  assert.equal(deleted.preview.canImport, false);
  assert.deepEqual(deleted.preview.target.conflicts, ['deleted-project']);

  const invalidTarget = previewBundle(fixture(), { targetName: 'Bad_Name' });
  assert.equal(invalidTarget.ok, false);
  assert.ok(codes(invalidTarget).includes('TARGET_INVALID'));
}

// Archive/link metadata, path traversal, case-fold aliases and suspicious
// names are rejected before any importer could stage or extract them.
for (const mutate of [
  (bundle) => { bundle.files[0].symlink = true; },
  (bundle) => { bundle.files[0].linkTarget = 'outside'; },
  (bundle) => { bundle.files[0].mode = 0o644; },
  (bundle) => { bundle.files[0].path = '../outside.md'; },
  (bundle) => {
    bundle.files.push({ ...bundle.files[0], path: 'project.md' });
    bundle.manifest.counts.files = 2;
    bundle.manifest.checksums.files['project.md'] = bundle.files[0].sha256;
  },
  (bundle) => { bundle.files[0].path = 'context/.private.md'; },
]) {
  const bundle = fixture();
  mutate(bundle);
  refreshPayloadChecksum(bundle);
  const result = previewBundle(bundle, { targetName: 'review-copy' });
  assert.equal(result.ok, false, JSON.stringify(result));
}

// Secret findings expose only a logical location and code, never values or
// snippets. Structurally valid bundles stay importable through the explicit
// redaction/unchanged-import decision surface.
{
  const bundle = fixture();
  bundle.tasks[0].description = 'apiKey: ghp_fake_review_value_1234567890';
  refreshPayloadChecksum(bundle);
  const result = previewBundle(bundle, { targetName: 'review-copy' });
  assert.equal(result.ok, true);
  assert.equal(result.preview.canImport, true);
  assert.deepEqual(result.preview.sensitiveContent, { count: 1, modes: ['redact', 'allow'] });
  assert.equal(result.preview.securityWarnings[0].path, 'tasks[0].description');
  assert.equal(JSON.stringify(result).includes('ghp_fake_review_value_1234567890'), false);
  assert.deepEqual(collectSensitiveFindings({ file: 'token: ghp_fake_review_value_1234567890' }), [{
    code: 'CREDENTIAL_ASSIGNMENT', path: '$',
  }]);

  const sourceSecret = fixture();
  sourceSecret.manifest.source.description = 'apiKey: ghp_source_value_1234567890';
  refreshPayloadChecksum(sourceSecret);
  const sourceResult = previewBundle(sourceSecret, { targetName: 'review-copy' });
  assert.equal(sourceResult.ok, true);
  assert.equal(sourceResult.preview.source.description, '[redacted]');
  assert.equal(JSON.stringify(sourceResult).includes('ghp_source_value_1234567890'), false);

  const unknownKeySecret = fixture();
  unknownKeySecret.tasks[0]['apiKey: ghp_abcdefghijklmnopqrstuvwxyz123456'] = 'unknown-key-value';
  refreshPayloadChecksum(unknownKeySecret);
  const unknownKeyResult = previewBundle(unknownKeySecret, { targetName: 'review-copy' });
  assert.equal(unknownKeyResult.ok, true);
  assert.ok(unknownKeyResult.preview.securityWarnings.length > 0);
  assert.ok(unknownKeyResult.preview.securityWarnings.every((warning) => warning.path === 'tasks[0]'));
  assert.equal(JSON.stringify(unknownKeyResult).includes('apiKey: ghp_abcdefghijklmnopqrstuvwxyz123456'), false);
  assert.equal(JSON.stringify(unknownKeyResult).includes('unknown-key-value'), false);

  const unknownCountSecret = fixture();
  unknownCountSecret.manifest.counts['apiKey: ghp_count_abcdefghijklmnopqrstuvwxyz123456'] = 1;
  refreshPayloadChecksum(unknownCountSecret);
  const unknownCountResult = previewBundle(unknownCountSecret, { targetName: 'review-copy' });
  assert.equal(unknownCountResult.ok, true);
  assert.equal(unknownCountResult.preview.canImport, true);
  assert.deepEqual(unknownCountResult.preview.counts, {
    tasks: 1, specs: 0, canvasNotes: 0, canvasConnections: 0,
    overviewWidgets: 0, files: 1, historyComments: 0, historyCheckpoints: 0,
  });
  assert.equal(JSON.stringify(unknownCountResult).includes('apiKey: ghp_count_abcdefghijklmnopqrstuvwxyz123456'), false);
}

assert.throws(() => parseJsonBody(Buffer.from([0xc3, 0x28])), (error) => error.code === 'INVALID_UTF8');
assert.throws(() => parseJsonBody(Buffer.from('{')), (error) => error.code === 'MALFORMED_JSON');
assert.throws(() => parseJsonBody(Buffer.alloc(RAW_BODY_LIMIT + 1)), (error) => error.code === 'RAW_SIZE_LIMIT');

async function rawRequest(ctx, body, contentType = 'application/vnd.flowboard.project+json', target, contentEncoding) {
  const query = target === undefined || target === null ? '' : `?targetName=${encodeURIComponent(target)}`;
  const response = await fetch(`${ctx.base}/api/projects/import/preview${query}`, {
    method: 'POST',
    headers: {
      'Content-Type': contentType,
      ...(contentEncoding ? { 'Content-Encoding': contentEncoding } : {}),
    },
    body,
  });
  return {
    status: response.status,
    body: await response.json().catch(() => null),
  };
}

async function main() {
  await withIsolatedDashboard(async (ctx) => {
    const created = await ctx.api('POST', '/projects', {
      name: 'existing-review', displayName: 'Existing Review',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const beforeProjects = await ctx.api('GET', '/projects');
    const beforeTasks = await ctx.api('GET', '/projects/existing-review/tasks?includeArchived=true');
    const beforeFiles = await ctx.api('GET', '/projects/existing-review/files');
    const beforeDir = fs.readdirSync(ctx.projectsDir, { withFileTypes: true })
      .map((entry) => entry.name).sort();
    const readEventWatermark = () => {
      const db = new Database(ctx.dbPath, { readonly: true });
      try {
        const row = db.prepare('SELECT COUNT(*) AS count, MAX(id) AS maxId FROM events').get();
        return { count: Number(row.count), maxId: row.maxId === null ? null : Number(row.maxId) };
      } finally {
        db.close();
      }
    };
    const beforeEvents = readEventWatermark();

    const bundle = fixture();
    fs.mkdirSync(path.join(ctx.projectsDir, 'review-fixture'), { recursive: true });
    const orphan = await rawRequest(ctx, JSON.stringify(bundle));
    assert.equal(orphan.status, 200, JSON.stringify(orphan.body));
    assert.equal(orphan.body.canImport, false);
    assert.ok(orphan.body.target.conflicts.includes('existing-directory'));
    fs.rmSync(path.join(ctx.projectsDir, 'review-fixture'), { recursive: true, force: true });

    const valid = await rawRequest(ctx, JSON.stringify(bundle));
    assert.equal(valid.status, 200, JSON.stringify(valid.body));
    assert.equal(valid.body.canImport, true);
    assert.equal(typeof valid.body.bundleDigest, 'string');
    assert.equal(valid.body.target.name, 'review-fixture');
    assert.equal(valid.body.target.availability, 'available');

    const repeated = await rawRequest(ctx, JSON.stringify(bundle));
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.bundleDigest, valid.body.bundleDigest);

    const conflict = await rawRequest(ctx, JSON.stringify(bundle), undefined, 'existing-review');
    assert.equal(conflict.status, 200, JSON.stringify(conflict.body));
    assert.equal(conflict.body.canImport, false);
    assert.deepEqual(conflict.body.target.conflicts, ['existing-project', 'existing-directory']);

    const unsupportedJson = await rawRequest(ctx, JSON.stringify(bundle), 'application/json');
    assert.equal(unsupportedJson.status, 415);
    const unsupportedZip = await rawRequest(ctx, Buffer.from('PK\\x03\\x04'), 'application/zip');
    assert.equal(unsupportedZip.status, 415);
    const compressed = await rawRequest(ctx, JSON.stringify(bundle), 'application/vnd.flowboard.project+json', undefined, 'gzip');
    assert.equal(compressed.status, 415);
    assert.equal(compressed.body.code, 'CONTENT_ENCODING_UNSUPPORTED');

    const malformed = await rawRequest(ctx, Buffer.from('{'));
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.code, 'MALFORMED_JSON');
    const invalidUtf8 = await rawRequest(ctx, Buffer.from([0xc3, 0x28]));
    assert.equal(invalidUtf8.status, 400);
    assert.equal(invalidUtf8.body.code, 'INVALID_UTF8');

    const secret = fixture();
    secret.tasks[0].description = 'apiKey: ghp_fake_review_value_1234567890';
    refreshPayloadChecksum(secret);
    const secretResponse = await rawRequest(ctx, JSON.stringify(secret));
    assert.equal(secretResponse.status, 200);
    assert.equal(secretResponse.body.canImport, true);
    assert.deepEqual(secretResponse.body.sensitiveContent, { count: 1, modes: ['redact', 'allow'] });
    assert.equal(JSON.stringify(secretResponse.body).includes('ghp_fake_review_value_1234567890'), false);

    const afterProjects = await ctx.api('GET', '/projects');
    const afterTasks = await ctx.api('GET', '/projects/existing-review/tasks?includeArchived=true');
    const afterFiles = await ctx.api('GET', '/projects/existing-review/files');
    const afterDir = fs.readdirSync(ctx.projectsDir, { withFileTypes: true })
      .map((entry) => entry.name).sort();
    const afterEvents = readEventWatermark();
    assert.deepEqual(afterProjects.body, beforeProjects.body, 'preview does not change project registry');
    assert.deepEqual(afterTasks.body, beforeTasks.body, 'preview does not change tasks');
    assert.deepEqual(afterFiles.body, beforeFiles.body, 'preview does not change files');
    assert.deepEqual(afterDir, beforeDir, 'preview does not create a project directory');
    assert.deepEqual(afterEvents, beforeEvents, 'preview does not append events');
  }, { prefix: 'flowboard-t468-preview-' });
  console.log('T-468-4 import preview tests passed');
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
