'use strict';

/**
 * End-to-end integration test for the snippet upgrade / migration flow.
 *
 * Builds a temp OPENCLAW_HOME sandbox with one workspace per state
 * (identical / drifted / missing / current / foreign-marker / claude-style)
 * and exercises collectStatus + applyActions through every code path:
 *
 *   - state classification per workspace
 *   - chip variant derivation (Migration required / Finish setup / Optional setup / hidden)
 *   - upgrade  action on identical → new block, backup written, content right
 *   - migrate  action on drifted   → structural replace, backup, content right
 *   - add      action on missing   → append at end, idempotent, backup
 *   - state-mismatch guards (upgrade-a-missing etc.) report correct skipped reasons
 *   - backup integrity — byte-exact pre-change copy
 *
 * Does NOT touch any real ~/.openclaw/* file. Run:
 *   node test-snippets-integration.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const doctor = require('./snippets-doctor.js');

let passed = 0;
let failed = 0;
let tmpHome = null;

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✅ ${msg}`); }
  else      { failed++; console.error(`  ❌ ${msg}`); }
}
function assertEqual(actual, expected, msg) {
  if (actual === expected) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}
function section(name) { console.log(`\n## ${name}`); }

function mkSandbox() {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-snippets-int-'));
  return tmpHome;
}
function cleanup() {
  if (tmpHome && fs.existsSync(tmpHome)) fs.rmSync(tmpHome, { recursive: true, force: true });
  tmpHome = null;
}
process.on('exit', cleanup);
process.on('uncaughtException', (e) => { console.error('UNCAUGHT:', e); cleanup(); process.exit(1); });

/** Seed the sandbox with one workspace per state plus a BOOT.md legacy-display case. */
function seedSandbox(home) {
  const legacyAgents  = doctor.readVendored('AGENTS-trigger.v2.md');
  const currentAgents = doctor.readCurrent('AGENTS-trigger.md');

  const mk = (workspace, file, contents) => {
    fs.mkdirSync(path.join(home, workspace), { recursive: true });
    fs.writeFileSync(path.join(home, workspace, file), contents);
    return path.join(home, workspace, file);
  };

  return {
    // A: byte-match legacy block — safe auto-upgrade
    identicalPath: mk('workspace', 'AGENTS.md',
      `# Main agent\n\n${legacyAgents}\n# trailer\n`),
    // B: structural legacy markers present + user edit somewhere in the block
    driftedPath: mk('workspace-drift', 'AGENTS.md',
      `# Drift agent\n\n## Custom section\nSome custom notes for my agent.\n\n` +
      legacyAgents.replace(
        'Read `BOOTSTRAP.md` — that is your project context.',
        'Read `BOOTSTRAP.md` — that is my customized project context.'
      ) + '\n# trailer\n'),
    // D: plain agent, no FlowBoard snippet at all
    missingPath: mk('workspace-plain', 'AGENTS.md',
      `# Plain agent\n\nJust some agent prose. No FlowBoard snippet anywhere.\n`),
    // E: already migrated (has current-snippet marker)
    currentPath: mk('workspace-done', 'AGENTS.md',
      `# Done agent\n\n${currentAgents}\n`),
    // False-positive: legacy marker substring but NOT the structural block
    // (like the real workspace-voice setup)
    foreignPath: mk('workspace-voice', 'AGENTS.md',
      `# Voice agent\n\n## Tools\n- Check ACTIVE-PROJECT.md via cat\n- Or load projects/PROJECT-RULES.md manually\n`),
    // Different agent schema entirely (like workspace-claude)
    claudeStylePath: mk('workspace-claude', 'AGENTS.md',
      `# Claude workspace\n\nIf BOOTSTRAP.md exists, that's your birth certificate.\nFollow it, figure out who you are, then delete it.\n`),
    // BOOT.md legacy case in workspace/ - display-only, not migrated
    bootLegacyPath: (() => {
      fs.writeFileSync(path.join(home, 'workspace', 'BOOT.md'),
        '# My BOOT\n\n## Project State Recovery (FlowBoard)\n\nUse the live-injected `BOOTSTRAP.md` content already present in the run context.\n');
      return path.join(home, 'workspace', 'BOOT.md');
    })(),
  };
}

