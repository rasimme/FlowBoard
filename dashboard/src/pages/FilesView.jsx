import { useState, useEffect, useCallback, useRef } from 'react';
import { useAppState } from '../context/AppStateContext.jsx';
import { FolderOpen, Folder, FileText, FileJson, FileCode, File, ChevronRight, ChevronDown } from 'lucide-react';

const CATEGORY_LABELS = { always: 'always loaded', lazy: 'lazy loaded', optional: 'context' };
const CATEGORY_COLORS = { always: 'var(--ok)', lazy: 'var(--warn)', optional: 'var(--info)' };

function formatSize(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function getFileIcon(name) {
  const ext = name.split('.').pop();
  if (ext === 'json') return <FileJson size={15} />;
  if (ext === 'md') return <FileText size={15} />;
  if (['js', 'jsx', 'ts', 'tsx', 'css', 'html'].includes(ext)) return <FileCode size={15} />;
  return <File size={15} />;
}

// --- Tree node ---
function TreeNode({ entry, depth, expandedDirs, onToggleDir, selectedFile, onSelectFile }) {
  const indent = depth * 16;

  if (entry.type === 'directory') {
    const expanded = expandedDirs.has(entry.path);
    return (
      <>
        <button
          className="flex items-center w-full text-left px-2 py-1 hover:bg-white/5 rounded transition-colors gap-1.5"
          style={{ paddingLeft: `${8 + indent}px` }}
          onClick={() => onToggleDir(entry.path)}
        >
          {expanded
            ? <ChevronDown size={13} className="shrink-0 text-[var(--text-3)]" />
            : <ChevronRight size={13} className="shrink-0 text-[var(--text-3)]" />}
          {expanded
            ? <FolderOpen size={15} className="shrink-0 text-[var(--accent)]" />
            : <Folder size={15} className="shrink-0 text-[var(--accent)]" />}
          <span className="truncate text-sm">{entry.name}</span>
          <span className="ml-auto text-xs text-[var(--text-3)] tabular-nums shrink-0">{entry.children.length}</span>
        </button>
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
    <button
      className={`flex items-center w-full text-left px-2 py-1 rounded transition-colors gap-1.5 ${
        isSelected ? 'bg-[var(--accent)]/15 text-[var(--accent)]' : 'hover:bg-white/5'
      }`}
      style={{ paddingLeft: `${8 + indent}px` }}
      onClick={() => onSelectFile(entry.path)}
    >
      {entry.category && (
        <span
          className="w-1.5 h-1.5 rounded-full shrink-0"
          style={{ backgroundColor: CATEGORY_COLORS[entry.category] || CATEGORY_COLORS.optional }}
        />
      )}
      <span className="shrink-0 text-[var(--text-3)]">{getFileIcon(entry.name)}</span>
      <span className="truncate text-sm">{entry.name}</span>
      <span className="ml-auto text-xs text-[var(--text-3)] tabular-nums shrink-0">{formatSize(entry.size)}</span>
    </button>
  );
}

// --- File preview ---
function FilePreview({ fileData, filePath }) {
  if (!fileData) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--text-3)] text-sm">
        Select a file to preview
      </div>
    );
  }

  const ext = filePath.split('.').pop();
  const catLabel = CATEGORY_LABELS[fileData.category] || '';
  const catColor = CATEGORY_COLORS[fileData.category] || CATEGORY_COLORS.optional;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-white/5 shrink-0 flex-wrap">
        <span className="text-sm font-medium truncate">{filePath}</span>
        <span className="text-xs text-[var(--text-3)] tabular-nums">{formatSize(fileData.size)}</span>
        {catLabel && (
          <span
            className="text-[10px] px-1.5 py-0.5 rounded-full"
            style={{ backgroundColor: `${catColor}22`, color: catColor }}
          >
            {catLabel}
          </span>
        )}
      </div>
      {/* Body */}
      <div className="flex-1 overflow-auto p-3">
        {ext === 'json' ? (
          <JsonPreview content={fileData.content} />
        ) : (
          <pre className="text-xs leading-relaxed whitespace-pre-wrap break-words font-[var(--font-mono)] text-[var(--text-2)]">
            {fileData.content}
          </pre>
        )}
      </div>
    </div>
  );
}

function JsonPreview({ content }) {
  let formatted;
  try {
    formatted = JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    formatted = content;
  }
  return (
    <pre className="text-xs leading-relaxed whitespace-pre-wrap break-words font-[var(--font-mono)] text-[var(--text-2)]">
      {formatted}
    </pre>
  );
}

