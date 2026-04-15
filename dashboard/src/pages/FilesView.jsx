import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useAppState } from '../context/AppStateContext.jsx';
import { useHaptic } from '../hooks/useHaptic.js';
import { FolderOpen, Folder, FileText, FileJson, FileCode, File, ChevronRight, ChevronDown, Pencil, Save, X, Trash2 } from 'lucide-react';

function showToast(msg) {
  if (window.Telegram?.WebApp?.showToast) window.Telegram.WebApp.showToast(msg);
  else if (window.showToast) window.showToast(msg);
}

function isEditablePath(filePath) {
  if (!filePath) return false;
  return filePath.startsWith('context/') || filePath.startsWith('specs/');
}

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
function FilePreview({ fileData, filePath, projectName, onDeleted }) {
  const haptic = useHaptic();
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const textareaRef = useRef(null);

  // Reset edit state when file changes
  useEffect(() => {
    setEditing(false);
    setEditContent('');
  }, [filePath]);

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
    setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const handleCancel = () => {
    setEditing(false);
    setEditContent('');
  };

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/projects/${projectName}/files/${filePath}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: editContent }),
      });
      if (!res.ok) throw new Error('Save failed');
      haptic.medium();
      showToast('File saved');
      fileData.content = editContent;
      fileData.size = new Blob([editContent]).size;
      setEditing(false);
    } catch (err) {
      console.warn('Save error:', err);
      haptic.error();
      showToast('Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    try {
      const res = await fetch(`/api/projects/${projectName}/files/${filePath}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
      haptic.medium();
      showToast('File deleted');
      setShowDeleteModal(false);
      onDeleted?.();
    } catch (err) {
      console.warn('Delete error:', err);
      haptic.error();
      showToast('Delete failed');
      setShowDeleteModal(false);
    }
  };

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
  const editable = isEditablePath(filePath);
  const unsaved = editing && editContent !== fileData.content;
  const fileName = filePath.split('/').pop();

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-white/5 shrink-0 flex-wrap">
        <span className="text-sm font-medium truncate">{filePath}</span>
        {unsaved && <span className="w-2 h-2 rounded-full bg-[var(--warn)] shrink-0" title="Unsaved" />}
        <span className="text-xs text-[var(--text-3)] tabular-nums">{formatSize(fileData.size)}</span>
        {catLabel && (
          <span
            className="text-[10px] px-1.5 py-0.5 rounded-full"
            style={{ backgroundColor: `${catColor}22`, color: catColor }}
          >
            {catLabel}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {editable && !editing && (
            <button onClick={handleEdit} className="p-1 rounded hover:bg-white/10 text-[var(--text-3)] hover:text-[var(--text-1)] transition-colors" title="Edit">
              <Pencil size={14} />
            </button>
          )}
          {editing && (
            <>
              <button onClick={handleSave} disabled={saving} className="p-1 rounded hover:bg-white/10 text-[var(--ok)] transition-colors" title="Save (Ctrl+S)">
                <Save size={14} />
              </button>
              <button onClick={handleCancel} className="p-1 rounded hover:bg-white/10 text-[var(--text-3)] hover:text-[var(--text-1)] transition-colors" title="Cancel (Esc)">
                <X size={14} />
              </button>
            </>
          )}
          {editable && !editing && (
            <button onClick={() => { haptic.light(); setShowDeleteModal(true); }} className="p-1 rounded hover:bg-white/10 text-[var(--text-3)] hover:text-[var(--danger)] transition-colors" title="Delete">
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>
      {/* Body */}
      <div className="flex-1 overflow-auto p-3">
        {editing ? (
          <textarea
            ref={textareaRef}
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
            className="w-full h-full resize-none bg-transparent text-xs leading-relaxed font-[var(--font-mono)] text-[var(--text-2)] outline-none"
            spellCheck={false}
          />
        ) : ext === 'json' ? (
          <JsonPreview content={fileData.content} />
        ) : ext === 'md' ? (
          <MarkdownPreview content={fileData.content} />
        ) : (
          <pre className="text-xs leading-relaxed whitespace-pre-wrap break-words font-[var(--font-mono)] text-[var(--text-2)]">
            {fileData.content}
          </pre>
        )}
      </div>

      {/* Delete confirmation modal */}
      {showDeleteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowDeleteModal(false)}>
          <div className="bg-[var(--bg-2)] rounded-xl p-5 w-[min(90vw,320px)] shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold mb-2">Delete {fileName}?</h3>
            <p className="text-xs text-[var(--text-3)] mb-4">This action cannot be undone.</p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setShowDeleteModal(false)} className="px-3 py-1.5 text-xs rounded-lg bg-white/5 hover:bg-white/10 transition-colors">Cancel</button>
              <button onClick={handleDelete} className="px-3 py-1.5 text-xs rounded-lg bg-[var(--danger)] text-white hover:brightness-110 transition-all">Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function escHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

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
      tokens.push({ type: match[4] === 'null' ? 'null' : 'boolean', value: match[4] });
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
    return (
      <pre className="text-xs leading-relaxed whitespace-pre-wrap break-words font-[var(--font-mono)] text-[var(--text-2)]">
        {content}
      </pre>
    );
  }

  return (
    <pre className="text-xs leading-relaxed whitespace-pre-wrap break-words font-[var(--font-mono)] text-[var(--text-2)]">
      {highlighted.map((tok, i) =>
        tok.type === 'ws' ? tok.value : (
          <span key={i} className={`json-${tok.type}`}>{tok.value}</span>
        )
      )}
    </pre>
  );
}

function MarkdownPreview({ content }) {
  const html = useMemo(() => {
    try {
      const escaped = escHtml(content);
      const lines = escaped.split('\n');
      const out = [];
      let i = 0;
      let inList = false;

      while (i < lines.length) {
        const line = lines[i];

        // Code block
        if (line.match(/^```/)) {
          if (inList) { out.push('</ul>'); inList = false; }
          const lang = line.slice(3).trim();
          const codeLines = [];
          i++;
          while (i < lines.length && !lines[i].match(/^```/)) {
            codeLines.push(lines[i]);
            i++;
          }
          i++; // skip closing ```
          const cls = lang ? ` class="language-${lang}"` : '';
          out.push(`<pre class="bg-white/5 rounded-lg p-3 overflow-x-auto my-2"><code${cls} class="text-xs font-[var(--font-mono)] text-[var(--text-2)]">${codeLines.join('\n')}</code></pre>`);
          continue;
        }

        // HR
        if (line.match(/^---+\s*$/)) {
          if (inList) { out.push('</ul>'); inList = false; }
          out.push('<hr class="border-white/10 my-4" />');
          i++;
          continue;
        }

        // Headings
        const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
        if (headingMatch) {
          if (inList) { out.push('</ul>'); inList = false; }
          const level = headingMatch[1].length;
          const text = inlineFormat(headingMatch[2]);
          const sizes = { 1: 'text-lg font-bold', 2: 'text-base font-semibold', 3: 'text-sm font-medium' };
          out.push(`<h${level} class="${sizes[level]} text-[var(--text-1)] mt-4 mb-2">${text}</h${level}>`);
          i++;
          continue;
        }

        // Unordered list item
        if (line.match(/^[-*]\s+/)) {
          if (!inList) { out.push('<ul class="list-disc list-inside space-y-1 my-2 text-[var(--text-2)]">'); inList = true; }
          out.push(`<li class="text-xs leading-relaxed">${inlineFormat(line.replace(/^[-*]\s+/, ''))}</li>`);
          i++;
          continue;
        }

        // Close list if non-list line
        if (inList) { out.push('</ul>'); inList = false; }

        // Empty line
        if (line.trim() === '') {
          i++;
          continue;
        }

        // Paragraph — collect consecutive non-empty lines
        const paraLines = [line];
        i++;
        while (i < lines.length && lines[i].trim() !== '' && !lines[i].match(/^#{1,3}\s/) && !lines[i].match(/^[-*]\s+/) && !lines[i].match(/^```/) && !lines[i].match(/^---+\s*$/)) {
          paraLines.push(lines[i]);
          i++;
        }
        out.push(`<p class="text-xs leading-relaxed text-[var(--text-2)] my-2">${inlineFormat(paraLines.join(' '))}</p>`);
      }

      if (inList) out.push('</ul>');
      return out.join('\n');
    } catch (err) {
      console.warn('Markdown parse error:', err);
      return null;
    }
  }, [content]);

  if (html === null) {
    return (
      <pre className="text-xs leading-relaxed whitespace-pre-wrap break-words font-[var(--font-mono)] text-[var(--text-2)]">
        {content}
      </pre>
    );
  }

  return <div className="markdown-preview" dangerouslySetInnerHTML={{ __html: html }} />;
}

