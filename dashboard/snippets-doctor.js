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
const childProcess = require('child_process');

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
  'echo "$OPENCLAW_AGENT_ID"',
  'Use the live-injected `BOOTSTRAP.md`',
  'regenerated `BOOTSTRAP.md`',
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
    summary: 'Replace shell-introspection identity guidance with API-first status check and lazy context loading',
    addSummary: 'Add the minimal FlowBoard API-first trigger (status check → lazy load)',
    // Phrase unique to the canonical v2 snapshot. Doctor uses this for both
    // drift detection (file has the marker but body no longer byte-matches)
    // and for replaceDriftedBlock's heading anchor.
    legacyFingerprint: [
      'FlowBoard delivers project context automatically',
      'At session start',
      'fetch project context',
      'Fetch individual sections on demand',
    ],
    legacyStructuralMarkers: [
      'echo "$OPENCLAW_AGENT_ID"',
      'FlowBoard delivers project context automatically',
      'At session start',
      'project-context',
    ],
    // staleCurrentFingerprint matches the previous API-first lazy-loading trigger
    // (with local-capable/no-inference contract, but without contextReady
    // verification and without memory ban).
    staleCurrentFingerprint: [
      'Check your status',
      'GET /api/status',
      'activeProject === null',
      'local-capable tool',
      'do not infer state',
    ],
    currentFingerprint: [
      'Check your status',
      'GET /api/status',
      'activeProject === null',
      'local-capable tool',
      'do not infer state',
      'before answering project questions',
      'contextReady === true',
      'fetch project context',
      'do not rely on memory or generic knowledge',
    ],
    currentMarkers: [
      'flowboard-snippet-contract: v3-command-startup-response',
      '<resolved-agentId>',
      'local-capable tool',
      'do not infer state',
      'explicit command wins over passive startup',
      'contextReady === true',
      'fetch project context',
      'do not rely on memory or generic knowledge',
      'maximum 3 attempts total, 500 ms between attempts, then report blocker and stop',
      'never JSON.parse this body',
      '~/.openclaw/workspace',
      '~/.openclaw/workspace-<id>',
      'Do not invent cwd/runtime hybrids',
    ],
  },
];

function containsAny(content, markers) {
  if (!Array.isArray(markers) || markers.length === 0) return false;
  return markers.some(m => content.includes(m));
}

const LEGACY_MEMORY_FLUSH_MARKERS = [
  'Read ACTIVE-PROJECT.md and update SESSION-STATE.md',
  'Update projects/[name]/PROJECT.md "Current Status" section',
  'Read projects/PROJECT-RULES.md and projects/[name]/PROJECT.md',
];

const API_FIRST_MEMORY_FLUSH_MARKERS = [
  'If you need project state, use FlowBoard API-first',
  'GET /api/status?agentId=<agentId>',
  'Do not read or write ACTIVE-PROJECT.md',
];

const TASK_STATE_LEAKAGE_RULES = [
  {
    id: 'operational-heading',
    pattern: /^#{1,6}\s+(current status|key next steps|active focus|aktueller fokus|naechste schritte|nächste schritte|next steps)\b/i,
    recommendation: 'Move current task focus or next work into FlowBoard/HZL tasks. Keep PROJECT.md as stable project knowledge.',
  },
  {
    id: 'task-id-with-status',
    pattern: /\bT-\d+(?:-\d+)?\b.*\b(in-progress|in progress|review|done|blocked|backlog|open|in bearbeitung|erledigt|blockiert)\b/i,
    recommendation: 'Record task status in FlowBoard/HZL, not in PROJECT.md.',
  },
  {
    id: 'task-id-with-next-work',
    pattern: /\bT-\d+(?:-\d+)?\b.*\b(next|naechste|nächste|focus|fokus|implement|umsetzen|angehen)\b/i,
    recommendation: 'Use FlowBoard/HZL tasks for next implementation work.',
  },
  {
    id: 'claim-or-lease',
    pattern: /\b(claimed by|claimed|lease|routed to|assigned to)\b/i,
    recommendation: 'Claims, leases, and routing belong to FlowBoard/HZL task state.',
  },
];

const TASK_STATE_LEAKAGE_ALLOWLIST = [
  'Current work, task status, claims, priorities, and next implementation steps live in FlowBoard/HZL tasks, not in this file.',
  'not authoritative for current task focus',
  'Operational work lives in FlowBoard/HZL tasks',
  'single source of truth for task state',
];

