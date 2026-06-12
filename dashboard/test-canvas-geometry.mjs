/**
 * Unit tests for the extracted canvas geometry/graph/markdown modules
 * (T-340-1, canvas React migration).
 *
 * The vanilla canvas code (js/canvas/) is the behavioral reference; these
 * modules must reproduce it exactly. DOM/state access is decoupled via
 * parameters, so everything here runs in plain Node.
 *
 *   - src/utils/canvasConstants.mjs  — shared constants
 *   - src/utils/canvasGeometry.mjs   — routing, ports, coordinate transforms
 *   - src/utils/canvasGraph.mjs      — connected-component / cluster derivation
 *   - src/utils/canvasMarkdown.mjs   — note markdown subset renderer
 *
 * Run: node test-canvas-geometry.mjs
 */

import {
  NOTE_WIDTH, SCALE_MIN, SCALE_MAX, NOTE_COLORS, COLOR_STROKE,
  CORNER_RADIUS, PORT_SPACING, MIN_ESCAPE, MAX_PORTS_PER_SIDE,
} from './src/utils/canvasConstants.mjs';
import {
  ptsToRoundedPath, routePath, manhattanPath, getBestSides,
  computePortPositions, stackOffset, screenToCanvas,
  portDotCss, stackedDotCanvas, buildConnectedPorts,
} from './src/utils/canvasGeometry.mjs';
import { getConnectedComponent, getAllClusters } from './src/utils/canvasGraph.mjs';
import { escHtml, renderNoteMarkdown } from './src/utils/canvasMarkdown.mjs';

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
section('Constants');

ok(NOTE_WIDTH === 160, 'NOTE_WIDTH is 160');
ok(SCALE_MIN === 0.3 && SCALE_MAX === 2.5, 'zoom clamp range is 0.3–2.5');
ok(
  JSON.stringify(NOTE_COLORS) === JSON.stringify(['grey', 'yellow', 'blue', 'green', 'red', 'teal']),
  'NOTE_COLORS order matches vanilla'
);
ok(COLOR_STROKE.yellow === 'var(--warn)' && COLOR_STROKE.grey === 'var(--border-strong)',
  'COLOR_STROKE maps to design tokens');
ok(CORNER_RADIUS === 12 && PORT_SPACING === 18 && MIN_ESCAPE === 28 && MAX_PORTS_PER_SIDE === 5,
  'routing constants match vanilla');

// =============================================================================
section('ptsToRoundedPath');

ok(ptsToRoundedPath([[0, 0], [100, 0]], 12) === 'M 0 0 L 100 0',
  'two points yield a straight line');
ok(ptsToRoundedPath([[0, 0], [0, 0], [100, 0]], 12) === 'M 0 0 L 100 0',
  'consecutive duplicate points are removed');
ok(ptsToRoundedPath([[0, 0]], 12) === '', 'single point yields empty path');
ok(
  ptsToRoundedPath([[0, 0], [100, 0], [100, 100]], 12) === 'M 0 0 L 88 0 Q 100 0 100 12 L 100 100',
  'right-angle corner gets a Q arc of radius 12'
);
ok(
  ptsToRoundedPath([[0, 0], [10, 0], [10, 10]], 12) === 'M 0 0 L 5 0 Q 10 0 10 5 L 10 10',
  'corner radius clamps to half the shorter segment'
);
ok(
  ptsToRoundedPath([[0, 0], [1, 0], [1, 1]], 12) === 'M 0 0 L 1 0 L 1 1',
  'sub-1px clamped radius degrades to sharp corner'
);

// =============================================================================
section('routePath — structural invariants');

