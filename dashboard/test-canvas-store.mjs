/**
 * Unit tests for the CanvasView state store (T-340-2, canvas React migration).
 *
 * Pure reducer + viewport math, extracted behavior-identical from the vanilla
 * canvas (js/canvas/state.js resetCanvasState, js/canvas/events.js wheel/pinch
 * zoom, js/canvas/index.js fitCanvasToNotes).
 *
 * Run: node test-canvas-store.mjs
 */

import { SCALE_MIN, SCALE_MAX } from './src/utils/canvasConstants.mjs';
import {
  initialCanvasState, canvasReducer, clampScale, zoomAt, fitToNotes,
  continueListOnEnter, addNotePosition,
} from './src/state/canvasStore.mjs';

let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, msg) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${msg}`);
  } else {
    fail++;
    failures.push(msg);
    console.log(`  ❌ ${msg}`);
  }
}

function section(title) {
  console.log(`\n## ${title}\n`);
}

// =============================================================================
section('initial state & reducer');

{
  const s0 = initialCanvasState();
  ok(s0.pan.x === 60 && s0.pan.y === 60 && s0.scale === 1, 'default viewport is pan {60,60} scale 1 (vanilla reset)');
  ok(s0.notes.length === 0 && s0.connections.length === 0, 'starts empty');

  const loaded = canvasReducer(s0, {
    type: 'loaded',
    notes: [{ id: 'a', x: 1, y: 2 }],
    connections: [{ from: 'a', to: 'b' }],
  });
  ok(loaded.notes.length === 1 && loaded.connections.length === 1, 'loaded replaces data');
  ok(loaded.error === null && loaded.loading === false, 'loaded clears loading/error');

  const reloaded = canvasReducer(
    { ...loaded, selectedIds: new Set(['a', 'gone']) },
    { type: 'loaded', notes: [{ id: 'a', x: 1, y: 2 }], connections: [] }
  );
  ok(reloaded.selectedIds.has('a') && !reloaded.selectedIds.has('gone'),
    'reload prunes selection of vanished notes (vanilla refreshCanvas after promote)');

  const err = canvasReducer({ ...s0, loading: true }, { type: 'load-error', error: 'boom' });
  ok(err.error === 'boom' && err.notes.length === 0, 'load-error keeps canvas empty (vanilla: empty arrays + toast)');

  const moved = canvasReducer(loaded, { type: 'viewport', pan: { x: -5, y: 9 }, scale: 1.4 });
  ok(moved.pan.x === -5 && moved.scale === 1.4, 'viewport commit stores pan/scale');

  const reset = canvasReducer(moved, { type: 'reset' });
  ok(reset.pan.x === 60 && reset.pan.y === 60 && reset.scale === 1 && reset.notes.length === 0,
    'reset restores default viewport and clears data (project switch)');
}

// =============================================================================
section('clampScale');

ok(clampScale(0.1) === SCALE_MIN, 'clamps below to SCALE_MIN');
ok(clampScale(99) === SCALE_MAX, 'clamps above to SCALE_MAX');
ok(clampScale(1.7) === 1.7, 'passes through in-range values');

// =============================================================================
section('zoomAt — cursor-anchored zoom (vanilla wheel/pinch math)');

{
  const pan = { x: 60, y: 60 };
  const scale = 1;
  const px = 300, py = 200; // cursor position relative to wrap
  const before = { x: (px - pan.x) / scale, y: (py - pan.y) / scale };

  const z = zoomAt(pan, scale, 1.1, px, py);
  const after = { x: (px - z.pan.x) / z.scale, y: (py - z.pan.y) / z.scale };
  ok(Math.abs(before.x - after.x) < 1e-9 && Math.abs(before.y - after.y) < 1e-9,
    'canvas point under cursor stays fixed while zooming in');
  ok(z.scale === clampScale(1.1), 'zoom factor multiplies scale');

  const out = zoomAt(pan, scale, 0.9, px, py);
  const afterOut = { x: (px - out.pan.x) / out.scale, y: (py - out.pan.y) / out.scale };
  ok(Math.abs(before.x - afterOut.x) < 1e-9, 'zoom out keeps anchor too');

  const maxed = zoomAt({ x: 0, y: 0 }, SCALE_MAX, 1.1, 100, 100);
  ok(maxed.scale === SCALE_MAX && maxed.pan.x === 0 && maxed.pan.y === 0,
    'at SCALE_MAX a further zoom-in is a no-op (clamp before pan math)');
}