function isAllowedTaskBoundaryLine(line) {
  return TASK_STATE_LEAKAGE_ALLOWLIST.some(phrase => line.includes(phrase));
}

function scanProjectDocumentForTaskLeakage(filePath, content) {
  const findings = [];
  const lines = String(content || '').replace(/\r\n/g, '\n').split('\n');
  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (!trimmed || isAllowedTaskBoundaryLine(trimmed)) return;
    const rule = TASK_STATE_LEAKAGE_RULES.find(r => r.pattern.test(trimmed));
    if (!rule) return;
    findings.push({
      path: filePath,
      line: idx + 1,
      rule: rule.id,
      snippet: trimmed.slice(0, 240),
      recommendation: rule.recommendation,
    });
  });
  return findings;
}

function collectBootstrapDocAdvisories(openclawHome) {
  const projectsDir = path.join(openclawHome, 'projects');
  let entries;
  try { entries = fs.readdirSync(projectsDir, { withFileTypes: true }); }
  catch { return []; }

  const advisories = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const projectMd = path.join(projectsDir, entry.name, 'PROJECT.md');
    let content;
    try { content = fs.readFileSync(projectMd, 'utf8'); }
    catch { continue; }

    const findings = scanProjectDocumentForTaskLeakage(projectMd, content);
    for (const finding of findings) {
      advisories.push({
        id: `${makeFileId(openclawHome, projectMd)}__task-state-leakage__${finding.line}`,
        path: projectMd,
        name: 'PROJECT.md',
        state: 'task-state-leakage',
        project: entry.name,
        line: finding.line,
        rule: finding.rule,
        snippet: finding.snippet,
        summary: `Possible task-state leakage in ${entry.name}/PROJECT.md:${finding.line} (${finding.rule}). ${finding.recommendation}`,
        recommendation: finding.recommendation,
        variant: 'warn',
      });
    }
  }
  return advisories;
}

function parsePsLstart(value) {
  if (!value || typeof value !== 'string') return null;
  const ts = Date.parse(value.trim());
  return Number.isNaN(ts) ? null : new Date(ts);
}

