'use strict';

const assert = require('node:assert/strict');
const {
  REQUIRED_REDACTIONS,
  canonicalJson,
  createBundle,
  payloadForChecksum,
  sha256,
  toPortableTask,
} = require('./project-bundle-schema.js');
const { validateBundle } = require('./project-bundle-validator.js');

const FIXED = Object.freeze({
  bundleId: 'bundle-0001',
  createdAt: '2026-08-26T09:00:00.000Z',
  producerName: 'FlowBoard',
  producerVersion: '5.0.4',
});

function fixture(options = {}) {
  return createBundle({
    project: {
      slug: 'portable-review-fixture',
      displayName: 'Portable Review Fixture',
      description: 'A deterministic fixture used by the bundle contract tests.',
      group: 'review',
      taskDiscipline: 'development',
      github: { repo: 'example/portable-review', branch: 'main' },
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-26T08:00:00.000Z',
    },
    tasks: [
      {
        id: 'T-2',
        title: 'Implement the child review',
        status: 'open',
        priority: 'high',
        description: 'A child task with a portable parent reference.',
        parentId: 'T-1',
        specFile: 'specs/T-2.md',
        tags: ['review'],
        links: ['https://example.test/review'],
        created: '2026-08-02',
        completed: null,
        enteredStatusAt: '2026-08-02T10:00:00.000Z',
        order: 2,
        workStateDetails: { reason: null, waitingFor: null, responsible: null, checkAgainAt: null, setAt: '2026-08-02T10:00:00.000Z' },
      },
      {
        id: 'T-1',
        title: 'Review the portable bundle',
        status: 'in-progress',
        priority: 'medium',
        description: 'The parent task.',
        tags: ['bundle'],
        created: '2026-08-01',
        completed: null,
        enteredStatusAt: '2026-08-01T10:00:00.000Z',
        order: null,
        workStateDetails: {},
      },
    ],
    specs: [
      { path: 'specs/T-2.md', taskId: 'T-2', content: '# Child review\n\nReviewable specification.' },
    ],
    canvas: {
      version: 1,
      notes: [
        { id: 'N-002', text: 'Second idea', x: 220, y: 120, color: 'blue', size: 'medium', created: '2026-08-03' },
        { id: 'N-001', text: 'First idea', x: 20, y: 30, color: 'yellow', size: 'small', created: '2026-08-02' },
      ],
      connections: [{ from: 'N-001', to: 'N-002', fromPort: 'right', toPort: 'left' }],
    },
    overview: {
      version: 1,
      layout: 'grid',
      widgets: [{ id: 'w-goals', type: 'project-goals', grid: { x: 0, y: 0, w: 6, h: 2 } }],
    },
    files: [
      { path: 'PROJECT.md', content: '# Portable Review Fixture\n' },
      { path: 'context/NOTES.md', content: 'Review notes.\n' },
    ],
    ...(options.includeHistory ? {
      history: {
        comments: [{ id: 'C-1', taskId: 'T-1', body: 'Please check the import boundary.', kind: 'question', createdAt: '2026-08-25T12:00:00.000Z', authorLabel: 'reviewer' }],
        checkpoints: [{ id: 'CP-1', taskId: 'T-1', message: 'Fixture checkpoint', progress: 50, createdAt: '2026-08-25T12:01:00.000Z' }],
      },
    } : {}),
  }, { ...FIXED, ...options });
}

function validBundle(options = {}) {
  const result = validateBundle(fixture(options));
  assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));
  return result.bundle;
}

function hasCode(result, code) {
  return result.errors.some((issue) => issue.code === code);
}

// A valid fixture has a stable canonical form and complete redaction claim.
{
  const first = fixture();
  const second = fixture();
  assert.equal(canonicalJson(first), canonicalJson(second), 'canonical JSON is deterministic');
  assert.deepEqual(first.manifest.redactions, [...REQUIRED_REDACTIONS]);
  assert.equal(validateBundle(first).ok, true);
  assert.equal(first.project.taskDiscipline, 'development');
  assert.deepEqual(first.project.github, { repo: 'example/portable-review', branch: 'main' });
  const child = first.tasks.find((task) => task.id === 'T-2');
  assert.equal(child.createdAt, '2026-08-02');
  assert.equal(child.completedAt, null);
  assert.equal(child.enteredStatusAt, '2026-08-02T10:00:00.000Z');
  assert.equal(child.order, 2);
  assert.deepEqual(Object.keys(child.workStateDetails).sort(), ['checkAgainAt', 'reason', 'responsible', 'setAt', 'waitingFor']);
  assert.deepEqual(first.manifest.counts, {
    tasks: 2,
    specs: 1,
    canvasNotes: 2,
    canvasConnections: 1,
    overviewWidgets: 1,
    files: 2,
    historyComments: 0,
    historyCheckpoints: 0,
  });
}

