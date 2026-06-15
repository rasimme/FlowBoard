import { useState, useEffect, useCallback, useRef, useMemo, lazy, Suspense } from 'react';
import { useAppState } from '../context/AppStateContext.jsx';
import { useDashboard } from '../context/DashboardContext.jsx';
import { useNavigation } from '../context/NavigationContext.jsx';
import { Button, Input, Modal } from '../components/index.js';
import { useHaptic } from '../hooks/useHaptic.js';
import { useCustomScroll } from '../hooks/useCustomScroll.js';
import { FolderOpen, Folder, FileText, FileJson, FileCode, File, Pencil, Save, X, Trash2, Upload, Download, FilePlus } from 'lucide-react';
import { apiFetch } from '../utils/apiFetch.js';
import {
  fileExists,
  getDefaultFileSelectionAction,
  getFileReconciliationAction,
  getFileVersion,
} from '../utils/fileRuntime.mjs';

const MarkdownEditor = lazy(() => import('../components/MarkdownEditor.jsx'));
const MarkdownPreview = lazy(() => import('../components/MarkdownPreview.jsx'));

function isEditablePath(filePath) {
  if (!filePath) return false;
  return filePath.startsWith('context/') || filePath.startsWith('specs/');
}

const CATEGORY_LABELS = { always: 'always loaded', lazy: 'lazy loaded', optional: 'context' };
const LAST_OPENED_STORAGE_KEY = 'flowboard.files.lastOpenedByProject';
const FILE_POLL_INTERVAL_MS = 5000;

