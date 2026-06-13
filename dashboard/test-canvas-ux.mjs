/**
 * Unit tests for the canvas UX helpers (T-345-5): Escape precedence, the
 * delete-snapshot builder, the undo connection id-remap, and the restoreNotes
 * mutation (mocked fetch — DOM-less).
 *
 * Run: node test-canvas-ux.mjs
 */

import {
  escapePrecedence, buildDeleteSnapshot, remapRestoredConnections,
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
section('escapePrecedence — connection > sidebar > selection > nothing');

{
  ok(escapePrecedence({ hasSelectedConnection: true, sidebarNoteId: 'n1', selectionCount: 3 })
    === 'close-connection', 'connection overlay wins over everything');
  ok(escapePrecedence({ hasSelectedConnection: false, sidebarNoteId: 'n1', selectionCount: 3 })
    === 'close-sidebar', 'sidebar wins over selection when no connection');
  ok(escapePrecedence({ hasSelectedConnection: false, sidebarNoteId: null, selectionCount: 3 })
    === 'clear-selection', 'selection cleared when nothing else open');
  ok(escapePrecedence({ hasSelectedConnection: false, sidebarNoteId: null, selectionCount: 0 })
    === null, 'nothing to do → null (event bubbles)');
  ok(escapePrecedence({}) === null, 'empty/undefined args → null');
  ok(escapePrecedence() === null, 'no args → null (no throw)');
  // Precedence is strict: each higher level masks all lower ones.
  ok(escapePrecedence({ hasSelectedConnection: true, sidebarNoteId: null, selectionCount: 0 })
    === 'close-connection', 'connection alone → close-connection');
  ok(escapePrecedence({ hasSelectedConnection: false, sidebarNoteId: 'n9', selectionCount: 0 })
    === 'close-sidebar', 'sidebar alone → close-sidebar');
}

// =============================================================================
section('buildDeleteSnapshot — captures notes + touching connections');

{
  const notes = [
    { id: 'a', text: 'A', x: 10.4, y: 20.6, color: 'red', size: 'large' },
    { id: 'b', text: 'B', x: 100, y: 200, color: 'blue' },
    { id: 'c', text: '', x: 5, y: 5 },
  ];
  const connections = [
    { from: 'a', to: 'b', fromPort: 'right', toPort: 'left' },
    { from: 'b', to: 'c' },
    { from: 'c', to: 'a' }, // touches a (deleted) and c (kept)
  ];

  const snap = buildDeleteSnapshot(notes, connections, ['a']);
  ok(snap.notes.length === 1 && snap.notes[0].oldId === 'a', 'snapshot keeps only the deleted note(s)');
  ok(snap.notes[0].x === 10 && snap.notes[0].y === 21, 'positions are rounded for re-POST');
  ok(snap.notes[0].color === 'red' && snap.notes[0].size === 'large', 'color + size preserved');

  const snapC = buildDeleteSnapshot(notes, connections, ['c']);
  ok(snapC.notes[0].text === '' && snapC.notes[0].color === 'grey' && snapC.notes[0].size === 'small',
    'missing text/color/size default to ""/grey/small');

  ok(snap.connections.length === 2, 'captures every connection touching a deleted note (a-b and c-a)');
  ok(snap.connections.some(c => c.from === 'a' && c.to === 'b' && c.fromPort === 'right'),
    'connection ports are preserved in the snapshot');
  ok(!snap.connections.some(c => c.from === 'b' && c.to === 'c'),
    'connections between two kept notes are NOT captured');

  // Multi-delete (Set input)
  const snap2 = buildDeleteSnapshot(notes, connections, new Set(['a', 'b']));
  ok(snap2.notes.length === 2, 'accepts a Set of ids');
  ok(snap2.connections.length === 3, 'all three connections touch a or b');
}

// =============================================================================
section('remapRestoredConnections — old→new id remap, drops unmappable');

{
  const conns = [
    { from: 'a', to: 'b', fromPort: 'right', toPort: 'left' },
    { from: 'b', to: 'c' },          // c not in map → dropped
    { from: 'a', to: 'a' },          // self → dropped (defensive)
  ];
  const idMap = new Map([['a', 'n10'], ['b', 'n11']]);

  const out = remapRestoredConnections(conns, idMap);
  ok(out.length === 1, 'only fully-mappable, non-self connections survive');
  ok(out[0].from === 'n10' && out[0].to === 'n11', 'endpoints remapped to new ids');
  ok(out[0].fromPort === 'right' && out[0].toPort === 'left', 'ports carried through');

  // Plain-object map also works
  const out2 = remapRestoredConnections([{ from: 'a', to: 'b' }], { a: 'x', b: 'y' });
  ok(out2.length === 1 && out2[0].from === 'x' && out2[0].to === 'y', 'accepts a plain-object id map');
  ok(out2[0].fromPort === null && out2[0].toPort === null, 'missing ports normalize to null');

  ok(remapRestoredConnections(null, idMap).length === 0, 'null connections → []');
  ok(remapRestoredConnections(conns, null).length === 0, 'null idMap → []');
}

// =============================================================================
section('restoreNotes — re-POST + remapped connections (mocked fetch)');

{
  // DOM-less fetch mock: POST notes returns sequential ids; POST connections
  // records the call. PUT/other are no-ops.
  const calls = { noteBodies: [], connBodies: [] };
  let seq = 100;
  globalThis.window = {}; // canvasMutations.toast guards on window.showToast
  globalThis.fetch = async (url, opts) => {
    const body = opts?.body ? JSON.parse(opts.body) : {};
    if (url.endsWith('/canvas/notes') && opts.method === 'POST') {
      calls.noteBodies.push(body);
      const id = 'r' + (seq++);
      return { ok: true, json: async () => ({ ok: true, note: { id, ...body } }) };
    }
    if (url.endsWith('/canvas/connections') && opts.method === 'POST') {
      calls.connBodies.push(body);
      return { ok: true, json: async () => ({ ok: true }) };
    }
    return { ok: true, json: async () => ({ ok: true }) };
  };

  const { restoreNotes } = await import('./src/state/canvasMutations.mjs');

  const dispatched = [];
  const dispatch = (a) => dispatched.push(a);
  const snapshot = {
    notes: [
      { oldId: 'a', text: 'A', x: 10, y: 20, color: 'red', size: 'large' },
      { oldId: 'b', text: 'B', x: 30, y: 40, color: 'blue', size: 'small' },
    ],
    connections: [
      { from: 'a', to: 'b', fromPort: 'right', toPort: 'left' },
      { from: 'a', to: 'ghost' }, // endpoint not restored → must be dropped
    ],
  };

  const idMap = await restoreNotes('proj', dispatch, snapshot);
  ok(idMap.get('a') === 'r100' && idMap.get('b') === 'r101', 'returns old→new id map from re-created notes');
  ok(calls.noteBodies.length === 2, 're-POSTs every buffered note');
  ok(calls.noteBodies[0].text === 'A' && calls.noteBodies[0].x === 10 && calls.noteBodies[0].color === 'red',
    'note body carries buffered content/position/color');
  ok(calls.connBodies.length === 1, 'only the fully-restorable connection is re-created (ghost dropped)');
  ok(calls.connBodies[0].from === 'r100' && calls.connBodies[0].to === 'r101',
    'restored connection uses the new ids');
  ok(dispatched.filter(a => a.type === 'note-created').length === 2,
    'dispatches note-created for each restored note');

  const empty = await restoreNotes(null, dispatch, snapshot);
  ok(empty.size === 0, 'no project → empty map, no calls');

  delete globalThis.fetch;
  delete globalThis.window;
}

// =============================================================================
console.log(`\n${'='.repeat(60)}`);
console.log(`Canvas UX helpers: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('All canvas UX helper tests passed ✅');