// All colors present in current/legacy Canvas persistence remain importable.
for (const color of ['grey', 'yellow', 'blue', 'green', 'red', 'teal', 'orange', 'purple']) {
  const colored = fixture();
  colored.canvas.notes[0].color = color;
  colored.manifest.checksums.payload = sha256(payloadForChecksum(colored));
  assert.equal(validateBundle(colored).ok, true, `canvas color ${color} is accepted`);
}

// Unknown future optional fields survive validation when the payload checksum
// is updated; the contract is forward-compatible without being permissive
// about explicitly forbidden implementation fields.
{
  const bundle = fixture();
  bundle.tasks[0].futureOptionalField = { enabled: true };
  bundle.manifest.checksums.payload = sha256(payloadForChecksum(bundle));
  const result = validateBundle(bundle);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.bundle.tasks[0].futureOptionalField, { enabled: true });
}

// DTO projections are allowlists: raw task metadata and ownership fields are
// dropped while semantic task fields remain portable.
{
  const projected = fixture();
  const actualPublicTask = toPortableTask({
    id: 'T-900', title: 'Public API task', status: 'open', priority: 'low',
    created: '2026-08-03', completed: null, enteredStatusAt: '2026-08-03T10:00:00.000Z',
    order: null, specFile: null,
    workStateDetails: { reason: 'review', agent: 'must-drop' },
    agent: 'must-drop', leaseUntil: 'must-drop', metadata: { raw: true },
  });
  assert.equal(actualPublicTask.createdAt, '2026-08-03');
  assert.equal(actualPublicTask.completedAt, null);
  assert.equal(actualPublicTask.enteredStatusAt, '2026-08-03T10:00:00.000Z');
  assert.equal(actualPublicTask.order, null);
  assert.equal(actualPublicTask.specFile, null);
  assert.equal(actualPublicTask.agent, undefined);
  assert.equal(actualPublicTask.leaseUntil, undefined);
  assert.equal(actualPublicTask.workStateDetails.responsible, null);
  const raw = { ...projected.tasks[0], metadata: { internal: true }, agent: 'worker', leaseUntil: 'never' };
  const rawProject = { ...projected.project, github: { repo: 'example/portable-review', branch: 'main', token: 'must-not-export' } };
  const safe = createBundle({
    project: rawProject,
    tasks: [raw, projected.tasks[1]],
    specs: projected.specs,
    canvas: projected.canvas,
    overview: projected.overview,
    files: projected.files,
  }, FIXED);
  assert.equal(safe.tasks[0].metadata, undefined);
  assert.equal(safe.tasks[0].agent, undefined);
  assert.equal(safe.project.github.token, undefined);
  assert.equal(validateBundle(safe).ok, true);
}

// Optional history is opt-in and must not silently enter the default review
// snapshot.
{
  const defaultBundle = fixture();
  defaultBundle.history = { comments: [], checkpoints: [] };
  defaultBundle.manifest.counts.historyComments = 0;
  defaultBundle.manifest.counts.historyCheckpoints = 0;
  defaultBundle.manifest.checksums.payload = sha256(payloadForChecksum(defaultBundle));
  const result = validateBundle(defaultBundle);
  assert.equal(result.ok, false);
  assert.equal(hasCode(result, 'OPTION_CONFLICT'), true);
  assert.equal(validateBundle(fixture({ includeHistory: true })).ok, true);
}

