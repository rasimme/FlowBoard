'use strict';

/**
 * Mechanical drift test for the ADR index (extends the T-197-8 drift-test family).
 *
 * Invariant: every Architecture Decision Record file docs/adr/NNNN-*.md is
 * cross-referenced consistently with its status:
 *   - Accepted / Superseded ADRs MUST be linked from BOTH the ADR index
 *     (docs/adr/README.md) AND the agent-facing index (llms.txt).
 *   - Draft ADRs MUST NOT be linked from either (per the "Accepted ADRs only"
 *     rule stated as a comment in both files).
 *
 * Catches the failure mode where a new ADR ships as a file but is never added
 * to the index / llms.txt, so the index silently lags reality.
 *
 * Run: node test-adr-index-drift.js
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT  = path.resolve(__dirname, '..');
const ADR_DIR    = path.join(REPO_ROOT, 'docs', 'adr');
const INDEX_PATH = path.join(ADR_DIR, 'README.md');
const LLMS_PATH  = path.join(REPO_ROOT, 'llms.txt');

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✅ ${msg}`); }
  else           { failed++; console.error(`  ❌ ${msg}`); }
}

function section(name) { console.log(`\n## ${name}`); }

// First non-empty content line inside the "## Status" section.
function readStatus(body) {
  const lines = body.split(/\r?\n/);
  const i = lines.findIndex(l => /^##\s+Status\s*$/i.test(l));
  if (i === -1) return '';
  for (let j = i + 1; j < lines.length; j++) {
    if (/^##\s/.test(lines[j])) break; // next heading → status section ended
    const t = lines[j].trim();
    if (t) return t;
  }
  return '';
}

section('ADR index ↔ files drift');

const adrFiles = fs.readdirSync(ADR_DIR)
  .filter(f => /^\d{4}-.*\.md$/.test(f))
  .sort();

assert(adrFiles.length > 0, `found ${adrFiles.length} ADR files in docs/adr/`);

const indexText = fs.readFileSync(INDEX_PATH, 'utf8');
const llmsText  = fs.readFileSync(LLMS_PATH, 'utf8');

for (const file of adrFiles) {
  const status  = readStatus(fs.readFileSync(path.join(ADR_DIR, file), 'utf8'));
  const isDraft = /^draft\b/i.test(status);
  const inIndex = indexText.includes(file);
  const inLlms  = llmsText.includes(file);

  if (isDraft) {
    assert(!inIndex && !inLlms,
      `${file} is Draft → must NOT be linked (index:${inIndex} llms:${inLlms})`);
  } else {
    assert(inIndex, `${file} (${status || 'no-status'}) must be linked in docs/adr/README.md`);
    assert(inLlms,  `${file} (${status || 'no-status'}) must be linked in llms.txt`);
  }
}

console.log(`\n${failed ? '❌' : '✅'} ADR index drift: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
