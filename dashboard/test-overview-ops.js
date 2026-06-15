'use strict';

// T-365-2 — incremental patch-ops authoring.
// applyOps refines an existing grid overview with small, coordinate-free
// operations (add/remove/resize/reorder) instead of rewriting the whole
// layout, then re-packs to a clean valid grid via packFlow.

const { applyOps, validateOverview, presetConfig } = require('./overview.js');

let pass = 0;
let fail = 0;
const failures = [];

function ok(condition, message) {
  if (condition) {
    pass++;
    console.log(`  ok - ${message}`);
  } else {
    fail++;
    failures.push(message);
    console.log(`  not ok - ${message}`);
  }
}

function section(name, fn) {
  try {
    fn();
  } catch (e) {
    fail++;
    failures.push(`${name}: ${e.message}`);
    console.log(`  not ok - ${name}: ${e.message}`);
  }
}

console.log('# Overview patch-ops (T-365-2)');

// A small starting grid config (two widgets) used as the base for most cases.
function base() {
  return {
    version: 1,
    layout: 'grid',
    widgets: [
      { id: 'stats', type: 'task-stats', grid: { x: 0, y: 0, w: 6, h: 2 } },
      { id: 'notes', type: 'notes', grid: { x: 6, y: 0, w: 4, h: 2 } },
    ],
  };
}

// add — appends a widget and re-packs into a valid grid.
section('add appends and packs', () => {
  const cfg = applyOps(base(), [{ op: 'add', type: 'blocked', size: 'm' }]);
  ok(cfg.layout === 'grid' && cfg.widgets.length === 3, 'add grows the widget list to 3');
  ok(cfg.widgets[2].type === 'blocked', 'the new widget is appended last');
  ok(typeof cfg.widgets[2].id === 'string' && cfg.widgets[2].id.length > 0, 'add auto-generates an id');
  ok(validateOverview(cfg).ok === true, 'config after add validates');
});

// add with an explicit id is honored.
section('add honors an explicit id', () => {
  const cfg = applyOps(base(), [{ op: 'add', type: 'links', id: 'my-links' }]);
  ok(cfg.widgets.some(w => w.id === 'my-links' && w.type === 'links'), 'explicit id is preserved');
});

// remove — drops the named widget.
section('remove drops a widget', () => {
  const cfg = applyOps(base(), [{ op: 'remove', id: 'notes' }]);
  ok(cfg.widgets.length === 1 && cfg.widgets[0].id === 'stats', 'remove leaves only the other widget');
  ok(validateOverview(cfg).ok === true, 'config after remove validates');
});

// resize — changes the width bucket of an existing widget.
section('resize changes the width bucket', () => {
  const cfg = applyOps(base(), [{ op: 'resize', id: 'notes', size: 'full' }]);
  const w = cfg.widgets.find(x => x.id === 'notes');
  ok(w && w.grid.w === 12, 'resize to full sets width to 12 columns');
  ok(validateOverview(cfg).ok === true, 'config after resize validates');
});

// reorder — moves a widget to a new position in reading order.
section('reorder changes the order', () => {
  const cfg = applyOps(base(), [{ op: 'reorder', id: 'notes', toIndex: 0 }]);
  ok(cfg.widgets[0].id === 'notes' && cfg.widgets[1].id === 'stats', 'reorder moves notes to the front');
  ok(validateOverview(cfg).ok === true, 'config after reorder validates');
});

// reorder clamps an out-of-range index to the bounds.
section('reorder clamps the index', () => {
  const cfg = applyOps(base(), [{ op: 'reorder', id: 'stats', toIndex: 99 }]);
  ok(cfg.widgets[cfg.widgets.length - 1].id === 'stats', 'an over-large toIndex clamps to the end');
});

// ops apply in order, composing into the final layout.
section('ops compose in order', () => {
  const cfg = applyOps(base(), [
    { op: 'add', type: 'blocked', id: 'b' },
    { op: 'remove', id: 'stats' },
    { op: 'reorder', id: 'b', toIndex: 0 },
  ]);
  ok(cfg.widgets.length === 2, 'add then remove nets to 2 widgets');
  ok(cfg.widgets[0].id === 'b', 'the reorder applies to the post-add/remove list');
  ok(validateOverview(cfg).ok === true, 'composed config validates');
});

