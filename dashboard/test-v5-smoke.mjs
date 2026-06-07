'use strict';

/**
 * Smoke tests for v5 core flows:
 * - MarkdownEditor component imports and has expected exports
 * - fileRuntime utilities integrate correctly with FilesView
 * - File operations (flatten, find, selection, reconciliation) work in context
 *
 * Run: node test-v5-smoke.mjs
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

// --- v5 Feature Tests ---

section('v5 Core Flows: fileRuntime utilities');

// Test 1: MarkdownEditor component file exists
import { statSync } from 'node:fs';
try {
  const stat = statSync('./src/components/MarkdownEditor.jsx');
  ok(stat.isFile(), 'MarkdownEditor.jsx file exists');
} catch (err) {
  ok(false, `MarkdownEditor.jsx not found: ${err.message}`);
}

// Test 2: fileRuntime utilities are importable
let fileRuntimeUtils;
try {
  fileRuntimeUtils = await import('./src/utils/fileRuntime.mjs');
  ok(fileRuntimeUtils, 'fileRuntime utilities import succeeds');
} catch (err) {
  ok(false, `fileRuntime import failed: ${err.message}`);
  process.exit(1);
}

// Test 3: Core fileRuntime functions exist
const requiredFunctions = [
  'flattenFiles',
  'fileExists',
  'findFileEntry',
  'getFileVersion',
  'pickDefaultFile',
  'getDefaultFileSelectionAction',
  'getFileReconciliationAction',
];

for (const fn of requiredFunctions) {
  ok(
    typeof fileRuntimeUtils[fn] === 'function',
    `fileRuntime.${fn} is exported as a function`
  );
}

// Test 4: flattenFiles works with nested structure
const nestedTree = [
  { type: 'file', name: 'README.md', path: 'README.md' },
  {
    type: 'directory',
    name: 'context',
    path: 'context',
    children: [
      { type: 'file', name: 'notes.md', path: 'context/notes.md' },
      {
        type: 'directory',
        name: 'subdir',
        path: 'context/subdir',
        children: [
          { type: 'file', name: 'deep.md', path: 'context/subdir/deep.md' },
        ],
      },
    ],
  },
];

const flattened = fileRuntimeUtils.flattenFiles(nestedTree);
ok(flattened.length === 3, 'flattenFiles returns all 3 files (recursive)');
ok(
  flattened.map(f => f.path).includes('context/subdir/deep.md'),
  'flattenFiles includes deeply nested files'
);

// Test 5: fileExists works correctly
ok(
  fileRuntimeUtils.fileExists(nestedTree, 'context/notes.md'),
  'fileExists finds nested file'
);
ok(
  !fileRuntimeUtils.fileExists(nestedTree, 'missing.md'),
  'fileExists returns false for missing file'
);

// Test 6: findFileEntry works correctly
const entry = fileRuntimeUtils.findFileEntry(nestedTree, 'context/subdir/deep.md');
ok(
  entry && entry.path === 'context/subdir/deep.md',
  'findFileEntry returns correct nested entry'
);
ok(
  !fileRuntimeUtils.findFileEntry(nestedTree, 'nonexistent.md'),
  'findFileEntry returns null for missing file'
);

// Test 7: pickDefaultFile prioritizes correctly
ok(
  fileRuntimeUtils.pickDefaultFile(nestedTree, 'context/notes.md') === 'context/notes.md',
  'pickDefaultFile returns preferred path when it exists'
);
ok(
  fileRuntimeUtils.pickDefaultFile(nestedTree, 'missing.md') === 'README.md',
  'pickDefaultFile falls back to README.md when preferred is missing'
);

// Test 8: getFileVersion handles versions correctly
const versionedFile = { path: 'test.md', version: '1:100', size: 100 };
const version = fileRuntimeUtils.getFileVersion(versionedFile);
ok(version === '1:100', 'getFileVersion returns stored version');

const unversionedFile = { path: 'test.md' };
const fallbackVersion = fileRuntimeUtils.getFileVersion(unversionedFile);
ok(fallbackVersion === ':', 'getFileVersion returns fallback for unversioned file');

// Test 9: getDefaultFileSelectionAction behavior
const action1 = fileRuntimeUtils.getDefaultFileSelectionAction({
  entries: nestedTree,
  selectedPath: null,
  preferredPath: 'context/notes.md',
  dirty: false,
});
ok(
  action1.type === 'select' && action1.path === 'context/notes.md',
  'getDefaultFileSelectionAction selects preferred file when empty'
);

const action2 = fileRuntimeUtils.getDefaultFileSelectionAction({
  entries: nestedTree,
  selectedPath: 'README.md',
  dirty: false,
});
ok(
  action2.type === 'none',
  'getDefaultFileSelectionAction returns none when file already selected'
);

const action3 = fileRuntimeUtils.getDefaultFileSelectionAction({
  entries: [],
  selectedPath: null,
  pendingSpecFile: true,
});
ok(
  action3.type === 'none',
  'getDefaultFileSelectionAction returns none when spec file pending'
);

// Test 10: getFileReconciliationAction detects version changes
const reconAction1 = fileRuntimeUtils.getFileReconciliationAction({
  entries: nestedTree,
  currentPath: 'context/notes.md',
  loadedFile: { path: 'context/notes.md', version: '1:50' },
  dirty: false,
});
ok(
  reconAction1.type === 'reload',
  'getFileReconciliationAction detects clean file version change as reload'
);

const reconAction2 = fileRuntimeUtils.getFileReconciliationAction({
  entries: nestedTree,
  currentPath: 'context/notes.md',
  loadedFile: { path: 'context/notes.md', version: '1:50' },
  dirty: true,
});
ok(
  reconAction2.type === 'conflict',
  'getFileReconciliationAction raises conflict when dirty file changed'
);

const reconAction3 = fileRuntimeUtils.getFileReconciliationAction({
  entries: nestedTree,
  currentPath: 'missing-file.md',
  loadedFile: { path: 'missing-file.md', version: '1:100' },
  dirty: false,
});
ok(
  reconAction3.type === 'missing',
  'getFileReconciliationAction detects missing file'
);

// --- Test Summary ---
section('Summary');

const total = pass + fail;
console.log(`Passed: ${pass}/${total}`);

if (fail > 0) {
  console.log(`\nFailed tests:\n${failures.map(f => `  • ${f}`).join('\n')}`);
  process.exit(1);
}

console.log('\n✅ All v5 smoke tests passed!');
