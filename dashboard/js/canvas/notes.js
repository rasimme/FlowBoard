// canvas/notes.js — Note CRUD, rendering, markdown, editing, sidebar

import { api, toast, showModal, escHtml, ICONS } from '../utils.js?v=5';
import { canvasState, NOTE_WIDTH, screenToCanvas } from './state.js?v=1';
import { renderConnections } from './connections.js?v=3';
import { updateToolbar, renderPromoteButton } from './toolbar.js?v=10';

// --- Markdown renderer (note subset: bold, lists, links only) ---
export function renderNoteMarkdown(text) {
  if (!text) return '';
  // Process line by line so list items stay together, plain lines use <br>
  const lines = text.split('\n');
  const out = [];
  let inList = false; // false | 'ul' | 'ol'
  for (let i = 0; i < lines.length; i++) {
    // Escape HTML first, then apply markdown (safe order: patterns like ** and [] survive escaping)
    let line = escHtml(lines[i]);
    // Bold
    line = line.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // Italic
    line = line.replace(/\*(.+?)\*/g, '<em>$1</em>');
    // Strip remaining unpaired/empty markers and empty tags
    line = line.replace(/\*+/g, '');
    line = line.replace(/<(strong|em)><\/\1>/g, '');
    // Explicit markdown links [label](url) — unescape URL for href (& → &amp; is valid in href)
    line = line.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
      // url may have &amp; from escHtml — decode for href
      const rawUrl = url.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
      const href = /^https?:\/\//.test(rawUrl) ? rawUrl : 'https://' + rawUrl;
      return `<a href="${href}" target="_blank" rel="noopener">${label}</a>`;
    });
    // Auto-link bare URLs — only in text segments outside HTML tags
    line = line.replace(/(<[^>]*>)|(?:https?:\/\/[^\s<>"]+|www\.[^\s<>"]+)/g, (match, tag) => {
      if (tag) return tag; // HTML tag — pass through unchanged
      const href = match.startsWith('http') ? match : 'https://' + match;
      return `<a href="${href}" target="_blank" rel="noopener">${match}</a>`;
    });
    const numListMatch = line.match(/^\d+\. (.*)/);
    if (line.startsWith('- ')) {
      if (inList === 'ol') { out.push('</ol>'); inList = false; }
      if (!inList) { out.push('<ul>'); inList = 'ul'; }
      out.push('<li>' + line.slice(2) + '</li>');
    } else if (numListMatch) {
      if (inList === 'ul') { out.push('</ul>'); inList = false; }
      if (!inList) { out.push('<ol>'); inList = 'ol'; }
      out.push('<li>' + numListMatch[1] + '</li>');
    } else {
      if (inList === 'ul') { out.push('</ul>'); inList = false; }
      if (inList === 'ol') { out.push('</ol>'); inList = false; }
      if (line === '') {
        out.push('<br>');
      } else {
        out.push(line + (i < lines.length - 1 ? '<br>' : ''));
      }
    }
  }
  if (inList === 'ul') out.push('</ul>'); if (inList === 'ol') out.push('</ol>');
  return out.join('');
}

export function checkTruncation(noteEl) {
  const body = noteEl?.querySelector('.note-body');
  if (!body) return;
  if (body.scrollHeight > body.clientHeight + 2) {
    body.classList.add('truncated');
  } else {
    body.classList.remove('truncated');
  }
}

// --- Note HTML ---
function noteHTML(note) {
  const rendered = renderNoteMarkdown(note.text || '');
  return `
    <div class="note-header" data-noteid="${note.id}">
      <span class="note-id">${note.id}</span>
    </div>
    <div class="note-body">
      <div class="note-text md-content">${rendered || '<span style="opacity:0.3;font-size:11px">Double-click to add text\u2026</span>'}</div>
    </div>
    <div class="note-overflow-fade" aria-hidden="true"></div>
    `;
}

export function createNoteElement(note) {
  const el = document.createElement('div');
  el.id = 'note-' + note.id;
  el.className = `note color-${note.color || 'grey'}${note.size === 'medium' ? ' size-medium' : ''}`;
  if (note.size === 'medium') el.style.width = '280px';
  if (canvasState.selectedIds.has(note.id)) el.classList.add('selected');
  el.style.left = note.x + 'px';
  el.style.top  = note.y + 'px';
  el.innerHTML = noteHTML(note);
  return el;
}