// Unknown id — the error message must include the offending op index.
section('unknown id errors with the op index', () => {
  let msg = '';
  try {
    applyOps(base(), [{ op: 'add', type: 'notes' }, { op: 'remove', id: 'nope' }]);
  } catch (e) {
    msg = e.message;
  }
  ok(msg.includes('ops[1]') && msg.includes('nope'), `error names ops[1] and the bad id (got: ${msg})`);
});

// Unknown op — rejected.
section('unknown op errors', () => {
  let msg = '';
  try {
    applyOps(base(), [{ op: 'frobnicate', id: 'stats' }]);
  } catch (e) {
    msg = e.message;
  }
  ok(msg.includes('ops[0]') && /unknown op|frobnicate/.test(msg), `error names ops[0] and the bad op (got: ${msg})`);
});

// add without a type — rejected.
section('add without type errors', () => {
  let msg = '';
  try {
    applyOps(base(), [{ op: 'add' }]);
  } catch (e) {
    msg = e.message;
  }
  ok(msg.includes('ops[0]'), `add without type names ops[0] (got: ${msg})`);
});

// No partial application — a failing op in the middle leaves nothing committed.
// (applyOps returns a fresh config; the base must be untouched and the throw
// must happen before any write — verified by the base object being unchanged.)
section('failure does not partially apply', () => {
  const cfg = base();
  const before = JSON.stringify(cfg);
  let threw = false;
  try {
    applyOps(cfg, [{ op: 'remove', id: 'stats' }, { op: 'resize', id: 'ghost', size: 'l' }]);
  } catch {
    threw = true;
  }
  ok(threw, 'a bad op in the batch throws');
  ok(JSON.stringify(cfg) === before, 'the input config is not mutated on failure');
});

// H1 regression: an op must refine a real layout, not silently rewrite the
// sizes of widgets it never touched. Start from a varied preset so widths and
// heights are NOT all on flow buckets.
section('reorder preserves untouched widget sizes (H1)', () => {
  const baseCfg = presetConfig('coding');
  const before = baseCfg.widgets.map(w => ({ id: w.id, w: w.grid.w, h: w.grid.h }));
  const out = applyOps(baseCfg, [{ op: 'reorder', id: 'w-ci', toIndex: 0 }]);
  let preserved = true;
  for (const b of before) {
    const a = out.widgets.find(x => x.id === b.id);
    if (!a || a.grid.w !== b.w || a.grid.h !== b.h) preserved = false;
  }
  ok(preserved, 'a reorder keeps every widget\'s exact width and height');
  ok(out.widgets[0].id === 'w-ci', 'the reorder still moved the target to the front');
  ok(validateOverview(out).ok === true, 'the result still validates');
});

section('resize changes only the target width and keeps heights (H1)', () => {
  const baseCfg = presetConfig('default');
  const before = baseCfg.widgets.map(w => ({ id: w.id, w: w.grid.w, h: w.grid.h }));
  const out = applyOps(baseCfg, [{ op: 'resize', id: 'w-timeline', size: 's' }]);
  const target = out.widgets.find(x => x.id === 'w-timeline');
  ok(target.grid.w === 3, 'the resized widget gets the new width (s -> 3)');
  ok(target.grid.h === before.find(b => b.id === 'w-timeline').h, 'the resized widget keeps its height');
  let othersIntact = true;
  for (const b of before) {
    if (b.id === 'w-timeline') continue;
    const a = out.widgets.find(x => x.id === b.id);
    if (!a || a.grid.w !== b.w || a.grid.h !== b.h) othersIntact = false;
  }
  ok(othersIntact, 'every other widget keeps its exact width and height');
});

// M2: the returned config must not share nested props references with the input.
section('output does not share props references with the input (M2)', () => {
  const input = { version: 1, layout: 'grid', widgets: [
    { id: 'lnk', type: 'links', props: { links: [{ label: 'x', url: 'https://e.x' }] }, grid: { x: 0, y: 0, w: 3, h: 2 } },
  ] };
  const out = applyOps(input, [{ op: 'reorder', id: 'lnk', toIndex: 0 }]);
  ok(out.widgets[0].props !== input.widgets[0].props, 'props is a distinct object, not a shared reference');
  out.widgets[0].props.links.push({ label: 'y', url: 'https://e.y' });
  ok(input.widgets[0].props.links.length === 1, 'mutating the output props does not affect the input');
});

if (fail === 0) {
  console.log(`\n✅ All ${pass} checks passed`);
} else {
  console.log(`\n❌ ${fail} failed, ${pass} passed`);
  failures.forEach(f => console.log(`  - ${f}`));
}
process.exit(fail > 0 ? 1 : 0);
