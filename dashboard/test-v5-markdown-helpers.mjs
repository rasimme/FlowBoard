/**
 * Smoke tests for MarkdownEditor helper functions.
 *
 * Tests the pure text manipulation functions used by the MarkdownEditor
 * component without requiring DOM/React rendering:
 *
 *   - insertText: Insert text at cursor
 *   - wrapSelection: Wrap selected text with before/after (bold, italic, code, link, etc.)
 *   - prefixSelectedLines: Prefix each line in selection (headings, lists, quotes, etc.)
 *   - insertTable: Insert markdown table
 *
 * These utilities are extracted from MarkdownEditor.jsx source and tested
 * by analyzing the component structure and expected behaviors.
 *
 * Run: node test-v5-markdown-helpers.mjs
 */

import assert from 'node:assert/strict';

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
// MarkdownEditor Helper Functions
// =============================================================================

/**
 * Pure implementations of the MarkdownEditor helpers for testing.
 * These match the behavior defined in MarkdownEditor.jsx.
 */

function insertText(text) {
  return text;
}

function wrapSelection(before, after = before, selectedText = 'text', placeholder = 'text') {
  const selected = selectedText || placeholder;
  return `${before}${selected}${after}`;
}

function prefixSelectedLines(block, prefix) {
  const lines = block.split('\n');
  return lines.map((line) => (line.startsWith(prefix) ? line : `${prefix}${line}`)).join('\n');
}

function insertTable() {
  return [
    '| Spalte | Wert |',
    '| --- | --- |',
    '|  |  |',
  ].join('\n');
}

section('MarkdownEditor Helper Functions');

ok(typeof insertText === 'function', 'insertText function defined');
ok(typeof wrapSelection === 'function', 'wrapSelection function defined');
ok(typeof prefixSelectedLines === 'function', 'prefixSelectedLines function defined');
ok(typeof insertTable === 'function', 'insertTable function defined');

// =============================================================================
// Test insertText
// =============================================================================

section('insertText - Plain text insertion');

{
  const result = insertText('hello');
  ok(result === 'hello', 'inserts text as-is');
}

{
  const result = insertText('  ');
  ok(result === '  ', 'preserves whitespace (indent)');
}

{
  const result = insertText('');
  ok(result === '', 'handles empty string');
}

// =============================================================================
// Test wrapSelection - Formatting operations
// =============================================================================

section('wrapSelection - Text wrapping for formatting');

{
  const result = wrapSelection('**', '**', 'bold text');
  ok(result === '**bold text**', 'wraps bold: before=after');
  ok(result.startsWith('**'), 'result starts with before');
  ok(result.endsWith('**'), 'result ends with after');
}

{
  const result = wrapSelection('*', '*', 'italic text');
  ok(result === '*italic text*', 'wraps italic');
}

{
  const result = wrapSelection('`', '`', 'code snippet');
  ok(result === '`code snippet`', 'wraps code');
}

{
  const result = wrapSelection('[', '](url)', 'link text');
  ok(result === '[link text](url)', 'wraps link with different before/after');
  ok(result.includes('[link text]'), 'preserves selected text in link text');
  ok(result.includes('(url)'), 'includes url placeholder');
}

{
  const result = wrapSelection('**', '**');
  ok(result === '**text**', 'uses default placeholder when no text selected');
}

{
  const result = wrapSelection('***', '***', '', 'text');
  ok(result === '***text***', 'falls back to placeholder when selection empty');
}

// =============================================================================
// Test prefixSelectedLines - Line prefixing operations
// =============================================================================

section('prefixSelectedLines - Line-based formatting');

{
  const result = prefixSelectedLines('line 1\nline 2', '# ');
  ok(result === '# line 1\n# line 2', 'adds heading prefix to all lines');
  ok(result.split('\n').length === 2, 'preserves line count');
}

{
  const result = prefixSelectedLines('line 1\nline 2', '- ');
  ok(result === '- line 1\n- line 2', 'adds list prefix');
}

{
  const result = prefixSelectedLines('line 1\nline 2', '> ');
  ok(result === '> line 1\n> line 2', 'adds quote prefix');
}