// --- Reposition notes that landed at origin (created via API with default x:0, y:0) ---
function repositionZeroNote(note) {
  const wrap = document.getElementById('canvasWrap');
  if (!wrap) return;
  // Compute canvas-space coordinate of the visible viewport center
  const cx = (wrap.clientWidth  / 2 - canvasState.pan.x) / canvasState.scale;
  const cy = (wrap.clientHeight / 2 - canvasState.pan.y) / canvasState.scale;
  // Scatter ±100px horizontal, ±50px vertical so multiple zero-notes don't stack
  note.x = cx + (Math.random() - 0.5) * 200;
  note.y = cy + (Math.random() - 0.5) * 100;
  // Persist in background — failure is silent, next refresh recalculates
  if (!window.appState?.viewedProject) return;
  api(`/projects/${window.appState.viewedProject}/canvas/notes/${note.id}`, {
    method: 'PUT', body: { x: Math.round(note.x), y: Math.round(note.y) }
  }).catch(() => {});
}

// --- Render notes ---
export function renderNotes() {
  const vp = document.getElementById('canvasViewport');
  if (!vp) return;
  // Remove old note elements (keep SVG) — skip the note being edited
  vp.querySelectorAll('.note').forEach(el => {
    const noteId = el.id.replace('note-', '');
    if (noteId === canvasState.editingId) return; // preserve active edit DOM
    el.remove();
  });
  for (const note of canvasState.notes) {
    if (note.id === canvasState.editingId) continue; // already in DOM, skip
    if (note.x === 0 && note.y === 0) repositionZeroNote(note);
    vp.appendChild(createNoteElement(note));
  }

  // Check truncation after DOM layout (skip editing note)
  requestAnimationFrame(() => {
    for (const note of canvasState.notes) {
      if (note.id === canvasState.editingId) continue;
      checkTruncation(document.getElementById('note-' + note.id));
    }
  });
}

// --- Empty state ---
export function renderEmptyState() {
  const vp = document.getElementById('canvasViewport');
  if (!vp) return;
  const wrap = document.getElementById('canvasWrap');
  const existing = (wrap || vp).querySelector('.canvas-empty');
  if (canvasState.notes.length === 0) {
    if (!existing) {
      const el = document.createElement('div');
      el.className = 'canvas-empty';
      el.innerHTML = `<div class="canvas-empty-icon">${ICONS.lightbulb}</div>
        <div>Double-click to create your first idea</div>
        <div style="font-size:12px;opacity:0.6">or use the + Note button</div>`;
      document.getElementById("canvasWrap").appendChild(el);
    }
  } else {
    if (existing) existing.remove();
  }
}

// --- Create note ---
export async function createNoteAt(x, y) {
  if (!window.appState?.viewedProject) return;
  try {
    const res = await api(`/projects/${window.appState.viewedProject}/canvas/notes`, {
      method: 'POST',
      body: { text: '', x: Math.round(x), y: Math.round(y), color: 'grey' }
    });
    if (res.ok) {
      canvasState.notes.push(res.note);
      const vp = document.getElementById('canvasViewport');
      if (vp) {
        const el = createNoteElement(res.note);
        vp.appendChild(el);
        // Select the newly created note
        canvasState.selectedIds.clear();
        document.querySelectorAll('.note.selected').forEach(n => n.classList.remove('selected'));
        canvasState.selectedIds.add(res.note.id);
        el.classList.add('selected');
        renderEmptyState();
        renderPromoteButton();
        updateToolbar();
        // Auto-focus the new note for editing
        setTimeout(() => startNoteEdit(res.note.id), 50);
      }
    }
  } catch {
    toast('Failed to create note', 'error');
  }
}

let _addNoteCounter = 0;
export function addNote(state) {
  // Toolbar button: place note in visible center of canvas, offset each successive one
  const wrap = document.getElementById('canvasWrap');
  if (!wrap) return;
  const offset = (_addNoteCounter++ % 8) * 30;
  const cx = (wrap.clientWidth  / 2 - canvasState.pan.x) / canvasState.scale - NOTE_WIDTH / 2 + offset;
  const cy = (wrap.clientHeight / 2 - canvasState.pan.y) / canvasState.scale - 40 + offset;
  createNoteAt(cx, cy);
}

// --- Delete note ---
export function startDeleteNote(id) {
  const note = canvasState.notes.find(n => n.id === id);
  if (!note) return;
  const preview = note.text ? note.text.slice(0, 60) : '(empty)';
  showModal(
    'Delete note?',
    `<strong>${id}</strong>: ${escHtml(preview)}<br>This action cannot be undone.`,
    () => confirmDeleteNote(id)
  );
}

