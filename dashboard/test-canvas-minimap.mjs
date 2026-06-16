/**
 * Tests for the canvas minimap + zoom controls (T-345-3).
 *
 * Two parts, both DOM-less:
 *   1. Pure minimap geometry helpers (canvasGeometry.mjs, additive): world
 *      bounding box, world→minimap projection, note rectangles, viewport
 *      frame, inverse mapping, and the center-on-world pan primitive.
 *   2. SSR smoke for CanvasMiniMap.jsx — the .jsx component is loaded through a
 *      sucrase node module hook (pattern: test-canvas-sidebar-editor.mjs) and
 *      rendered with fixture notes + a committed viewport; asserts the note
 *      rectangles and the viewport frame appear in the markup.
 *
 * Run: node test-canvas-minimap.mjs
 */

import { register, createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  notesBounds, minimapTransform, noteMiniRect, viewportFrameRect,
  minimapToWorld, panToCenterWorld,
} from './src/utils/canvasGeometry.mjs';

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

function approx(a, b, eps = 1e-6) {
  return Math.abs(a - b) < eps;
}

// =============================================================================
section('notesBounds');

{
  ok(notesBounds([], () => null) === null, 'empty notes yield null bounds');
  ok(notesBounds(null, () => null) === null, 'null notes yield null bounds');

  // Two notes, dims supplied; pad = 0 to check raw extents.
  const notes = [
    { id: 'a', x: 0, y: 0 },
    { id: 'b', x: 300, y: 100 },
  ];
  const dims = (id) => (id === 'a' ? { w: 160, h: 120 } : { w: 200, h: 80 });
  const b0 = notesBounds(notes, dims, 0);
  ok(b0.minX === 0 && b0.minY === 0, 'min corner is the top-left-most note');
  ok(b0.maxX === 500 && b0.maxY === 180, 'max corner spans note widths/heights');
  ok(b0.width === 500 && b0.height === 180, 'width/height derive from extents');

  const bp = notesBounds(notes, dims, 40);
  ok(bp.minX === -40 && bp.maxX === 540 && bp.width === 580, 'pad expands the box on all sides');

  // Missing dims fall back to 160x120 (matches fitToNotes).
  const fb = notesBounds([{ id: 'x', x: 10, y: 20 }], () => null, 0);
  ok(fb.maxX === 170 && fb.maxY === 140, 'unknown dims fall back to 160x120');
}

// =============================================================================
section('minimapTransform — uniform fit + centering');

{
  // 400x200 world into a 100x100 panel → scale 0.25 (width-bound), letterboxed.
  const bounds = { minX: 0, minY: 0, maxX: 400, maxY: 200, width: 400, height: 200 };
  const mm = minimapTransform(bounds, 100, 100);
  ok(approx(mm.scale, 0.25), 'scale fits the limiting (wider) axis: 100/400');
  ok(approx(mm.offsetX, 0), 'no horizontal letterbox on the limiting axis');
  ok(approx(mm.offsetY, (100 - 200 * 0.25) / 2), 'short axis is centered (letterboxed)');

  const tl = mm.project(0, 0);
  ok(approx(tl.x, 0) && approx(tl.y, 25), 'world top-left projects to the panel with offset');
  const br = mm.project(400, 200);
  ok(approx(br.x, 100) && approx(br.y, 75), 'world bottom-right projects to the far panel edge');
}

// =============================================================================
section('noteMiniRect');

{
  const bounds = { minX: 0, minY: 0, maxX: 400, maxY: 400, width: 400, height: 400 };
  const mm = minimapTransform(bounds, 100, 100); // scale 0.25, no letterbox
  const note = { id: 'a', x: 40, y: 80 };
  const r = noteMiniRect(note, () => ({ w: 160, h: 120 }), mm);
  ok(approx(r.x, 10) && approx(r.y, 20), 'note top-left scales into panel pixels');
  ok(approx(r.w, 40) && approx(r.h, 30), 'note size scales by the minimap scale');

  const r1 = noteMiniRect({ id: 'tiny', x: 0, y: 0 }, () => ({ w: 1, h: 1 }), mm);
  ok(r1.w >= 1 && r1.h >= 1, 'rect stays at least 1px so notes remain visible');
}

