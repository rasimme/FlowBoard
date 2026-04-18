#!/usr/bin/env node
'use strict';

/**
 * snippets-doctor — detect legacy AGENTS.md / BOOT.md snippets and (optionally)
 * replace them with the current canonical versions.
 *
 * Usage:
 *   node snippets-doctor.js             # dry-run: list findings and show diffs
 *   node snippets-doctor.js --apply     # replace legacy blocks that byte-match the vendored legacy copy
 *   node snippets-doctor.js --apply --yes   # skip confirmation prompt
 *   node snippets-doctor.js --base <dir>    # override OPENCLAW_HOME (default: ~/.openclaw)
 *
 * Safety: only replaces a block when it is BYTE-IDENTICAL to the vendored
 * legacy copy (snippets/legacy/*.v1.md). Divergent blocks are reported only —
 * the user must merge manually. A `.bak-<timestamp>` backup is written before
 * every in-place edit.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO_ROOT = path.resolve(__dirname, '..');

// --- Pure logic -----------------------------------------------------------

const LEGACY_MARKERS = [
  'ACTIVE-PROJECT.md',
  'projects/PROJECT-RULES.md',
];

function detectLegacyMarkers(content) {
  if (typeof content !== 'string' || content.length === 0) return false;
  return LEGACY_MARKERS.some(m => content.includes(m));
}

function matchesLegacyBlockExactly(content, legacyBlock) {
  if (typeof content !== 'string' || typeof legacyBlock !== 'string') return false;
  if (legacyBlock.length === 0) return false;
  return content.includes(legacyBlock);
}

function replaceLegacyBlock(content, legacyBlock, newBlock) {
  if (!matchesLegacyBlockExactly(content, legacyBlock)) return null;
  // First occurrence only — users with duplicated blocks must intervene manually.
  return content.replace(legacyBlock, newBlock);
}

function auditFile(filePath, { legacyBlock, newBlock }) {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf8'); } catch {
    return { exists: false, hasLegacyMarkers: false, matchesExactly: false, suggestedContent: null };
  }
  const hasLegacyMarkers = detectLegacyMarkers(content);
  const matchesExactly = matchesLegacyBlockExactly(content, legacyBlock);
  const suggestedContent = matchesExactly ? replaceLegacyBlock(content, legacyBlock, newBlock) : null;
  return { exists: true, filePath, content, hasLegacyMarkers, matchesExactly, suggestedContent };
}

function findCandidateFiles(baseDir, fileName) {
  const results = [];
  let entries;
  try { entries = fs.readdirSync(baseDir, { withFileTypes: true }); }
  catch { return results; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const isWorkspace = entry.name === 'workspace' || entry.name.startsWith('workspace-');
    if (!isWorkspace) continue;
    const candidate = path.join(baseDir, entry.name, fileName);
    if (fs.existsSync(candidate)) results.push(candidate);
  }
  return results;
}

function backupPath(filePath) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${filePath}.bak-${ts}`;
}

// --- CLI ------------------------------------------------------------------

function parseArgs(argv) {
  const args = { apply: false, yes: false, base: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--yes' || a === '-y') args.yes = true;
    else if (a === '--base') args.base = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function readVendored(name) {
  const p = path.join(REPO_ROOT, 'snippets', 'legacy', name);
  return fs.readFileSync(p, 'utf8');
}
function readCurrent(name) {
  const p = path.join(REPO_ROOT, 'snippets', name);
  return fs.readFileSync(p, 'utf8');
}

function runCli(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    stdout.write([
      'snippets-doctor — check and (optionally) update AGENTS.md / BOOT.md snippets',
      '',
      'Usage:',
      '  node snippets-doctor.js                # dry-run',
      '  node snippets-doctor.js --apply        # replace byte-identical legacy blocks',
      '  node snippets-doctor.js --apply --yes  # no confirmation prompt',
      '  node snippets-doctor.js --base <dir>   # override OPENCLAW_HOME (~/.openclaw)',
      '',
    ].join('\n'));
    return 0;
  }

  const baseDir = args.base || process.env.OPENCLAW_HOME || path.join(os.homedir(), '.openclaw');
  const targets = [
    { name: 'AGENTS.md', legacyVendored: 'AGENTS-trigger.v1.md', currentSnippet: 'AGENTS-trigger.md' },
    { name: 'BOOT.md',   legacyVendored: 'BOOT-extension.v1.md', currentSnippet: 'BOOT-extension.md' },
  ];

  let total = 0, withMarkers = 0, exactMatches = 0, divergent = 0, replaced = 0;

  for (const t of targets) {
    const candidates = findCandidateFiles(baseDir, t.name);
    if (candidates.length === 0) continue;

    let legacyBlock, newBlock;
    try {
      legacyBlock = readVendored(t.legacyVendored);
      newBlock = readCurrent(t.currentSnippet);
    } catch (err) {
      stderr.write(`[snippets-doctor] Could not read snippets for ${t.name}: ${err.message}\n`);
      continue;
    }

    for (const file of candidates) {
      total++;
      const audit = auditFile(file, { legacyBlock, newBlock });
      if (!audit.hasLegacyMarkers) continue;
      withMarkers++;
      stdout.write(`\n--- ${file}\n`);
      if (audit.matchesExactly) {
        exactMatches++;
        stdout.write(`[OK] Legacy block is byte-identical to snippets/legacy/${t.legacyVendored}\n`);
        if (args.apply) {
          const bak = backupPath(file);
          fs.copyFileSync(file, bak);
          fs.writeFileSync(file, audit.suggestedContent);
          replaced++;
          stdout.write(`[APPLIED] Replaced legacy block. Backup: ${bak}\n`);
        } else {
          stdout.write(`[DRY-RUN] Would replace legacy block with current snippets/${t.currentSnippet}\n`);
          stdout.write(`          Re-run with --apply to write the change (a .bak-<ts> backup will be created).\n`);
        }
      } else {
        divergent++;
        stdout.write(`[DIVERGENT] Legacy markers detected but block differs from vendored copy.\n`);
        stdout.write(`            Manual merge required. Compare against:\n`);
        stdout.write(`              snippets/legacy/${t.legacyVendored} (old canonical)\n`);
        stdout.write(`              snippets/${t.currentSnippet}         (new canonical)\n`);
      }
    }
  }

  stdout.write(`\n=== snippets-doctor summary ===\n`);
  stdout.write(`Checked: ${total} file(s)\n`);
  stdout.write(`With legacy markers: ${withMarkers}\n`);
  stdout.write(`Byte-identical legacy block: ${exactMatches}\n`);
  stdout.write(`Divergent (manual merge needed): ${divergent}\n`);
  if (args.apply) stdout.write(`Replaced: ${replaced}\n`);
  return divergent > 0 ? 2 : 0;
}

module.exports = {
  detectLegacyMarkers,
  matchesLegacyBlockExactly,
  replaceLegacyBlock,
  auditFile,
  findCandidateFiles,
  backupPath,
  parseArgs,
  runCli,
};

if (require.main === module) {
  const code = runCli(process.argv.slice(2));
  process.exit(code);
}
