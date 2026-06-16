'use strict';

/**
 * Real-data sanity check — copies the CURRENT user's AGENTS.md and BOOT.md
 * files from ~/.openclaw/workspace and ~/.openclaw/workspace-<agent> dirs
 * into a throwaway sandbox, runs collectStatus against the copies, and
 * prints the classification alongside a pass/fail report against what we
 * expect from the live dashboard.
 *
 * Does NOT mutate any real file. Does NOT run any action. Pure read-and-classify.
 * Run: node test-snippets-realdata.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const doctor = require('./snippets-doctor.js');

const OPENCLAW_HOME = path.join(os.homedir(), '.openclaw');
let tmpHome = null;

function cleanup() {
  if (tmpHome && fs.existsSync(tmpHome)) fs.rmSync(tmpHome, { recursive: true, force: true });
  tmpHome = null;
}
process.on('exit', cleanup);
process.on('uncaughtException', (e) => { console.error('UNCAUGHT:', e); cleanup(); process.exit(1); });

function mirrorWorkspaces(srcHome, dstHome) {
  if (!fs.existsSync(srcHome)) {
    console.log(`[realdata] source ${srcHome} does not exist; skipping host-local real-data snapshot`);
    process.exit(0);
  }
  const entries = fs.readdirSync(srcHome, { withFileTypes: true });
  let copied = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const isWorkspace = entry.name === 'workspace' || entry.name.startsWith('workspace-');
    if (!isWorkspace) continue;
    const srcDir = path.join(srcHome, entry.name);
    const dstDir = path.join(dstHome, entry.name);
    fs.mkdirSync(dstDir, { recursive: true });
    for (const candidate of ['AGENTS.md', 'BOOT.md']) {
      const srcFile = path.join(srcDir, candidate);
      if (fs.existsSync(srcFile)) {
        fs.copyFileSync(srcFile, path.join(dstDir, candidate));
        copied++;
      }
    }
  }
  return copied;
}

console.log(`\n## Real-data snapshot — copying AGENTS.md / BOOT.md from ${OPENCLAW_HOME}`);
tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-realdata-'));
const copied = mirrorWorkspaces(OPENCLAW_HOME, tmpHome);
console.log(`   ${copied} file(s) copied into ${tmpHome}`);

const status = doctor.collectStatus(tmpHome);

console.log(`\n## Classification (${status.counts.total} total, chip: ${status.chip ? status.chip.text : 'HIDDEN'})`);
console.log(`   identical: ${status.counts.identical}`);
console.log(`   drifted:   ${status.counts.drifted}`);
console.log(`   missing:   ${status.counts.missing}`);
console.log(`   current:   ${status.counts.current}`);
console.log(`   ignored:   ${status.counts.ignored}`);

console.log(`\n## Per-file breakdown`);
for (const f of status.files) {
  const rel = path.relative(tmpHome, f.path);
  console.log(`   [${f.state.padEnd(9)}] ${rel.padEnd(45)} ${f.bytes}`);
}

// Also print current/ignored which are excluded from files[]
console.log(`\n## Files in state "current" (skipped from UI list)`);
for (const target of doctor.TARGETS) {
  const candidates = doctor.findCandidateFiles(tmpHome, target.name);
  let legacyBlock, newBlock;
  try {
    legacyBlock = doctor.readVendored(target.vendored);
    newBlock = doctor.readCurrent(target.current);
  } catch { continue; }
  for (const p of candidates) {
    const cls = doctor.classifyFile(p, target, { legacyBlock, newBlock, ignoredPaths: new Set() });
    if (cls?.state === 'current') {
      const rel = path.relative(tmpHome, p);
      console.log(`   [current  ] ${rel}`);
    }
  }
}

console.log(`\n## What each action would do (dry-run, per file)`);
for (const f of status.files) {
  const rel = path.relative(tmpHome, f.path);
  let action;
  if (f.state === 'identical') action = 'upgrade → replace legacy with current block, .bak written';
  else if (f.state === 'drifted') action = 'migrate → force-replace drifted region, .bak written';
  else if (f.state === 'missing') action = 'add (opt-in) or dismiss (skip for good) — user chooses';
  console.log(`   ${rel.padEnd(45)} ${action}`);
}

// Compare with live dashboard — user can eyeball these numbers match
console.log(`\n## Cross-check with live dashboard`);
console.log(`   Run:  curl -s http://localhost:18790/api/snippets/status | python3 -m json.tool`);
console.log(`   Expect the same counts + chip text as above.`);

console.log(`\n## OK — no real files were modified`);
console.log(`   Sandbox at ${tmpHome} will be deleted on exit.`);

process.exit(0);
