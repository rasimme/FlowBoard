'use strict';

/**
 * Mechanical drift test for the concepts index / Coverage Matrix
 * (extends the T-197-8 drift-test family; sibling of test-adr-index-drift.js).
 *
 * Invariants for docs/concepts/README.md (the concept list + Coverage Matrix):
 *   1. Link integrity — every local `(*.md)` link in README.md resolves to an
 *      existing file in docs/concepts/. Catches renamed/deleted concept docs
 *      whose matrix row or list entry still points at the old path.
 *   2. Concept coverage — every docs/concepts/*.md (except README.md) is linked
 *      at least once from README.md, so a new concept doc cannot ship unlisted.
 *
 * Surface-level completeness ("every shipped subsystem has a matrix row") is a
 * process obligation (the documentation decision tree), not asserted here —
 * "surface" is not mechanically derivable without false positives.
 *
 * Run: node test-concepts-index-drift.js
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT    = path.resolve(__dirname, '..');
const CONCEPTS_DIR = path.join(REPO_ROOT, 'docs', 'concepts');
const INDEX_PATH   = path.join(CONCEPTS_DIR, 'README.md');

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✅ ${msg}`); }
  else           { failed++; console.error(`  ❌ ${msg}`); }
}

function section(name) { console.log(`\n## ${name}`); }

const indexText = fs.readFileSync(INDEX_PATH, 'utf8');

section('Concept link integrity');
// Same-directory markdown link targets, e.g. `](lazy-loading.md)`.
// Links with a slash (../adr/, ../reference/...) are out of scope here.
const targets = [...new Set(
  [...indexText.matchAll(/\]\(([A-Za-z0-9._-]+\.md)\)/g)].map(m => m[1])
)];
assert(targets.length > 0, `found ${targets.length} local .md links in concepts/README.md`);
for (const t of targets) {
  assert(fs.existsSync(path.join(CONCEPTS_DIR, t)), `link target resolves: ${t}`);
}

section('Concept coverage');
const conceptFiles = fs.readdirSync(CONCEPTS_DIR)
  .filter(f => f.endsWith('.md') && f !== 'README.md')
  .sort();
assert(conceptFiles.length > 0, `found ${conceptFiles.length} concept docs`);
for (const f of conceptFiles) {
  assert(indexText.includes(`(${f})`), `${f} is linked from concepts/README.md`);
}

console.log(`\n${failed ? '❌' : '✅'} concepts index drift: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
