import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useAppState } from '../context/AppStateContext.jsx';
import { Modal } from '../components/index.js';
import { useHaptic } from '../hooks/useHaptic.js';
import { useCustomScroll } from '../hooks/useCustomScroll.js';
import { FolderOpen, Folder, FileText, FileJson, FileCode, File, Pencil, Save, X, Trash2 } from 'lucide-react';

function isEditablePath(filePath) {
  if (!filePath) return false;
  return filePath.startsWith('context/') || filePath.startsWith('specs/');
}

const CATEGORY_LABELS = { always: 'always loaded', lazy: 'lazy loaded', optional: 'context' };

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

function escHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function expandParentsOf(path, dirs) {
  const parts = path.split('/');
  const next = new Set(dirs);
  for (let i = 1; i < parts.length; i++) {
    next.add(parts.slice(0, i).join('/'));
  }
  return next;
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
function FilePreview({ fileData, filePath, projectName, onDeleted, onBack, previewScrollRef }) {
  const haptic = useHaptic();
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const textareaRef = useRef(null);

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
      if (window.showToast) window.showToast('File saved', 'success');
      // Update fileData content + size so preview shows new content
      fileData.content = editContent;
      fileData.size = new Blob([editContent]).size;
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
      const res = await fetch(`/api/projects/${projectName}/files/${filePath}`, { method: 'DELETE' });
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

  const handleEditorKeyDown = (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = e.target;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const val = editContent;
      setEditContent(val.substring(0, start) + '  ' + val.substring(end));
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = start + 2;
      });
    }
  };

  if (!fileData) {
    return <div className="file-preview-empty">Select a file to preview</div>;
  }

  const ext = filePath.split('.').pop();
  const editable = isEditablePath(filePath);
  const unsaved = editing && editContent !== fileData.content;
  const fileName = filePath.split('/').pop();

  return (
    <>
      <div className="file-preview-header">
        <button className="file-back-btn" onClick={onBack}>← Files</button>
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
          {editable && !editing && (
            <button className="delete-btn" onClick={() => { haptic.light(); setShowDeleteModal(true); }} title="Delete" style={{ opacity: 0.6 }}>
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>
      <div className={`file-preview-body${editing ? '' : ''}`} ref={editing ? undefined : previewScrollRef}>
        {editing ? (
          <textarea
            ref={textareaRef}
            className="file-editor"
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
            onKeyDown={handleEditorKeyDown}
            spellCheck={false}
          />
        ) : ext === 'json' ? (
          <JsonPreview content={fileData.content} />
        ) : ext === 'md' ? (
          <MarkdownPreview content={fileData.content} />
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

// --- Markdown rendering (uses .md-content CSS from dashboard.css) ---
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
          i++;
          const cls = lang ? ` class="language-${lang}"` : '';
          out.push(`<pre><code${cls}>${codeLines.join('\n')}</code></pre>`);
          continue;
        }

        // HR
        if (line.match(/^---+\s*$/)) {
          if (inList) { out.push('</ul>'); inList = false; }
          out.push('<hr />');
          i++;
          continue;
        }

        // Headings
        const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
        if (headingMatch) {
          if (inList) { out.push('</ul>'); inList = false; }
          const level = headingMatch[1].length;
          const text = inlineFormat(headingMatch[2]);
          out.push(`<h${level}>${text}</h${level}>`);
          i++;
          continue;
        }

        // Blockquote
        if (line.match(/^>\s/)) {
          if (inList) { out.push('</ul>'); inList = false; }
          out.push(`<blockquote><p>${inlineFormat(line.replace(/^>\s+/, ''))}</p></blockquote>`);
          i++;
          continue;
        }

        // Unordered list item
        if (line.match(/^[-*]\s+/)) {
          if (!inList) { out.push('<ul>'); inList = true; }
          out.push(`<li>${inlineFormat(line.replace(/^[-*]\s+/, ''))}</li>`);
          i++;
          continue;
        }

        if (inList) { out.push('</ul>'); inList = false; }

        // Empty line
        if (line.trim() === '') { i++; continue; }

        // Paragraph
        const paraLines = [line];
        i++;
        while (i < lines.length && lines[i].trim() !== '' && !lines[i].match(/^#{1,4}\s/) && !lines[i].match(/^[-*]\s+/) && !lines[i].match(/^```/) && !lines[i].match(/^---+\s*$/) && !lines[i].match(/^>\s/)) {
          paraLines.push(lines[i]);
          i++;
        }
        out.push(`<p>${inlineFormat(paraLines.join(' '))}</p>`);
      }

      if (inList) out.push('</ul>');
      return out.join('\n');
    } catch (err) {
      console.warn('[markdown-parse]', err);
      return null;
    }
  }, [content]);

  if (html === null) {
    return <pre className="mono" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{content}</pre>;
  }

  return <div className="md-content" dangerouslySetInnerHTML={{ __html: html }} />;
}

function inlineFormat(text) {
  return text
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
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
  const [showPreview, setShowPreview] = useState(false);
  const abortRef = useRef(null);

  const treeScrollRef = useCustomScroll();
  const previewScrollRef = useCustomScroll();

  // Load file tree
  const fetchTree = useCallback(() => {
    if (!viewedProject) return;
    setTreeLoading(true);
    fetch(`/api/projects/${viewedProject}/files`)
      .then(r => r.json())
      .then(data => { setFileTree(data); setTreeLoading(false); })
      .catch(err => { console.warn('[file-tree]', err); setTreeLoading(false); });
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
      selectFile(pending);
    }
  });

  // Scroll selected tree item into view
  useEffect(() => {
    if (!selectedFile) return;
    requestAnimationFrame(() => {
      const item = document.querySelector('.tree-item.selected');
      if (item) item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  }, [selectedFile]);

  const handleFileDeleted = useCallback(() => {
    setSelectedFile(null);
    setFileData(null);
    setShowPreview(false);
    fetchTree();
  }, [fetchTree]);

  const toggleDir = useCallback((dirPath) => {
    setExpandedDirs(prev => {
      const next = new Set(prev);
      if (next.has(dirPath)) next.delete(dirPath);
      else next.add(dirPath);
      return next;
    });
  }, []);

  const selectFile = useCallback((filePath) => {
    if (!viewedProject) return;
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setSelectedFile(filePath);
    setShowPreview(true);
    setLoading(true);
    setFileData(null);

    // Auto-expand parent dirs
    setExpandedDirs(prev => expandParentsOf(filePath, prev));

    fetch(`/api/projects/${viewedProject}/files/${filePath}`, { signal: controller.signal })
      .then(r => r.json())
      .then(data => {
        if (data?.error) {
          console.warn('[file-load]', data.error);
          setFileData(null);
        } else {
          setFileData(data);
        }
        setLoading(false);
      })
      .catch(err => {
        if (err.name !== 'AbortError') {
          console.warn('[file-load]', err);
          setLoading(false);
        }
      });
  }, [viewedProject]);

  if (!viewedProject) {
    return (
      <div className="file-preview-empty" data-react-files>
        Select a project to view files
      </div>
    );
  }

  const tree = fileTree?.tree || [];

  return (
    <div className={`file-explorer${showPreview ? ' show-preview' : ''}`} data-react-files>
      {/* File tree */}
      <div className="file-tree">
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
            onBack={() => setShowPreview(false)}
            previewScrollRef={previewScrollRef}
          />
        )}
      </div>
    </div>
  );
}
