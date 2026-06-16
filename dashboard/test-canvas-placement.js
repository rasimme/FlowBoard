'use strict';

// Unit tests for the pure canvas auto-placement helper (T-352).
// No DB, no server — just the slot-picking geometry.

const assert = require('node:assert/strict');
const { autoPlaceNote, NOTE_W, NOTE_H, ORIGIN } = require('./canvas-placement.js');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✅ ${msg}`); }
  else { fail++; failures.push(msg); console.log(`  ❌ ${msg}`); }
}

// AABB overlap with the SAME margin the helper enforces (16) so "no overlap"
// here means "respects the breathing room", not merely "edges don't touch".
const MARGIN = 16;
function overlapsWithMargin(a, b) {
  const ax = a.x - MARGIN, ay = a.y - MARGIN, aw = NOTE_W + 2 * MARGIN, ah = NOTE_H + 2 * MARGIN;
  return ax < b.x + NOTE_W && ax + aw > b.x && ay < b.y + NOTE_H && ay + ah > b.y;
}
function box(x, y) { return { x, y }; }
function noOverlapAgainst(placed, notes) {
  return notes.every(n => !overlapsWithMargin(placed, n));
}

console.log('# canvas auto-placement (T-352)\n');

// 1. Empty canvas → fixed origin.
{
  const p = autoPlaceNote([]);
  ok(p.x === ORIGIN.x && p.y === ORIGIN.y, 'empty canvas → ORIGIN');
  ok(Number.isInteger(p.x) && Number.isInteger(p.y), 'empty canvas → integer coords');
}

// 2. Single existing note → new note never overlaps it.
{
  const notes = [box(60, 60)];
  const p = autoPlaceNote(notes);
  ok(noOverlapAgainst(p, notes), 'single note → placed without overlap');
}

// 3. Dense cluster → still collision-free.
{
  const notes = [];
  for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) {
    notes.push(box(200 + i * (NOTE_W + 32), 200 + j * (NOTE_H + 32)));
  }
  const p = autoPlaceNote(notes);
  ok(noOverlapAgainst(p, notes), 'dense 5×5 cluster → placed without overlap');
  ok(Number.isInteger(p.x) && Number.isInteger(p.y), 'cluster → integer coords');
}

// 4. near: anchor beside a specific note, collision-free, and reasonably close.
{
  const target = box(1000, 1000);
  const notes = [box(60, 60), target, box(400, 400)];
  const p = autoPlaceNote(notes, { near: 'X' }); // 'X' not present → falls back
  ok(noOverlapAgainst(p, notes), 'near (missing id) → falls back, still collision-free');

  const withId = [{ id: 'A', x: 60, y: 60 }, { id: 'T', x: 1000, y: 1000 }];
  const near = autoPlaceNote(withId, { near: 'T' });
  ok(noOverlapAgainst(near, withId), 'near present → collision-free');
  const dist = Math.hypot((near.x) - 1000, (near.y) - 1000);
  ok(dist <= (NOTE_W + 80) * 2, `near present → lands adjacent to target (dist=${Math.round(dist)})`);
}

// 5. Deterministic: same inputs → same slot.
{
  const notes = [box(0, 0), box(300, 0), box(0, 300)];
  const a = autoPlaceNote(notes);
  const b = autoPlaceNote(notes);
  assert.deepEqual(a, b);
  ok(true, 'deterministic: identical inputs → identical slot');
}

// 6. Overlapping anchor (centroid lands inside a note) still escapes outward.
{
  const notes = [box(500, 500)]; // centroid === this note → r=0 overlaps → must escape
  const p = autoPlaceNote(notes);
  ok(noOverlapAgainst(p, notes), 'centroid-on-note → spiral escapes to a free slot');
  ok(!(p.x === 500 && p.y === 500), 'centroid-on-note → not stacked on the existing note');
}

console.log(`\n# results: ${pass} passed, ${fail} failed`);
if (fail > 0) { console.log('# failures:'); failures.forEach(f => console.log(`#   - ${f}`)); process.exitCode = 1; }