// Focused malformed cases: unsafe fields, hierarchy, references and enums.
{
  const forbidden = fixture();
  forbidden.tasks[0].metadata = { internal: true };
  assert.equal(hasCode(validateBundle(forbidden), 'FORBIDDEN_FIELD'), true);

  const duplicateTask = fixture();
  duplicateTask.tasks[1].id = duplicateTask.tasks[0].id;
  assert.equal(hasCode(validateBundle(duplicateTask), 'DUPLICATE_ID'), true);

  const deepHierarchy = fixture();
  deepHierarchy.tasks[1].parentId = 'T-2';
  assert.equal(hasCode(validateBundle(deepHierarchy), 'HIERARCHY_DEPTH'), true);

  const badSpecTarget = fixture();
  badSpecTarget.specs[0].taskId = 'T-999';
  assert.equal(hasCode(validateBundle(badSpecTarget), 'REFERENCE_MISSING'), true);

  const badCanvas = fixture();
  badCanvas.canvas.connections.push({ from: 'N-002', to: 'N-001', fromPort: 'diagonal' });
  assert.equal(hasCode(validateBundle(badCanvas), 'DUPLICATE_CONNECTION'), true);
  assert.equal(hasCode(validateBundle(badCanvas), 'ENUM_INVALID'), true);

  const rootDependencyCycle = fixture();
  rootDependencyCycle.tasks[0].dependsOn = ['T-1'];
  rootDependencyCycle.tasks[1].dependsOn = ['T-2'];
  assert.equal(hasCode(validateBundle(rootDependencyCycle), 'DEPENDENCY_CYCLE'), true);

  const rootMissingDependency = fixture();
  rootMissingDependency.tasks[1].dependsOn = ['T-999'];
  assert.equal(hasCode(validateBundle(rootMissingDependency), 'REFERENCE_MISSING'), true);
}

// File inventory and checksum drift fail before an importer can write.
{
  const checksumDrift = fixture();
  checksumDrift.files[0].content = 'tampered';
  assert.equal(hasCode(validateBundle(checksumDrift), 'CHECKSUM_MISMATCH'), true);

  const inventoryDrift = fixture();
  delete inventoryDrift.manifest.checksums.files['PROJECT.md'];
  assert.equal(hasCode(validateBundle(inventoryDrift), 'CHECKSUM_INVENTORY_MISMATCH'), true);

  const traversal = fixture();
  traversal.files[0].path = '../outside.txt';
  assert.equal(hasCode(validateBundle(traversal), 'PATH_UNSAFE'), true);

  const windowsPath = fixture();
  windowsPath.files[0].path = 'context\\NOTES.md';
  assert.equal(hasCode(validateBundle(windowsPath), 'PATH_NON_CANONICAL'), true);
}

// Project lifecycle slugs are lowercase kebab-case and at most 63 characters.
for (const slug of ['Portable-review', 'portable_review', `a${'b'.repeat(63)}`]) {
  const invalidSlug = fixture();
  invalidSlug.project.slug = slug;
  invalidSlug.manifest.source.slug = slug;
  invalidSlug.manifest.checksums.payload = sha256(payloadForChecksum(invalidSlug));
  assert.equal(hasCode(validateBundle(invalidSlug), 'FORMAT_INVALID'), true, `rejects project slug ${slug}`);
}

// History is review context, but every item must remain attached to a task.
{
  const missingHistoryTarget = fixture({ includeHistory: true });
  delete missingHistoryTarget.history.comments[0].taskId;
  assert.equal(hasCode(validateBundle(missingHistoryTarget), 'FIELD_REQUIRED'), true);
}

// Runtime task completion is a YYYY-MM-DD value; new enteredStatusAt values
// are zoned timestamps and are validated separately.
{
  const timestampCompletion = fixture();
  timestampCompletion.tasks[0].completedAt = '2026-08-26T12:00:00.000Z';
  assert.equal(hasCode(validateBundle(timestampCompletion), 'TIMESTAMP_INVALID'), true);
}

// Legacy public API rows can expose enteredStatusAt as the date-only created
// fallback. The exact value is retained rather than upgraded or fabricated.
{
  const legacyEntered = fixture();
  const legacyTask = legacyEntered.tasks.find((task) => task.id === 'T-1');
  legacyTask.enteredStatusAt = '2026-08-01';
  legacyEntered.manifest.checksums.payload = sha256(payloadForChecksum(legacyEntered));
  assert.equal(validateBundle(legacyEntered).ok, true);
  assert.equal(validateBundle(legacyEntered).bundle.tasks.find((task) => task.id === 'T-1').enteredStatusAt, '2026-08-01');
}

// Unsupported format versions are not guessed or downgraded.
{
  const unsupported = fixture();
  unsupported.manifest.formatVersion = 2;
  assert.equal(hasCode(validateBundle(unsupported), 'FORMAT_UNSUPPORTED'), true);
}

console.log('T-468-2 bundle schema and validator tests passed');
