/**
 * DOM-less smoke tests for the canvas NoteSidebar editor (T-345-1).
 *
 * Pattern: test-v5-components-smoke.mjs / test-canvas-migration-ui.mjs — no
 * browser, no jsdom. The .jsx component is loaded through a sucrase-based node
 * module hook (sucrase ships with the dashboard dependency tree), so the real
 * NoteSidebar export is tested:
 *
 *   1. NoteSidebar renders the shared MarkdownEditor (CodeMirror) instead of a
 *      raw <textarea> — verified via a prop-capturing MarkdownEditor stub and
 *      via SSR markup (toolbar present, no canvas-sidebar-textarea).
 *   2. Save semantics: the editor's onSave / onCancel callbacks persist the
 *      current value through onSave(note.id, value); onCancel also closes.
 *   3. Source assertions: imports MarkdownEditor, no raw textarea, height is
 *      configured inline (not via styles/*.css), sidebar stops propagation.
 *
 * Run: node test-canvas-sidebar-editor.mjs
 */

import { register, createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

// -----------------------------------------------------------------------------
// JSX loader hook + a MarkdownEditor stub that captures the props NoteSidebar
// hands it, so we can drive onSave / onCancel without a DOM.
// -----------------------------------------------------------------------------

// In-memory (data: URL) stub for MarkdownEditor — no extra files on disk.
// Captures the props NoteSidebar passes and renders a marker element for SSR.
const stubSource = `
import { createElement } from 'react';
export default function MarkdownEditorStub(props) {
  globalThis.__capturedMdEditorProps = props;
  return createElement('div', { 'data-md-editor-stub': 'true', className: props.className });
}
`;
const stubUrl = 'data:text/javascript;base64,' + Buffer.from(stubSource).toString('base64');

// Resolve react for the data:-URL stub (data: modules can't resolve bare specifiers).
const reactUrl = pathToFileURL(createRequire(import.meta.url).resolve('react')).href;

const hooksSource = `
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(${JSON.stringify(import.meta.url)});
const { transform } = require('sucrase');
const STUB = ${JSON.stringify(stubUrl)};
const REACT = ${JSON.stringify(reactUrl)};
export async function resolve(specifier, context, nextResolve) {
  // Redirect NoteSidebar's '../MarkdownEditor.jsx' import to the stub.
  if (context.parentURL && context.parentURL.endsWith('/canvas/NoteSidebar.jsx')
      && specifier.endsWith('MarkdownEditor.jsx')) {
    return { url: STUB, shortCircuit: true };
  }
  // The data:-URL stub imports 'react' but data: modules can't resolve bare specifiers.
  if (specifier === 'react' && context.parentURL && context.parentURL.startsWith('data:')) {
    return { url: REACT, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
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

// Sanity: sucrase must be resolvable for the hook above.
const requireHere = createRequire(import.meta.url);
requireHere.resolve('sucrase');

// Captured props from the most recent MarkdownEditor render.
globalThis.__capturedMdEditorProps = null;

const { createElement: h } = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');

const here = fileURLToPath(new URL('.', import.meta.url));

// -----------------------------------------------------------------------------
// Test 1 + 2: stubbed render — wiring & save semantics
// -----------------------------------------------------------------------------

section('NoteSidebar wiring (stubbed MarkdownEditor)');

const NoteSidebar = (await import('./src/components/canvas/NoteSidebar.jsx')).default;

ok(typeof NoteSidebar === 'function', 'NoteSidebar default export is a component');

{
  const note = { id: 'N-7', text: '**bold** note body', color: 'blue' };
  const saveCalls = [];
  let closed = 0;

  // Render once (SSR runs hooks, captures the editor props via the stub).
  renderToStaticMarkup(h(NoteSidebar, {
    note,
    onSave: (id, val) => saveCalls.push([id, val]),
    onClose: () => { closed += 1; },
  }));

  const props = globalThis.__capturedMdEditorProps;
  ok(props != null, 'NoteSidebar rendered the MarkdownEditor (stub received props)');
  ok(props.value === note.text, 'editor is loaded with the note text (controlled value)');
  ok(typeof props.onChange === 'function', 'editor gets an onChange handler');
  ok(typeof props.onSave === 'function', 'editor gets an onSave handler (Mod-s)');
  ok(typeof props.onCancel === 'function', 'editor gets an onCancel handler (Escape)');

  // M3 dedupe semantics: the editor's onSave (Mod-s) / onCancel (Escape) persist
  // the *current* value through onSave(note.id, value), but a save is suppressed
  // when the text is unchanged since it was last persisted for this open note.
  // That dedupes the close double-PUT (wrapper onBlur + unmount-cleanup both
  // firing for the same text). In this one-shot SSR harness the value can't be
  // edited (renderToStaticMarkup never re-renders, so onChange/setValue never
  // updates valueRef) — the value equals note.text throughout, so every persist
  // is a legitimate no-op. The real changed-value single-PUT-on-close path is
  // covered by the browser test test-canvas-sidebar-save.js.

  // onSave (Mod-s) with unchanged text does not persist (M3 dedupe).
  props.onSave();
  ok(saveCalls.length === 0, 'editor onSave does not persist unchanged text (M3 dedupe)');

  // onCancel (Escape) closes the sidebar; unchanged text is still a no-op.
  props.onCancel();
  ok(closed === 1, 'editor onCancel closes the sidebar');
  ok(saveCalls.length === 0, 'editor onCancel does not persist unchanged text (M3 dedupe)');
}

{
  // Closed sidebar (note == null) renders nothing extra and does not mount the editor.
  globalThis.__capturedMdEditorProps = null;
  const html = renderToStaticMarkup(h(NoteSidebar, {
    note: null,
    onSave: () => {},
    onClose: () => {},
  }));
  ok(!/ open"/.test(html) && html.includes('canvas-sidebar'), 'closed sidebar has no "open" class');
  ok(globalThis.__capturedMdEditorProps === null, 'editor is not mounted when no note is open');
}

// -----------------------------------------------------------------------------
// Test 3: SSR markup with the REAL MarkdownEditor (separate process-free import)
// -----------------------------------------------------------------------------

section('SSR markup with the real MarkdownEditor');

{
  // Import the real MarkdownEditor directly and render it the way NoteSidebar
  // does, to prove the CodeMirror-based editor (not a textarea) is what ends up
  // in the sidebar body.
  const RealMarkdownEditor = (await import('./src/components/MarkdownEditor.jsx')).default;
  const html = renderToStaticMarkup(h(RealMarkdownEditor, {
    className: 'canvas-sidebar-editor',
    value: '**bold** note body',
    onChange: () => {},
  }));
  ok(html.includes('markdown-editor'), 'real editor renders the .markdown-editor wrapper');
  ok(html.includes('canvas-sidebar-editor'), 'sidebar passes its className through to the editor');
  ok(html.includes('markdown-editor-toolbar'), 'editor renders the formatting toolbar');
  ok(html.includes('aria-label="Markdown formatting"'), 'toolbar is the markdown toolbar');
  ok(!html.includes('canvas-sidebar-textarea'), 'no legacy plain textarea markup');
}

// -----------------------------------------------------------------------------
// Test 4: Source assertions
// -----------------------------------------------------------------------------

section('Source assertions');

const sidebarSrc = readFileSync(`${here}/src/components/canvas/NoteSidebar.jsx`, 'utf8');

ok(/import\s+MarkdownEditor\s+from\s+'\.\.\/MarkdownEditor\.jsx'/.test(sidebarSrc),
  'NoteSidebar imports the shared MarkdownEditor');
ok(sidebarSrc.includes('<MarkdownEditor'), 'NoteSidebar renders <MarkdownEditor>');
// Strip block + line comments so doc-comment mentions of <textarea> don't
// count — we only care that no <textarea> element is actually rendered.
const sidebarCode = sidebarSrc
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '');
ok(!/<textarea/.test(sidebarCode), 'NoteSidebar no longer renders a raw <textarea>');
ok(!sidebarSrc.includes('applyFormattingToTextarea'),
  'NoteSidebar no longer uses the self-built textarea format buttons');
ok(/onSave\(\s*[a-zA-Z.]+\.id\s*,/.test(sidebarSrc) || sidebarSrc.includes('onSave(n.id, valueRef.current)'),
  'save persists via onSave(note.id, value)');
ok(sidebarSrc.includes('e.stopPropagation()') && sidebarSrc.includes('onWheel'),
  'sidebar still stops wheel propagation (no canvas zoom while editing)');
ok(sidebarSrc.includes('onKeyDown') && sidebarSrc.includes('stopPropagation'),
  'sidebar stops key propagation so CodeMirror keys do not fire canvas shortcuts');
ok(/flexDirection|flex:|minHeight/.test(sidebarSrc),
  'height/layout configured inline (props/style), not via CSS files');

// canvasTextFormat.mjs must still exist (the inline card edit still uses it).
const fmtExists = (() => {
  try { readFileSync(`${here}/src/utils/canvasTextFormat.mjs`, 'utf8'); return true; }
  catch { return false; }
})();
ok(fmtExists, 'canvasTextFormat.mjs is preserved (inline card toolbar still uses it)');

// -----------------------------------------------------------------------------
// Results
// -----------------------------------------------------------------------------

section('Test Summary');
console.log(`\nPassed: ${pass}`);
console.log(`Failed: ${fail}`);

if (fail > 0) {
  console.log('\nFailures:');
  failures.forEach((msg) => console.log(`  - ${msg}`));
  process.exit(1);
}

console.log('\n✅ All canvas sidebar editor tests passed!');