// =============================================================================
section('fitToNotes — vanilla fitCanvasToNotes math');

{
  const dims = () => ({ w: 160, h: 120 });
  ok(fitToNotes([], dims, 800, 600) === null, 'no notes → no fit (keep current viewport)');

  const one = fitToNotes([{ id: 'a', x: 0, y: 0 }], dims, 800, 600);
  // content bounds 0..160 / 0..120, pad 40 → 240x200 → scale min(800/240, 600/200, 1) = 1
  ok(one.scale === 1, 'small content does not zoom in beyond 1');
  ok(one.pan.x === 800 / 2 - 80 && one.pan.y === 600 / 2 - 60, 'content bounds are centered');

  const wide = fitToNotes([{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 3840, y: 0 }], dims, 800, 600);
  // contentW = 4000 + 80 = 4080 → raw scale 800/4080 ≈ 0.196 → clamped to SCALE_MIN
  ok(wide.scale === SCALE_MIN, 'oversized content clamps to SCALE_MIN');
  ok(wide.pan.x === 800 / 2 - 2000 * SCALE_MIN && wide.pan.y === 600 / 2 - 60 * SCALE_MIN,
    'clamped fit still centers content bounds');

  const fallback = fitToNotes([{ id: 'a', x: 0, y: 0 }], () => null, 800, 600);
  ok(fallback.pan.x === 800 / 2 - 80 && fallback.pan.y === 600 / 2 - 60,
    'missing dims fall back to 160x120 (vanilla offsetWidth fallback)');
}

// =============================================================================
section('note actions (T-340-3)');

{
  const base = canvasReducer(initialCanvasState(), {
    type: 'loaded',
    notes: [{ id: 'a', x: 0, y: 0, text: 'A' }, { id: 'b', x: 10, y: 10, text: 'B' }],
    connections: [{ from: 'a', to: 'b' }],
  });

  const created = canvasReducer(base, { type: 'note-created', note: { id: 'c', x: 5, y: 5, text: '' } });
  ok(created.notes.length === 3, 'note-created appends the note');
  ok(created.selectedIds.size === 1 && created.selectedIds.has('c'),
    'note-created selects only the new note (vanilla createNoteAt)');

  const patched = canvasReducer(base, { type: 'note-patch', id: 'a', patch: { text: 'neu', color: 'red' } });
  ok(patched.notes.find(n => n.id === 'a').text === 'neu' &&
     patched.notes.find(n => n.id === 'a').color === 'red', 'note-patch merges fields');
  ok(patched.notes.find(n => n.id === 'b').text === 'B', 'note-patch leaves other notes alone');

  const sel = canvasReducer(base, { type: 'select-only', id: 'a' });
  ok(sel.selectedIds.size === 1 && sel.selectedIds.has('a'), 'select-only replaces the selection');
  const cleared = canvasReducer(sel, { type: 'clear-selection' });
  ok(cleared.selectedIds.size === 0, 'clear-selection empties the selection');

  const editing = canvasReducer(sel, { type: 'editing', id: 'a' });
  ok(editing.editingId === 'a', 'editing tracks the note id');
  const sidebar = canvasReducer(editing, { type: 'sidebar', id: 'b' });
  ok(sidebar.sidebarNoteId === 'b', 'sidebar tracks the note id');

  const delState = canvasReducer({ ...sel, editingId: 'a', sidebarNoteId: 'a' }, { type: 'note-deleted', id: 'a' });
  ok(delState.notes.length === 1 && delState.notes[0].id === 'b', 'note-deleted removes the note');
  ok(delState.connections.length === 0, 'note-deleted removes attached connections (vanilla confirmDeleteNote)');
  ok(!delState.selectedIds.has('a') && delState.editingId === null && delState.sidebarNoteId === null,
    'note-deleted clears selection/edit/sidebar references');

  const moved = canvasReducer(base, { type: 'notes-moved', positions: { a: { x: 100, y: 200 } } });
  ok(moved.notes.find(n => n.id === 'a').x === 100 && moved.notes.find(n => n.id === 'a').y === 200,
    'notes-moved commits dragged positions');
}