function readGatewayProcesses({ processRows } = {}) {
  if (Array.isArray(processRows)) return processRows;
  try {
    const out = childProcess.execFileSync('ps', ['-axo', 'pid,lstart,command'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split(/\r?\n/).slice(1).map(line => {
      const m = line.match(/^\s*(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.+)$/);
      if (!m) return null;
      return { pid: Number(m[1]), startedAt: parsePsLstart(m[2]), command: m[3] };
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function collectConfigAdvisories(openclawHome, options = {}) {
  const advisories = [];
  const configPath = path.join(openclawHome, 'openclaw.json');
  let content;
  let stat;
  try {
    content = fs.readFileSync(configPath, 'utf8');
    stat = fs.statSync(configPath);
  } catch {
    return advisories;
  }

  const hasLegacyMemoryFlush = matchesFingerprint(content, LEGACY_MEMORY_FLUSH_MARKERS, 0.34).meetsThreshold;
  const hasApiFirstMemoryFlush = matchesFingerprint(content, API_FIRST_MEMORY_FLUSH_MARKERS, 0.67).meetsThreshold;

  if (hasLegacyMemoryFlush) {
    advisories.push({
      id: `${makeFileId(openclawHome, configPath)}__legacy-memory-flush`,
      path: configPath,
      name: 'openclaw.json',
      state: 'legacy-config',
      summary: 'openclaw.json still contains the legacy memoryFlush prompt that reads ACTIVE-PROJECT.md / SESSION-STATE.md. Update the OpenClaw config from the current FlowBoard install guidance, then restart OpenClaw.',
      variant: 'warn',
    });
    return advisories;
  }

  if (!hasApiFirstMemoryFlush) return advisories;

  const gatewayProcesses = readGatewayProcesses(options)
    .filter(p => p && p.startedAt && /openclaw/.test(p.command || '') && /\bgateway\b/.test(p.command || ''));
  const stale = gatewayProcesses
    .filter(p => p.startedAt.getTime() < stat.mtime.getTime())
    .sort((a, b) => a.startedAt - b.startedAt)[0];

  if (stale) {
    advisories.push({
      id: `${makeFileId(openclawHome, configPath)}__stale-runtime-config`,
      path: configPath,
      name: 'OpenClaw Gateway',
      state: 'stale-runtime-config',
      summary: 'openclaw.json is API-first, but the running OpenClaw gateway was started before the config file changed. Restart OpenClaw so new sessions and compaction prompts use the migrated memoryFlush config.',
      variant: 'warn',
      pid: stale.pid,
      startedAt: stale.startedAt.toISOString(),
      configMtime: stat.mtime.toISOString(),
    });
  }

  return advisories;
}

// Extract the actual snippet body to INSERT into a user's file. For AGENTS.md
// the whole current file IS the snippet. For BOOT.md the current file wraps
// the snippet in a markdown code fence (```markdown ... ```) — extract the
// content inside the fence.
function extractInsertBody(_target, currentText) {
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

function findSnippetRegion(content, legacyBlock, target) {
  if (typeof content !== 'string') return null;

  if (matchesLegacyBlockExactly(content, legacyBlock)) {
    const start = content.indexOf(legacyBlock);
    return { start, end: start + legacyBlock.length, text: legacyBlock };
  }

  const markerCandidates = [
    ...(target.currentMarkers || []),
    ...(target.staleCurrentFingerprint || []),
    ...(target.legacyStructuralMarkers || []),
    ...(target.legacyFingerprint || []),
  ];
  const marker = markerCandidates.find(m => content.includes(m));
  if (!marker) return null;

  const lines = content.split('\n');
  const markerIdx = lines.findIndex(l => l.includes(marker));
  if (markerIdx < 0) return null;

  let blockStart = markerIdx;
  for (let i = markerIdx; i >= 0; i--) {
    if (/^##?\s/.test(lines[i])) { blockStart = i; break; }
    if (i === 0) blockStart = 0;
  }

  const legacyLines = legacyBlock.replace(/\n+$/, '').split('\n').length;
  let blockEnd = Math.min(blockStart + legacyLines, lines.length);
  for (let i = blockStart + 1; i < blockEnd; i++) {
    if (/^##?\s/.test(lines[i])) { blockEnd = i; break; }
  }

  const text = lines.slice(blockStart, blockEnd).join('\n').replace(/\n+$/, '');
  return { text };
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
// Multi-phrase fingerprint matching for robust legacy detection.
// Returns { matched, total, score } where score is matched/total.
function matchesFingerprint(content, phrases, threshold = 0.75) {
  if (!Array.isArray(phrases) || phrases.length === 0) return { matched: 0, total: 0, score: 0 };
  const matched = phrases.filter(p => content.includes(p)).length;
  const score = matched / phrases.length;
  return { matched, total: phrases.length, score, meetsThreshold: score >= threshold };
}

function classifyFile(filePath, target, { legacyBlock, newBlock }) {
  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); }
  catch { return null; }

  // Priority order matters: an exact current block wins over legacy to prevent
  // endless re-flagging after a post-add file still carries a stray legacy
  // reference. But marker-only matches are not enough for "current": a
  // partially edited/stale contract can still contain all critical marker
  // phrases while missing the canonical runtime wording. Treat that as drifted
  // so the migration path can force-replace it safely.
  if (typeof newBlock === 'string' && newBlock.length > 0 && content.includes(newBlock.trimEnd())) {
    return { state: 'current', content, confidence: 1 };
  }
  if (content.includes('flowboard-snippet-contract: v3-command-startup-response')) {
    return { state: 'drifted', content, confidence: 1 };
  }
  const currentMatch = matchesFingerprint(content, target.currentMarkers || target.currentFingerprint, 1.0);
  if (currentMatch.meetsThreshold) {
    return { state: 'drifted', content, confidence: currentMatch.score };
  }

  // Previous-current snippets are intentionally treated as drifted so the
  // migration UI can update them to the newest contract without presenting
  // them as missing/new installs.
  const staleCurrentMatch = matchesFingerprint(content, target.staleCurrentFingerprint, 0.75);
  if (staleCurrentMatch.meetsThreshold) {
    return { state: 'drifted', content, confidence: staleCurrentMatch.score };
  }

  // New: multi-phrase fingerprint for legacy detection
  const legacyFingerprint = target.legacyFingerprint || target.legacyStructuralMarkers;
  const legacyMatch = matchesFingerprint(content, legacyFingerprint, 0.75);
  if (legacyMatch.meetsThreshold) {
    // Check if byte-identical to vendored snapshot
    if (matchesLegacyBlockExactly(content, legacyBlock)) {
      return { state: 'identical', content, confidence: legacyMatch.score };
    }
    return { state: 'drifted', content, confidence: legacyMatch.score };
  }

  return { state: 'missing', content, confidence: 0 };
}

// Aggregate snippet status across all workspace dirs under OPENCLAW_HOME.
// Returns { counts, chip, files: [...] } where files carries per-file metadata
// needed by the dashboard UI (path, name, bytes, state, diff, summary).
//
// States: identical (State A), drifted (State B), missing (State D), current
// (State E — skipped from files list), ignored (dismissed — skipped).
//
// Chip variants: "Migration required" when any legacy remains; "FlowBoard setup"
// when existing AGENTS.md files can be onboarded. Hidden only when there is
// nothing actionable left.
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
        const region = findSnippetRegion(cls.content, legacyBlock, target);
        entry.diff = computeSimpleDiff(region?.text || legacyBlock, newBlock, `@@ ${target.name} — snippet block @@`);
      } else if (cls.state === 'missing') {
        entry.summary = target.addSummary;
        // Preview: what gets added. Use an add-context diff (no legacy lines).
        entry.diff = computeSimpleDiff('', insertBody, `@@ ${target.name} — snippet to insert @@`);
      }
      files.push(entry);
    }
  }

  // BOOT.md Legacy-Erkennung (nur anzeigen, nicht migrieren)
  const bootLegacyFiles = [];
  const bootCandidates = findCandidateFiles(openclawHome, 'BOOT.md');
  for (const filePath of bootCandidates) {
    let content;
    try { content = fs.readFileSync(filePath, 'utf8'); }
    catch { continue; }
    const bootLegacyMatch = matchesFingerprint(content, [
      'Use the live-injected `BOOTSTRAP.md`',
      'Project State Recovery (FlowBoard)',
    ], 0.5);
    if (bootLegacyMatch.meetsThreshold) {
      bootLegacyFiles.push({
        id: makeFileId(openclawHome, filePath),
        path: filePath,
        name: 'BOOT.md',
        state: 'legacy',
        summary: 'BOOT.md contains deprecated FlowBoard content. Clean up manually — this file should be OpenClaw-owned.',
        variant: 'info',
      });
    }
  }

  // Runtime state leftovers from pre-API-first Project Mode. These files are
  // display-only advisories: FlowBoard must not delete user/workspace files
  // automatically, but the dashboard should make stale state visible during
  // upgrades.
  const legacyStateFiles = [];
  for (const name of ['SESSION-STATE.md', 'BOOTSTRAP.md', 'ACTIVE-PROJECT.md']) {
    const candidates = findCandidateFiles(openclawHome, name);
    for (const filePath of candidates) {
      legacyStateFiles.push({
        id: makeFileId(openclawHome, filePath),
        path: filePath,
        name,
        state: 'legacy-state',
        summary: `${name} is legacy project-state residue. FlowBoard now uses /api/status and flowboard_agents; archive or remove this file manually after checking it contains no durable notes.`,
        variant: 'info',
      });
    }
  }

  const configAdvisories = collectConfigAdvisories(openclawHome);
  const bootstrapDocAdvisories = collectBootstrapDocAdvisories(openclawHome);

  let chip = null;
  const hasLegacy = counts.identical > 0 || counts.drifted > 0;
  if (hasLegacy || bootLegacyFiles.length > 0 || legacyStateFiles.length > 0 || configAdvisories.length > 0 || bootstrapDocAdvisories.length > 0) {
    chip = { text: 'Migration required', variant: 'warn' };
  } else if (counts.current === 0 && counts.missing > 0) {
    chip = { text: 'Finish setup', variant: 'info' };
  } else if (counts.current > 0 && counts.missing > 0) {
    chip = { text: 'Optional setup', variant: 'info' };
  }

  return { counts, chip, files, bootLegacyFiles, legacyStateFiles, configAdvisories, bootstrapDocAdvisories };
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
  const region = findSnippetRegion(content, legacyBlock, target);
  if (!region || !region.text) return null;
  return content.replace(region.text, newBlock.trimEnd())
    .replace(/\n*$/, '\n');
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
  let total = 0, exactMatches = 0, divergent = 0, replaced = 0, migrated = 0, missing = 0, added = 0, remaining = 0;

  for (const t of TARGETS) {
    const candidates = findCandidateFiles(baseDir, t.name);
    if (candidates.length === 0) continue;

    let legacyBlock, newBlock;
    try {
      legacyBlock = readVendored(t.vendored);
      newBlock = readCurrent(t.current);
    } catch (err) {
      stderr.write(`[snippets-doctor] Could not read snippets for ${t.name}: ${err.message}\n`);
      continue;
    }

    for (const file of candidates) {
      total++;
      const cls = classifyFile(file, t, { legacyBlock, newBlock });
      if (!cls || cls.state === 'current') continue;

      stdout.write(`\n--- ${file}\n`);
      if (cls.state === 'identical') {
        exactMatches++;
        stdout.write(`[OK] Legacy block is byte-identical to snippets/legacy/${t.vendored}\n`);
        if (args.apply) {
          const result = applyActions(baseDir, [{ id: makeFileId(baseDir, file), action: 'upgrade' }]);
          if (result.applied.length > 0) {
            replaced++;
            stdout.write(`[APPLIED] Replaced legacy block. Backup: ${result.applied[0].backup}\n`);
          } else {
            remaining++;
            stdout.write(`[SKIPPED] ${result.skipped[0]?.reason || 'upgrade was not applied'}\n`);
          }
        } else {
          stdout.write(`[DRY-RUN] Would replace legacy block with current snippets/${t.current}\n`);
          stdout.write(`          Re-run with --apply to write the change (a .bak-<ts> backup will be created).\n`);
        }
      } else if (cls.state === 'drifted') {
        divergent++;
        stdout.write(`[DIVERGENT] FlowBoard snippet is present but differs from current canonical snippet.\n`);
        if (args.apply && args.migrate) {
          const result = applyActions(baseDir, [{ id: makeFileId(baseDir, file), action: 'migrate' }]);
          if (result.applied.length > 0) {
            migrated++;
            stdout.write(`[MIGRATED] Force-replaced drifted block via heading heuristic. Backup: ${result.applied[0].backup}\n`);
          } else {
            remaining++;
            stdout.write(`            ${result.skipped[0]?.reason || 'Could not locate the snippet block via heading marker'}.\n`);
            stdout.write(`            Manual merge required. Compare against:\n`);
            stdout.write(`              snippets/legacy/${t.vendored} (old canonical)\n`);
            stdout.write(`              snippets/${t.current}         (new canonical)\n`);
          }
        } else if (args.apply && !args.migrate) {
          remaining++;
          stdout.write(`            Re-run with --migrate to force-replace via heading heuristic, or merge manually.\n`);
          stdout.write(`            Compare against:\n`);
          stdout.write(`              snippets/legacy/${t.vendored} (old canonical)\n`);
          stdout.write(`              snippets/${t.current}         (new canonical)\n`);
        } else {
          remaining++;
          stdout.write(`            Manual merge required. Compare against:\n`);
          stdout.write(`              snippets/legacy/${t.vendored} (old canonical)\n`);
          stdout.write(`              snippets/${t.current}         (new canonical)\n`);
        }
      } else if (cls.state === 'missing') {
        missing++;
        stdout.write(`[MISSING] No FlowBoard snippet block found.\n`);
        if (args.apply && args.migrate) {
          const result = applyActions(baseDir, [{ id: makeFileId(baseDir, file), action: 'add' }]);
          if (result.applied.length > 0) {
            added++;
            stdout.write(`[ADDED] Appended current snippets/${t.current}. Backup: ${result.applied[0].backup}\n`);
          } else {
            remaining++;
            stdout.write(`[SKIPPED] ${result.skipped[0]?.reason || 'add was not applied'}\n`);
          }
        } else {
          remaining++;
          stdout.write(`            Re-run with --apply --migrate to append current snippets/${t.current}, or merge manually.\n`);
        }
      }
    }
  }

  stdout.write(`\n=== snippets-doctor summary ===\n`);
  stdout.write(`Checked: ${total} file(s)\n`);
  stdout.write(`Byte-identical legacy block: ${exactMatches}\n`);
  stdout.write(`Divergent: ${divergent}\n`);
  stdout.write(`Missing: ${missing}\n`);
  if (args.apply) {
    stdout.write(`Replaced (byte-identical): ${replaced}\n`);
    if (args.migrate) stdout.write(`Migrated (heuristic force-replace): ${migrated}\n`);
    if (args.migrate) stdout.write(`Added: ${added}\n`);
  }
  return remaining > 0 ? 2 : 0;
}

module.exports = {
  TARGETS,
  TASK_STATE_LEAKAGE_RULES,
  detectLegacyMarkers,
  scanProjectDocumentForTaskLeakage,
  collectBootstrapDocAdvisories,
  collectConfigAdvisories,
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
  findSnippetRegion,
  makeFileId,
  collectStatus,
  applyActions,
  applySelected,
};

if (require.main === module) {
  const code = runCli(process.argv.slice(2));
  process.exit(code);
}
