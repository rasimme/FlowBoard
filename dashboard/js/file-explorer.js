// file-explorer.js — File Tree + Preview

import { api, toast, escHtml, formatSize } from './utils.js?v=3';

// File loading categories
const CATEGORY_LABELS = { always: 'always loaded', lazy: 'lazy loaded', optional: 'context' };
const CATEGORY_COLORS = { always: 'ok', lazy: 'warn', optional: 'info' };

export const fileState = {
  fileTree: null,
  selectedFile: null,
  fileContent: null,
  fileEditing: false,
  fileUnsaved: false,
  fileEditedContent: null,
  expandedDirs: new Set(['context'])
};

export async function loadFileTree(state) {
  if (!state.viewedProject) return;
  try {
    const data = await api(`/projects/${state.viewedProject}/files`);
    fileState.fileTree = data;
  } catch (err) {
    console.error('Failed to load file tree:', err);
    fileState.fileTree = null;
  }
}

export async function loadFileContent(filePath, state) {
  if (!state.viewedProject) return;
  try {
    const data = await api(`/projects/${state.viewedProject}/files/${filePath}`);
    if (data?.error) {
      toast(`Datei nicht gefunden: ${filePath}`, 'warn');
      console.warn('Failed to load file:', data.error);
      return;
    }
    fileState.fileContent = data;
    fileState.selectedFile = filePath;
    fileState.fileEditing = false;
    fileState.fileUnsaved = false;
    fileState.fileEditedContent = null;
    // Auto-expand all parent directories so file is visible in tree
    const parts = filePath.split('/');
    for (let i = 1; i < parts.length; i++) {
      fileState.expandedDirs.add(parts.slice(0, i).join('/'));
    }
    // Mobile: switch to preview view
    const explorer = document.querySelector('.file-explorer');
    if (explorer) explorer.classList.add('show-preview');
    renderFileTree();
    renderFilePreview();
  } catch (err) {
    toast(`Fehler beim Laden: ${filePath}`, 'error');
    console.error('Failed to load file:', err);
  }
}

export async function saveFileContent(state) {
  if (!state.viewedProject || !fileState.selectedFile) return;
  const content = fileState.fileEditedContent ?? fileState.fileContent?.content;
  if (!content && content !== '') return;
  try {
    await api(`/projects/${state.viewedProject}/files/${fileState.selectedFile}`, {
      method: 'PUT', body: { content }
    });
    fileState.fileContent.content = content;
    fileState.fileUnsaved = false;
    fileState.fileEditedContent = null;
    toast('File saved', 'success');
    renderFilePreview();
    loadFileTree(state);
  } catch (err) {
    toast('Failed to save: ' + err.message, 'error');
  }
}

export function toggleFileEdit() {
  if (fileState.fileEditing) {
    const editor = document.getElementById('fileEditor');
    if (editor) fileState.fileEditedContent = editor.value;
  }
  fileState.fileEditing = !fileState.fileEditing;
  renderFilePreview();
  if (fileState.fileEditing) {
    setTimeout(() => {
      const editor = document.getElementById('fileEditor');
      if (editor) editor.focus();
    }, 50);
  }
}

export function fileBackToTree() {
  const explorer = document.querySelector('.file-explorer');
  if (explorer) explorer.classList.remove('show-preview');
}

export function toggleDir(dirPath) {
  if (fileState.expandedDirs.has(dirPath)) fileState.expandedDirs.delete(dirPath);
  else fileState.expandedDirs.add(dirPath);
  renderFileTree();
}

export async function renderFileExplorer(state) {
  if (!fileState.fileTree) await loadFileTree(state);
  const content = document.getElementById('content');
  content.style.overflow = 'hidden';
  content.innerHTML = `<div class="file-explorer">
    <div class="file-tree">
      <div class="file-tree-items" id="fileTreeItems"></div>
      <div class="file-tree-footer" id="fileTreeFooter"></div>
    </div>
    <div class="file-preview" id="filePreview">
      <div class="file-preview-empty">Select a file to preview</div>
    </div>
  </div>`;
  renderFileTree();
  const isMobile = window.matchMedia('(max-width: 900px)').matches;
  if (isMobile) {
    // Mobile: always show tree first, never auto-open
    const explorer = document.querySelector('.file-explorer');
    if (explorer) explorer.classList.remove('show-preview');
  } else if (!fileState.selectedFile && fileState.fileTree && fileState.fileTree.tree.length > 0) {
    const firstFile = fileState.fileTree.tree.find(e => e.type === 'file');
    if (firstFile) loadFileContent(firstFile.path, state);
  } else if (fileState.selectedFile) {
    loadFileContent(fileState.selectedFile, state);
  }
}

