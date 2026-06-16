/**
 * Unit tests for the canvas text formatting module (T-340-5) — verbatim port
 * of the vanilla toolbar formatting (js/canvas/toolbar.js
 * applyFormattingToTextarea / insertLinePrefix / insertNumberedPrefix).
 *
 * Run: node test-canvas-textformat.mjs
 */

import {
  applyFormattingToTextarea, insertLinePrefix, insertNumberedPrefix,
} from './src/utils/canvasTextFormat.mjs';

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

function makeTa(value, start, end = start) {
  return {
    value,
    selectionStart: start,
    selectionEnd: end,
    setSelectionRange(s, e) { this.selectionStart = s; this.selectionEnd = e; },
    focus() {},
    dispatchEvent() {},
  };
}

// =============================================================================
section('bold/italic wrapping');

{
  const ta = makeTa('hello', 0, 5);
  applyFormattingToTextarea(ta, 'bold');
  ok(ta.value === '**hello**', 'bold wraps the selection');
  applyFormattingToTextarea(ta, 'bold');
  ok(ta.value === 'hello', 'bold toggles off a wrapped selection');
}
{
  const ta = makeTa('**hello**', 0, 9);
  applyFormattingToTextarea(ta, 'italic');
  ok(ta.value === '***hello***', 'italic on bold text adds the italic layer');
}
{
  const ta = makeTa('x', 1);
  applyFormattingToTextarea(ta, 'bold');
  ok(ta.value === 'x****' && ta.selectionStart === 3, 'empty selection inserts marker pair with caret inside');
}
{
  const ta = makeTa('- item', 2, 6);
  applyFormattingToTextarea(ta, 'bold');
  ok(ta.value === '- **item**', 'bold respects list prefixes');
}
{
  const ta = makeTa('a\nb', 0, 3);
  applyFormattingToTextarea(ta, 'bold');
  ok(ta.value === '**a**\n**b**', 'multi-line bold wraps each line');
  ta.selectionStart = 0; ta.selectionEnd = ta.value.length;
  applyFormattingToTextarea(ta, 'bold');
  ok(ta.value === 'a\nb', 'multi-line bold toggles off when all lines wrapped');
}

// =============================================================================
section('link formatting');

{
  const ta = makeTa('name', 0, 4);
  applyFormattingToTextarea(ta, 'link');
  ok(ta.value === '[name](url)', 'link wraps selection');
  ok(ta.value.slice(ta.selectionStart, ta.selectionEnd) === 'url', 'url placeholder is selected');
}
{
  const ta = makeTa('[name](http://x)', 0, 16);
  applyFormattingToTextarea(ta, 'link');
  ok(ta.value === 'name', 'link toggles off to the label');
}
{
  const ta = makeTa('', 0, 0);
  applyFormattingToTextarea(ta, 'link');
  ok(ta.value === '[title](url)', 'empty selection inserts a placeholder link');
}

// =============================================================================
section('bullet lists');

{
  const ta = makeTa('abc', 1);
  insertLinePrefix(ta, '- ');
  ok(ta.value === '- abc', 'caret line gets the bullet prefix');
  insertLinePrefix(ta, '- ');
  ok(ta.value === 'abc', 'bullet toggles off');
}
{
  const ta = makeTa('1. abc', 3);
  insertLinePrefix(ta, '- ');
  ok(ta.value === '- abc', 'bullet replaces a numbered prefix');
}
{
  const ta = makeTa('a\nb\nc', 0, 5);
  insertLinePrefix(ta, '- ');
  ok(ta.value === '- a\n- b\n- c', 'selection prefixes every line');
  ta.selectionStart = 0; ta.selectionEnd = ta.value.length;
  insertLinePrefix(ta, '- ');
  ok(ta.value === 'a\nb\nc', 'all-prefixed selection toggles off');
}

// =============================================================================
section('numbered lists');

{
  const ta = makeTa('abc', 0);
  insertNumberedPrefix(ta);
  ok(ta.value === '1. abc', 'first numbered line starts at 1');
  insertNumberedPrefix(ta);
  ok(ta.value === 'abc', 'number toggles off');
}
{
  const ta = makeTa('1. first\nsecond', 12);
  insertNumberedPrefix(ta);
  ok(ta.value === '1. first\n2. second', 'numbering continues from the previous line');
}
{
  const ta = makeTa('a\n- b\nc', 0, 7);
  insertNumberedPrefix(ta);
  ok(ta.value === '1. a\n2. b\n3. c', 'selection numbers all lines, stripping bullets');
}

// =============================================================================
console.log(`\n${'='.repeat(60)}`);
console.log(`Canvas text format tests: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
