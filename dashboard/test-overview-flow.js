'use strict';

// T-365 Increment 1 — flow authoring.
// packFlow expands a coordinate-free, ordered widget list (type + coarse size
// hint) into a validated 12-column grid, so an LLM never computes x/y/w/h.

const { packFlow, validateOverview, WIDGET_TYPES } = require('./overview.js');

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

console.log('# Overview flow authoring (T-365)');

// Core packing: a full-width widget fills the top row; the next one wraps below
// it (no horizontal room), positions never overlap, and the result passes the
// existing grid validator unchanged.
section('basic packing', () => {
  const cfg = packFlow([
    { type: 'task-stats', size: 'full' },
    { type: 'notes', size: 'M' },
  ]);
  ok(cfg && cfg.layout === 'grid' && Array.isArray(cfg.widgets) && cfg.widgets.length === 2,
     'packFlow returns a grid config with all widgets');
  const [a, b] = cfg.widgets || [];
  ok(a && a.grid.x === 0 && a.grid.y === 0 && a.grid.w === 12,
     'first widget fills the top row (size:full -> w=12)');
  ok(b && b.grid.x === 0 && b.grid.y === a.grid.h,
     'second widget wraps onto the next row (no room beside a full-width widget)');
  ok(validateOverview(cfg).ok === true,
     'packed config passes the existing validator');
});

// Side-by-side: two half-width widgets share the top row; a third wraps below.
section('side-by-side packing', () => {
  const cfg = packFlow([
    { type: 'blocked', size: 'm' },
    { type: 'approvals', size: 'm' },
    { type: 'notes', size: 'm' },
  ]);
  const [a, b, c] = cfg.widgets;
  ok(a.grid.x === 0 && a.grid.y === 0 && a.grid.w === 6, 'first half-width widget at column 0');
  ok(b.grid.x === 6 && b.grid.y === 0, 'second half-width widget sits beside it (column 6, same row)');
  ok(c.grid.x === 0 && c.grid.y > 0, 'third half-width widget wraps to the next row');
  ok(validateOverview(cfg).ok === true, 'three-widget row config validates');
});

// No size hint: the widget keeps its registry defaultSize (w and h).
section('default size without a hint', () => {
  const cfg = packFlow([{ type: 'task-stats' }]);
  const g = cfg.widgets[0].grid;
  ok(g.w === WIDGET_TYPES['task-stats'].defaultSize.w && g.h === WIDGET_TYPES['task-stats'].defaultSize.h,
     'no size hint -> widget keeps its defaultSize');
});

// props, title and an explicit id survive expansion; missing ids are generated
// uniquely so the output always validates.
section('props, title and id handling', () => {
  const cfg = packFlow([
    { type: 'links', title: 'Deploys', props: { links: [{ label: 'x', url: 'https://e.x' }] }, id: 'my-links' },
    { type: 'notes' },
  ]);
  const [a, b] = cfg.widgets;
  ok(a.id === 'my-links' && a.title === 'Deploys' && a.props && Array.isArray(a.props.links),
     'explicit id, title and props are preserved');
  ok(typeof b.id === 'string' && b.id.length > 0 && b.id !== a.id, 'missing id is generated and unique');
  ok(validateOverview(cfg).ok === true, 'config with props/title/ids validates');
});

// Unknown types do not crash packing — they pass through and the single trusted
// validator rejects them, keeping one validation path.
section('unknown type passes through to the validator', () => {
  const cfg = packFlow([{ type: 'evil-widget', size: 'l' }]);
  ok(cfg.widgets.length === 1 && cfg.widgets[0].grid, 'unknown type is still packed (no crash)');
  const v = validateOverview(cfg);
  ok(v.ok === false && JSON.stringify(v.errors).includes('not a registered widget'),
     'validator rejects the unknown type');
});

if (fail === 0) {
  console.log(`\n✅ All ${pass} checks passed`);
} else {
  console.log(`\n❌ ${fail} failed, ${pass} passed`);
  failures.forEach(f => console.log(`  - ${f}`));
}
process.exit(fail > 0 ? 1 : 0);
