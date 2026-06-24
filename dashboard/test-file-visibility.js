'use strict';

// T-375-1 — Editor file-visibility allowlist (canonical knowledge layer).

const { isEditorVisible } = require('./file-visibility');

let pass = 0, fail = 0;
const failures = [];
function ok(c, m) { if (c) { pass++; console.log(`  ok - ${m}`); } else { fail++; failures.push(m); console.log(`  not ok - ${m}`); } }

console.log('# File visibility (T-375-1)');

// Canonical knowledge-layer Markdown is visible by default.
ok(isEditorVisible('PROJECT.md') === true, 'root PROJECT.md visible');
ok(isEditorVisible('SESSIONS.md') === true, 'root SESSIONS.md visible');
ok(isEditorVisible('DECISIONS.md') === true, 'root DECISIONS.md visible');
ok(isEditorVisible('context/architecture.md') === true, 'context/*.md visible');
ok(isEditorVisible('specs/T-1-x.md') === true, 'specs/*.md visible');
ok(isEditorVisible('PROJECT.MD') === true, 'canonical root names are case-insensitive');

// Arbitrary Markdown and operational files are hidden unless includeHidden is used.
ok(isEditorVisible('README.MD') === false, 'arbitrary root Markdown hidden');
ok(isEditorVisible('DEPLOYMENT.md') === false, 'custom root Markdown hidden');
ok(isEditorVisible('context/archive/old.md') === false, 'nested context Markdown hidden');
ok(isEditorVisible('specs/archive/old.md') === false, 'nested specs Markdown hidden');
ok(isEditorVisible('overview.json') === false, 'overview.json hidden');
ok(isEditorVisible('specs/_index.json') === false, 'specs/_index.json hidden');
ok(isEditorVisible('canvas.json.pre-db.bak') === false, 'canvas backup hidden');
ok(isEditorVisible('canvas.json.pre-db.bak.1781') === false, 'epoch backup hidden');
ok(isEditorVisible('tasks.json.migrated') === false, 'migrated tasks hidden');
ok(isEditorVisible('tasks.tmp') === false, 'tmp file hidden');
ok(isEditorVisible('canvas.json') === false, 'canvas.json hidden');

console.log(`\n# file-visibility: ${pass} passed, ${fail} failed`);
if (fail > 0) { console.error('FAILURES:\n' + failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