// Every routed path must start at the source dot and end at the target dot,
// and contain only M/L/Q commands (Manhattan with rounded corners).
const ROUTE_CASES = [
  [0, 0, 200, 100, 'right', null, 0],
  [0, 0, 200, 100, 'bottom', null, 0],
  [0, 0, 200, 80, 'right', 'left', 80],   // facing S-shape
  [0, 0, 200, 0, 'right', 'left', 80],    // straight facing
  [200, 0, 0, 80, 'right', 'left', 80],   // facing away → Z
  [0, 0, 200, 0, 'bottom', 'bottom', 80], // same-side U
  [0, 0, 30, 0, 'bottom', 'bottom', 80],  // same-side U, overlapping arms → C
  [0, 0, 200, 100, 'right', 'top', 80],   // perpendicular L
  [0, 0, -200, 100, 'right', 'top', 80],  // perpendicular with reversal risk
  [0, 0, 200, 100, 'bottom', 'left', 80], // perpendicular V→H
];
for (const [x1, y1, x2, y2, fromSide, toSide] of ROUTE_CASES) {
  const d = routePath(x1, y1, x2, y2, fromSide, toSide, 80);
  const label = `routePath(${fromSide}→${toSide ?? 'free'}) [${x1},${y1}]→[${x2},${y2}]`;
  ok(typeof d === 'string' && d.startsWith(`M ${x1} ${y1}`), `${label} starts at source`);
  const endsAtTarget = new RegExp(`(L|Q [-\\d.]+ [-\\d.]+) ${x2} ${y2}$`).test(d);
  ok(endsAtTarget, `${label} ends at target`);
  ok(!/[^MLQ\s\-.\d]/.test(d), `${label} uses only M/L/Q commands`);
}

// Specific shape expectations derived from the vanilla algorithm:
{
  // Free drag from a right port: escape 28px, then L to target.
  const d = routePath(0, 0, 200, 100, 'right', null, 0);
  ok(d.includes('L 28 0') || d.includes('Q 28 0'), 'free drag escapes MIN_ESCAPE from source edge');
}
{
  // Facing S-shape: vertical segment centered between escapes (x=100).
  const d = routePath(0, 0, 200, 80, 'right', 'left', 80);
  ok(d.includes(' 100 '), 'facing S-shape routes through centered vertical');
}
{
  // Same-side bottom U: horizontal connector below both escapes (y = 28+28 = 56).
  const d = routePath(0, 0, 200, 0, 'bottom', 'bottom', 80);
  ok(d.includes(' 56'), 'same-side bottom U dips MIN_ESCAPE below both escapes');
}

// =============================================================================
section('manhattanPath');

ok(manhattanPath(0, 0, 1, 100) === 'M 0 0 L 1 100',
  'degenerate horizontal delta yields straight line');
{
  const d = manhattanPath(0, 0, 200, 100, 'horizontal', 'horizontal');
  ok(d.startsWith('M 0 0 L 88 0 Q 100 0 100 12'), 'H→H routes via x midpoint with arcs');
  ok(d.endsWith('L 200 100'), 'H→H ends at target');
}
{
  const d = manhattanPath(0, 0, 200, 100, 'vertical', 'vertical');
  ok(d.includes(' 50') && d.split('Q').length === 3, 'V→V routes via y midpoint with two arcs');
}
{
  const d = manhattanPath(0, 0, 200, 100, 'horizontal', 'vertical');
  ok(d === 'M 0 0 L 188 0 Q 200 0 200 12 L 200 100', 'H→V is a single rounded bend at (x2,y1)');
}
{
  const d = manhattanPath(0, 0, 200, 100, 'vertical', 'horizontal');
  ok(d === 'M 0 0 L 0 88 Q 0 100 12 100 L 200 100', 'V→H is a single rounded bend at (x1,y2)');
}

// =============================================================================
section('getBestSides');

const DIMS = { w: 160, h: 100 };
ok(JSON.stringify(getBestSides({ x: 0, y: 0 }, { x: 400, y: 0 }, DIMS, DIMS))
  === JSON.stringify({ sideA: 'right', sideB: 'left' }), 'B east of A → right/left');
ok(JSON.stringify(getBestSides({ x: 400, y: 0 }, { x: 0, y: 0 }, DIMS, DIMS))
  === JSON.stringify({ sideA: 'left', sideB: 'right' }), 'B west of A → left/right');
ok(JSON.stringify(getBestSides({ x: 0, y: 0 }, { x: 0, y: 300 }, DIMS, DIMS))
  === JSON.stringify({ sideA: 'bottom', sideB: 'top' }), 'B south of A → bottom/top');
