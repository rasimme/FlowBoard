/**
 * T-392 — context-index ordering: pinned files first, then most-recently-edited
 * (modifiedMs desc), then name. Pure helper so it's unit-testable.
 * Run: node test-context-sort.mjs
 */
import assert from 'node:assert/strict';
import { sortContextFiles } from './src/utils/contextSort.js';

let pass = 0, fail = 0; const failures = [];
function ok(c, m) { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; failures.push(m); console.log(`  ❌ ${m}`); } }
const names = arr => arr.map(f => f.name).join(',');

const files = [
  { name: 'old.md', modifiedMs: 100 },
  { name: 'newest.md', modifiedMs: 300 },
  { name: 'mid.md', modifiedMs: 200 },
];

ok(names(sortContextFiles(files, [])) === 'newest.md,mid.md,old.md',
   'no pins → most recently edited first');

ok(names(sortContextFiles(files, ['old.md'])) === 'old.md,newest.md,mid.md',
   'a pinned file floats to the top, the rest stay recency-ordered');

// tie on modifiedMs → name ascending
ok(names(sortContextFiles([{ name: 'b.md', modifiedMs: 100 }, { name: 'a.md', modifiedMs: 100 }], [])) === 'a.md,b.md',
   'equal mtime → name ascending tiebreak');

// missing modifiedMs sorts oldest (bottom)
ok(names(sortContextFiles([{ name: 'x.md' }, { name: 'y.md', modifiedMs: 50 }], [])) === 'y.md,x.md',
   'missing modifiedMs is treated as oldest');

// does not mutate input
const input = [{ name: 'a.md', modifiedMs: 1 }, { name: 'b.md', modifiedMs: 2 }];
sortContextFiles(input, []);
ok(input[0].name === 'a.md', 'input array is not mutated');

if (fail === 0) console.log(`\n✅ All ${pass} checks passed`);
else { console.log(`\n❌ ${fail} failed, ${pass} passed`); failures.forEach(f => console.log(`  - ${f}`)); }
process.exit(fail > 0 ? 1 : 0);