// =============================================================================
section('viewportFrameRect');

{
  // World 0..400 mapped to 0..100 (scale 0.25). Canvas wrap 200x200 with pan
  // {100,100}, scale 1 → world-visible region is (-100..100, -100..100).
  const bounds = { minX: 0, minY: 0, maxX: 400, maxY: 400, width: 400, height: 400 };
  const mm = minimapTransform(bounds, 100, 100);
  const frame = viewportFrameRect({ x: 100, y: 100 }, 1, 200, 200, mm, 100, 100);
  // wx1=-100→ project x = (-100)*0.25 = -25 → clamped to 0; wx2=100 → 25.
  ok(approx(frame.x, 0) && approx(frame.y, 0), 'frame left/top clamps into the panel');
  ok(approx(frame.w, 25) && approx(frame.h, 25), 'frame spans the visible world slice, clamped');

  // Fully-contained viewport: pan 0, scale 1, wrap 100x100 → world 0..100.
  const f2 = viewportFrameRect({ x: 0, y: 0 }, 1, 100, 100, mm, 100, 100);
  ok(approx(f2.x, 0) && approx(f2.w, 25), 'a small viewport yields a small frame');

  // Inset keeps the (square) frame clear of the panel's rounded corners.
  // A zoomed-out viewport that would span the whole panel is held `inset` in
  // on every side so its corners stay visible (T-345-3 follow-up fix).
  const big = viewportFrameRect({ x: 0, y: 0 }, 0.1, 1000, 1000, mm, 100, 100, 6);
  ok(approx(big.x, 6) && approx(big.y, 6), 'inset frame starts at the inset offset');
  ok(approx(big.x + big.w, 94) && approx(big.y + big.h, 94),
    'inset frame ends inset-px before the panel edge (corners clear the rounding)');
  // Default inset 0 keeps the old flush behavior (back-compat).
  const flush = viewportFrameRect({ x: 0, y: 0 }, 0.1, 1000, 1000, mm, 100, 100);
  ok(approx(flush.x, 0) && approx(flush.x + flush.w, 100), 'inset defaults to 0 (flush, unchanged)');
}

// =============================================================================
section('minimapToWorld — inverse of project');

{
  const bounds = { minX: -40, minY: -40, maxX: 360, maxY: 360, width: 400, height: 400 };
  const mm = minimapTransform(bounds, 100, 100);
  // Round-trip a few world points through project → minimapToWorld.
  for (const [wx, wy] of [[-40, -40], [0, 0], [160, 200], [360, 360]]) {
    const p = mm.project(wx, wy);
    const back = minimapToWorld(p.x, p.y, bounds, mm);
    ok(approx(back.x, wx) && approx(back.y, wy), `round-trips world point (${wx},${wy})`);
  }
}

// =============================================================================
section('panToCenterWorld');

{
  // Centering world (200,150) at scale 1 in a 800x600 wrap → pan puts it mid-screen.
  const pan = panToCenterWorld(200, 150, 1, 800, 600);
  ok(approx(pan.x, 400 - 200) && approx(pan.y, 300 - 150), 'pan centers the world point in the wrap');
  // The centered point must map back to the wrap center.
  const screenX = 200 * 1 + pan.x;
  const screenY = 150 * 1 + pan.y;
  ok(approx(screenX, 400) && approx(screenY, 300), 'centered world point lands at wrap center');

  const pan2 = panToCenterWorld(200, 150, 0.5, 800, 600);
  ok(approx(pan2.x, 400 - 100) && approx(pan2.y, 300 - 75), 'pan respects scale');
}

// =============================================================================
// SSR smoke — render CanvasMiniMap.jsx with fixture notes + a viewport.
// =============================================================================
section('CanvasMiniMap SSR smoke');