function formatSize(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function getFileIcon(name) {
  const ext = name.split('.').pop();
  if (ext === 'json') return <FileJson size={14} />;
  if (ext === 'md') return <FileText size={14} />;
  if (['js', 'jsx', 'ts', 'tsx', 'css', 'html'].includes(ext)) return <FileCode size={14} />;
  return <File size={14} />;
}

function expandParentsOf(path, dirs) {
  const parts = path.split('/');
  const next = new Set(dirs);
  for (let i = 1; i < parts.length; i++) {
    next.add(parts.slice(0, i).join('/'));
  }
  return next;
}

function readLastOpenedFiles() {
  try {
    return JSON.parse(sessionStorage.getItem(LAST_OPENED_STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

function writeLastOpenedFile(project, filePath) {
  try {
    sessionStorage.setItem(LAST_OPENED_STORAGE_KEY, JSON.stringify({
      ...readLastOpenedFiles(),
      [project]: filePath,
    }));
  } catch {
    // Session persistence is a convenience only; runtime state still works.
  }
}

function filenameFromTitle(title) {
  const base = String(title || '')
    .trim()
    .replace(/\u00df/g, 'ss')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\.md$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${base || 'untitled'}.md`;
}

// --- Tree node (uses legacy CSS classes) ---
function TreeNode({ entry, depth, expandedDirs, onToggleDir, selectedFile, onSelectFile }) {
  const indent = 14 + depth * 16;

  if (entry.type === 'directory') {
    const expanded = expandedDirs.has(entry.path);
    return (
      <>
        <div
          className="tree-item directory"
          style={{ paddingLeft: `${indent}px` }}
          onClick={() => onToggleDir(entry.path)}
        >
          <span className="tree-icon">
            {expanded ? <FolderOpen size={14} /> : <Folder size={14} />}
          </span>
          <span className="tree-name">{entry.name}</span>
          <span className="tree-meta">{entry.children?.length}</span>
        </div>
        {expanded && entry.children?.map(child => (
          <TreeNode
            key={child.path}
            entry={child}
            depth={depth + 1}
            expandedDirs={expandedDirs}
            onToggleDir={onToggleDir}
            selectedFile={selectedFile}
            onSelectFile={onSelectFile}
          />
        ))}
      </>
    );
  }

  const isSelected = selectedFile === entry.path;
  return (
    <div
      className={`tree-item${isSelected ? ' selected' : ''}`}
      style={{ paddingLeft: `${indent}px` }}
      onClick={() => onSelectFile(entry.path)}
    >
      {entry.category && <span className={`tree-badge ${entry.category}`} />}
      <span className="tree-icon">{getFileIcon(entry.name)}</span>
      <span className="tree-name">{entry.name}</span>
      <span className="tree-meta">{formatSize(entry.size)}</span>
    </div>
  );
}

// --- File preview (uses legacy CSS classes) ---
function FilePreview({
  fileData,
  filePath,
  projectName,
  onDeleted,
  onSaved,
  previewScrollRef,
  fromTaskId,
  onBackToTask,
  onBackToList,
  conflict,
  onReloadFromDisk,
  onKeepLocalChanges,
  onDirtyChange,
}) {
  const haptic = useHaptic();
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const dirtyStateRef = useRef(false);

  const fileVersion = getFileVersion(fileData);
  useEffect(() => {
    setEditing(false);
    setEditContent('');
  }, [filePath]);

  useEffect(() => {
    if (editing && !conflict && !dirtyStateRef.current) setEditContent(fileData?.content || '');
  }, [conflict, editing, fileData?.content, fileVersion]);

  const dirty = editing && editContent !== (fileData?.content || '');
  useEffect(() => {
    dirtyStateRef.current = dirty;
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  // Keyboard shortcuts
  useEffect(() => {
    if (!editing) return;
    const handler = (e) => {
      if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        handleSave();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        handleCancel();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  const handleEdit = () => {
    haptic.light();
    setEditContent(fileData.content);
    setEditing(true);
  };

  const handleCancel = () => {
    setEditing(false);
    setEditContent('');
  };

  const handleReloadFromDisk = () => {
    dirtyStateRef.current = false;
    onDirtyChange?.(false);
    setEditContent(fileData?.content || '');
    onReloadFromDisk?.();
  };

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const res = await apiFetch(`/api/projects/${projectName}/files/${filePath}`, {
        method: 'PUT',
        body: JSON.stringify({ content: editContent }),
      });
      if (!res.ok) throw new Error('Save failed');
      const saved = await res.json();
      haptic.medium();
      if (window.showToast) window.showToast('File saved', 'success');
      onSaved?.({
        ...fileData,
        ...saved,
        content: editContent,
        category: fileData.category,
      });
      setEditContent('');
      setEditing(false);
    } catch (err) {
      console.warn('[file-save]', err);
      haptic.error();
      if (window.showToast) window.showToast('Save failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    try {
      const res = await apiFetch(`/api/projects/${projectName}/files/${filePath}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
      haptic.medium();
      if (window.showToast) window.showToast('File deleted', 'success');
      setShowDeleteModal(false);
      onDeleted?.();
    } catch (err) {
      console.warn('[file-delete]', err);
      haptic.error();
      if (window.showToast) window.showToast('Delete failed', 'error');
      setShowDeleteModal(false);
    }
  };

  // Guard on filePath too: when the selection is cleared (e.g. mobile "← Files")
  // fileData may briefly linger a render before it's reset — without this the
  // filePath.split() below would throw (T-367-3).
  if (!fileData || !filePath) {
    return <div className="file-preview-empty">Select a file to preview</div>;
  }

  const ext = filePath.split('.').pop();
  const editable = isEditablePath(filePath);
  const unsaved = dirty;
  const fileName = filePath.split('/').pop();

  return (
    <>
      <div className="file-preview-header">
        {/* T-367-3 / T-368-4: mobile master-detail back button. Hidden on wide
            screens (CSS) AND suppressed when opened from a task — then the
            single "← Back to Task" is the one obvious back action, instead of
            two competing left-arrow buttons. */}
        {!fromTaskId && (
          <button className="file-back-to-list" onClick={onBackToList} aria-label="Back to file list">← Files</button>
        )}
        {fromTaskId && (
          <button className="file-back-btn" onClick={onBackToTask}>← Back to Task</button>
        )}
        <div className="file-preview-info">
          <span className="file-preview-name">
            {filePath}
            {unsaved && <span className="unsaved-dot" />}
          </span>
          <span className="file-preview-size">{formatSize(fileData.size)}</span>
          {fileData.category && (
            <span className={`file-preview-badge ${fileData.category}`}>
              {CATEGORY_LABELS[fileData.category]}
            </span>
          )}
        </div>
        <div className="file-preview-actions">
          {editable && !editing && (
            <button className="btn btn-ghost btn-sm" onClick={handleEdit} title="Edit">
              <Pencil size={14} />
            </button>
          )}
          {editing && (
            <>
              <button className="btn btn-ghost btn-sm" onClick={handleSave} disabled={saving} title="Save (Ctrl+S)" style={{ color: 'var(--ok)' }}>
                <Save size={14} />
              </button>
              <button className="btn btn-ghost btn-sm" onClick={handleCancel} title="Cancel (Esc)">
                <X size={14} />
              </button>
            </>
          )}
          {!editing && (
            <button className="btn btn-ghost btn-sm" onClick={() => {
              const blob = new Blob([fileData.content], { type: 'text/markdown' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = fileName;
              a.click();
              URL.revokeObjectURL(url);
            }} title="Download">
              <Download size={14} />
            </button>
          )}
          {editable && !editing && (
            <button className="delete-btn" onClick={() => { haptic.light(); setShowDeleteModal(true); }} title="Delete" style={{ opacity: 0.6 }}>
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>
      {conflict && (
        <div className="file-conflict-banner">
          <span>{conflict.deleted ? 'File was deleted on disk.' : 'File changed on disk.'}</span>
          <button className="btn btn-ghost btn-sm" onClick={handleReloadFromDisk}>Reload</button>
          <button className="btn btn-ghost btn-sm" onClick={onKeepLocalChanges}>Keep editing</button>
        </div>
      )}
      <div className={`file-preview-body${editing ? '' : ''}`} ref={editing ? undefined : previewScrollRef}>
        {editing ? (
          <Suspense fallback={<div className="file-preview-loading">Loading editor...</div>}>
            <MarkdownEditor
              value={editContent}
              onChange={setEditContent}
              onSave={handleSave}
              onCancel={handleCancel}
            />
          </Suspense>
        ) : ext === 'json' ? (
          <JsonPreview content={fileData.content} />
        ) : ext === 'md' ? (
          <Suspense fallback={<div className="file-preview-loading">Loading preview...</div>}>
            <MarkdownPreview content={fileData.content} />
          </Suspense>
        ) : (
          <pre className="mono" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '12px', lineHeight: 1.5 }}>
            {fileData.content}
          </pre>
        )}
      </div>

      {showDeleteModal && (
        <Modal
          open
          onClose={() => setShowDeleteModal(false)}
          title={`Delete ${fileName}?`}
          actions={<>
            <Modal.Button variant="secondary" onClick={() => setShowDeleteModal(false)}>Cancel</Modal.Button>
            <Modal.Button variant="danger" onClick={handleDelete}>Delete</Modal.Button>
          </>}
        >
          <p className="text-sm text-muted">This action cannot be undone.</p>
        </Modal>
      )}
    </>
  );
}

// --- JSON syntax highlighting ---
const JSON_TOKEN_RE = /("(?:[^"\\]|\\.)*")\s*(:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(true|false|null)|([{}\[\],])/g;

function tokenizeJson(jsonStr) {
  const tokens = [];
  let lastIndex = 0;
  let match;
  JSON_TOKEN_RE.lastIndex = 0;
  while ((match = JSON_TOKEN_RE.exec(jsonStr)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ type: 'ws', value: jsonStr.slice(lastIndex, match.index) });
    }
    if (match[1] !== undefined) {
      if (match[2] !== undefined) {
        tokens.push({ type: 'key', value: match[1] });
        tokens.push({ type: 'ws', value: match[0].slice(match[1].length, -1) });
        tokens.push({ type: 'punctuation', value: ':' });
      } else {
        tokens.push({ type: 'string', value: match[1] });
      }
    } else if (match[3] !== undefined) {
      tokens.push({ type: 'number', value: match[3] });
    } else if (match[4] !== undefined) {
      // CSS uses .json-bool and .json-null (not .json-boolean)
      tokens.push({ type: match[4] === 'null' ? 'null' : 'bool', value: match[4] });
    } else if (match[5] !== undefined) {
      tokens.push({ type: 'punctuation', value: match[5] });
    }
    lastIndex = JSON_TOKEN_RE.lastIndex;
  }
  if (lastIndex < jsonStr.length) {
    tokens.push({ type: 'ws', value: jsonStr.slice(lastIndex) });
  }
  return tokens;
}

function JsonPreview({ content }) {
  const highlighted = useMemo(() => {
    let formatted;
    try {
      formatted = JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      return null;
    }
    return tokenizeJson(formatted);
  }, [content]);

  if (!highlighted) {
    return <pre className="json-content">{content}</pre>;
  }

  return (
    <pre className="json-content">
      {highlighted.map((tok, i) =>
        tok.type === 'ws' ? tok.value : (
          <span key={i} className={`json-${tok.type}`}>{tok.value}</span>
        )
      )}
    </pre>
  );
}

// --- Main view ---
export default function FilesView() {
  const { state } = useAppState();
  const { switchTab } = useDashboard();
  const { intent: navIntent, clearPendingNewFile, goToTask } = useNavigation();
  const viewedProject = state?.viewedProject;

  const [fileTree, setFileTree] = useState(null);
  const [expandedDirs, setExpandedDirs] = useState(new Set(['context']));
  const [selectedFile, setSelectedFile] = useState(null);
  const [fileData, setFileData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [treeLoading, setTreeLoading] = useState(false);
  const [fileConflict, setFileConflict] = useState(null);
  const uploadInputRef = useRef(null);
  // T-221: when FilesView is opened from a task's "Open spec" action, we
  // remember the originating task ID so the spec preview can render a
  // "← Back to Task" button. Cleared as soon as the user picks a different
  // file from the tree (manual navigation = no implicit "back" target).
  const [fromTaskId, setFromTaskId] = useState(null);
  // T-222: file upload state
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  // overview quick action "New File" — consume the navigation intent (T-356)
  useEffect(() => {
    if (navIntent.pendingNewFile) {
      clearPendingNewFile();
      setCreateOpen(true);
    }
  }, [navIntent.pendingNewFile]); // eslint-disable-line react-hooks/exhaustive-deps
  const [newFileTitle, setNewFileTitle] = useState('');
  const [creatingFile, setCreatingFile] = useState(false);
  const abortRef = useRef(null);
  const lastOpenedRef = useRef(readLastOpenedFiles());
  const selectedFileRef = useRef(null);
  const fileDataRef = useRef(null);
  const dirtyRef = useRef(false);
  const ignoredConflictRef = useRef(null);

  const treeScrollRef = useCustomScroll();
  const previewScrollRef = useCustomScroll();

  useEffect(() => { selectedFileRef.current = selectedFile; }, [selectedFile]);
  useEffect(() => { fileDataRef.current = fileData; }, [fileData]);

  const setLastOpenedFile = useCallback((filePath) => {
    if (!viewedProject) return;
    lastOpenedRef.current = {
      ...lastOpenedRef.current,
      [viewedProject]: filePath,
    };
    writeLastOpenedFile(viewedProject, filePath);
  }, [viewedProject]);

  const clearLastOpenedFile = useCallback((filePath) => {
    if (!viewedProject || lastOpenedRef.current[viewedProject] !== filePath) return;
    lastOpenedRef.current = { ...lastOpenedRef.current };
    delete lastOpenedRef.current[viewedProject];
    try {
      sessionStorage.setItem(LAST_OPENED_STORAGE_KEY, JSON.stringify(lastOpenedRef.current));
    } catch {
      // Ignore storage errors; the tree refresh will pick a default.
    }
  }, [viewedProject]);

  // Load file tree
  const fetchTree = useCallback(async (opts = {}) => {
    if (!viewedProject) return null;
    if (!opts.background) setTreeLoading(true);
    try {
      const res = await apiFetch(`/api/projects/${viewedProject}/files`);
      if (!res.ok) throw new Error('File tree failed');
      const data = await res.json();
      setFileTree(data);
      return data;
    } catch (err) {
      console.warn('[file-tree]', err);
      return null;
    } finally {
      if (!opts.background) setTreeLoading(false);
    }
  }, [viewedProject]);

  useEffect(() => {
    if (!viewedProject) {
      setFileTree(null);
      setSelectedFile(null);
      setFileData(null);
      setFileConflict(null);
      return;
    }
    fetchTree();
    setSelectedFile(null);
    setFileData(null);
    setFileConflict(null);
  }, [viewedProject, fetchTree]);

  // Consume pending spec file from _openSpec bridge (T-221).
  // useRef guard prevents double-consumption within the same spec-open
  // cycle (avoids a race where setFromTaskId triggers re-render before
  // the bridge values are gone). Resets when a NEW pending spec arrives
  // (different value than last consumed) so sequential opens work.
  const lastSpecRef = useRef(null);
  const [triggerFromPanel, setTriggerFromPanel] = useState(false);
  useEffect(() => {
    const pending = window.appState?.pendingSpecFile;
    if (!pending || pending === lastSpecRef.current) return;
    lastSpecRef.current = pending;
    const pendingTaskId = window.appState?.pendingSpecTaskId || null;
    const pendingFromPanel = window.appState?.pendingSpecFromPanel || false;
    delete window.appState.pendingSpecFile;
    delete window.appState.pendingSpecTaskId;
    delete window.appState.pendingSpecFromPanel;
    // fromTaskId is set whenever a task context opened the spec.
    // triggerFromPanel remembers how onBackToTask should route.
    setFromTaskId(pendingTaskId);
    setTriggerFromPanel(pendingFromPanel);
    selectFile(pending, { keepFromTaskId: true });
  });

  // Scroll selected tree item into view
  useEffect(() => {
    if (!selectedFile) return;
    requestAnimationFrame(() => {
      const item = document.querySelector('.tree-item.selected');
      if (item) item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  }, [selectedFile]);

  // T-222: handle file upload to context/
  const loadFile = useCallback(async (filePath, opts = {}) => {
    if (!viewedProject || !filePath) return null;
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setSelectedFile(filePath);
    if (!opts.background) setLoading(true);
    if (!opts.keepPreview) setFileData(null);
    if (!opts.keepFromTaskId) setFromTaskId(null);

    setExpandedDirs(prev => expandParentsOf(filePath, prev));
    setLastOpenedFile(filePath);

    try {
      const res = await apiFetch(`/api/projects/${viewedProject}/files/${filePath}`, { signal: controller.signal });
      if (res.status === 404) {
        clearLastOpenedFile(filePath);
        setSelectedFile(null);
        setFileData(null);
        setFileConflict(null);
        return null;
      }
      if (!res.ok) throw new Error('File load failed');
      const data = await res.json();
      if (data?.error) {
        console.warn('[file-load]', data.error);
        setFileData(null);
        return null;
      }
      setFileData(data);
      setFileConflict(null);
      ignoredConflictRef.current = null;
      return data;
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.warn('[file-load]', err);
      }
      return null;
    } finally {
      if (!opts.background) setLoading(false);
    }
  }, [clearLastOpenedFile, setLastOpenedFile, viewedProject]);

  const handleUpload = useCallback(async (file) => {
    if (!viewedProject) return;
    if (!file.name.toLowerCase().endsWith('.md')) {
      window.dispatchEvent(new CustomEvent('toast', { detail: { text: 'Only .md files are allowed', type: 'warn' } }));
      return;
    }
    setUploading(true);
    try {
      const content = await file.text();
      const res = await apiFetch(`/api/projects/${viewedProject}/files/context`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, content }),
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(err);
      }
      const uploaded = await res.json();
      window.dispatchEvent(new CustomEvent('toast', { detail: { text: `${file.name} uploaded`, type: 'success' } }));
      await fetchTree({ background: true });
      setExpandedDirs(prev => new Set(prev).add('context'));
      if (uploaded?.path) loadFile(uploaded.path, { keepFromTaskId: true });
    } catch (err) {
      console.warn('[upload]', err);
      window.dispatchEvent(new CustomEvent('toast', { detail: { text: 'Upload failed', type: 'error' } }));
    } finally {
      setUploading(false);
    }
  }, [viewedProject, fetchTree, loadFile]);

  const handleUploadClick = useCallback(() => {
    uploadInputRef.current?.click();
  }, []);

  const handleUploadFile = useCallback((e) => {
    const file = e.target.files?.[0];
    if (file) handleUpload(file);
    e.target.value = '';
  }, [handleUpload]);

  const handleCreateFile = useCallback(async (e) => {
    e?.preventDefault?.();
    if (!viewedProject || creatingFile) return;
    const title = newFileTitle.trim();
    const filename = filenameFromTitle(title);
    const path = `context/${filename}`;
    if (fileExists(fileTree?.tree || [], path)) {
      window.dispatchEvent(new CustomEvent('toast', { detail: { text: `${filename} already exists`, type: 'warn' } }));
      return;
    }
    setCreatingFile(true);
    try {
      const content = title ? `# ${title}\n\n` : '';
      const res = await apiFetch(`/api/projects/${viewedProject}/files/context`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, content }),
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(err);
      }
      const created = await res.json();
      window.dispatchEvent(new CustomEvent('toast', { detail: { text: `${filename} created`, type: 'success' } }));
      setCreateOpen(false);
      setNewFileTitle('');
      await fetchTree({ background: true });
      setExpandedDirs(prev => new Set(prev).add('context'));
      if (created?.path) loadFile(created.path, { keepFromTaskId: true });
    } catch (err) {
      console.warn('[create-file]', err);
      window.dispatchEvent(new CustomEvent('toast', { detail: { text: 'File could not be created', type: 'error' } }));
    } finally {
      setCreatingFile(false);
    }
  }, [creatingFile, fetchTree, fileTree?.tree, loadFile, newFileTitle, viewedProject]);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) handleUpload(file);
  }, [handleUpload]);

  const handleFileDeleted = useCallback(() => {
    const deletedPath = selectedFileRef.current;
    setSelectedFile(null);
    setFileData(null);
    setFileConflict(null);
    clearLastOpenedFile(deletedPath);
    fetchTree();
  }, [clearLastOpenedFile, fetchTree]);

  const toggleDir = useCallback((dirPath) => {
    setExpandedDirs(prev => {
      const next = new Set(prev);
      if (next.has(dirPath)) next.delete(dirPath);
      else next.add(dirPath);
      return next;
    });
  }, []);

  const selectFile = useCallback((filePath, opts = {}) => {
    // T-221: a manual click on a different file means the user is no longer
    // viewing the spec that was opened from a task — clear the back-target.
    loadFile(filePath, opts);
  }, [loadFile]);

  const reloadSelectedFromDisk = useCallback(() => {
    const current = selectedFileRef.current;
    if (!current) return;
    dirtyRef.current = false;
    setFileConflict(null);
    ignoredConflictRef.current = null;
    loadFile(current, { keepPreview: true, keepFromTaskId: true });
  }, [loadFile]);

  const handleSaved = useCallback(async (nextFileData) => {
    setFileData(nextFileData);
    setFileConflict(null);
    ignoredConflictRef.current = null;
    await fetchTree({ background: true });
  }, [fetchTree]);

  const handleDirtyChange = useCallback((dirty) => {
    dirtyRef.current = dirty;
  }, []);

  const reconcileSelectedFile = useCallback((nextTree) => {
    const currentPath = selectedFileRef.current;
    const action = getFileReconciliationAction({
      entries: nextTree?.tree || [],
      currentPath,
      loadedFile: fileDataRef.current,
      dirty: dirtyRef.current,
      ignoredConflict: ignoredConflictRef.current,
    });

    if (action.type === 'missing') {
      clearLastOpenedFile(currentPath);
      setSelectedFile(null);
      setFileData(null);
      setFileConflict(null);
      return;
    }

    if (action.type === 'conflict') {
      setFileConflict(action.conflict);
      return;
    }

    if (action.type === 'reload') {
      loadFile(action.path, { background: true, keepPreview: true, keepFromTaskId: true });
    }
  }, [clearLastOpenedFile, loadFile]);

  useEffect(() => {
    if (!viewedProject || state?.currentTab !== 'files') return;
    let stopped = false;
    const tick = async () => {
      const nextTree = await fetchTree({ background: true });
      if (stopped || !nextTree) return;
      reconcileSelectedFile(nextTree);
    };
    const id = setInterval(tick, FILE_POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [fetchTree, reconcileSelectedFile, state?.currentTab, viewedProject]);

  useEffect(() => {
    if (!viewedProject || treeLoading || !fileTree?.tree?.length) return;
    const action = getDefaultFileSelectionAction({
      entries: fileTree.tree,
      selectedPath: selectedFile,
      preferredPath: lastOpenedRef.current[viewedProject],
      dirty: dirtyRef.current,
      conflict: fileConflict,
      pendingSpecFile: window.appState?.pendingSpecFile,
    });
    // T-367-3: on phones (master-detail) don't auto-open a default file when
    // nothing is selected — the user should land on the file LIST and tap to
    // open. Reconciliation selects (e.g. a renamed/deleted current file) still
    // run; only the "pick a default for an empty selection" case is suppressed.
    const isNarrow = typeof window !== 'undefined' && window.matchMedia?.('(max-width: 600px)').matches;
    if (action.type === 'select' && !(isNarrow && !selectedFile)) selectFile(action.path);
  }, [fileConflict, fileTree, selectedFile, selectFile, treeLoading, viewedProject]);

  if (!viewedProject) {
    return (
      <div className="file-preview-empty" data-react-files>
        Select a project to view files
      </div>
    );
  }

  const tree = fileTree?.tree || [];

  return (
    <div
      className="file-explorer"
      data-react-files
      data-view={selectedFile ? 'preview' : 'list'}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* File tree */}
      <div className="file-tree">
        {/* T-228: Upload area is part of the left file navigator, not a separate screen. */}
        {!treeLoading && tree.some(e => e.path === 'context') && (
          <div className={`file-upload-area${dragOver ? ' drag-over' : ''}`}>
            <input
              ref={uploadInputRef}
              type="file"
              accept=".md"
              style={{ display: 'none' }}
              onChange={handleUploadFile}
            />
            <button className="file-upload-btn" onClick={handleUploadClick} disabled={uploading}>
              <Upload size={14} />
              {uploading ? 'Uploading…' : 'Upload .md to context/'}
            </button>
            <button className="file-upload-btn" onClick={() => setCreateOpen(true)} disabled={uploading || creatingFile}>
              <FilePlus size={14} />
              New .md file
            </button>
            <span className="file-upload-hint">or drop here</span>
          </div>
        )}
        <div className="file-tree-items" ref={treeScrollRef} style={{ overflowY: 'auto' }}>
          {treeLoading ? (
            <div className="text-muted text-xs text-center py-8">Loading…</div>
          ) : tree.length === 0 ? (
            <div className="text-muted text-xs text-center py-8">No files</div>
          ) : (
            tree.map(entry => (
              <TreeNode
                key={entry.path}
                entry={entry}
                depth={0}
                expandedDirs={expandedDirs}
                onToggleDir={toggleDir}
                selectedFile={selectedFile}
                onSelectFile={selectFile}
              />
            ))
          )}
        </div>
        <div className="file-tree-footer">
          {fileTree && (
            <>
              <span>{fileTree.fileCount} files · {formatSize(fileTree.totalSize)}</span>
              <div className="context-bar">
                <div
                  className="context-bar-fill"
                  style={{
                    width: `${Math.min(100, Math.round((fileTree.totalSize / 50000) * 100))}%`,
                    background: fileTree.totalSize > 50000 ? 'var(--danger)'
                      : fileTree.totalSize > 40000 ? 'var(--warn)' : 'var(--ok)',
                  }}
                />
              </div>
            </>
          )}
        </div>
      </div>

      <Modal
        open={createOpen}
        onClose={() => {
          if (creatingFile) return;
          setCreateOpen(false);
        }}
        title="Create Markdown file"
        actions={(
          <>
            <Button variant="ghost" onClick={() => setCreateOpen(false)} disabled={creatingFile}>Cancel</Button>
            <Button onClick={handleCreateFile} disabled={creatingFile}>Create</Button>
          </>
        )}
      >
        <form onSubmit={handleCreateFile} className="space-y-3">
          <Input
            autoFocus
            value={newFileTitle}
            onChange={(e) => setNewFileTitle(e.target.value)}
            placeholder="Title"
            disabled={creatingFile}
          />
          <div className="text-xs text-muted">
            {`context/${filenameFromTitle(newFileTitle)}`}
          </div>
        </form>
      </Modal>

      {/* File preview */}
      <div className="file-preview">
        {loading ? (
          <div className="file-preview-empty">Loading…</div>
        ) : (
          <FilePreview
            fileData={fileData}
            filePath={selectedFile}
            projectName={viewedProject}
            onDeleted={handleFileDeleted}
            onSaved={handleSaved}
            previewScrollRef={previewScrollRef}
            fromTaskId={fromTaskId}
            onBackToList={() => { setSelectedFile(null); setFileData(null); }}
            conflict={fileConflict}
            onReloadFromDisk={reloadSelectedFromDisk}
            onKeepLocalChanges={() => {
              if (fileConflict) ignoredConflictRef.current = fileConflict;
              setFileConflict(null);
            }}
            onDirtyChange={handleDirtyChange}
            onBackToTask={() => {
              const taskId = fromTaskId;
              setFromTaskId(null);
              setTriggerFromPanel(false);
              switchTab('tasks');
              if (taskId) {
                if (triggerFromPanel && window.openTaskDetail) {
                  window.openTaskDetail(taskId);
                } else {
                  goToTask(taskId);
                }
              }
            }}
          />
        )}
      </div>
    </div>
  );
}