// ============================================================
section('State classification — every category present');
// ============================================================
{
  const home = mkSandbox();
  try {
    const paths = seedSandbox(home);
    const status = doctor.collectStatus(home);
    const byPath = new Map(status.files.map(f => [f.path, f]));

    assertEqual(status.counts.identical, 1, 'one identical (workspace/AGENTS.md)');
    assertEqual(status.counts.drifted, 1,
      'one drifted: workspace-drift/AGENTS.md');
    assertEqual(status.counts.current, 1, 'one current (workspace-done)');
    assertEqual(status.counts.missing, 3,
      'three missing: workspace-plain, workspace-voice, workspace-claude');
    assertEqual(status.bootLegacyFiles?.length || 0, 1, 'one BOOT.md legacy advisory');

    // current not in files list
    assert(!byPath.has(paths.currentPath), 'current file skipped from UI list');
    // identical / drifted / missing are in the list
    assertEqual(byPath.get(paths.identicalPath)?.state, 'identical', 'identical state assigned');
    assertEqual(byPath.get(paths.driftedPath)?.state, 'drifted', 'drifted state assigned');
    assertEqual(byPath.get(paths.missingPath)?.state, 'missing', 'missing state assigned');
    // false-positive paths classified as missing (no structural legacy block)
    assertEqual(byPath.get(paths.foreignPath)?.state, 'missing',
      'foreign (stray marker, no block) classified as missing, not drifted');
    assertEqual(byPath.get(paths.claudeStylePath)?.state, 'missing',
      'claude-style agent (no FlowBoard block) classified as missing');
  } finally { cleanup(); }
}

// ============================================================
section('Chip — "Migration required" when any legacy remains');
// ============================================================
{
  const home = mkSandbox();
  try {
    seedSandbox(home);
    const status = doctor.collectStatus(home);
    assert(status.chip, 'chip present');
    assertEqual(status.chip.text, 'Migration required', 'chip text');
    assertEqual(status.chip.variant, 'warn', 'chip variant = warn');
  } finally { cleanup(); }
}

// ============================================================
section('Chip — "Finish setup" when only missing');
// ============================================================
{
  const home = mkSandbox();
  try {
    // Only a plain workspace, nothing else
    fs.mkdirSync(path.join(home, 'workspace-fresh'), { recursive: true });
    fs.writeFileSync(path.join(home, 'workspace-fresh', 'AGENTS.md'),
      '# Fresh agent\n\nNothing here yet.\n');
    const status = doctor.collectStatus(home);
    assert(status.chip, 'chip present');
    assertEqual(status.chip.text, 'Finish setup', 'fresh install → Finish setup');
    assertEqual(status.chip.variant, 'info', 'variant = info');
  } finally { cleanup(); }
}

// ============================================================
section('UI copy — FlowBoard setup makes existing AGENTS.md files explicit');
// ============================================================
{
  const src = fs.readFileSync(path.join(__dirname, 'src/components/SnippetUpgrade.jsx'), 'utf8');
  assert(src.includes('Add FlowBoard to existing AGENTS.md'),
    'setup explainer names existing AGENTS.md files');
  assert(src.includes('Existing AGENTS.md without FlowBoard'),
    'missing group title names AGENTS.md files');
  assert(src.includes('They simply do not contain the FlowBoard project trigger yet'),
    'setup copy clarifies files are not broken');
  assert(src.includes('Legacy BOOT.md cleanup required'),
    'BOOT.md legacy advisory is rendered in the modal');
  assert(src.includes('Display-only advisory: BOOT.md is OpenClaw-owned'),
    'BOOT.md copy explains why it is display-only');
  assert(src.includes('remove only the deprecated FlowBoard section'),
    'BOOT.md copy gives concrete cleanup step');
  assert(src.includes('keep all other OpenClaw/user content unchanged'),
    'BOOT.md copy warns not to delete unrelated content');
  assert(src.includes('save, then refresh this dashboard'),
    'BOOT.md copy tells the user how to re-check after cleanup');
}