export function renderFileTree() {
  const container = document.getElementById('fileTreeItems');
  if (!container || !fileState.fileTree) return;

  let html = '';

  function renderEntry(entry, depth) {
    const indent = depth * 16;
    if (entry.type === 'directory') {
      const expanded = fileState.expandedDirs.has(entry.path);
      const icon = expanded ? '📂' : '📁';
      html += `<div class="tree-item directory" style="padding-left:${14 + indent}px" onclick="window.toggleDir('${entry.path}')">
        <span class="tree-icon">${icon}</span>
        <span class="tree-name">${escHtml(entry.name)}</span>
        <span class="tree-meta">${entry.children.length}</span>
      </div>`;
      if (expanded && entry.children) {
        for (const child of entry.children) renderEntry(child, depth + 1);
      }
    } else {
      const isSelected = fileState.selectedFile === entry.path;
      const sizeStr = formatSize(entry.size);
      const ext = entry.name.split('.').pop();
      const icon = ext === 'json' ? '{ }' : ext === 'md' ? '📝' : '📄';
      html += `<div class="tree-item${isSelected ? ' selected' : ''}" style="padding-left:${14 + indent}px" onclick="window.loadFileContent('${entry.path}')">
        <span class="tree-badge ${entry.category}"></span>
        <span class="tree-icon">${icon}</span>
        <span class="tree-name">${escHtml(entry.name)}</span>
        <span class="tree-meta">${sizeStr}</span>
      </div>`;
    }
  }

  for (const entry of fileState.fileTree.tree) renderEntry(entry, 0);
  container.innerHTML = html;

  const footer = document.getElementById('fileTreeFooter');
  if (footer && fileState.fileTree) {
    const total = fileState.fileTree.totalSize;
    const recommended = 50 * 1024;
    const pct = Math.min(100, Math.round((total / recommended) * 100));
    const color = pct > 80 ? 'var(--warn)' : pct > 100 ? 'var(--danger)' : 'var(--ok)';
    footer.innerHTML = `
      <div>${fileState.fileTree.fileCount} files · ${formatSize(total)}</div>
      <div class="context-bar">
        <div class="context-bar-fill" style="width:${pct}%;background:${color}"></div>
      </div>
    `;
  }
}

function renderFilePreview() {
  const container = document.getElementById('filePreview');
  if (!container) return;

  container.classList.toggle('editing', !!fileState.fileEditing);

  if (!fileState.fileContent) {
    container.innerHTML = '<div class="file-preview-empty">Select a file to preview</div>';
    return;
  }

  const f = fileState.fileContent;
  const catLabel = CATEGORY_LABELS[f.category] || '';
  const catClass = f.category || 'optional';
  const ext = f.path.split('.').pop();
  const isJson = ext === 'json';

  const unsavedDot = fileState.fileUnsaved ? '<span class="unsaved-dot" title="Unsaved changes"></span>' : '';
  const saveBtn = fileState.fileUnsaved
    ? '<button class="btn btn-primary btn-sm" onclick="window.saveFileContent()" style="font-size:11px">Save</button>'
    : '';

  container.innerHTML = `
    <div class="file-preview-header">
      <button class="file-back-btn" onclick="window.fileBackToTree()">← Files</button>
      <div class="file-preview-info">
        <span class="file-preview-name">${escHtml(f.path)}${unsavedDot}</span>
        <span class="file-preview-size">${formatSize(f.size)}</span>
        <span class="file-preview-badge ${catClass}">${catLabel}</span>
      </div>
      <div class="file-preview-actions">
        ${saveBtn}
        <button class="btn btn-ghost btn-sm" onclick="window.toggleFileEdit()">
          ${fileState.fileEditing ? 'Preview' : 'Edit'}
        </button>
      </div>
    </div>
    <div class="file-preview-body" id="filePreviewBody"></div>
  `;

  const body = document.getElementById('filePreviewBody');
  const displayContent = fileState.fileEditedContent ?? f.content;

  if (fileState.fileEditing) {
    body.innerHTML = `<textarea class="file-editor" id="fileEditor" spellcheck="false">${escHtml(displayContent)}</textarea>`;
    const editor = document.getElementById('fileEditor');
    editor.addEventListener('input', () => {
      fileState.fileEditedContent = editor.value;
      fileState.fileUnsaved = editor.value !== f.content;
      const actions = container.querySelector('.file-preview-actions');
      const nameEl = container.querySelector('.file-preview-name');
      if (nameEl) {
        const dot = nameEl.querySelector('.unsaved-dot');
        if (fileState.fileUnsaved && !dot) nameEl.insertAdjacentHTML('beforeend', '<span class="unsaved-dot" title="Unsaved changes"></span>');
        else if (!fileState.fileUnsaved && dot) dot.remove();
      }
      if (actions) {
        const existing = actions.querySelector('.btn-primary');
        if (fileState.fileUnsaved && !existing) {
          actions.insertAdjacentHTML('afterbegin', '<button class="btn btn-primary btn-sm" onclick="window.saveFileContent()" style="font-size:11px">Save</button>');
        } else if (!fileState.fileUnsaved && existing) {
          existing.remove();
        }
      }
    });
    editor.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        window.saveFileContent();
      }
      if (e.key === 'Escape') {
        window.toggleFileEdit();
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        const start = editor.selectionStart;
        const end = editor.selectionEnd;
        editor.value = editor.value.substring(0, start) + '  ' + editor.value.substring(end);
        editor.selectionStart = editor.selectionEnd = start + 2;
        editor.dispatchEvent(new Event('input'));
      }
    });
  } else if (isJson) {
    body.innerHTML = `<div class="json-content">${syntaxHighlightJson(displayContent)}</div>`;
  } else {
    body.innerHTML = `<div class="md-content">${renderMarkdown(displayContent)}</div>`;
  }
  requestAnimationFrame(applyFileScrollbars);
}