// =============================================================================
section('connection actions (T-340-4)');

{
  const base = canvasReducer(initialCanvasState(), {
    type: 'loaded',
    notes: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 400, y: 0 }],
    connections: [{ from: 'a', to: 'b', fromPort: 'right', toPort: 'left' }],
  });

  const added = canvasReducer(base, {
    type: 'connection-added',
    connection: { from: 'b', to: 'c', fromPort: null, toPort: null },
  });
  ok(added.connections.length === 2, 'connection-added appends');

  const rePorted = canvasReducer(base, {
    type: 'connection-ports', from: 'a', to: 'b', fromPort: 'bottom', toPort: 'bottom',
  });
  ok(rePorted.connections[0].fromPort === 'bottom' && rePorted.connections[0].toPort === 'bottom',
    'connection-ports updates stored ports');

  const reversed = canvasReducer(base, {
    type: 'connection-ports', from: 'b', to: 'a', fromPort: 'top', toPort: 'bottom',
  });
  ok(reversed.connections[0].fromPort === 'bottom' && reversed.connections[0].toPort === 'top',
    'connection-ports maps reversed direction onto the stored edge (vanilla saveConnection)');

  const deleted = canvasReducer(base, { type: 'connection-deleted', from: 'b', to: 'a' });
  ok(deleted.connections.length === 0, 'connection-deleted removes the edge in either direction');
}

// =============================================================================
section('continueListOnEnter — textarea list continuation (vanilla startNoteEdit)');

{
  const cont = continueListOnEnter('- eins', 6);
  ok(cont && cont.value === '- eins\n- ' && cont.selStart === 9, 'bullet line continues with "- "');

  const exit = continueListOnEnter('- eins\n- ', 9);
  ok(exit && exit.value === '- eins\n' && exit.selStart === 7, 'empty bullet exits the list (prefix removed)');

  const num = continueListOnEnter('1. eins', 7);
  ok(num && num.value === '1. eins\n2. ' && num.selStart === 11, 'numbered line continues with incremented number');

  const numExit = continueListOnEnter('1. eins\n2. ', 11);
  ok(numExit && numExit.value === '1. eins\n' && numExit.selStart === 8, 'empty numbered line exits the list');

  ok(continueListOnEnter('plain', 5) === null, 'plain line: no list handling (default Enter)');

  const midline = continueListOnEnter('- ab\nx', 4);
  ok(midline && midline.value === '- ab\n- \nx' && midline.selStart === 7,
    'continuation inserts at the caret, not at line end');
}

// =============================================================================
section('addNotePosition — toolbar "+ Note" placement (vanilla addNote)');

{
  const p0 = addNotePosition(800, 600, { x: 60, y: 60 }, 1, 0);
  ok(p0.x === (400 - 60) / 1 - 80 && p0.y === (300 - 60) / 1 - 40, 'first note lands at visible center');
  const p1 = addNotePosition(800, 600, { x: 60, y: 60 }, 1, 1);
  ok(p1.x === p0.x + 30 && p1.y === p0.y + 30, 'successive notes offset by 30px');
  const p8 = addNotePosition(800, 600, { x: 60, y: 60 }, 1, 8);
  ok(p8.x === p0.x && p8.y === p0.y, 'offset cycles after 8 notes');
  const zoomed = addNotePosition(800, 600, { x: 0, y: 0 }, 2, 0);
  ok(zoomed.x === 200 - 80 && zoomed.y === 150 - 40, 'placement respects zoom scale');
}

// =============================================================================
console.log(`\n${'='.repeat(60)}`);
console.log(`Canvas store tests: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