// ============================================================
section('Chip — "Optional setup" when current exists and missing remains');
// ============================================================
{
  const home = mkSandbox();
  try {
    const currentAgents = doctor.readCurrent('AGENTS-trigger.md');
    fs.mkdirSync(path.join(home, 'workspace-done'), { recursive: true });
    fs.writeFileSync(path.join(home, 'workspace-done', 'AGENTS.md'),
      `# Done\n\n${currentAgents}\n`);
    fs.mkdirSync(path.join(home, 'workspace-fresh'), { recursive: true });
    fs.writeFileSync(path.join(home, 'workspace-fresh', 'AGENTS.md'),
      '# Fresh\n\n');
    const status = doctor.collectStatus(home);
    assert(status.chip, 'chip present');
    assertEqual(status.chip.text, 'Optional setup', 'current exists + missing → Optional setup');
    assertEqual(status.chip.variant, 'info', 'variant = info');
  } finally { cleanup(); }
}

// ============================================================
section('Chip — hidden when current exists and nothing is missing');
// ============================================================
{
  const home = mkSandbox();
  try {
    const currentAgents = doctor.readCurrent('AGENTS-trigger.md');
    fs.mkdirSync(path.join(home, 'workspace-done'), { recursive: true });
    fs.writeFileSync(path.join(home, 'workspace-done', 'AGENTS.md'),
      `# Done\n\n${currentAgents}\n`);
    const status = doctor.collectStatus(home);
    assertEqual(status.chip, null,
      'current only and no missing → chip hidden');
  } finally { cleanup(); }
}

// ============================================================
section('Upgrade action — identical file → current block + backup');
// ============================================================
{
  const home = mkSandbox();
  try {
    const paths = seedSandbox(home);
    const before = fs.readFileSync(paths.identicalPath, 'utf8');
    const status = doctor.collectStatus(home);
    const target = status.files.find(f => f.path === paths.identicalPath);
    assert(target, 'identical file has an entry');

    const r = doctor.applyActions(home, [{ id: target.id, action: 'upgrade' }]);
    assertEqual(r.applied.length, 1, 'one applied');
    assertEqual(r.applied[0].action, 'upgrade', 'action recorded');
    assert(r.applied[0].backup && fs.existsSync(r.applied[0].backup), 'backup file exists');

    // Post-state: file contains the current-snippet marker, not legacy
    const after = fs.readFileSync(paths.identicalPath, 'utf8');
    assert(after.includes('Check your status'),
      'current snippet marker present after upgrade');
    assert(!after.includes('FlowBoard delivers project context automatically'),
      'legacy structural marker gone after upgrade');

    // Backup is BYTE-EXACT pre-change content
    const bak = fs.readFileSync(r.applied[0].backup, 'utf8');
    assertEqual(bak, before, 'backup matches pre-upgrade bytes exactly');

    // Surrounding content preserved (the "# Main agent" header and "# trailer")
    assert(after.startsWith('# Main agent'), 'header preserved');
    assert(after.trimEnd().endsWith('# trailer'), 'trailer preserved');
  } finally { cleanup(); }
}

// ============================================================
section('Migrate action — drifted file → canonical block + backup');
// ============================================================
{
  const home = mkSandbox();
  try {
    const paths = seedSandbox(home);
    const before = fs.readFileSync(paths.driftedPath, 'utf8');
    const status = doctor.collectStatus(home);
    const target = status.files.find(f => f.path === paths.driftedPath);
    assert(target, 'drifted file has an entry');

    const r = doctor.applyActions(home, [{ id: target.id, action: 'migrate' }]);
    assertEqual(r.applied.length, 1, 'one applied');
    assertEqual(r.applied[0].action, 'migrate', 'action recorded');
    assert(r.applied[0].backup && fs.existsSync(r.applied[0].backup), 'backup written');

    const after = fs.readFileSync(paths.driftedPath, 'utf8');
    assert(after.includes('Check your status'),
      'new block inserted after migrate');
    assert(!after.includes('my customized project context'),
      'user custom-drift line removed');

    // Custom header section BEFORE the snippet block should survive
    assert(after.includes('## Custom section'),
      'user custom section above snippet preserved');
    assert(after.includes('Some custom notes for my agent'),
      'user custom prose preserved');

    const bak = fs.readFileSync(r.applied[0].backup, 'utf8');
    assertEqual(bak, before, 'backup matches pre-migrate bytes exactly');
  } finally { cleanup(); }
}