function inlineFormat(text) {
  return text
    .replace(/`([^`]+)`/g, '<code class="bg-white/5 rounded px-1 py-0.5 font-[var(--font-mono)] text-xs">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong class="font-semibold text-[var(--text-1)]">$1</strong>')
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener" class="text-[var(--accent)] underline decoration-[var(--accent)]/40 hover:decoration-[var(--accent)]">$1</a>');
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
  const fetchTree = useCallback(() => {
    if (!viewedProject) return;
    setTreeLoading(true);
    fetch(`/api/projects/${viewedProject}/files`)
      .then(r => r.json())
      .then(data => { setFileTree(data); setTreeLoading(false); })
      .catch(err => { console.warn('Failed to load file tree:', err); setTreeLoading(false); });
  }, [viewedProject]);

  useEffect(() => {
    if (!viewedProject) {
      setFileTree(null);
      setSelectedFile(null);
      setFileData(null);
      return;
    }
    fetchTree();
    setSelectedFile(null);
    setFileData(null);
  }, [viewedProject, fetchTree]);

  // Consume pending spec file from _openSpec bridge
  useEffect(() => {
    const pending = window.appState?.pendingSpecFile;
    if (pending) {
      delete window.appState.pendingSpecFile;
      setSelectedFile(pending);
    }
  });

  const handleFileDeleted = useCallback(() => {
    setSelectedFile(null);
    setFileData(null);
    fetchTree();
  }, [fetchTree]);

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
      <style>{`
        .json-key { color: var(--accent); }
        .json-string { color: var(--ok); }
        .json-number { color: var(--info); }
        .json-boolean, .json-null { color: var(--warn); }
        .json-punctuation { color: var(--text-3); }
      `}</style>
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
          <FilePreview fileData={fileData} filePath={selectedFile} projectName={viewedProject} onDeleted={handleFileDeleted} />
        )}
      </div>
    </div>
  );
}
