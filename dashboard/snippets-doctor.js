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

// Coarse "this file has SOME legacy FlowBoard snippet content" filter.
// Used by detectLegacyMarkers / auditFile to gate the per-file output —
// the precise classifier (classifyFile) uses TARGETS.legacyStructuralMarkers.
//
// Keep this in sync with the active legacy layer's distinguishing phrase.
// When you ship a new release: snapshot the current snippet to
// snippets/legacy/AGENTS-trigger.vN.md, point TARGETS.vendored at the new
// snapshot, and update this list to whichever phrase identifies the
// previously-canonical (now-legacy) shape.
const LEGACY_MARKERS = [
  'Project-activation commands run only on explicit user request',
];

// Snippet targets: which workspace files are migrated, which vendored/current
// pair covers them, a human-readable summary, and structural markers used to
// distinguish "this file has a FlowBoard snippet block (possibly drifted)" from
// "this file merely mentions a legacy path in some other context".
//
// Convention (single-step migration model):
//   vendored — last main-released snapshot of the snippet
//   current  — what this dev release ships (snippets/<current>.md)
// On each main release, snapshot the new current as a new vN+1 vendored,
// update TARGETS.vendored to point at it, bump markers, and the doctor
// migrates from "what shipped on main" to "what dev is shipping now".
// Older release-pair migrations are not chained — drop the previous vendored
// when retiring a layer, see commit 4914c59 for the v1.md retirement.
//
// legacyStructuralMarkers — strings that uniquely identify the LEGACY snippet
//   block. MUST be present in snippets/legacy/<vendored>.md. MUST NOT be
//   present in snippets/<current>.md. Change both files together.
// currentMarkers — strings that uniquely identify the CURRENT (post-migration)
//   snippet block. MUST be present in snippets/<current>.md. MUST NOT be
//   present in snippets/legacy/<vendored>.md.
//
// ⚠️  If you edit either snippet and the marker phrase moves or disappears,
//     the classifier silently misclassifies files. The test suite guards
//     this — see "TARGETS ↔ snippet files — marker coherence" in
//     test-snippets-doctor.js. Run tests after every snippet edit.
const TARGETS = [
  {
    name: 'AGENTS.md',
    // v2 snapshot is the snippet AS IT STOOD before commit e236314 added the
    // "Tasks, specs, canvas (API-first)" workflow block. Anything older (the
    // pre-T-131-3 v0 with `MANDATORY on EVERY first message`) is no longer
    // present in the wild on this installation; if it resurfaces, snapshot
    // a v3 layer rather than chaining markers here.
    vendored: 'AGENTS-trigger.v2.md',
    current: 'AGENTS-trigger.md',
    summary: 'Sharpen project commands into positive imperative with bilingual phrasing + anti-echo rule',
    addSummary: 'Add the FlowBoard project trigger block with the API-first task workflow',
    // Phrase unique to the canonical v2 snapshot. Doctor uses this for both
    // drift detection (file has the marker but body no longer byte-matches)
    // and for replaceDriftedBlock's heading anchor.
    legacyStructuralMarkers: [
      'Project-activation commands run only on explicit user request',
    ],
    // Phrase unique to the current block — if present, migration is already
    // done for this file; no action needed.
    currentMarkers: [
      'never just echo the trigger back as if confirmed',
    ],
  },
  {
    name: 'BOOT.md',
    vendored: 'BOOT-extension.v1.md',
    current: 'BOOT-extension.md',
    summary: 'Point bootstrap at BOOTSTRAP.md manifest instead of eager PROJECT-RULES load',
    addSummary: 'Add the FlowBoard gateway-restart recovery block',
    legacyStructuralMarkers: [
      '1. Read `ACTIVE-PROJECT.md`',
    ],
    currentMarkers: [
      'regenerated `BOOTSTRAP.md`',
    ],
  },
];

