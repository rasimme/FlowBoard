'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  ProjectBundleExportError,
  SENSITIVE_EXPORT_CONFIRMATION,
  WARNING_CODES,
  exportProjectReviewBundle,
  safeDownloadFilename,
} = require('./project-bundle-export.js');
const { canonicalJson } = require('./project-bundle-schema.js');
const { validateBundle } = require('./project-bundle-validator.js');
const { containsSensitiveContent, scanSensitiveContent } = require('./project-bundle-secrets.js');

function task(id, extra = {}) {
  return {
    id,
    title: `Task ${id}`,
    status: 'open',
    priority: 'medium',
    description: 'A portable review task.',
    tags: [],
    links: [],
    created: '2026-08-01',
    completed: null,
    enteredStatusAt: '2026-08-01',
    order: null,
    workStateDetails: {},
    ...extra,
  };
}

function fixture(root) {
  fs.mkdirSync(path.join(root, 'context', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(root, 'PROJECT.md'), '# Portable Fixture\n');
  fs.writeFileSync(path.join(root, 'DECISIONS.md'), '# Decisions\n');
  fs.writeFileSync(path.join(root, 'SESSIONS.md'), 'private session history\n');
  fs.writeFileSync(path.join(root, 'context', 'NOTES.md'), 'Safe review context.\n');
  fs.writeFileSync(path.join(root, 'context', 'nested', 'MORE.md'), 'Nested context.\n');
  fs.writeFileSync(path.join(root, 'context', 'T-3-context-spec.md'), '# Context linked spec\n');
  fs.writeFileSync(path.join(root, 'context', 'secrets.md'), 'must be excluded\n');
  fs.writeFileSync(path.join(root, 'context', 'tool.sh'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(root, 'context', 'notes.md.bak'), 'backup\n');
  fs.symlinkSync(path.join(root, 'outside.md'), path.join(root, 'context', 'LINK.md'));
  fs.writeFileSync(path.join(root, 'outside.md'), 'outside\n');
  fs.mkdirSync(path.join(root, 'specs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'specs', 'T-2-review.md'), '# Review spec\n');
}

function input(root, options = {}) {
  return {
    projectName: 'portable-review-fixture',
    project: {
      name: 'portable-review-fixture',
      displayName: 'Portable Review Fixture',
      description: 'Fixture project.',
      group: 'review',
      taskDiscipline: 'development',
      github: { repo: 'example/fixture', branch: 'main', token: 'must-drop' },
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-26T10:00:00.000Z',
      config: { group: 'wrong-config-value', secret: 'must-drop' },
      assignedAgents: ['must-drop'],
    },
    tasks: [
      task('T-1', { status: 'done', agent: 'must-drop', leaseUntil: 'must-drop', metadata: { raw: true }, workStateDetails: { responsible: 'must-drop' } }),
      task('T-2', { parentId: 'T-1', specFile: 'specs/T-2-review.md', status: 'archived', claimedBy: 'must-drop' }),
      task('T-3', { specFile: 'context/T-3-context-spec.md' }),
    ],
    canvas: {
      version: 1,
      notes: [{ id: 'N-1', text: 'Review idea', x: 10, y: 20, color: 'yellow', size: 'small', created: '2026-08-02', agent: 'must-drop' }],
      connections: [],
      metadata: { raw: true },
    },
    overview: {
      version: 1,
      layout: 'grid',
      widgets: [{ id: 'w-goal', type: 'project-goals', grid: { x: 0, y: 0, w: 6, h: 2 }, agent: 'must-drop' }],
      source: 'must-drop',
    },
    projectDir: root,
    options: { bundleId: 'bundle-export-test', createdAt: '2026-08-26T10:00:00.000Z', producerVersion: 'test' },
    ...options,
  };
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-export-test-'));
  try {
    fixture(root);
    const first = exportProjectReviewBundle(input(root));
    const second = exportProjectReviewBundle(input(root));
    assert.equal(canonicalJson(first.bundle), canonicalJson(second.bundle), 'fixed provenance export is deterministic');
    assert.equal(validateBundle(first.bundle).ok, true, JSON.stringify(validateBundle(first.bundle).errors));
    assert.deepEqual(first.bundle.tasks.map((item) => item.id), ['T-1', 'T-2', 'T-3']);
    assert.equal(first.bundle.tasks[0].agent, undefined);
    assert.equal(first.bundle.tasks[0].metadata, undefined);
    assert.equal(first.bundle.tasks[0].workStateDetails.responsible, 'must-drop');
    assert.equal(first.bundle.project.github.token, undefined);
    assert.equal(first.bundle.specs.some((spec) => spec.path === 'specs/T-2-review.md' && spec.taskId === 'T-2' && spec.content === '# Review spec\n'), true);
    assert.equal(first.bundle.specs.some((spec) => spec.path === 'context/T-3-context-spec.md'), true);
    assert.deepEqual(first.bundle.files.map((file) => file.path), [
      'context/nested/MORE.md', 'context/NOTES.md', 'DECISIONS.md', 'PROJECT.md',
    ]);
    assert.ok(first.bundle.manifest.warnings.some((item) => item.code === WARNING_CODES.SYMLINK_EXCLUDED));
    assert.ok(first.bundle.manifest.warnings.some((item) => item.code === WARNING_CODES.EXCLUDED_FILE));
    assert.equal(first.bundle.manifest.options.includeHistory, false);
    assert.equal(first.bundle.history, undefined);
    assert.equal(first.bundle.manifest.checksums.files['specs/T-2-review.md'], undefined);
    assert.equal(first.bundle.manifest.checksums.files['context/T-3-context-spec.md'], undefined);

    fs.unlinkSync(path.join(root, 'DECISIONS.md'));
    const missingOptional = exportProjectReviewBundle(input(root));
    assert.ok(missingOptional.bundle.manifest.warnings.some((item) => item.code === WARNING_CODES.OPTIONAL_FILE_MISSING && item.path === 'DECISIONS.md'));

    assert.equal(safeDownloadFilename('A project / unsafe'), 'flowboard-a-project-unsafe.flowboard.json');
    assert.throws(() => exportProjectReviewBundle({
      ...input(root),
      tasks: [task('T-1', { specFile: 'specs/missing.md' })],
    }), (error) => error instanceof ProjectBundleExportError
      && error.code === 'SPEC_READ_FAILED'
      && error.message === 'A linked task spec is missing or unreadable.'
      && !error.message.includes('specs/missing.md')
      && !JSON.stringify(error.diagnostics).includes('specs/missing.md')
      && error.diagnostics[0].taskId === 'T-1'
      && error.diagnostics[0].code === 'SPEC_READ_FAILED');

    const before = fs.readFileSync(path.join(root, 'PROJECT.md'), 'utf8');
    exportProjectReviewBundle(input(root));
    assert.equal(fs.readFileSync(path.join(root, 'PROJECT.md'), 'utf8'), before, 'export does not mutate project files');

    const fakeSecret = 'sk-review-only-fake-value-1234567890';
    fs.writeFileSync(path.join(root, 'context', 'NOTES.md'), `Review note with apiKey: ${fakeSecret}\n`);
    const redacted = exportProjectReviewBundle(input(root));
    assert.equal(redacted.bundle.files.some((file) => file.path === 'context/NOTES.md'), false);
    assert.ok(redacted.bundle.manifest.warnings.some((item) => item.code === WARNING_CODES.SENSITIVE_CONTENT_EXCLUDED));
    assert.equal(JSON.stringify(redacted.bundle).includes(fakeSecret), false);

    const canonicalHit = 'ghp_review_only_fake_value_1234567890';
    assert.throws(() => exportProjectReviewBundle(input(root, {
      tasks: [task('T-1', { description: `token: ${canonicalHit}` })],
    })), (error) => error.code === 'SENSITIVE_CONTENT_DETECTED' && !error.message.includes(canonicalHit));

    const recovered = exportProjectReviewBundle(input(root, {
      tasks: [task('T-1', { description: `token: ${canonicalHit}` })],
      options: {
        bundleId: 'bundle-export-override-test',
        createdAt: '2026-08-26T10:00:00.000Z',
        producerVersion: 'test',
        allowSensitiveCanonicalData: true,
      },
    }));
    assert.equal(recovered.bundle.tasks[0].description.includes(canonicalHit), true);
    assert.equal(SENSITIVE_EXPORT_CONFIRMATION, 'export-sensitive-project');

    const safeProse = 'This review explains token handling and HMAC verification without embedding credentials.';
    assert.equal(containsSensitiveContent(safeProse), false);
    const findings = scanSensitiveContent(`Bearer ${fakeSecret}`);
    assert.equal(findings.length > 0, true);
    assert.equal(JSON.stringify(findings).includes(fakeSecret), false);
    const highConfidenceExamples = [
      '-----BEGIN RSA PRIVATE KEY-----\nZmFrZS1rZXktbG9uZy12YWx1ZQ==\n-----END RSA PRIVATE KEY-----',
      'Bearer review-only-fake-bearer-value-123456',
      'eyJreviewonlyheader1234.eyJreviewonlypayload1234.review-only-signature-1234',
      'sk-reviewonlyprefixvalue123456',
      'sk-proj-reviewonlyvalue_1234567890-abcdef',
      'sk-ant_reviewonlyvalue-1234567890_abcdef',
      'ghp_reviewonlygithubvalue1234567890',
      'github_pat_reviewonlygithubvalue1234567890',
      '123456789:review-only-telegram-bot-token-123456',
      'https://review-user:review-password@example.test/path',
      'password: review-only-assignment-value-123456',
    ];
    for (const example of highConfidenceExamples) {
      assert.equal(containsSensitiveContent(example), true, `scanner should detect ${example.slice(0, 12)}`);
      assert.equal(JSON.stringify(scanSensitiveContent(example)).includes(example), false);
    }
    assert.equal(containsSensitiveContent('The sk-proj-token format is documented here.'), false);
    assert.equal(containsSensitiveContent('The sk-ant-format uses provider markers.'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('T-468-3 project bundle exporter tests passed');
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
