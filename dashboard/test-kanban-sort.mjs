/**
 * T-376 — Kanban column sort. A freshly created task (no manual `order` yet)
 * must appear at the TOP of a custom-sorted column, even when its siblings have
 * been manually ranked. newest/oldest sort purely by task number.
 *
 * Run: node test-kanban-sort.mjs
 */
import assert from 'node:assert/strict';
import { sortTasks } from './src/pages/taskSort.js';

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✅ ${msg}`); }
  else { fail++; failures.push(msg); console.log(`  ❌ ${msg}`); }
}
const ids = arr => arr.map(t => t.id);

// A column where the existing tasks were manually ranked (have `order`) and a
// brand-new task T-300 has no order yet.
const ranked = [
  { id: 'T-010', order: 10 },
  { id: 'T-011', order: 20 },
  { id: 'T-012', order: 30 },
];
const withNew = [...ranked, { id: 'T-300' }]; // T-300 = newest, unranked

// custom: the new unranked task is FIRST; ranked tasks follow in rank order.
{
  const out = sortTasks(withNew, 'custom');
  ok(out[0].id === 'T-300', `custom: new unranked task is at the top (got ${ids(out).join(',')})`);
  ok(ids(out.slice(1)).join(',') === 'T-010,T-011,T-012', 'custom: ranked tasks keep their ascending rank order below');
}

// Two unranked new tasks: newest-first among themselves, both above ranked.
{
  const out = sortTasks([...ranked, { id: 'T-300' }, { id: 'T-301' }], 'custom');
  ok(ids(out).slice(0, 2).join(',') === 'T-301,T-300', 'custom: multiple new tasks stack newest-first at the top');
}

// newest: purely by number, highest first (new task on top — unchanged).
{
  const out = sortTasks(withNew, 'newest');
  ok(out[0].id === 'T-300', 'newest: highest task number on top');
  ok(ids(out).join(',') === 'T-300,T-012,T-011,T-010', 'newest: strict descending by number, ranks ignored');
}

// oldest: purely by number, lowest first (new task at the bottom — unchanged).
{
  const out = sortTasks(withNew, 'oldest');
  ok(out[out.length - 1].id === 'T-300', 'oldest: new (highest number) task at the bottom');
  ok(ids(out).join(',') === 'T-010,T-011,T-012,T-300', 'oldest: strict ascending by number, ranks ignored');
}

// T-379: unranked tasks sort by `enteredStatusAt` (when they entered the column)
// DESC — most recently moved/created on top — NOT by task number. So an OLDER
// task just moved into a column lands above newer ones already sitting there.
{
  const out = sortTasks([
    { id: 'T-050', enteredStatusAt: '2026-06-16T09:00:00.000Z' }, // newer id, entered earlier
    { id: 'T-010', enteredStatusAt: '2026-06-16T10:00:00.000Z' }, // older id, entered just now
  ], 'custom');
  ok(out[0].id === 'T-010', 'custom: most recently entered task is on top, even with a lower id');
  ok(ids(out).join(',') === 'T-010,T-050', 'custom: unranked order follows enteredStatusAt desc, not id');
}

// Fallback: unranked tasks without enteredStatusAt still order newest-id-first.
{
  const out = sortTasks([{ id: 'T-010' }, { id: 'T-050' }], 'custom');
  ok(ids(out).join(',') === 'T-050,T-010', 'custom: no enteredStatusAt → falls back to newest id');
}

// A task WITH a timestamp sorts above one without (a moved task beats a legacy one).
{
  const out = sortTasks([{ id: 'T-099' }, { id: 'T-001', enteredStatusAt: '2026-06-16T08:00:00.000Z' }], 'custom');
  ok(out[0].id === 'T-001', 'custom: a task with enteredStatusAt ranks above one without');
}

if (fail === 0) console.log(`\n✅ All ${pass} checks passed`);
else { console.log(`\n❌ ${fail} failed, ${pass} passed`); failures.forEach(f => console.log(`  - ${f}`)); }
process.exit(fail > 0 ? 1 : 0);
