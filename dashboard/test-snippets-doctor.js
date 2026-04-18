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

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
