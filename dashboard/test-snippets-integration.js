'use strict';

/**
 * End-to-end integration test for the snippet upgrade / migration flow.
 *
 * Builds a temp OPENCLAW_HOME sandbox with one workspace per state
 * (identical / drifted / missing / current / foreign-marker / claude-style)
 * and exercises collectStatus + applyActions through every code path:
 *
 *   - state classification per workspace
 *   - chip variant derivation (Migration required / Finish setup / hidden)
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

/** Seed the sandbox with one workspace per state plus a BOOT.md drift case. */
function seedSandbox(home) {
  const legacyAgents  = doctor.readVendored('AGENTS-trigger.v1.md');
  const currentAgents = doctor.readCurrent('AGENTS-trigger.md');
  const legacyBoot    = doctor.readVendored('BOOT-extension.v1.md');

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
        'MANDATORY on EVERY first message of a conversation',
        'MANDATORY on EVERY first message of my_custom_agent'
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
    // BOOT.md drift case in workspace/
    bootDriftedPath: (() => {
      const drifted = legacyBoot.replace('existing BOOT.md', 'customized BOOT.md');
      fs.writeFileSync(path.join(home, 'workspace', 'BOOT.md'),
        `# My BOOT\n\n## Custom ${''}startup\nSome steps.\n\n${drifted}\n`);
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
    assertEqual(status.counts.drifted, 2,
      'two drifted: workspace-drift/AGENTS.md + workspace/BOOT.md');
    assertEqual(status.counts.current, 1, 'one current (workspace-done)');
    assertEqual(status.counts.missing, 3,
      'three missing: workspace-plain, workspace-voice, workspace-claude');

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
section('Chip — "Finish setup" when only missing (no legacy, no current)');
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
section('Chip — hidden when at least one current and no legacy');
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
    assertEqual(status.chip, null,
      'current exists + no legacy (even with missing) → chip hidden');
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
    assert(after.includes('delivers project context automatically'),
      'current snippet marker present after upgrade');
    assert(!after.includes('MANDATORY on EVERY first message'),
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
    assert(after.includes('delivers project context automatically'),
      'new block inserted after migrate');
    assert(!after.includes('MANDATORY on EVERY first message of my_custom_agent'),
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
    assert(after.includes('delivers project context automatically'),
      'current snippet appended');
    assert(after.indexOf('delivers project context automatically') >
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
    assert(fs.readFileSync(paths.identicalPath, 'utf8').includes('MANDATORY on EVERY first message'),
      'identical file still carries legacy block');
    assert(fs.readFileSync(paths.driftedPath, 'utf8').includes('my_custom_agent'),
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
      assert(content.includes('delivers project context automatically'),
        `${path.basename(path.dirname(p))} has current snippet after batch apply`);
    }

    // Each file has a backup pointing at its pre-change content
    for (const entry of r.applied) {
      assert(fs.existsSync(entry.backup),
        `backup for ${path.basename(path.dirname(entry.path))} exists`);
    }

    // Status after batch: only workspace-voice + workspace-claude + BOOT.md still
    // need attention (voice + claude are missing; BOOT.md is drifted). Chip
    // still "Migration required" because of BOOT drift.
    const status2 = doctor.collectStatus(home);
    // 4 current total: the 3 we just applied + workspace-done which was
    // already current from the seed.
    assertEqual(status2.counts.current, 4,
      'four files now current (3 batch-applied + 1 pre-existing)');
    assertEqual(status2.counts.drifted, 1, 'only BOOT.md drift remains');
    assertEqual(status2.chip.text, 'Migration required', 'chip still reflects remaining drift');
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
section('BOOT.md — migrate action handles BOOT-specific extract');
// ============================================================
{
  const home = mkSandbox();
  try {
    const paths = seedSandbox(home);
    const before = fs.readFileSync(paths.bootDriftedPath, 'utf8');
    const status = doctor.collectStatus(home);
    const target = status.files.find(f => f.path === paths.bootDriftedPath);
    assert(target, 'BOOT.md drift has an entry');
    assertEqual(target.state, 'drifted', 'BOOT.md classified as drifted');

    const r = doctor.applyActions(home, [{ id: target.id, action: 'migrate' }]);
    assertEqual(r.applied.length, 1, 'BOOT migrate applied');

    const after = fs.readFileSync(paths.bootDriftedPath, 'utf8');
    assert(after.includes("regenerated `BOOTSTRAP.md`"),
      'current BOOT snippet marker present');
    assert(after.includes('# My BOOT'), 'BOOT header preserved');
    const bak = fs.readFileSync(r.applied[0].backup, 'utf8');
    assertEqual(bak, before, 'BOOT backup byte-exact');
  } finally { cleanup(); }
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