// --- Markdown Renderer (simple, no external deps) ---
function renderMarkdown(text) {
  let html = escHtml(text);

  const codeBlocks = [];
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const placeholder = `<!--CODEBLOCK${codeBlocks.length}-->`;
    codeBlocks.push(`<pre><code class="language-${lang}">${code.trim()}</code></pre>`);
    return placeholder;
  });

  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
  html = html.replace(/^---$/gm, '<hr>');
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1">');
  html = html.replace(/^(\|.+\|)\n(\|[-:\s|]+\|)\n((?:\|.+\|\n?)*)/gm, (_, header, sep, body) => {
    const ths = header.split('|').filter(c => c.trim()).map(c => `<th>${c.trim()}</th>`).join('');
    const rows = body.trim().split('\n').map(row => {
      const tds = row.split('|').filter(c => c.trim()).map(c => `<td>${c.trim()}</td>`).join('');
      return `<tr>${tds}</tr>`;
    }).join('');
    return `<table><thead><tr>${ths}</tr></thead><tbody>${rows}</tbody></table>`;
  });
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
  html = html.replace(/^(?!<[a-z/]|$)(.+)$/gm, '<p>$1</p>');
  html = html.replace(/<p>(<h[1-4]|<pre|<blockquote|<ul|<ol|<table|<hr|<!--CODEBLOCK)/g, '$1');
  html = html.replace(/(<\/h[1-4]>|<\/pre>|<\/blockquote>|<\/ul>|<\/ol>|<\/table>|<hr>|<!--CODEBLOCK\d+-->)<\/p>/g, '$1');
  codeBlocks.forEach((block, i) => {
    html = html.replace(`<!--CODEBLOCK${i}-->`, block);
  });
  html = html.replace(/&lt;!--[\s\S]*?--&gt;/g, '');
  return html;
}

function syntaxHighlightJson(text) {
  try {
    const obj = JSON.parse(text);
    const formatted = JSON.stringify(obj, null, 2);
    return escHtml(formatted)
      .replace(/"([^"]+)":/g, '<span class="json-key">"$1"</span>:')
      .replace(/: "([^"]*)"/g, ': <span class="json-string">"$1"</span>')
      .replace(/: (\d+\.?\d*)/g, ': <span class="json-number">$1</span>')
      .replace(/: (true|false)/g, ': <span class="json-bool">$1</span>')
      .replace(/: (null)/g, ': <span class="json-null">$1</span>');
  } catch {
    return `<pre>${escHtml(text)}</pre>`;
  }
}

// --- Custom Scrollbar ---
function _makeTrack() {
  const track = document.createElement('div');
  track.className = 'cscroll-track';
  const thumb = document.createElement('div');
  thumb.className = 'cscroll-thumb';
  track.appendChild(thumb);
  return { track, thumb };
}

