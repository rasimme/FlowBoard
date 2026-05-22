'use strict';

/**
 * Unit tests for healProject() and detectProjectDrift() in project-lifecycle.
 *
 * healProject() is the idempotent recovery path for projects that exist at
 * the filesystem layer or in the flowboard_projects metadata table but are
 * missing a canonical HZL project_created event. detectProjectDrift() is the
 * read-only inverse: it lists any name that lives at one layer but not in HZL.
 *
 * These tests use in-memory stubs so they can run without a live dashboard.
 *
 * Run: node test-heal-project.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const lifecycle = require('./project-lifecycle.js');

let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✅ ${msg}`); }
  else      { fail++; failures.push(msg); console.log(`  ❌ ${msg}`); }
}

function section(title) {
  console.log(`\n## ${title}\n`);
}

// ---------------------------------------------------------------------------
// In-memory stubs for hzlService and fbMeta
// ---------------------------------------------------------------------------

function makeStubs({ hzlNames = [], metaRows = new Map(), deleted = new Set() } = {}) {
  const createProjectCalls = [];
  const upsertCalls = [];

  const hzlService = {
    listHzlProjects: () => hzlNames.map(n => ({ name: n })),
    createProject: (name, description) => {
      hzlNames.push(name);
      createProjectCalls.push({ name, description });
    },
  };

  const fbMeta = {
    getProject: (name) => metaRows.get(name) || null,
    upsertProject: (name, data, force) => {
      upsertCalls.push({ name, data, force });
      metaRows.set(name, {
        name,
        display_name: (data && data.displayName) || name,
        status: (data && data.status) || 'active',
        created_at: (data && data.createdAt) || new Date().toISOString(),
        config: JSON.stringify((data && data.config) || {}),
      });
    },
    listMetaProjects: () => [...metaRows.values()],
    isProjectDeleted: (name) => deleted.has(name),
  };

  return { hzlService, fbMeta, createProjectCalls, upsertCalls };
}

function tmpProjectsDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fb-heal-'));
}

function makeDir(root, name) {
  const d = path.join(root, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'PROJECT.md'), `# ${name}\n`);
  return d;
}

// ---------------------------------------------------------------------------
// healProject scenarios
// ---------------------------------------------------------------------------

function testHealWhenMetaOnly() {
  section('heal — metadata row exists but no HZL event');
  const projectsDir = tmpProjectsDir();
  const meta = new Map([['demo-a', {
    name: 'demo-a', display_name: 'Demo A', status: 'active', created_at: '2026-01-01T00:00:00Z',
  }]]);
  const { hzlService, fbMeta, createProjectCalls, upsertCalls } =
    makeStubs({ hzlNames: [], metaRows: meta });

  const result = lifecycle.healProject({ name: 'demo-a' }, { hzlService, fbMeta, projectsDir });

  ok(result.healed === true, 'healed=true when work was done');
  ok(result.actions.includes('hzl_event'), 'actions include hzl_event');
  ok(!result.actions.includes('metadata_row'), 'metadata_row NOT in actions (already existed)');
  ok(createProjectCalls.length === 1, 'hzlService.createProject called exactly once');
  ok(upsertCalls.length === 0, 'fbMeta.upsertProject NOT called (row preserved)');
  ok(result.project.displayName === 'Demo A', 'existing displayName preserved');
}

function testHealWhenFsOnly() {
  section('heal — filesystem dir exists, no metadata, no HZL event');
  const projectsDir = tmpProjectsDir();
  makeDir(projectsDir, 'demo-b');
  const { hzlService, fbMeta, createProjectCalls, upsertCalls } = makeStubs();

  const result = lifecycle.healProject({ name: 'demo-b' }, { hzlService, fbMeta, projectsDir });

  ok(result.healed === true, 'healed=true');
  ok(result.actions.includes('hzl_event'), 'hzl_event written');
  ok(result.actions.includes('metadata_row'), 'metadata_row written');
  ok(createProjectCalls.length === 1, 'one HZL event written');
  ok(upsertCalls.length === 1, 'one metadata row written');
}

function testHealWithExplicitDisplayName() {
  section('heal — explicit displayName for filesystem-only project');
  const projectsDir = tmpProjectsDir();
  makeDir(projectsDir, 'demo-bb');
  const { hzlService, fbMeta } = makeStubs();

  const result = lifecycle.healProject(
    { name: 'demo-bb', displayName: 'Demo BB Pretty' },
    { hzlService, fbMeta, projectsDir }
  );

  ok(result.project.displayName === 'Demo BB Pretty', 'explicit displayName used');
}

function testHealIdempotent() {
  section('heal — fully healthy project (idempotent no-op)');
  const projectsDir = tmpProjectsDir();
  const meta = new Map([['demo-c', {
    name: 'demo-c', display_name: 'Demo C', status: 'active', created_at: '2026-01-01T00:00:00Z',
  }]]);
  const { hzlService, fbMeta, createProjectCalls, upsertCalls } =
    makeStubs({ hzlNames: ['demo-c'], metaRows: meta });

  const result = lifecycle.healProject({ name: 'demo-c' }, { hzlService, fbMeta, projectsDir });

  ok(result.healed === false, 'healed=false on already-healthy project');
  ok(result.actions.length === 0, 'no actions on idempotent call');
  ok(createProjectCalls.length === 0, 'no HZL writes');
  ok(upsertCalls.length === 0, 'no metadata writes');
}

function testHealRefusesUnknown() {
  section('heal — name absent at every layer must throw NOT_FOUND');
  const projectsDir = tmpProjectsDir();
  const { hzlService, fbMeta } = makeStubs();

  let thrown = null;
  try {
    lifecycle.healProject({ name: 'no-where' }, { hzlService, fbMeta, projectsDir });
  } catch (e) { thrown = e; }

  ok(thrown !== null, 'throws when project not found at any layer');
  ok(thrown && thrown.code === 'NOT_FOUND', `code=NOT_FOUND (got ${thrown && thrown.code})`);
}

function testHealRefusesDeleted() {
  section('heal — tombstoned project must be refused');
  const projectsDir = tmpProjectsDir();
  makeDir(projectsDir, 'demo-d');
  const { hzlService, fbMeta } = makeStubs({ deleted: new Set(['demo-d']) });

  let thrown = null;
  try {
    lifecycle.healProject({ name: 'demo-d' }, { hzlService, fbMeta, projectsDir });
  } catch (e) { thrown = e; }

  ok(thrown !== null, 'throws on deleted project');
  ok(thrown && thrown.code === 'NOT_FOUND', `code=NOT_FOUND for deleted (got ${thrown && thrown.code})`);
}

function testHealValidatesName() {
  section('heal — invalid slug rejected');
  const projectsDir = tmpProjectsDir();
  const { hzlService, fbMeta } = makeStubs();

  let thrown = null;
  try {
    lifecycle.healProject({ name: 'INVALID NAME!' }, { hzlService, fbMeta, projectsDir });
  } catch (e) { thrown = e; }
  ok(thrown && thrown.code === 'VALIDATION_ERROR', 'invalid name → VALIDATION_ERROR');
}

function testHealDoesNotScaffold() {
  section('heal — leaves existing PROJECT.md untouched (no scaffold)');
  const projectsDir = tmpProjectsDir();
  const dir = makeDir(projectsDir, 'demo-e');
  const customContent = '# Custom Project E\n\nUser data here.\n';
  fs.writeFileSync(path.join(dir, 'PROJECT.md'), customContent);
  const { hzlService, fbMeta } = makeStubs();

  lifecycle.healProject({ name: 'demo-e' }, { hzlService, fbMeta, projectsDir });

  const after = fs.readFileSync(path.join(dir, 'PROJECT.md'), 'utf8');
  ok(after === customContent, 'PROJECT.md content preserved verbatim');
}

// ---------------------------------------------------------------------------
// detectProjectDrift scenarios
// ---------------------------------------------------------------------------

function testDetectDriftFindsMetaOnly() {
  section('detectProjectDrift — finds metadata rows without HZL event');
  const projectsDir = tmpProjectsDir();
  const meta = new Map([
    ['meta-only', { name: 'meta-only', display_name: 'M', status: 'active' }],
    ['in-all',    { name: 'in-all',    display_name: 'A', status: 'active' }],
  ]);
  const { hzlService, fbMeta } = makeStubs({ hzlNames: ['in-all'], metaRows: meta });

  const drift = lifecycle.detectProjectDrift({ hzlService, fbMeta, projectsDir });
  const names = new Set(drift.map(d => d.name));
  ok(names.has('meta-only'), 'detects metadata-only project');
  ok(!names.has('in-all'), 'ignores fully-healthy project');
  const row = drift.find(d => d.name === 'meta-only');
  ok(row && row.sources.includes('metadata'), 'reports source=metadata');
}

function testDetectDriftFindsFsOnly() {
  section('detectProjectDrift — finds filesystem dirs without HZL event');
  const projectsDir = tmpProjectsDir();
  makeDir(projectsDir, 'fs-only');
  makeDir(projectsDir, 'in-all');
  const meta = new Map([['in-all', { name: 'in-all', display_name: 'A', status: 'active' }]]);
  const { hzlService, fbMeta } = makeStubs({ hzlNames: ['in-all'], metaRows: meta });

  const drift = lifecycle.detectProjectDrift({ hzlService, fbMeta, projectsDir });
  const names = new Set(drift.map(d => d.name));
  ok(names.has('fs-only'), 'detects filesystem-only project');
  const row = drift.find(d => d.name === 'fs-only');
  ok(row && row.sources.includes('filesystem'), 'reports source=filesystem');
}

function testDetectDriftIgnoresHidden() {
  section('detectProjectDrift — ignores dot-dirs (.trash, .hzl, etc.)');
  const projectsDir = tmpProjectsDir();
  fs.mkdirSync(path.join(projectsDir, '.trash'));
  fs.mkdirSync(path.join(projectsDir, '.hzl'));
  const { hzlService, fbMeta } = makeStubs();

  const drift = lifecycle.detectProjectDrift({ hzlService, fbMeta, projectsDir });
  const names = drift.map(d => d.name);
  ok(!names.includes('.trash'), '.trash not reported as drift');
  ok(!names.includes('.hzl'), '.hzl not reported as drift');
}

function testDetectDriftIgnoresDirsWithoutProjectMd() {
  section('detectProjectDrift — skips dirs without PROJECT.md marker');
  const projectsDir = tmpProjectsDir();
  // Real project dir (has PROJECT.md via makeDir helper)
  makeDir(projectsDir, 'real-project');
  // Agent-manual-style dir (no PROJECT.md, just some other file)
  const manualDir = path.join(projectsDir, 'agent-manual');
  fs.mkdirSync(manualDir);
  fs.writeFileSync(path.join(manualDir, 'AGENTS.md'), '# Manual\n');
  // Empty dir
  fs.mkdirSync(path.join(projectsDir, 'empty-dir'));

  const { hzlService, fbMeta } = makeStubs();
  const drift = lifecycle.detectProjectDrift({ hzlService, fbMeta, projectsDir });
  const names = drift.map(d => d.name);

  ok(names.includes('real-project'), 'dir with PROJECT.md still reported');
  ok(!names.includes('agent-manual'), 'AGENTS.md-only dir NOT reported');
  ok(!names.includes('empty-dir'), 'empty dir NOT reported');
}

function testDetectDriftIgnoresDeleted() {
  section('detectProjectDrift — does not flag tombstoned projects');
  const projectsDir = tmpProjectsDir();
  const meta = new Map([['tombstoned', { name: 'tombstoned', display_name: 'T', status: 'active' }]]);
  const { hzlService, fbMeta } = makeStubs({ metaRows: meta, deleted: new Set(['tombstoned']) });

  const drift = lifecycle.detectProjectDrift({ hzlService, fbMeta, projectsDir });
  const names = drift.map(d => d.name);
  ok(!names.includes('tombstoned'), 'deleted project is not flagged');
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

(function main() {
  testHealWhenMetaOnly();
  testHealWhenFsOnly();
  testHealWithExplicitDisplayName();
  testHealIdempotent();
  testHealRefusesUnknown();
  testHealRefusesDeleted();
  testHealValidatesName();
  testHealDoesNotScaffold();

  testDetectDriftFindsMetaOnly();
  testDetectDriftFindsFsOnly();
  testDetectDriftIgnoresHidden();
  testDetectDriftIgnoresDirsWithoutProjectMd();
  testDetectDriftIgnoresDeleted();

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log('\nFailures:');
    failures.forEach(f => console.log(`  - ${f}`));
    process.exit(1);
  }
})();