function containsAny(content, markers) {
  if (!Array.isArray(markers) || markers.length === 0) return false;
  return markers.some(m => content.includes(m));
}

// Extract the actual snippet body to INSERT into a user's file. For AGENTS.md
// the whole current file IS the snippet. For BOOT.md the current file wraps
// the snippet in a markdown code fence (```markdown ... ```) — extract the
// content inside the fence.
function extractInsertBody(target, currentText) {
  if (target.name === 'BOOT.md') {
    const m = currentText.match(/```markdown\n([\s\S]*?)```/);
    if (m) return m[1].trimEnd();
  }
  return currentText.trimEnd();
}

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
  const args = { apply: false, yes: false, base: null, migrate: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--yes' || a === '-y') args.yes = true;
    else if (a === '--base') args.base = argv[++i];
    else if (a === '--migrate') args.migrate = true;
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

function formatBytes(n) {
  if (typeof n !== 'number' || !isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} kB`;
}

// Compact line-based diff suited for a "review the change" dashboard panel.
// Not a real LCS — it emits the full legacy block as `del` lines followed by
// the full new block as `add` lines, prefixed by a hunk header. Good enough
// for the reviewer to see what's going away and what replaces it.
function computeSimpleDiff(oldText, newText, hunkLabel) {
  const out = [{ t: 'hunk', text: hunkLabel || '@@ Snippet block @@' }];
  const oldLines = String(oldText || '').replace(/\r\n/g, '\n').split('\n');
  const newLines = String(newText || '').replace(/\r\n/g, '\n').split('\n');
  // Drop a single trailing empty line (textual files conventionally end with \n)
  if (oldLines.length && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines.length && newLines[newLines.length - 1] === '') newLines.pop();
  oldLines.forEach((text, i) => out.push({ t: 'del', n: i + 1, text }));
  newLines.forEach((text, i) => out.push({ t: 'add', n: i + 1, text }));
  return out;
}

// Stable, URL-safe ID for a workspace file — used by the apply endpoint to
// identify which files to upgrade without exposing filesystem paths in the
// request body.
function makeFileId(openclawHome, filePath) {
  const rel = path.relative(openclawHome, filePath).replace(/[^A-Za-z0-9._-]/g, '_');
  return rel;
}

// Classify a single workspace file into one of the states. Returns null if
// the file doesn't exist.
// States:
//   'identical'  — byte-matches vendored legacy block → safe auto-upgrade
//   'drifted'    — has legacy structural markers (heading + key phrase) but
//                  isn't byte-identical → user-edited snippet, needs migrate
//   'current'    — already has the new canonical block → done, skip in UI
//   'missing'    — file exists but has no snippet block at all (may still
//                  contain stray legacy-path references in other contexts)
function classifyFile(filePath, target, { legacyBlock, newBlock }) {
  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); }
  catch { return null; }

  // Priority order matters: "current" wins over legacy to prevent endless
  // re-flagging after a post-add file still carries a stray legacy reference.
  if (containsAny(content, target.currentMarkers)) {
    return { state: 'current', content };
  }
  if (matchesLegacyBlockExactly(content, legacyBlock)) {
    return { state: 'identical', content };
  }
  if (containsAny(content, target.legacyStructuralMarkers)) {
    return { state: 'drifted', content };
  }
  return { state: 'missing', content };
}

// Aggregate snippet status across all workspace dirs under OPENCLAW_HOME.
// Returns { counts, chip, files: [...] } where files carries per-file metadata
// needed by the dashboard UI (path, name, bytes, state, diff, summary).
//
// States: identical (State A), drifted (State B), missing (State D), current
// (State E — skipped from files list), ignored (dismissed — skipped).
//
// Chip variants follow the binary model: "Migration required" when any legacy
// remains; "Finish setup" when no legacy exists and no agent is configured;
// hidden once at least one agent is on the current snippet and no legacy.
function collectStatus(openclawHome) {
  const files = [];
  const counts = { identical: 0, drifted: 0, missing: 0, current: 0, total: 0 };
  for (const target of TARGETS) {
    let legacyBlock, newBlock, insertBody;
    try {
      legacyBlock = readVendored(target.vendored);
      newBlock = readCurrent(target.current);
      insertBody = extractInsertBody(target, newBlock);
    } catch {
      continue;
    }
    const candidates = findCandidateFiles(openclawHome, target.name);
    for (const filePath of candidates) {
      counts.total++;
      const cls = classifyFile(filePath, target, { legacyBlock, newBlock });
      if (!cls) continue;
      counts[cls.state]++;
      // current entries don't need a row in the UI
      if (cls.state === 'current') continue;

      let bytes = '0 B';
      try { bytes = formatBytes(fs.statSync(filePath).size); } catch {}
      const entry = {
        id: makeFileId(openclawHome, filePath),
        path: filePath,
        name: target.name,
        bytes,
        state: cls.state,
      };
      if (cls.state === 'identical' || cls.state === 'drifted') {
        entry.summary = target.summary;
        entry.diff = computeSimpleDiff(legacyBlock, newBlock, `@@ ${target.name} — snippet block @@`);
      } else if (cls.state === 'missing') {
        entry.summary = target.addSummary;
        // Preview: what gets added. Use an add-context diff (no legacy lines).
        entry.diff = computeSimpleDiff('', insertBody, `@@ ${target.name} — snippet to insert @@`);
      }
      files.push(entry);
    }
  }

  // Chip logic (binary + hidden)
  let chip = null;
  const hasLegacy = counts.identical > 0 || counts.drifted > 0;
  const hasCurrent = counts.current > 0;
  if (hasLegacy) {
    chip = { text: 'Migration required', variant: 'warn' };
  } else if (!hasCurrent && counts.missing > 0) {
    chip = { text: 'Finish setup', variant: 'info' };
  } // else: either nothing to do or at least one agent is configured → hide

  return { counts, chip, files };
}

// Apply a list of {id, action} pairs atomically per file.
// Supported actions:
//   'upgrade' — byte-identical legacy → new block (state: identical only)
//   'migrate' — drifted legacy → new block (state: drifted only, force-replace)
//   'add'     — insert snippet at end of file (state: missing only)
//
// Every action writes a `.bak-<timestamp>` before modifying. Unknown IDs,
// state mismatches, and filesystem errors are reported in `skipped`.
function applyActions(openclawHome, actions) {
  const applied = [];
  const skipped = [];
  const status = collectStatus(openclawHome);
  const byId = new Map(status.files.map(f => [f.id, f]));

  for (const { id, action } of Array.isArray(actions) ? actions : []) {
    if (!action) { skipped.push({ id, reason: 'no-action' }); continue; }

    const file = byId.get(id);
    if (!file) { skipped.push({ id, reason: 'not-found' }); continue; }
    const target = TARGETS.find(t => t.name === file.name);
    if (!target) { skipped.push({ id, reason: 'no-target' }); continue; }

    // State guard: never migrate a file that isn't in the expected state.
    const validMatrix = { upgrade: 'identical', migrate: 'drifted', add: 'missing' };
    if (file.state !== validMatrix[action]) {
      skipped.push({ id, reason: `state-mismatch: expected ${validMatrix[action]}, got ${file.state}` });
      continue;
    }

    let legacyBlock, newBlock, insertBody;
    try {
      legacyBlock = readVendored(target.vendored);
      newBlock = readCurrent(target.current);
      insertBody = extractInsertBody(target, newBlock);
    } catch (err) {
      skipped.push({ id, reason: `snippet-unavailable: ${err.message}` });
      continue;
    }
    let content;
    try { content = fs.readFileSync(file.path, 'utf8'); }
    catch (err) { skipped.push({ id, reason: `read-failed: ${err.message}` }); continue; }

    let next;
    if (action === 'upgrade') {
      next = replaceLegacyBlock(content, legacyBlock, newBlock);
      if (next === null) { skipped.push({ id, reason: 'no-longer-exact' }); continue; }
    } else if (action === 'migrate') {
      // Force-replace the drifted block. Strategy: find the structural legacy
      // heading and replace from there to the end of the legacy block region.
      // For robustness, we replace the FIRST occurrence of the heading + the
      // next ~15 lines (scoping by legacy snippet length).
      next = replaceDriftedBlock(content, legacyBlock, newBlock, target);
      if (next === null) { skipped.push({ id, reason: 'drift-region-not-found' }); continue; }
    } else if (action === 'add') {
      // Idempotency: if somehow already present, skip
      if (containsAny(content, target.currentMarkers)) {
        skipped.push({ id, reason: 'already-has-current-block' });
        continue;
      }
      // Append at end with a blank-line separator
      const trimmedContent = content.replace(/\n+$/, '');
      next = `${trimmedContent}\n\n${insertBody.trimEnd()}\n`;
    }

    const bak = backupPath(file.path);
    try {
      fs.copyFileSync(file.path, bak);
      fs.writeFileSync(file.path, next);
      applied.push({ id, path: file.path, backup: bak, action });
    } catch (err) {
      skipped.push({ id, reason: `write-failed: ${err.message}` });
    }
  }
  return { applied, skipped };
}

// Force-replace a drifted legacy block. The user's file no longer matches the
// vendored block byte-for-byte, but it DOES contain the legacy structural
// marker (heading or key phrase). We replace the region starting from the
// first structural marker and spanning the legacy block's line count.
function replaceDriftedBlock(content, legacyBlock, newBlock, target) {
  const marker = target.legacyStructuralMarkers.find(m => content.includes(m));
  if (!marker) return null;

  const lines = content.split('\n');
  const markerIdx = lines.findIndex(l => l.includes(marker));
  if (markerIdx < 0) return null;

  // Walk back to the nearest `## ` heading (or BOF) — that's the block start.
  let blockStart = markerIdx;
  for (let i = markerIdx; i >= 0; i--) {
    if (/^##?\s/.test(lines[i])) { blockStart = i; break; }
    if (i === 0) blockStart = 0;
  }

  // Block end: use the legacy block's line count as the window size (trailing
  // empty lines ignored), or walk forward until the next `##` heading or EOF.
  const legacyLines = legacyBlock.replace(/\n+$/, '').split('\n').length;
  let blockEnd = Math.min(blockStart + legacyLines, lines.length);
  // Tighten: if a new heading appears inside the window, stop there.
  for (let i = blockStart + 1; i < blockEnd; i++) {
    if (/^##?\s/.test(lines[i])) { blockEnd = i; break; }
  }

  const before = lines.slice(0, blockStart).join('\n').replace(/\n+$/, '');
  const after = lines.slice(blockEnd).join('\n').replace(/^\n+/, '');
  const middle = newBlock.trimEnd();

  const parts = [];
  if (before) parts.push(before);
  parts.push(middle);
  if (after) parts.push(after);
  return parts.join('\n\n') + '\n';
}

// Legacy wrapper — old single-action apply. Maps to the new applyActions
// with `{ id, action: 'upgrade' }`. Preserves external API (CLI + tests).
function applySelected(openclawHome, ids) {
  const actions = Array.isArray(ids) ? ids.map(id => ({ id, action: 'upgrade' })) : [];
  const result = applyActions(openclawHome, actions);
  return result;
}

function runCli(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    stdout.write([
      'snippets-doctor — check and (optionally) update AGENTS.md / BOOT.md snippets',
      '',
      'Usage:',
      '  node snippets-doctor.js                    # dry-run',
      '  node snippets-doctor.js --apply            # replace byte-identical legacy blocks',
      '  node snippets-doctor.js --apply --migrate  # also force-replace divergent blocks (heuristic; backs up first)',
      '  node snippets-doctor.js --apply --yes      # no confirmation prompt',
      '  node snippets-doctor.js --base <dir>       # override OPENCLAW_HOME (~/.openclaw)',
      '',
    ].join('\n'));
    return 0;
  }

  const baseDir = args.base || process.env.OPENCLAW_HOME || path.join(os.homedir(), '.openclaw');
  // Single source of truth: the module-level TARGETS array. The CLI used to
  // hardcode its own list which silently drifted from TARGETS (and missed
  // snippet version bumps). Adapt the schema for the CLI's local naming.
  const targets = TARGETS.map(t => ({
    name: t.name,
    legacyVendored: t.vendored,
    currentSnippet: t.current,
  }));

  let total = 0, withMarkers = 0, exactMatches = 0, divergent = 0, replaced = 0, migrated = 0, divergentRemaining = 0;

  for (const t of targets) {
    const candidates = findCandidateFiles(baseDir, t.name);
    if (candidates.length === 0) continue;

    // Full TARGETS entry — needed for legacyStructuralMarkers used by
    // replaceDriftedBlock when --migrate is on.
    const fullTarget = TARGETS.find(x => x.name === t.name);

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
        if (args.apply && args.migrate && fullTarget) {
          const next = replaceDriftedBlock(audit.content, legacyBlock, newBlock, fullTarget);
          if (next === null) {
            divergentRemaining++;
            stdout.write(`            Could not locate the legacy block via heading marker.\n`);
            stdout.write(`            Manual merge required. Compare against:\n`);
            stdout.write(`              snippets/legacy/${t.legacyVendored} (old canonical)\n`);
            stdout.write(`              snippets/${t.currentSnippet}         (new canonical)\n`);
          } else {
            const bak = backupPath(file);
            fs.copyFileSync(file, bak);
            fs.writeFileSync(file, next);
            migrated++;
            stdout.write(`[MIGRATED] Force-replaced drifted block via heading heuristic. Backup: ${bak}\n`);
          }
        } else if (args.apply && !args.migrate) {
          divergentRemaining++;
          stdout.write(`            Re-run with --migrate to force-replace via heading heuristic, or merge manually.\n`);
          stdout.write(`            Compare against:\n`);
          stdout.write(`              snippets/legacy/${t.legacyVendored} (old canonical)\n`);
          stdout.write(`              snippets/${t.currentSnippet}         (new canonical)\n`);
        } else {
          divergentRemaining++;
          stdout.write(`            Manual merge required. Compare against:\n`);
          stdout.write(`              snippets/legacy/${t.legacyVendored} (old canonical)\n`);
          stdout.write(`              snippets/${t.currentSnippet}         (new canonical)\n`);
        }
      }
    }
  }

  stdout.write(`\n=== snippets-doctor summary ===\n`);
  stdout.write(`Checked: ${total} file(s)\n`);
  stdout.write(`With legacy markers: ${withMarkers}\n`);
  stdout.write(`Byte-identical legacy block: ${exactMatches}\n`);
  stdout.write(`Divergent: ${divergent}\n`);
  if (args.apply) {
    stdout.write(`Replaced (byte-identical): ${replaced}\n`);
    if (args.migrate) stdout.write(`Migrated (heuristic force-replace): ${migrated}\n`);
  }
  return divergentRemaining > 0 ? 2 : 0;
}

module.exports = {
  TARGETS,
  detectLegacyMarkers,
  matchesLegacyBlockExactly,
  replaceLegacyBlock,
  replaceDriftedBlock,
  auditFile,
  classifyFile,
  findCandidateFiles,
  backupPath,
  parseArgs,
  runCli,
  readVendored,
  readCurrent,
  extractInsertBody,
  formatBytes,
  computeSimpleDiff,
  makeFileId,
  collectStatus,
  applyActions,
  applySelected,
};

if (require.main === module) {
  const code = runCli(process.argv.slice(2));
  process.exit(code);
}
