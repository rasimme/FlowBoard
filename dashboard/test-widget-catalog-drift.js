'use strict';

/**
 * Drift test for the human widget catalog (extends the drift-test family).
 *
 * Invariant: every widget type in the trusted registry (overview.WIDGET_TYPES)
 * is listed in the user-facing catalog docs/guide/reference/widget-catalog.md
 * (matched on the backticked `type` key). A new widget can't ship without a
 * catalog entry. Complements test-overview-registry-drift.js, which keeps the
 * server catalog, the frontend registry, and the agent rule doc in lockstep.
 *
 * Run: node test-widget-catalog-drift.js
 */

const fs = require('fs');
const path = require('path');
const overview = require('./overview.js');

const CATALOG_PATH = path.resolve(__dirname, '..', 'docs', 'guide', 'reference', 'widget-catalog.md');

let passed = 0;
let failed = 0;
function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✅ ${msg}`); }
  else           { failed++; console.error(`  ❌ ${msg}`); }
}

const text = fs.readFileSync(CATALOG_PATH, 'utf8');
const types = Object.keys(overview.WIDGET_TYPES).sort();

assert(types.length >= 7, `registry exposes ${types.length} widget types`);
for (const t of types) {
  assert(text.includes('`' + t + '`'), `widget-catalog.md lists \`${t}\``);
}

console.log(`\n${failed ? '❌' : '✅'} widget catalog drift: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
