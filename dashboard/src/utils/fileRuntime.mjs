export function flattenFiles(entries = []) {
  const files = [];
  for (const entry of entries) {
    if (entry.type === 'directory') {
      files.push(...flattenFiles(entry.children || []));
    } else {
      files.push(entry);
    }
  }
  return files;
}

export function fileExists(entries, filePath) {
  return flattenFiles(entries).some(entry => entry.path === filePath);
}

export function findFileEntry(entries, filePath) {
  return flattenFiles(entries).find(entry => entry.path === filePath) || null;
}

export function getFileVersion(file) {
  if (!file) return null;
  return file.version || `${file.modified || ''}:${file.size ?? ''}`;
}

export function pickDefaultFile(entries, preferredPath) {
  const files = flattenFiles(entries);
  if (preferredPath && files.some(entry => entry.path === preferredPath)) return preferredPath;
  if (files.some(entry => entry.path === 'PROJECT.md')) return 'PROJECT.md';

  const markdownFile = files.find(entry => entry.name?.toLowerCase().endsWith('.md'));
  return markdownFile?.path || files[0]?.path || null;
}

export function getDefaultFileSelectionAction({
  entries = [],
  selectedPath = null,
  preferredPath = null,
  dirty = false,
  conflict = null,
  pendingSpecFile = null,
} = {}) {
  if (!entries?.length || pendingSpecFile) return { type: 'none' };
  if (selectedPath && fileExists(entries, selectedPath)) return { type: 'none' };
  if (selectedPath && (dirty || conflict?.path === selectedPath)) return { type: 'none' };

  const path = pickDefaultFile(entries, preferredPath);
  return path ? { type: 'select', path } : { type: 'none' };
}

export function getFileReconciliationAction({
  entries = [],
  currentPath,
  loadedFile,
  dirty = false,
  ignoredConflict = null,
} = {}) {
  if (!currentPath) return { type: 'none' };

  const entry = findFileEntry(entries, currentPath);
  if (!entry) {
    if (ignoredConflict?.path === currentPath && ignoredConflict?.deleted) return { type: 'none' };
    if (dirty) return { type: 'conflict', conflict: { path: currentPath, deleted: true } };
    return { type: 'missing', path: currentPath };
  }

  const treeVersion = getFileVersion(entry);
  const loadedVersion = getFileVersion(loadedFile);
  if (!loadedVersion || !treeVersion || treeVersion === loadedVersion) return { type: 'none' };

  if (dirty) {
    if (ignoredConflict?.path === currentPath && ignoredConflict?.version === treeVersion) return { type: 'none' };
    return { type: 'conflict', conflict: { path: currentPath, version: treeVersion } };
  }

  return { type: 'reload', path: currentPath };
}