export async function confirmDeleteNote(id) {
  if (!window.appState?.viewedProject) return;
  const el = document.getElementById('note-' + id);
  if (el) el.style.opacity = '0.4';

  // If deleting the active editor/sidebar note, clear state first
  if (canvasState.editingId === id) {
    canvasState.editingId = null;
  }
  if (canvasState.sidebarNoteId === id) {
    const sidebar = document.getElementById('canvasSidebar');
    if (sidebar) sidebar.classList.remove('open');
    canvasState.sidebarNoteId = null;
  }
  try {
    const res = await api(
      `/projects/${window.appState.viewedProject}/canvas/notes/${id}`,
      { method: 'DELETE' }
    );
    if (res.ok) {
      canvasState.notes = canvasState.notes.filter(n => n.id !== id);
      canvasState.connections = canvasState.connections.filter(
        c => c.from !== id && c.to !== id
      );
      canvasState.selectedIds.delete(id);
      if (el) el.remove();
      renderConnections();
      renderEmptyState();
      renderPromoteButton();
      updateToolbar();
    }
  } catch {
    toast('Failed to delete note', 'error');
    if (el) el.style.opacity = '';
  }
}

// --- Note editing ---
export function startNoteEdit(id) {
  const el = document.getElementById('note-' + id);
  if (!el) return;
  const body = el.querySelector('.note-body');

  // If truncated, open sidebar instead of inline edit
  if (body?.classList.contains('truncated')) {
    openSidebar(id);
    return;
  }

  // If sidebar is open for another note, close it
  if (canvasState.sidebarNoteId) closeSidebar();

  if (canvasState.editingId === id) return;
  // Save any current edit first
  if (canvasState.editingId) {
    const prevTa = document.getElementById('note-ta-' + canvasState.editingId);
    if (prevTa) saveNoteText(canvasState.editingId, prevTa.value);
  }
  canvasState.editingId = id;
  renderPromoteButton();
  const note = canvasState.notes.find(n => n.id === id);
  if (!note) return;

  // Track that we're editing (for cleanup on save), no height lock
  el.dataset.editLockHeight = '1';

  if (!body) return;
  el.classList.add('editing');
  body.innerHTML = `<textarea class="note-textarea" id="note-ta-${id}">${escHtml(note.text || '')}</textarea>`;
  const ta = document.getElementById('note-ta-' + id);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);

  ta.addEventListener('blur', () => {
    if (canvasState.editingId === id) saveNoteText(id, ta.value);
  });
  ta.addEventListener('keydown', e => {
    e.stopPropagation(); // prevent canvas keybindings
    if (e.key === 'Escape') { ta.blur(); return; }

    // Auto-continue lists on Enter
    if (e.key === 'Enter') {
      const pos = ta.selectionStart;
      const val = ta.value;
      const lineStart = val.lastIndexOf('\n', pos - 1) + 1;
      const line = val.substring(lineStart, pos);

      // Detect list prefix: "- " or "N. "
      const bulletMatch = line.match(/^(- )(.*)/);
      const numberMatch = line.match(/^(\d+)\. (.*)/);

      if (bulletMatch) {
        e.preventDefault();
        const content = bulletMatch[2];
        if (content.trim() === '') {
          // Empty bullet → exit list (remove prefix)
          ta.value = val.substring(0, lineStart) + val.substring(pos);
          ta.setSelectionRange(lineStart, lineStart);
        } else {
          // Continue bullet
          const insert = '\n- ';
          ta.value = val.substring(0, pos) + insert + val.substring(pos);
          ta.setSelectionRange(pos + insert.length, pos + insert.length);
        }
        ta.dispatchEvent(new Event('input'));
        return;
      }
      if (numberMatch) {
        e.preventDefault();
        const num = parseInt(numberMatch[1], 10);
        const content = numberMatch[2];
        if (content.trim() === '') {
          // Empty numbered line → exit list
          ta.value = val.substring(0, lineStart) + val.substring(pos);
          ta.setSelectionRange(lineStart, lineStart);
        } else {
          const insert = '\n' + (num + 1) + '. ';
          ta.value = val.substring(0, pos) + insert + val.substring(pos);
          ta.setSelectionRange(pos + insert.length, pos + insert.length);
        }
        ta.dispatchEvent(new Event('input'));
        return;
      }
    }
  });
  ta.addEventListener('click', e => e.stopPropagation());
  ta.addEventListener('mousedown', e => e.stopPropagation());

  // Auto-grow textarea as user types; CSS handles body max-height + scroll
  const autoGrow = () => {
    ta.style.height = '1px';
    ta.style.height = ta.scrollHeight + 'px';
    renderConnections();
    updateToolbar();
  };
  ta.addEventListener('input', autoGrow);
  requestAnimationFrame(autoGrow);

  updateToolbar(); // show format section in toolbar
}

