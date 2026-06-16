import assert from 'node:assert/strict';

import {
  fileExists,
  getDefaultFileSelectionAction,
  getFileReconciliationAction,
  pickDefaultFile,
} from './src/utils/fileRuntime.mjs';

const tree = [
  { type: 'file', name: 'PROJECT.md', path: 'PROJECT.md', version: '1:10', size: 10 },
  {
    type: 'directory',
    name: 'context',
    path: 'context',
    children: [
      { type: 'file', name: 'notes.md', path: 'context/notes.md', version: '2:20', size: 20 },
    ],
  },
];

assert.equal(fileExists(tree, 'context/notes.md'), true, 'nested file is found');
assert.equal(fileExists(tree, 'context/missing.md'), false, 'missing file is not found');

assert.equal(
  pickDefaultFile(tree, 'context/notes.md'),
  'context/notes.md',
  'preferred existing file wins'
);
assert.equal(
  pickDefaultFile(tree, 'context/missing.md'),
  'PROJECT.md',
  'PROJECT.md is the fallback default'
);

assert.deepEqual(
  getFileReconciliationAction({
    entries: tree,
    currentPath: 'context/notes.md',
    loadedFile: { path: 'context/notes.md', version: '1:20' },
    dirty: false,
  }),
  { type: 'reload', path: 'context/notes.md' },
  'clean selected file reloads when tree version changes'
);

assert.deepEqual(
  getFileReconciliationAction({
    entries: tree,
    currentPath: 'context/notes.md',
    loadedFile: { path: 'context/notes.md', version: '1:20' },
    dirty: true,
  }),
  { type: 'conflict', conflict: { path: 'context/notes.md', version: '2:20' } },
  'dirty selected file raises a conflict when tree version changes'
);

assert.deepEqual(
  getFileReconciliationAction({
    entries: tree,
    currentPath: 'context/notes.md',
    loadedFile: { path: 'context/notes.md', version: '1:20' },
    dirty: true,
    ignoredConflict: { path: 'context/notes.md', version: '2:20' },
  }),
  { type: 'none' },
  'ignored dirty conflict is not re-raised for the same version'
);

assert.deepEqual(
  getFileReconciliationAction({
    entries: tree,
    currentPath: 'context/missing.md',
    loadedFile: { path: 'context/missing.md', version: '1:20' },
    dirty: false,
  }),
  { type: 'missing', path: 'context/missing.md' },
  'clean deleted selected file can be cleared and replaced by fallback'
);

assert.deepEqual(
  getFileReconciliationAction({
    entries: tree,
    currentPath: 'context/missing.md',
    loadedFile: { path: 'context/missing.md', version: '1:20' },
    dirty: true,
  }),
  { type: 'conflict', conflict: { path: 'context/missing.md', deleted: true } },
  'dirty deleted selected file keeps local edits behind a conflict'
);

assert.deepEqual(
  getFileReconciliationAction({
    entries: tree,
    currentPath: 'context/missing.md',
    loadedFile: { path: 'context/missing.md', version: '1:20' },
    dirty: true,
    ignoredConflict: { path: 'context/missing.md', deleted: true },
  }),
  { type: 'none' },
  'ignored deleted-file conflict is not re-raised while the user keeps editing'
);

assert.deepEqual(
  getDefaultFileSelectionAction({
    entries: tree,
    selectedPath: 'context/missing.md',
    preferredPath: 'context/missing.md',
    dirty: true,
    conflict: { path: 'context/missing.md', deleted: true },
  }),
  { type: 'none' },
  'dirty deleted-file conflict blocks automatic fallback selection'
);

assert.deepEqual(
  getDefaultFileSelectionAction({
    entries: tree,
    selectedPath: 'context/missing.md',
    preferredPath: 'context/missing.md',
    dirty: false,
  }),
  { type: 'select', path: 'PROJECT.md' },
  'clean missing selected file falls back to PROJECT.md without preserving task context'
);

assert.deepEqual(
  getDefaultFileSelectionAction({
    entries: tree,
    selectedPath: 'context/missing.md',
    preferredPath: 'context/notes.md',
    dirty: false,
    pendingSpecFile: 'context/spec.md',
  }),
  { type: 'none' },
  'pending spec open blocks automatic fallback selection'
);

console.log('✅ file runtime tests passed');