// ============================================================
section('Migrate action — fingerprint-only drifted file → canonical block + backup');
// ============================================================
{
  const home = mkSandbox();
  try {
    fs.mkdirSync(path.join(home, 'workspace-real-drift'), { recursive: true });
    const filePath = path.join(home, 'workspace-real-drift', 'AGENTS.md');
    fs.writeFileSync(filePath,
      `# AGENTS.md - Operating Manual\n\n` +
      `## Projects (MANDATORY)\n\n` +
      `FlowBoard delivers project context automatically as \`BOOTSTRAP.md\` in\n` +
      `your run context. The \`project-context\` hook injects it via the\n` +
      `OpenClaw \`agent:bootstrap\` event before every agent run.\n\n` +
      `### At session start\n` +
      `1. Your project context is already in your run context.\n` +
      `2. Fetch individual sections on demand from the FlowBoard API.\n\n` +
      `## Response Style\n` +
      `Keep it short.\n`);
    const before = fs.readFileSync(filePath, 'utf8');
    const status = doctor.collectStatus(home);
    const target = status.files.find(f => f.path === filePath);
    assert(target, 'fingerprint-only drifted file has an entry');
    assertEqual(target.state, 'drifted', 'fingerprint-only file classified as drifted');

    const r = doctor.applyActions(home, [{ id: target.id, action: 'migrate' }]);
    assertEqual(r.applied.length, 1, 'fingerprint-only migration applied');
    assertEqual(r.skipped.length, 0, 'fingerprint-only migration not skipped');

    const after = fs.readFileSync(filePath, 'utf8');
    assert(after.includes('Check your status'),
      'fingerprint-only migration inserts current snippet');
    assert(!after.includes('FlowBoard delivers project context automatically'),
      'fingerprint-only migration removes legacy prose');
    assert(after.includes('## Response Style'),
      'fingerprint-only migration preserves following sections');

    const bak = fs.readFileSync(r.applied[0].backup, 'utf8');
    assertEqual(bak, before, 'fingerprint-only backup matches pre-migrate bytes exactly');
  } finally { cleanup(); }
}

// ============================================================
section('Add action — missing file → append at end, idempotent');
// ============================================================
{
  const home = mkSandbox();
  try {
    const paths = seedSandbox(home);
    const before = fs.readFileSync(paths.missingPath, 'utf8');
    const status = doctor.collectStatus(home);
    const target = status.files.find(f => f.path === paths.missingPath);
    assert(target, 'missing file has an entry');

    const r = doctor.applyActions(home, [{ id: target.id, action: 'add' }]);
    assertEqual(r.applied.length, 1, 'one applied');
    assertEqual(r.applied[0].action, 'add', 'action recorded');
    assert(r.applied[0].backup && fs.existsSync(r.applied[0].backup), 'backup written');

    const after = fs.readFileSync(paths.missingPath, 'utf8');
    assert(after.startsWith('# Plain agent'),
      'existing content preserved at top');
    assert(after.includes('Just some agent prose. No FlowBoard snippet anywhere.'),
      'existing body text preserved');
    assert(after.includes('Check your status'),
      'current snippet appended');
    assert(after.indexOf('Check your status') >
           after.indexOf('Just some agent prose'),
      'snippet is appended AFTER original content');

    const bak = fs.readFileSync(r.applied[0].backup, 'utf8');
    assertEqual(bak, before, 'backup matches pre-add bytes exactly');

    // Idempotent: running add again → skipped with reason
    const status2 = doctor.collectStatus(home);
    const sameFile = status2.files.find(f => f.path === paths.missingPath);
    // After add, file is now `current`, so it won't appear in files list
    assertEqual(sameFile, undefined,
      'after add, file is in state current → excluded from files list');

    // If we force the same action with the old id, it's either not-found
    // (because the id no longer resolves to a file in status) — correct guard
    const r2 = doctor.applyActions(home, [{ id: target.id, action: 'add' }]);
    assertEqual(r2.applied.length, 0, 'second add is not applied');
    assertEqual(r2.skipped.length, 1, 'second add is skipped');
    assertEqual(r2.skipped[0].reason, 'not-found',
      'reason is not-found (file now in state current, off the UI list)');
  } finally { cleanup(); }
}

