import assert from 'node:assert/strict';
import { posToOffset, resolveSelection, estimateColumn } from './src/utils/notesLocate.mjs';

// --- posToOffset (line 1-based, col 0-based; clamps) ---
const t = 'abc\ndef\nghi';
assert.equal(posToOffset(t, 1, 0), 0, 'line1 col0');
assert.equal(posToOffset(t, 2, 0), 4, 'line2 col0 (after "abc\\n")');
assert.equal(posToOffset(t, 2, 2), 6, 'line2 col2');
assert.equal(posToOffset(t, 3, 0), 8, 'line3 col0');
assert.equal(posToOffset(t, 1, 99), 3, 'col clamps to line length');
assert.equal(posToOffset(t, 99, 0), 8, 'line clamps to last line');
assert.equal(posToOffset(t, 2, -5), 4, 'negative col clamps to 0');
assert.equal(posToOffset(t, 1), 0, 'col defaults to 0');

// --- resolveSelection (best-effort: exact substring within line range, else line-range fallback) ---
const md = '# Title\n\nHello **world** here\n\nHello again';
assert.deepEqual(resolveSelection(md, 3, 3, 'world'), { from: 17, to: 22 }, 'unique substring → exact offsets');
assert.deepEqual(resolveSelection(md, 3, 3, 'Hello'), { from: 9, to: 14 }, 'Hello on line 3 resolves within line 3 slice only');
assert.deepEqual(resolveSelection(md, 3, 3, 'zzz'), { from: 9, to: 29 }, 'not found → full line range');
assert.deepEqual(resolveSelection(md, 3, 5, ''), { from: 9, to: 42 }, 'empty selection → multi-line range');

// trimmed fallback: rendered selection may carry surrounding whitespace
assert.deepEqual(resolveSelection(md, 3, 3, '  world  '), { from: 17, to: 22 }, 'trimmed match still resolves');

// --- estimateColumn (best-effort: locate last rendered word in the source line) ---
assert.equal(estimateColumn('Hello **world** here', 'Hello world'), 13, 'cursor after "world" in source (past the **)');
assert.equal(estimateColumn('Hello **world** here', 'Hello'), 5, 'cursor after first word');
assert.equal(estimateColumn('plain text line', ''), 0, 'no rendered-before text → column 0');
assert.equal(estimateColumn('Hello world', 'zzz nope'), 0, 'word not in source line → column 0');

console.log('# notes-locate: all assertions passed');