ok(JSON.stringify(getBestSides({ x: 0, y: 300 }, { x: 0, y: 0 }, DIMS, DIMS))
  === JSON.stringify({ sideA: 'top', sideB: 'bottom' }), 'B north of A → top/bottom');
ok(JSON.stringify(getBestSides({ x: 0, y: 0 }, { x: 300, y: 290 }, DIMS, DIMS))
  === JSON.stringify({ sideA: 'right', sideB: 'left' }), 'horizontal dominance wins ties toward right/left');

// =============================================================================
section('stackOffset');

ok(stackOffset(0) === 0, 'slot 0 is centered');
ok(stackOffset(1) === PORT_SPACING, 'slot 1 offsets +18');
ok(stackOffset(2) === -PORT_SPACING, 'slot 2 offsets -18');
ok(stackOffset(3) === 2 * PORT_SPACING, 'slot 3 offsets +36');
ok(stackOffset(4) === -2 * PORT_SPACING, 'slot 4 offsets -36');

// =============================================================================
section('port dot placement (renderPorts / getStackedDotPos formulas)');

{
  const dims = { w: 160, h: 100, bl: 1, bt: 1 };
  // CSS-relative dot position (vanilla renderPorts)
  ok(JSON.stringify(portDotCss('right', dims, 0)) === JSON.stringify({ left: Math.round(160 - 1.5), top: 50 }),
    'right free dot sits on the border line at side center');
  ok(JSON.stringify(portDotCss('bottom', dims, 18)) === JSON.stringify({ left: 80 + 18, top: Math.round(100 - 1.5) }),
    'bottom dot offsets along x');
  ok(portDotCss('left', dims, -100).top === 8, 'offsets clamp 8px inside the card');
  ok(JSON.stringify(portDotCss('left', dims, 0)) === JSON.stringify({ left: 0, top: 50 }),
    'left dot centers on the border (rounds -0.5 to -0)');

  // Canvas-space stacked dot (vanilla getStackedDotPos)
  const note = { x: 200, y: 100 };
  ok(JSON.stringify(stackedDotCanvas(note, dims, 'right', 0)) === JSON.stringify({ x: Math.round(200 + 160 - 0.5), y: Math.round(100 + 1 + 50) }),
    'stacked right dot in canvas coords');
  ok(JSON.stringify(stackedDotCanvas(note, dims, 'bottom', -18)) === JSON.stringify({ x: Math.round(200 + 1 + 80 - 18), y: Math.round(100 + 1 + 100 - 1.5) }),
    'stacked bottom dot respects offset and border math');
}

// =============================================================================
section('computePortPositions');

{
  const notes = [
    { id: 'a', x: 0, y: 0 },
    { id: 'b', x: 400, y: 0 },
    { id: 'c', x: 400, y: 200 },
  ];
  const dims = () => ({ w: 160, h: 100, bl: 1, bt: 1 });
  const one = computePortPositions(notes, [{ from: 'a', to: 'b' }], dims);
  const entry = one.get('a:b');
  ok(!!entry, 'port map is keyed by "fromId:toId"');
  ok(entry.sideA === 'right' && entry.sideB === 'left', 'sides assigned via getBestSides');
  ok(entry.ax === Math.round(0 + 160 - 0.5) && entry.ay === Math.round(0 + 1 + 50),
    'source port sits on the right edge center (border-adjusted)');
  ok(entry.bx === Math.round(400 + 0.5) && entry.by === Math.round(0 + 1 + 50),
    'target port sits on the left edge center (border-adjusted)');

  const two = computePortPositions(
    notes,
    [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }],
    dims
  );
  const e1 = two.get('a:b');
  const e2 = two.get('a:c');
  const ays = [e1.ay, e2.ay].sort((p, q) => p - q);
  ok(ays[1] - ays[0] === PORT_SPACING, 'two connections on one side stack 18px apart');

  const missing = computePortPositions(notes, [{ from: 'a', to: 'ghost' }], dims);
  ok(missing.size === 0, 'connections to missing notes are skipped');
}

// =============================================================================
section('buildConnectedPorts — per-side dot occupancy (vanilla renderConnections step 1)');