// ============================================================
section('State-mismatch guards — wrong action per state is skipped');
// ============================================================
{
  const home = mkSandbox();
  try {
    const paths = seedSandbox(home);
    const status = doctor.collectStatus(home);

    const idIdentical = status.files.find(f => f.path === paths.identicalPath).id;
    const idDrifted   = status.files.find(f => f.path === paths.driftedPath).id;
    const idMissing   = status.files.find(f => f.path === paths.missingPath).id;

    // Wrong combos
    const r = doctor.applyActions(home, [
      { id: idIdentical, action: 'migrate' }, // upgrade only
      { id: idIdentical, action: 'add' },     // upgrade only
      { id: idDrifted,   action: 'upgrade' }, // migrate only
      { id: idDrifted,   action: 'add' },     // migrate only
      { id: idMissing,   action: 'upgrade' }, // add only
      { id: idMissing,   action: 'migrate' }, // add only
      { id: 'nope',      action: 'upgrade' }, // unknown id
    ]);
    assertEqual(r.applied.length, 0, 'no wrong action succeeded');
    assertEqual(r.skipped.length, 7, 'all seven rejected');
    const reasons = r.skipped.map(s => s.reason);
    assert(reasons.every(r => /state-mismatch|not-found/.test(r)),
      'all skipped reasons are state-mismatch or not-found');

    // Files untouched: read-back equals seed content
    assert(fs.readFileSync(paths.identicalPath, 'utf8').includes('Read `BOOTSTRAP.md` — that is your project context.'),
      'identical file still carries legacy block');
    assert(fs.readFileSync(paths.driftedPath, 'utf8').includes('my customized project context'),
      'drifted file still carries user edit');
    assert(!fs.readFileSync(paths.missingPath, 'utf8').includes('delivers project context'),
      'missing file still has no snippet');
  } finally { cleanup(); }
}

// ============================================================
section('Batch apply — upgrade + migrate + add in one call');
// ============================================================
{
  const home = mkSandbox();
  try {
    const paths = seedSandbox(home);
    const status = doctor.collectStatus(home);
    const byPath = new Map(status.files.map(f => [f.path, f]));

    const actions = [
      { id: byPath.get(paths.identicalPath).id, action: 'upgrade' },
      { id: byPath.get(paths.driftedPath).id,   action: 'migrate' },
      { id: byPath.get(paths.missingPath).id,   action: 'add' },
    ];
    const r = doctor.applyActions(home, actions);
    assertEqual(r.applied.length, 3, 'all three actions applied');
    assertEqual(r.skipped.length, 0, 'none skipped');

    // Each file now has the current snippet
    for (const p of [paths.identicalPath, paths.driftedPath, paths.missingPath]) {
      const content = fs.readFileSync(p, 'utf8');
      assert(content.includes('Check your status'),
        `${path.basename(path.dirname(p))} has current snippet after batch apply`);
    }

    // Each file has a backup pointing at its pre-change content
    for (const entry of r.applied) {
      assert(fs.existsSync(entry.backup),
        `backup for ${path.basename(path.dirname(entry.path))} exists`);
    }

    // Status after batch: workspace-voice + workspace-claude remain missing;
    // BOOT.md legacy remains display-only but still keeps the migration
    // advisory visible because manual cleanup is required.
    const status2 = doctor.collectStatus(home);
    // 4 current total: the 3 we just applied + workspace-done which was
    // already current from the seed.
    assertEqual(status2.counts.current, 4,
      'four files now current (3 batch-applied + 1 pre-existing)');
    assertEqual(status2.counts.drifted, 0, 'no drifted migratable files remain');
    assertEqual(status2.bootLegacyFiles?.length || 0, 1, 'BOOT.md legacy advisory still visible');
    assertEqual(status2.chip.text, 'Migration required', 'chip reflects remaining manual cleanup advisory');
  } finally { cleanup(); }
}