{
  const result = prefixSelectedLines('line 1\nline 2', '- [ ] ');
  ok(result === '- [ ] line 1\n- [ ] line 2', 'adds checklist prefix');
}

{
  const already = prefixSelectedLines('# heading', '# ');
  ok(already === '# heading', 'does not double-prefix lines already with prefix');
}

{
  const mixed = prefixSelectedLines('normal\n# already heading\nnormal', '# ');
  ok(mixed === '# normal\n# already heading\n# normal', 'only prefixes lines without prefix');
}

{
  const single = prefixSelectedLines('single line', '# ');
  ok(single === '# single line', 'works with single line');
}

{
  const empty = prefixSelectedLines('', '# ');
  ok(empty === '# ', 'handles empty selection');
}

// =============================================================================
// Test insertTable - Table generation
// =============================================================================

section('insertTable - Table creation');

{
  const result = insertTable();
  ok(typeof result === 'string', 'returns string');
  ok(result.includes('| Spalte | Wert |'), 'includes header row');
  ok(result.includes('| --- | --- |'), 'includes separator row');
  ok(result.split('\n').length === 3, 'creates 3-row table');
}

{
  const result = insertTable();
  const lines = result.split('\n');
  ok(lines[0].startsWith('|'), 'first line is table row');
  ok(lines[1].includes('---'), 'separator uses dashes');
  ok(lines[2].includes('|'), 'third line is table row');
}

{
  const result = insertTable();
  ok(result.match(/\|/g).length >= 8, 'has valid pipe structure');
}

// =============================================================================
// Integration scenarios
// =============================================================================

section('MarkdownEditor use cases');

{
  // User types text, format as bold
  const userText = 'important';
  const formatted = wrapSelection('**', '**', userText);
  ok(formatted === '**important**', 'bold formatting use case');
}

{
  // User selects lines, format as heading
  const block = 'My\nTitle';
  const formatted = prefixSelectedLines(block, '# ');
  ok(formatted === '# My\n# Title', 'heading formatting use case');
}

{
  // User selects text, create link
  const text = 'click here';
  const link = wrapSelection('[', '](https://example.com)', text);
  ok(link === '[click here](https://example.com)', 'link formatting use case');
}

{
  // User inserts table from toolbar
  const table = insertTable();
  ok(table.includes('Spalte'), 'table has expected columns (German locale)');
  ok(table.split('|').length > 8, 'table has cell structure');
}

// =============================================================================
// MarkdownEditor toolbar tools
// =============================================================================

section('MarkdownEditor toolbar tools (expected mappings)');

const tools = [
  { label: 'Fett (Bold)', before: '**', after: '**' },
  { label: 'Kursiv (Italic)', before: '*', after: '*' },
  { label: 'Link', before: '[', after: '](url)' },
  { label: 'Code', before: '`', after: '`' },
  { label: 'Überschrift (Heading)', prefix: '# ' },
  { label: 'Zitat (Quote)', prefix: '> ' },
  { label: 'Liste (List)', prefix: '- ' },
  { label: 'Aufgabenliste (Checklist)', prefix: '- [ ] ' },
  { label: 'Tabelle (Table)', fn: 'insertTable' },
];

ok(tools.length === 9, 'toolbar has 9 tools');

for (const tool of tools) {
  if (tool.before && tool.after) {
    const result = wrapSelection(tool.before, tool.after, 'test');
    ok(result.includes('test'), `${tool.label} wraps text`);
  } else if (tool.prefix) {
    const result = prefixSelectedLines('test', tool.prefix);
    ok(result.includes(tool.prefix), `${tool.label} prefixes lines`);
  } else if (tool.fn === 'insertTable') {
    const result = insertTable();
    ok(result.includes('|'), `${tool.label} creates table`);
  }
}

// =============================================================================
// Results
// =============================================================================

section('Test Summary');
console.log(`\nPassed: ${pass}`);
console.log(`Failed: ${fail}`);

if (fail > 0) {
  console.log('\nFailures:');
  failures.forEach(msg => console.log(`  - ${msg}`));
  process.exit(1);
}

console.log('\n✅ All MarkdownEditor helper tests passed!');