export async function saveNoteText(id, text) {
  canvasState.editingId = null;
  const note = canvasState.notes.find(n => n.id === id);
  if (!note) return;
  note.text = text;

  // Re-render note body from markdown
  const el = document.getElementById('note-' + id);
  if (el) {
    const body = el.querySelector('.note-body');
    if (body) {
      const rendered = renderNoteMarkdown(text);
      body.innerHTML = `<div class="note-text md-content">${rendered || '<span style="opacity:0.3;font-size:11px">Double-click to add text\u2026</span>'}</div>`;
    }
    checkTruncation(el);

    // Clear edit size lock + editing class (restore natural height)
    if (el.dataset.editLockHeight) {
      delete el.dataset.editLockHeight;
      el.style.minHeight = '';
    }
    // Clear any inline heights set during edit mode
    if (body) { body.style.height = ''; body.style.overflowY = ''; }
    el.classList.remove('editing');
  }
  renderConnections();
  updateToolbar(); // hide format section
  renderPromoteButton();

  if (!window.appState?.viewedProject) return;
  try {
    await api(`/projects/${window.appState.viewedProject}/canvas/notes/${id}`, {
      method: 'PUT', body: { text }
    });
  } catch { /* silent — data is in memory */ }
}

// --- Sidebar ---
export function openSidebar(noteId) {
  const note = canvasState.notes.find(n => n.id === noteId);
  if (!note) return;
  canvasState.sidebarNoteId = noteId;

  const sidebar = document.getElementById('canvasSidebar');
  const colorBar = document.getElementById('sidebarColorBar');
  const noteIdEl = document.getElementById('sidebarNoteId');
  const textarea = document.getElementById('sidebarTextarea');
  if (!sidebar || !textarea) return;

  sidebar.classList.add('open');
  colorBar.className = `canvas-sidebar-color-bar sidebar-color-${note.color || 'grey'}`;
  noteIdEl.textContent = note.id;
  textarea.value = note.text || '';
  // Prevent browser scroll/viewport adjustments when focusing the sidebar textarea
  try {
    textarea.focus({ preventScroll: true });
  } catch {
    textarea.focus();
  }
}

export function closeSidebar() {
  const sidebar = document.getElementById('canvasSidebar');
  if (!sidebar) return;

  // Save current text before closing
  if (canvasState.sidebarNoteId) {
    const textarea = document.getElementById('sidebarTextarea');
    if (textarea) {
      saveNoteText(canvasState.sidebarNoteId, textarea.value);
    }
  }

  sidebar.classList.remove('open');
  canvasState.sidebarNoteId = null;
}

// --- Debounced position save ---
export function schedulePositionSave(noteId) {
  clearTimeout(canvasState.posSaveTimers[noteId]);
  canvasState.posSaveTimers[noteId] = setTimeout(async () => {
    const note = canvasState.notes.find(n => n.id === noteId);
    if (!note || !window.appState?.viewedProject) return;
    try {
      await api(`/projects/${window.appState.viewedProject}/canvas/notes/${noteId}`, {
        method: 'PUT', body: { x: Math.round(note.x), y: Math.round(note.y) }
      });
    } catch { /* silent */ }
  }, 500);
}

/** Immediately persists a note's current canvas position to the server. */
export async function saveNotePosition(noteId) {
  const note = canvasState.notes.find(n => n.id === noteId);
  if (!note || !window.appState?.viewedProject) return;
  try {
    await api(`/projects/${window.appState.viewedProject}/canvas/notes/${noteId}`, {
      method: 'PUT', body: { x: Math.round(note.x), y: Math.round(note.y) }
    });
  } catch {
    toast('Position save failed — refresh may revert', 'warn');
  }
}

export async function setNoteColor(noteId, color) {
  const note = canvasState.notes.find(n => n.id === noteId);
  if (!note) return;
  note.color = color;
  const el = document.getElementById('note-' + noteId);
  if (el) {
    el.className = `note color-${color}${note.size === 'medium' ? ' size-medium' : ''}${canvasState.selectedIds.has(noteId) ? ' selected' : ''}`;
  }
  if (!window.appState?.viewedProject) return;
  try {
    await api(`/projects/${window.appState.viewedProject}/canvas/notes/${noteId}`, {
      method: 'PUT', body: { color }
    });
  } catch { /* silent */ }
}

export async function setNoteSize(noteId, size) {
  const note = canvasState.notes.find(n => n.id === noteId);
  if (!note) return;
  note.size = size;
  const el = document.getElementById('note-' + noteId);
  if (el) {
    el.classList.toggle('size-medium', size === 'medium');
    el.style.width = size === 'medium' ? '280px' : '';
    requestAnimationFrame(() => checkTruncation(el));
  }
  renderConnections();
  requestAnimationFrame(() => updateToolbar());
  if (!window.appState?.viewedProject) return;
  try {
    await api(`/projects/${window.appState.viewedProject}/canvas/notes/${noteId}`, {
      method: 'PUT', body: { size }
    });
  } catch { /* silent */ }
}