// ============================================================
section('current wins over legacy — post-add stray reference');
// ============================================================
{
  const home = mkSandbox();
  try {
    // A file that contains both the CURRENT snippet block AND a stray
    // legacy-marker string elsewhere (e.g. in user prose). This is exactly
    // what happens AFTER an add on a workspace whose original content
    // already mentioned ACTIVE-PROJECT.md somewhere.
    const currentAgents = doctor.readCurrent('AGENTS-trigger.md');
    fs.mkdirSync(path.join(home, 'workspace-mixed'), { recursive: true });
    fs.writeFileSync(
      path.join(home, 'workspace-mixed', 'AGENTS.md'),
      `# Mixed agent\n\n## Tools\nCheck ACTIVE-PROJECT.md for legacy reference.\n\n${currentAgents}\n`
    );

    const status = doctor.collectStatus(home);
    assertEqual(status.counts.current, 1, 'classified as current (not drifted)');
    assertEqual(status.counts.drifted, 0, 'not double-counted as drifted');
    assertEqual(status.files.length, 0, 'current files excluded from UI list');
  } finally { cleanup(); }
}

// ============================================================
section('BOOT.md - legacy advisory is display-only');
// ============================================================
{
  const home = mkSandbox();
  try {
    const paths = seedSandbox(home);
    const before = fs.readFileSync(paths.bootLegacyPath, 'utf8');
    const status = doctor.collectStatus(home);
    const target = status.files.find(f => f.path === paths.bootLegacyPath);
    assert(!target, 'BOOT.md is not a migratable file entry');
    const advisory = status.bootLegacyFiles.find(f => f.path === paths.bootLegacyPath);
    assert(advisory, 'BOOT.md legacy advisory present');
    assertEqual(advisory.state, 'legacy', 'BOOT.md classified as legacy advisory');

    const r = doctor.applyActions(home, [{ id: advisory.id, action: 'migrate' }]);
    assertEqual(r.applied.length, 0, 'BOOT migrate is not applied');
    assertEqual(r.skipped.length, 1, 'BOOT migrate request is skipped');
    assertEqual(fs.readFileSync(paths.bootLegacyPath, 'utf8'), before, 'BOOT.md left untouched');
  } finally { cleanup(); }
}

// ============================================================
section('Legacy project-state files - display-only advisory');
// ============================================================
{
  const home = mkSandbox();
  try {
    fs.mkdirSync(path.join(home, 'workspace'), { recursive: true });
    fs.writeFileSync(path.join(home, 'workspace', 'AGENTS.md'), `${doctor.readCurrent('AGENTS-trigger.md')}\n`);
    fs.writeFileSync(path.join(home, 'workspace', 'SESSION-STATE.md'), '# stale session\n');
    fs.writeFileSync(path.join(home, 'workspace', 'BOOTSTRAP.md'), '# stale bootstrap\n');
    fs.writeFileSync(path.join(home, 'workspace', 'ACTIVE-PROJECT.md'), 'project: stale\n');

    const status = doctor.collectStatus(home);
    assertEqual(status.files.length, 0, 'current AGENTS.md has no migratable rows');
    assertEqual(status.legacyStateFiles?.length || 0, 3, 'three legacy project-state advisories visible');
    assertEqual(status.chip.text, 'Migration required', 'legacy project-state files keep migration chip visible');

    const r = doctor.applyActions(home, [{ id: status.legacyStateFiles[0].id, action: 'migrate' }]);
    assertEqual(r.applied.length, 0, 'legacy state file is not auto-migrated');
    assertEqual(r.skipped.length, 1, 'legacy state migrate request is skipped');
    assert(fs.existsSync(path.join(home, 'workspace', 'SESSION-STATE.md')), 'SESSION-STATE.md left untouched');
  } finally { cleanup(); }
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