// --- Main view ---
export default function FilesView() {
  const { state } = useAppState();
  const viewedProject = state?.viewedProject;

  const [fileTree, setFileTree] = useState(null);
  const [expandedDirs, setExpandedDirs] = useState(new Set(['context']));
  const [selectedFile, setSelectedFile] = useState(null);
  const [fileData, setFileData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [treeLoading, setTreeLoading] = useState(false);
  const abortRef = useRef(null);

  // Load file tree
  useEffect(() => {
    if (!viewedProject) {
      setFileTree(null);
      setSelectedFile(null);
      setFileData(null);
      return;
    }

    let cancelled = false;
    setTreeLoading(true);

    fetch(`/api/projects/${viewedProject}/files`)
      .then(r => r.json())
      .then(data => {
        if (!cancelled) {
          setFileTree(data);
          setTreeLoading(false);
        }
      })
      .catch(err => {
        console.warn('Failed to load file tree:', err);
        if (!cancelled) setTreeLoading(false);
      });

    // Reset selection when project changes
    setSelectedFile(null);
    setFileData(null);

    return () => { cancelled = true; };
  }, [viewedProject]);

  // Toggle directory
  const toggleDir = useCallback((dirPath) => {
    setExpandedDirs(prev => {
      const next = new Set(prev);
      if (next.has(dirPath)) next.delete(dirPath);
      else next.add(dirPath);
      return next;
    });
  }, []);

  // Select file
  const selectFile = useCallback((filePath) => {
    if (!viewedProject) return;
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setSelectedFile(filePath);
    setLoading(true);
    setFileData(null);

    // Auto-expand parent dirs
    const parts = filePath.split('/');
    if (parts.length > 1) {
      setExpandedDirs(prev => {
        const next = new Set(prev);
        for (let i = 1; i < parts.length; i++) {
          next.add(parts.slice(0, i).join('/'));
        }
        return next;
      });
    }

    fetch(`/api/projects/${viewedProject}/files/${filePath}`, { signal: controller.signal })
      .then(r => r.json())
      .then(data => {
        if (data?.error) {
          console.warn('File load error:', data.error);
          setFileData(null);
        } else {
          setFileData(data);
        }
        setLoading(false);
      })
      .catch(err => {
        if (err.name !== 'AbortError') {
          console.warn('Failed to load file:', err);
          setLoading(false);
        }
      });
  }, [viewedProject]);

  if (!viewedProject) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--text-3)] text-sm" data-react-files>
        Select a project to view files
      </div>
    );
  }

  const tree = fileTree?.tree || [];

  return (
    <div className="flex h-full" data-react-files>
      {/* File tree pane */}
      <div className="w-[260px] shrink-0 border-r border-white/5 flex flex-col overflow-hidden max-md:w-full max-md:min-w-0">
        <div className="flex-1 overflow-y-auto py-1">
          {treeLoading ? (
            <div className="flex items-center justify-center py-8 text-[var(--text-3)] text-sm">Loading…</div>
          ) : tree.length === 0 ? (
            <div className="flex items-center justify-center py-8 text-[var(--text-3)] text-sm">No files</div>
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
        {/* Footer */}
        {fileTree && (
          <div className="px-3 py-2 border-t border-white/5 text-xs text-[var(--text-3)]">
            <div className="flex justify-between">
              <span>{fileTree.fileCount} files</span>
              <span>{formatSize(fileTree.totalSize)}</span>
            </div>
            {fileTree.totalSize != null && (
              <div className="mt-1 h-1 rounded-full bg-white/5 overflow-hidden">
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${Math.min(100, Math.round((fileTree.totalSize / (50 * 1024)) * 100))}%`,
                    backgroundColor: fileTree.totalSize > 50 * 1024 ? 'var(--danger)' : fileTree.totalSize > 40 * 1024 ? 'var(--warn)' : 'var(--ok)',
                  }}
                />
              </div>
            )}
          </div>
        )}
      </div>

      {/* Preview pane */}
      <div className="flex-1 min-w-0 overflow-hidden max-md:hidden">
        {loading ? (
          <div className="flex items-center justify-center h-full text-[var(--text-3)] text-sm">Loading…</div>
        ) : (
          <FilePreview fileData={fileData} filePath={selectedFile} />
        )}
      </div>
    </div>
  );
}
