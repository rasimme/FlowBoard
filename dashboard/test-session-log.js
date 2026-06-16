'use strict';

// T-375-3 — SESSIONS.md entry formatting + insertion (pure).

const { formatSessionEntry, insertEntry } = require('./session-log');

let pass = 0, fail = 0;
const failures = [];
function ok(c, m) { if (c) { pass++; console.log(`  ok - ${m}`); } else { fail++; failures.push(m); console.log(`  not ok - ${m}`); } }

console.log('# Session log (T-375-3)');

// --- formatSessionEntry ---
{
  const e = formatSessionEntry({ date: '2026-06-15', agent: 'claude-code-3', summary: 'Did X.' });
  ok(e.startsWith('### 2026-06-15 — claude-code-3'), 'heading uses date + agent when no title');
  ok(e.includes('Did X.'), 'body contains summary');
  ok(e.endsWith('\n'), 'entry ends with newline');
}
{
  const e = formatSessionEntry({ date: '2026-06-15', agent: 'claude-code-3', summary: 'Body', title: 'Closed T-1' });
  ok(e.startsWith('### 2026-06-15 — Closed T-1'), 'heading uses title when provided');
}

// --- insertEntry: newest-first under "## Session Log" ---
{
  const existing = '# Session Log — p\n\n## Session Log\n\n### 2026-06-01 — old\n- prior\n';
  const block = formatSessionEntry({ date: '2026-06-15', agent: 'a', summary: 'new entry' });
  const out = insertEntry(existing, block);
  ok(out.indexOf('new entry') < out.indexOf('old'), 'new entry inserted above older entries');
  ok(out.includes('### 2026-06-01 — old') && out.includes('- prior'), 'old entry preserved (append-only)');
  ok(out.indexOf('## Session Log') < out.indexOf('new entry'), 'entry stays under the Session Log header');
}

// --- insertEntry: no marker → appended at end ---
{
  const out = insertEntry('just text', formatSessionEntry({ date: '2026-06-15', agent: 'a', summary: 'z' }));
  ok(out.includes('just text') && out.includes('z'), 'no-marker content is kept and entry appended');
}

console.log(`\n# session-log: ${pass} passed, ${fail} failed`);
if (fail > 0) { console.error('FAILURES:\n' + failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