{
  const notes = [
    { id: 'a', x: 0, y: 0, color: 'red' },
    { id: 'b', x: 400, y: 0 },
    { id: 'c', x: 400, y: 300 },
  ];
  const conns = [
    { from: 'a', to: 'b', fromPort: 'right', toPort: 'left' },
    { from: 'a', to: 'c', fromPort: null, toPort: null }, // legacy: sides via getBestSides
  ];
  const dims = () => ({ w: 160, h: 100, bl: 1, bt: 1 });
  const cp = buildConnectedPorts(notes, conns, dims);
  ok(cp.get('a:right')?.length === 2, 'stored and derived sides share the same per-side list');
  ok(cp.get('a:right')[0].color === COLOR_STROKE.red, 'dot color follows the FROM note color');
  ok(cp.get('b:left')?.length === 1 && cp.get('c:left')?.length === 1,
    'targets get their side entries too');
  ok(cp.get('a:right')[0].connId === 'a:b', 'entries carry the connection key');
}

// =============================================================================
section('screenToCanvas');

{
  const rect = { left: 100, top: 50 };
  const out = screenToCanvas(300, 250, rect, { x: 60, y: 60 }, 2);
  ok(out.x === (300 - 100 - 60) / 2 && out.y === (250 - 50 - 60) / 2,
    'inverts pan and scale relative to wrap rect');
}

// =============================================================================
section('cluster graph');

{
  const conns = [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }];
  const comp = getConnectedComponent(conns, 'a');
  ok(comp.size === 3 && comp.has('a') && comp.has('b') && comp.has('c'),
    'connected component follows edges both directions');
  ok(getConnectedComponent(conns, 'd').size === 1, 'isolated start id yields singleton');

  const notes = ['a', 'b', 'c', 'd', 'e', 'f'].map(id => ({ id }));
  const clusters = getAllClusters(notes, [...conns, { from: 'e', to: 'f' }]);
  ok(clusters.length === 2, 'two islands yield two clusters');
  ok(clusters.every(c => c.size >= 2), 'singletons are not clusters');
  const cycle = getAllClusters(notes.slice(0, 3), [...conns, { from: 'c', to: 'a' }]);
  ok(cycle.length === 1 && cycle[0].size === 3, 'cycles terminate and form one cluster');
}

// =============================================================================
section('note markdown subset');

ok(escHtml('a&<>"') === 'a&amp;&lt;&gt;&quot;', 'escHtml escapes &, <, >, "');
ok(renderNoteMarkdown('') === '', 'empty text renders empty');
ok(renderNoteMarkdown('**bold**') === '<strong>bold</strong>', 'bold');
ok(renderNoteMarkdown('*it*') === '<em>it</em>', 'italic');
ok(renderNoteMarkdown('*dangling') === 'dangling', 'unpaired asterisks are stripped');
ok(renderNoteMarkdown('<script>') === '&lt;script&gt;', 'HTML is escaped before markdown');
ok(renderNoteMarkdown('[site](example.com/a&b)') ===
  '<a href="https://example.com/a&b" target="_blank" rel="noopener">site</a>',
  'markdown link gets https:// prefix and decoded href');
ok(renderNoteMarkdown('see www.foo.de now').includes('<a href="https://www.foo.de"'),
  'bare www URL is auto-linked');
ok(renderNoteMarkdown('- a\n- b') === '<ul><li>a</li><li>b</li></ul>', 'dash list becomes <ul>');
ok(renderNoteMarkdown('1. a\n2. b') === '<ol><li>a</li><li>b</li></ol>', 'numbered list becomes <ol>');
ok(renderNoteMarkdown('- a\n1. b') === '<ul><li>a</li></ul><ol><li>b</li></ol>',
  'switching list type closes the previous list');
ok(renderNoteMarkdown('x\n\ny') === 'x<br><br>y', 'blank line renders as <br>');
ok(renderNoteMarkdown('only') === 'only', 'single plain line has no trailing <br>');

// =============================================================================
console.log(`\n${'='.repeat(60)}`);
console.log(`Canvas geometry tests: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
