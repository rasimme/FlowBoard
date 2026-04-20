'use strict';

/**
 * Unit tests for snippets-doctor.js — the legacy-snippet detection + safe-replace logic.
 * Run: node test-snippets-doctor.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const doctor = require('./snippets-doctor.js');

let passed = 0;
let failed = 0;
let tmpDir = null;

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✅ ${msg}`); }
  else      { failed++; console.error(`  ❌ ${msg}`); }
}
function assertEqual(actual, expected, msg) {
  if (actual === expected) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}
function section(name) { console.log(`\n## ${name}`); }

function mkTmp() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snippets-doctor-test-'));
  return tmpDir;
}
function cleanupTmp() {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  tmpDir = null;
}

const LEGACY_BLOCK = `## Projects (MANDATORY)
MANDATORY on EVERY first message of a conversation: read \`ACTIVE-PROJECT.md\`.
- If an active project exists: read \`projects/PROJECT-RULES.md\`, then read the project's \`PROJECT.md\`. Follow all rules in PROJECT-RULES.md.
- If no active project or file is empty/missing: work normally without project context.

Commands — always read \`projects/PROJECT-RULES.md\` first before executing:
- "Projekt: [Name]" → activate project
- "Projekt beenden" → deactivate project
- "Projekte" → show project overview
- "Neues Projekt: [Name]" → create new project

Only explicit user commands may change ACTIVE-PROJECT.md. Never modify it automatically via cron, sub-agents, or other automation.
`;

const NEW_BLOCK = `## Projects (MANDATORY)

FlowBoard delivers project context automatically as \`BOOTSTRAP.md\`.
See snippets/AGENTS-trigger.md for the full current block.
`;

section('detectLegacyMarkers()');
{
  assert(doctor.detectLegacyMarkers(LEGACY_BLOCK) === true,
    'detects ACTIVE-PROJECT.md marker');
  assert(doctor.detectLegacyMarkers('# My AGENTS.md\n\njust some notes') === false,
    'returns false for clean content');
  assert(doctor.detectLegacyMarkers('') === false,
    'returns false for empty content');
  assert(doctor.detectLegacyMarkers(NEW_BLOCK) === false,
    'returns false for new-style content (no legacy markers)');
  assert(doctor.detectLegacyMarkers('read projects/PROJECT-RULES.md') === true,
    'detects projects/PROJECT-RULES.md marker standalone');
}

section('matchesLegacyBlockExactly()');
{
  // Block exists byte-identical inside larger content
  const containerWithLegacy = `# My AGENTS.md\n\nSome preamble.\n\n${LEGACY_BLOCK}\n\nSome epilogue.\n`;
  assert(doctor.matchesLegacyBlockExactly(containerWithLegacy, LEGACY_BLOCK) === true,
    'finds byte-identical legacy block inside larger file');

  // Modified block (one char changed)
  const modified = LEGACY_BLOCK.replace('MANDATORY', 'Mandatory');
  const containerWithModified = `# AGENTS.md\n\n${modified}\n`;
  assert(doctor.matchesLegacyBlockExactly(containerWithModified, LEGACY_BLOCK) === false,
    'rejects block with single-char modification');

  // Whitespace difference
  const trimmedTrailing = LEGACY_BLOCK.trimEnd();
  assert(doctor.matchesLegacyBlockExactly(trimmedTrailing, LEGACY_BLOCK) === false,
    'rejects block with differing trailing whitespace');

  // Completely missing
  assert(doctor.matchesLegacyBlockExactly('unrelated content', LEGACY_BLOCK) === false,
    'returns false when block absent');
}

section('replaceLegacyBlock()');
{
  const container = `# AGENTS.md\n\nPreamble.\n\n${LEGACY_BLOCK}\nEpilogue.\n`;
  const result = doctor.replaceLegacyBlock(container, LEGACY_BLOCK, NEW_BLOCK);
  assert(typeof result === 'string', 'returns string on exact match');
  assert(result.includes('Preamble.'), 'preserves preamble');
  assert(result.includes('Epilogue.'), 'preserves epilogue');
  assert(result.includes(NEW_BLOCK), 'inserts new block');
  assert(!result.includes('ACTIVE-PROJECT.md'), 'removes legacy markers');

  // Divergent content → null
  const divergent = container.replace('MANDATORY', 'mandatory');
  assertEqual(doctor.replaceLegacyBlock(divergent, LEGACY_BLOCK, NEW_BLOCK), null,
    'returns null when legacy block differs');

  // No legacy block present → null
  assertEqual(doctor.replaceLegacyBlock('unrelated\n', LEGACY_BLOCK, NEW_BLOCK), null,
    'returns null when legacy block absent');
}

section('auditFile()');
{
  const dir = mkTmp();
  try {
    const cleanPath = path.join(dir, 'clean.md');
    fs.writeFileSync(cleanPath, '# Clean AGENTS.md\n\nNothing FlowBoardy here.\n');

    const legacyExactPath = path.join(dir, 'legacy-exact.md');
    fs.writeFileSync(legacyExactPath, `# AGENTS.md\n\n${LEGACY_BLOCK}\nEnd.\n`);

    const legacyModifiedPath = path.join(dir, 'legacy-modified.md');
    fs.writeFileSync(legacyModifiedPath, `# AGENTS.md\n\n${LEGACY_BLOCK.replace('MANDATORY', 'mandatory')}\nEnd.\n`);

    const cleanAudit = doctor.auditFile(cleanPath, { legacyBlock: LEGACY_BLOCK, newBlock: NEW_BLOCK });
    assertEqual(cleanAudit.hasLegacyMarkers, false, 'clean file: no markers');
    assertEqual(cleanAudit.matchesExactly, false, 'clean file: not exact match');
    assertEqual(cleanAudit.suggestedContent, null, 'clean file: no suggestion');

    const exactAudit = doctor.auditFile(legacyExactPath, { legacyBlock: LEGACY_BLOCK, newBlock: NEW_BLOCK });
    assertEqual(exactAudit.hasLegacyMarkers, true, 'exact legacy: markers detected');
    assertEqual(exactAudit.matchesExactly, true, 'exact legacy: matches byte-for-byte');
    assert(typeof exactAudit.suggestedContent === 'string' && exactAudit.suggestedContent.includes(NEW_BLOCK),
      'exact legacy: suggests replacement with new block');

    const modifiedAudit = doctor.auditFile(legacyModifiedPath, { legacyBlock: LEGACY_BLOCK, newBlock: NEW_BLOCK });
    assertEqual(modifiedAudit.hasLegacyMarkers, true, 'modified legacy: markers detected');
    assertEqual(modifiedAudit.matchesExactly, false, 'modified legacy: not exact match');
    assertEqual(modifiedAudit.suggestedContent, null, 'modified legacy: no auto-suggestion');
  } finally {
    cleanupTmp();
  }
}

section('findCandidateFiles()');
{
  const dir = mkTmp();
  try {
    // Simulate openclaw home with multiple workspace dirs
    fs.mkdirSync(path.join(dir, 'workspace'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'workspace-alice'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'workspace-bob'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'not-a-workspace'), { recursive: true });

    fs.writeFileSync(path.join(dir, 'workspace', 'AGENTS.md'), '');
    fs.writeFileSync(path.join(dir, 'workspace-alice', 'AGENTS.md'), '');
    // bob intentionally has no AGENTS.md
    fs.writeFileSync(path.join(dir, 'not-a-workspace', 'AGENTS.md'), ''); // should NOT be picked up

    const results = doctor.findCandidateFiles(dir, 'AGENTS.md');
    assert(Array.isArray(results), 'returns an array');
    assertEqual(results.length, 2, 'finds 2 AGENTS.md (workspace + workspace-alice, excludes not-a-workspace)');
    assert(results.some(p => p.endsWith(path.join('workspace', 'AGENTS.md'))), 'includes workspace');
    assert(results.some(p => p.endsWith(path.join('workspace-alice', 'AGENTS.md'))), 'includes workspace-alice');
    assert(!results.some(p => p.includes('not-a-workspace')), 'excludes non-workspace dir');
    assert(!results.some(p => p.includes('workspace-bob')), 'excludes workspace without target file');
  } finally {
    cleanupTmp();
  }
}

section('formatBytes()');
{
  assertEqual(doctor.formatBytes(0), '0 B', 'zero');
  assertEqual(doctor.formatBytes(512), '512 B', 'bytes under 1024');
  assertEqual(doctor.formatBytes(1024), '1.0 kB', 'exactly 1024');
  assertEqual(doctor.formatBytes(2560), '2.5 kB', '2.5 kB');
  assertEqual(doctor.formatBytes(-5), '0 B', 'negative → 0 B');
  assertEqual(doctor.formatBytes(NaN), '0 B', 'NaN → 0 B');
}

section('computeSimpleDiff()');
{
  const diff = doctor.computeSimpleDiff('old line 1\nold line 2\n', 'new line 1\nnew line 2\nnew line 3\n');
  assert(Array.isArray(diff), 'returns array');
  assertEqual(diff[0].t, 'hunk', 'first entry is hunk');
  const dels = diff.filter(d => d.t === 'del');
  const adds = diff.filter(d => d.t === 'add');
  assertEqual(dels.length, 2, 'two del lines (trailing newline trimmed)');
  assertEqual(adds.length, 3, 'three add lines');
  assertEqual(dels[0].text, 'old line 1', 'first del text');
  assertEqual(dels[0].n, 1, 'first del line number');
  assertEqual(adds[2].n, 3, 'third add line number');

  const labeled = doctor.computeSimpleDiff('x', 'y', '@@ custom @@');
  assertEqual(labeled[0].text, '@@ custom @@', 'custom hunk label');

  const emptyDiff = doctor.computeSimpleDiff('', '');
  assertEqual(emptyDiff.length, 1, 'only hunk when both sides empty');
}

section('collectStatus()');
{
  const dir = mkTmp();
  try {
    fs.mkdirSync(path.join(dir, 'workspace'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'workspace-beta'), { recursive: true });

    // workspace/AGENTS.md = byte-identical legacy block
    const legacyAgents = doctor.readVendored('AGENTS-trigger.v1.md');
    fs.writeFileSync(path.join(dir, 'workspace', 'AGENTS.md'),
      `# My agents file\n\n${legacyAgents}\n# trailer\n`);
    // workspace-beta/AGENTS.md = DIVERGENT (markers present, block modified)
    const modified = legacyAgents.replace('MANDATORY', 'mandatory');
    fs.writeFileSync(path.join(dir, 'workspace-beta', 'AGENTS.md'),
      `# beta\n\n${modified}\n`);

    const status = doctor.collectStatus(dir);
    assert(status.counts.total >= 2, `total counts both candidates (got ${status.counts.total})`);
    assertEqual(status.counts.identical, 1, 'one identical (byte-match legacy)');
    assertEqual(status.counts.drifted, 1, 'one drifted (structural legacy block, modified)');
    assertEqual(status.files.length, 2, 'files array has 2 entries (identical + drifted)');
    const identical = status.files.find(f => f.state === 'identical');
    const drifted = status.files.find(f => f.state === 'drifted');
    assert(identical, 'identical entry present');
    assert(drifted, 'drifted entry present');
    assert(typeof identical.id === 'string' && identical.id.length > 0, 'identical has id');
    assert(identical.bytes && /[kB]/.test(identical.bytes), `identical has human bytes string (${identical.bytes})`);
    assert(Array.isArray(identical.diff) && identical.diff.length > 0, 'identical has diff');
    assert(status.chip && /Migration required/.test(status.chip.text), 'chip says Migration required');
  } finally {
    cleanupTmp();
  }
}

section('applySelected() — byte-identical only, with .bak');
{
  const dir = mkTmp();
  try {
    fs.mkdirSync(path.join(dir, 'workspace'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'workspace-beta'), { recursive: true });

    const legacyAgents = doctor.readVendored('AGENTS-trigger.v1.md');
    const targetPath = path.join(dir, 'workspace', 'AGENTS.md');
    const originalContent = `# My agents file\n\n${legacyAgents}\n# trailer\n`;
    fs.writeFileSync(targetPath, originalContent);

    const divergentPath = path.join(dir, 'workspace-beta', 'AGENTS.md');
    const divergentContent = `# beta\n\n${legacyAgents.replace('MANDATORY', 'mandatory')}\n`;
    fs.writeFileSync(divergentPath, divergentContent);

    const status = doctor.collectStatus(dir);
    const identicalId = status.files.find(f => f.state === 'identical').id;
    const driftedId = status.files.find(f => f.state === 'drifted').id;

    // applySelected is the legacy single-action wrapper (action=upgrade).
    // It should touch only the identical file, never the drifted one.
    const result = doctor.applySelected(dir, [identicalId, driftedId, 'unknown-id']);
    assertEqual(result.applied.length, 1, 'one apply');
    assertEqual(result.applied[0].id, identicalId, 'applied the identical one');
    assert(result.applied[0].backup && fs.existsSync(result.applied[0].backup), 'backup file exists');

    // Skipped array contains drifted (state-mismatch) + unknown
    assertEqual(result.skipped.length, 2, 'two skipped');
    const skippedIds = result.skipped.map(s => s.id);
    assert(skippedIds.includes(driftedId), 'drifted skipped (state-mismatch for upgrade)');
    assert(skippedIds.includes('unknown-id'), 'unknown id skipped');

    // Verify the identical file was actually replaced
    const afterIdentical = fs.readFileSync(targetPath, 'utf8');
    const currentBlock = doctor.readCurrent('AGENTS-trigger.md');
    assert(afterIdentical.includes(currentBlock.trim().slice(0, 60)), 'new block present in identical file');
    assert(!afterIdentical.includes('MANDATORY on EVERY first message'), 'legacy phrasing gone');

    // Verify drifted was NOT touched
    const afterDrifted = fs.readFileSync(divergentPath, 'utf8');
    assertEqual(afterDrifted, divergentContent, 'drifted file untouched');

    // Backup should equal the ORIGINAL pre-upgrade content
    const backupContent = fs.readFileSync(result.applied[0].backup, 'utf8');
    assertEqual(backupContent, originalContent, 'backup contains original content');
  } finally {
    cleanupTmp();
  }
}

section('makeFileId()');
{
  const base = '/tmp/.openclaw';
  const id1 = doctor.makeFileId(base, '/tmp/.openclaw/workspace/AGENTS.md');
  const id2 = doctor.makeFileId(base, '/tmp/.openclaw/workspace-alice/BOOT.md');
  assert(id1.length > 0 && id2.length > 0, 'non-empty ids');
  assert(id1 !== id2, 'different paths → different ids');
  assert(!/[\s'"]/.test(id1), 'id has no spaces or quotes');
}

section('classifyFile() — state machine');
{
  const dir = mkTmp();
  try {
    fs.mkdirSync(path.join(dir, 'workspace'), { recursive: true });
    const legacyAgents = doctor.readVendored('AGENTS-trigger.v1.md');
    const currentAgents = doctor.readCurrent('AGENTS-trigger.md');
    const target = doctor.TARGETS.find(t => t.name === 'AGENTS.md');

    // identical
    const pIdentical = path.join(dir, 'workspace', 'AGENTS.md');
    fs.writeFileSync(pIdentical, `# header\n\n${legacyAgents}\n`);
    const cIdent = doctor.classifyFile(pIdentical, target, {
      legacyBlock: legacyAgents, newBlock: currentAgents,
    });
    assertEqual(cIdent.state, 'identical', 'byte-match legacy → identical');

    // drifted (structural marker present, block edited)
    const pDrifted = path.join(dir, 'workspace', 'AGENTS-drifted.md');
    const drifted = legacyAgents.replace('MANDATORY on EVERY first message of a conversation', 'MANDATORY on EVERY first message of my_custom_agent');
    fs.writeFileSync(pDrifted, drifted);
    const cDrift = doctor.classifyFile(pDrifted, target, {
      legacyBlock: legacyAgents, newBlock: currentAgents,
    });
    assertEqual(cDrift.state, 'drifted', 'structural legacy + modified → drifted');

    // current (new canonical block present)
    const pCurrent = path.join(dir, 'workspace', 'AGENTS-current.md');
    fs.writeFileSync(pCurrent, `# header\n\n${currentAgents}\n`);
    const cCur = doctor.classifyFile(pCurrent, target, {
      legacyBlock: legacyAgents, newBlock: currentAgents,
    });
    assertEqual(cCur.state, 'current', 'current marker present → current');

    // current wins over legacy (stray legacy marker after add)
    const pMixed = path.join(dir, 'workspace', 'AGENTS-mixed.md');
    fs.writeFileSync(pMixed, `# header\n\nSee ACTIVE-PROJECT.md for legacy notes.\n\n${currentAgents}\n`);
    const cMix = doctor.classifyFile(pMixed, target, {
      legacyBlock: legacyAgents, newBlock: currentAgents,
    });
    assertEqual(cMix.state, 'current', 'current-marker wins over stray legacy text');

    // missing (no markers at all)
    const pMissing = path.join(dir, 'workspace', 'AGENTS-missing.md');
    fs.writeFileSync(pMissing, '# my custom AGENTS file\n\njust some notes\n');
    const cMiss = doctor.classifyFile(pMissing, target, {
      legacyBlock: legacyAgents, newBlock: currentAgents,
    });
    assertEqual(cMiss.state, 'missing', 'no markers → missing');
  } finally {
    cleanupTmp();
  }
}

section('applyActions() — migrate + add + state guards');
{
  const dir = mkTmp();
  try {
    fs.mkdirSync(path.join(dir, 'workspace'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'workspace-beta'), { recursive: true });

    const legacyAgents = doctor.readVendored('AGENTS-trigger.v1.md');
    const currentAgents = doctor.readCurrent('AGENTS-trigger.md');

    // Drifted file: legacy structural marker + custom edit
    const driftedPath = path.join(dir, 'workspace', 'AGENTS.md');
    const driftedContent = `# my agents\n\n${legacyAgents.replace('MANDATORY on EVERY first message of a conversation', 'MANDATORY on EVERY first message of my_custom_agent')}\n# trailer\n`;
    fs.writeFileSync(driftedPath, driftedContent);

    // Missing file: no markers at all
    const missingPath = path.join(dir, 'workspace-beta', 'AGENTS.md');
    const missingContent = '# my beta config\n\nJust some prose, no FlowBoard snippet.\n';
    fs.writeFileSync(missingPath, missingContent);

    const status = doctor.collectStatus(dir);
    const driftedId = status.files.find(f => f.state === 'drifted').id;
    const missingId = status.files.find(f => f.state === 'missing').id;

    // Chip should say Migration required because we have drifted
    assert(status.chip && status.chip.text === 'Migration required', `chip = Migration required (got ${status.chip?.text})`);

    // migrate: should replace drifted block with current
    const r1 = doctor.applyActions(dir, [{ id: driftedId, action: 'migrate' }]);
    assertEqual(r1.applied.length, 1, 'migrate applied');
    assertEqual(r1.applied[0].action, 'migrate', 'action recorded as migrate');
    const afterDrift = fs.readFileSync(driftedPath, 'utf8');
    assert(afterDrift.includes('delivers project context automatically'), 'current block inserted');
    assert(!afterDrift.includes('MANDATORY on EVERY first message of my_custom_agent'), 'custom drift line removed');

    // add: should append insertBody at end of missing file
    const r2 = doctor.applyActions(dir, [{ id: missingId, action: 'add' }]);
    assertEqual(r2.applied.length, 1, 'add applied');
    assertEqual(r2.applied[0].action, 'add', 'action recorded as add');
    const afterMissing = fs.readFileSync(missingPath, 'utf8');
    assert(afterMissing.startsWith('# my beta config'), 'existing content preserved at top');
    assert(afterMissing.includes('delivers project context automatically'), 'new block appended');

    // State guard: migrate on missing → rejected
    fs.writeFileSync(missingPath, missingContent); // reset
    const st2 = doctor.collectStatus(dir);
    const missingId2 = st2.files.find(f => f.state === 'missing').id;
    const r3 = doctor.applyActions(dir, [{ id: missingId2, action: 'migrate' }]);
    assertEqual(r3.applied.length, 0, 'migrate on missing rejected');
    assertEqual(r3.skipped.length, 1, 'one skipped');
    assert(/state-mismatch/.test(r3.skipped[0].reason), 'reason is state-mismatch');
  } finally {
    cleanupTmp();
  }
}

section('collectStatus() — chip variants');
{
  const dir = mkTmp();
  try {
    fs.mkdirSync(path.join(dir, 'workspace'), { recursive: true });

    // (1) All missing → "Finish setup"
    fs.writeFileSync(path.join(dir, 'workspace', 'AGENTS.md'), '# plain\n');
    const s1 = doctor.collectStatus(dir);
    assertEqual(s1.chip?.text, 'Finish setup', 'all missing → Finish setup');
    assertEqual(s1.chip?.variant, 'info', 'Finish setup variant = info');

    // (2) Current only → no chip
    const currentAgents = doctor.readCurrent('AGENTS-trigger.md');
    fs.writeFileSync(path.join(dir, 'workspace', 'AGENTS.md'), `# plain\n\n${currentAgents}\n`);
    const s2 = doctor.collectStatus(dir);
    assertEqual(s2.chip, null, 'current-only → chip hidden');
  } finally {
    cleanupTmp();
  }
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