function _bindScroll(scrollEl, track, thumb) {
  let dragging = false, startY = 0, startScroll = 0;
  function update() {
    const sh = scrollEl.scrollHeight, ch = scrollEl.clientHeight;
    if (sh <= ch + 1) { track.classList.add('hidden'); return; }
    track.classList.remove('hidden');
    const trackH = track.clientHeight;
    const thumbH = Math.max(24, trackH * (ch / sh));
    const scrollRatio = scrollEl.scrollTop / (sh - ch);
    thumb.style.height = thumbH + 'px';
    thumb.style.top = (scrollRatio * (trackH - thumbH)) + 'px';
  }
  scrollEl.addEventListener('scroll', update, { passive: true });
  new ResizeObserver(update).observe(scrollEl);
  new MutationObserver(update).observe(scrollEl, { childList: true, subtree: true });
  thumb.addEventListener('mousedown', (e) => {
    e.preventDefault(); e.stopPropagation();
    dragging = true; startY = e.clientY; startScroll = scrollEl.scrollTop;
    thumb.classList.add('dragging');
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const sh = scrollEl.scrollHeight, ch = scrollEl.clientHeight, trackH = track.clientHeight;
    const thumbH = Math.max(24, trackH * (ch / sh));
    scrollEl.scrollTop = startScroll + (e.clientY - startY) * ((sh - ch) / (trackH - thumbH));
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false; thumb.classList.remove('dragging');
  });
  track.addEventListener('mousedown', (e) => {
    if (e.target === thumb) return;
    const rect = track.getBoundingClientRect();
    scrollEl.scrollTop = ((e.clientY - rect.top) / rect.height) * (scrollEl.scrollHeight - scrollEl.clientHeight);
  });
  requestAnimationFrame(() => requestAnimationFrame(update));
  return update;
}

function cscrollWrap(el) {
  if (!el || el.classList.contains('cscroll-inner')) return;
  const wrap = document.createElement('div');
  wrap.className = 'cscroll-wrap';
  const cs = getComputedStyle(el);
  if (cs.flex && cs.flex !== '0 1 auto') wrap.style.flex = cs.flex;
  wrap.style.overflow = 'hidden';
  el.parentNode.insertBefore(wrap, el);
  wrap.appendChild(el);
  el.classList.add('cscroll-inner');
  el.style.overflowY = 'auto';
  const { track, thumb } = _makeTrack();
  wrap.appendChild(track);
  const updateFn = _bindScroll(el, track, thumb);
  wrap._cscrollUpdate = updateFn;
}

function cscrollBind(scrollEl, trackHost) {
  if (!scrollEl || !trackHost) return;
  trackHost.style.position = 'relative';
  const old = trackHost.querySelector(':scope > .cscroll-track');
  if (old) old.remove();
  const { track, thumb } = _makeTrack();
  trackHost.appendChild(track);
  _bindScroll(scrollEl, track, thumb);
}

let _staticDone = false;
export function applyStaticScrollbars() {
  if (_staticDone) return;
  const content = document.getElementById('content');
  if (content && !content.classList.contains('cscroll-inner')) {
    cscrollWrap(content);
    const wrap = content.parentElement;
    if (wrap && wrap.classList.contains('cscroll-wrap')) {
      wrap.style.gridRow = '3';
      wrap.style.overflow = 'hidden';
      wrap.classList.add('content-wrapper');
    }
  }
  _staticDone = true;
  updateContentScrollbarVisibility();
}

export function updateContentScrollbarVisibility() {
  const wrap = document.querySelector('.content-wrapper');
  const contentTrack = wrap && wrap.querySelector(':scope > .cscroll-track');
  if (contentTrack) {
    const currentTab = window.appState?.currentTab;
    if (currentTab === 'tasks') {
      contentTrack.style.display = '';
      if (wrap._cscrollUpdate) {
        requestAnimationFrame(() => requestAnimationFrame(wrap._cscrollUpdate));
      }
    } else {
      contentTrack.style.display = 'none';
    }
  }
}

function applyFileScrollbars() {
  const tree = document.querySelector('.file-tree');
  const treeItems = document.querySelector('.file-tree-items');
  if (tree && treeItems) cscrollBind(treeItems, tree);

  const preview = document.getElementById('filePreview');
  if (!preview) return;

  if (fileState.fileEditing) {
    const editor = document.querySelector('.file-editor');
    if (editor) cscrollBind(editor, preview);
  } else {
    const body = document.querySelector('.file-preview-body');
    if (body) cscrollBind(body, preview);
  }
}