const hooksSource = `
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(${JSON.stringify(import.meta.url)});
const { transform } = require('sucrase');
export async function load(url, context, nextLoad) {
  if (url.endsWith('.jsx')) {
    const source = readFileSync(new URL(url), 'utf8');
    const { code } = transform(source, {
      transforms: ['jsx'],
      jsxRuntime: 'automatic',
      production: true,
      filePath: url,
    });
    return { format: 'module', source: code, shortCircuit: true };
  }
  return nextLoad(url, context);
}
`;
register('data:text/javascript;base64,' + Buffer.from(hooksSource).toString('base64'));

// sucrase must be resolvable for the hook above.
createRequire(import.meta.url).resolve('sucrase');

const { createElement: h } = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const CanvasMiniMap = (await import('./src/components/canvas/CanvasMiniMap.jsx')).default;

ok(typeof CanvasMiniMap === 'function', 'CanvasMiniMap default export is a component');

{
  const notes = [
    { id: 'a', x: 0, y: 0, color: 'red' },
    { id: 'b', x: 400, y: 200, color: 'blue' },
    { id: 'c', x: 200, y: 600, color: 'green' },
  ];
  const getDims = () => ({ w: 160, h: 120 });
  const view = { pan: { x: 60, y: 60 }, scale: 1 };

  const html = renderToStaticMarkup(h(CanvasMiniMap, {
    notes,
    getView: () => view,
    getDims,
    wrapSize: { w: 800, h: 600 },
    scale: 1,
    onNavigate: () => {},
    onZoom: () => {},
    onFit: () => {},
  }));

  ok(html.includes('data-canvas-ui'), 'minimap carries data-canvas-ui (no canvas gestures)');
  ok(html.includes('data-minimap'), 'minimap root is marked data-minimap');
  ok((html.match(/data-mini-note/g) || []).length === notes.length,
    'one rectangle rendered per note');
  ok(html.includes('data-mini-viewport'), 'viewport frame is rendered');
  // Zoom controls: − / % / + / Fit
  ok(html.includes('data-zoom-out') && html.includes('data-zoom-in'),
    'zoom −/+ controls present');
  ok(html.includes('data-zoom-fit'), 'Fit control present');
  ok(/100\s*%/.test(html), 'percent readout reflects scale (100%)');
}

{
  // Empty canvas: no notes → no bounds. Component must still render the zoom
  // controls (so zoom stays discoverable) without throwing.
  const html = renderToStaticMarkup(h(CanvasMiniMap, {
    notes: [],
    getView: () => ({ pan: { x: 0, y: 0 }, scale: 1 }),
    getDims: () => null,
    wrapSize: { w: 800, h: 600 },
    scale: 1,
    onNavigate: () => {},
    onZoom: () => {},
    onFit: () => {},
  }));
  ok(html.includes('data-zoom-fit'), 'zoom controls render even with no notes');
  ok(!html.includes('data-mini-note'), 'no note rectangles when there are no notes');
}

// =============================================================================
section('Source assertions');

const here = fileURLToPath(new URL('.', import.meta.url));
const src = readFileSync(`${here}/src/components/canvas/CanvasMiniMap.jsx`, 'utf8');

ok(/data-canvas-ui/.test(src), 'component sets data-canvas-ui');
ok(!/import\s+['"].*\.css['"]/.test(src), 'component imports no CSS file (Tailwind/inline only)');
// Reuses the additive geometry helpers, not a private re-implementation.
ok(/notesBounds|minimapTransform|noteMiniRect|viewportFrameRect/.test(src),
  'component reuses canvasGeometry minimap helpers');

// =============================================================================
section('Test Summary');
console.log(`\nPassed: ${pass}`);
console.log(`Failed: ${fail}`);
if (fail > 0) {
  console.log('\nFailures:');
  failures.forEach((m) => console.log(`  - ${m}`));
  process.exit(1);
}
console.log('\n✅ All canvas minimap tests passed!');
