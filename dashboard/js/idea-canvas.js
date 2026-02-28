// idea-canvas.js — Infinite sticky-note canvas

import { api, toast, showModal, escHtml } from './utils.js?v=3';

// Inject canvas.css once at module load (overrides dashboard.css canvas rules)
if (!document.querySelector('link[data-canvas]')) {
  const _l = document.createElement('link');
  _l.rel = 'stylesheet';
  _l.href = './styles/canvas.css?v=4';
  _l.dataset.canvas = '1';
  document.head.appendChild(_l);
}

// --- Constants ---
const NOTE_WIDTH = 160;
const SCALE_MIN = 0.3;
const SCALE_MAX = 2.5;
const NOTE_COLORS = ['yellow', 'blue', 'green', 'red', 'teal'];
const CORNER_RADIUS = 12;    // px — radius of rounded bends in connection paths
const PORT_SPACING  = 18;    // px — spacing between stacked port centers on a side

// SVG stroke color by note color name
const COLOR_STROKE = {
  yellow: 'var(--warn)',
  blue:   'var(--info)',
  green:  'var(--ok)',
  red:    'var(--danger)',
  teal:   'var(--accent-2)'
};

// --- State ---
export const canvasState = {
  notes: [],
  connections: [],
  pan: { x: 60, y: 60 },
  scale: 1.0,
  selectedIds: new Set(),
  editingId: null,
  dragging: null,      // { noteId, startMouseX, startMouseY, startNoteX, startNoteY }
  connecting: null,    // { fromId }
  panning: null,       // { startX, startY, startPanX, startPanY }
  lassoState: null,    // { startX, startY, rect: {x,y,w,h} }
  posSaveTimers: {},
  sidebarNoteId: null,
  _state: null         // ref to global app state, set on renderIdeaCanvas
};

// --- Markdown renderer (note subset: bold, lists, links only) ---
function renderNoteMarkdown(text) {
  if (!text) return '';
  let html = escHtml(text);
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, match => `<ul>${match}</ul>`);
  html = html.replace(/^(?!<[ul]|$)(.+)$/gm, '<p>$1</p>');
  return html;
}

function checkTruncation(noteEl) {
  const body = noteEl?.querySelector('.note-body');
  if (!body) return;
  if (body.scrollHeight > body.clientHeight + 2) {
    body.classList.add('truncated');
  } else {
    body.classList.remove('truncated');
  }
}

// --- Coordinate helpers ---
function screenToCanvas(screenX, screenY) {
  const wrap = document.getElementById('canvasWrap');
  if (!wrap) return { x: 0, y: 0 };
  const rect = wrap.getBoundingClientRect();
  return {
    x: (screenX - rect.left - canvasState.pan.x) / canvasState.scale,
    y: (screenY - rect.top  - canvasState.pan.y) / canvasState.scale
  };
}

function getNoteCenter(id) {
  const el = document.getElementById('note-' + id);
  const note = canvasState.notes.find(n => n.id === id);
  if (!el || !note) return null;
  return { x: note.x + el.offsetWidth / 2, y: note.y + el.offsetHeight / 2 };
}

function getNoteDotPosition(noteId, port) {
  const el = document.getElementById('note-' + noteId);
  const note = canvasState.notes.find(n => n.id === noteId);
  if (!el || !note) return null;
  const w = el.offsetWidth, h = el.offsetHeight;
  return {
    top:    { x: note.x + w / 2, y: note.y },
    right:  { x: note.x + w,     y: note.y + h / 2 },
    bottom: { x: note.x + w / 2, y: note.y + h },
    left:   { x: note.x,         y: note.y + h / 2 }
  }[port];
}

// --- Transform ---
function applyTransform() {
  const vp = document.getElementById('canvasViewport');
  if (vp) vp.style.transform =
    `translate(${canvasState.pan.x}px, ${canvasState.pan.y}px) scale(${canvasState.scale})`;
}

// --- Load canvas data ---
async function loadCanvas(state) {
  try {
    const data = await api(`/projects/${state.viewedProject}/canvas`);
    canvasState.notes = data.notes || [];
    canvasState.connections = data.connections || [];
  } catch {
    toast('Failed to load canvas', 'error');
    canvasState.notes = [];
    canvasState.connections = [];
  }
}

// --- Empty state ---
function renderEmptyState() {
  const vp = document.getElementById('canvasViewport');
  if (!vp) return;
  const existing = vp.querySelector('.canvas-empty');
  if (canvasState.notes.length === 0) {
    if (!existing) {
      const el = document.createElement('div');
      el.className = 'canvas-empty';
      el.innerHTML = `<div class="canvas-empty-icon">💡</div>
        <div>Double-click to create your first idea</div>
        <div style="font-size:12px;opacity:0.6">or use the + Note button</div>`;
      vp.appendChild(el);
    }
  } else {
    if (existing) existing.remove();
  }
}

// --- Render all canvas elements ---
export function renderAll() {
  renderNotes();
  applyTransform();
  renderEmptyState();
  renderPromoteButton();
  requestAnimationFrame(renderConnections);
}

// --- Main entry point called from switchTab ---
export async function renderIdeaCanvas(state) {
  canvasState._state = state;
  const content = document.getElementById('content');
  content.style.overflow = 'hidden';

  content.innerHTML = `
    <div class="canvas-wrap" id="canvasWrap">
      <div class="canvas-toolbar">
        <button class="btn btn-primary btn-sm" onclick="window.addNote()">+ Note</button>
      </div>
      <div class="canvas-viewport" id="canvasViewport">
        <svg id="canvasSvg" class="canvas-svg canvas-svg-underlay">
          <defs>
            <pattern id="dotPattern" width="24" height="24" patternUnits="userSpaceOnUse">
              <circle cx="12" cy="12" r="1" fill="#3a3a45"/>
            </pattern>
          </defs>
          <rect width="10000" height="10000" x="-5000" y="-5000" fill="url(#dotPattern)"/>
        </svg>
        <svg id="canvasSvgOverlay" class="canvas-svg canvas-svg-overlay"></svg>
      </div>
      <div class="canvas-lasso" id="canvasLasso"></div>
      <div class="canvas-sidebar" id="canvasSidebar">
        <div class="canvas-sidebar-header">
          <span class="canvas-sidebar-color-bar" id="sidebarColorBar"></span>
          <span class="canvas-sidebar-id" id="sidebarNoteId"></span>
          <button class="canvas-sidebar-close" onclick="window.closeSidebar()">✕</button>
        </div>
        <div class="canvas-sidebar-body">
          <textarea class="canvas-sidebar-textarea" id="sidebarTextarea"></textarea>
        </div>
      </div>
    </div>`;

  bindCanvasEvents();

  // Sidebar textarea events
  const sidebarTa = document.getElementById('sidebarTextarea');
  if (sidebarTa) {
    sidebarTa.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Escape') closeSidebar();
    });
    sidebarTa.addEventListener('blur', () => {
      if (canvasState.sidebarNoteId) {
        saveNoteText(canvasState.sidebarNoteId, sidebarTa.value);
      }
    });
  }

  // Sidebar event isolation — prevent canvas interactions from leaking through
  const sidebar = document.getElementById('canvasSidebar');
  if (sidebar) {
    sidebar.addEventListener('wheel', e => e.stopPropagation(), { passive: false });
    sidebar.addEventListener('mousedown', e => e.stopPropagation());
    sidebar.addEventListener('touchstart', e => e.stopPropagation(), { passive: false });
    sidebar.addEventListener('touchmove', e => e.stopPropagation(), { passive: false });
  }

  if (!state.viewedProject) {
    const vp = document.getElementById('canvasViewport');
    if (vp) vp.innerHTML = `<svg id="canvasSvg" class="canvas-svg canvas-svg-underlay">
        <defs>
          <pattern id="dotPattern" width="24" height="24" patternUnits="userSpaceOnUse">
            <circle cx="12" cy="12" r="1" fill="#3a3a45"/>
          </pattern>
        </defs>
        <rect width="10000" height="10000" x="-5000" y="-5000" fill="url(#dotPattern)"/>
      </svg>
      <svg id="canvasSvgOverlay" class="canvas-svg canvas-svg-overlay"></svg>
      <div class="canvas-empty"><div class="canvas-empty-icon">💡</div><div>Select a project</div></div>`;
    return;
  }

  // Use cached data if available (set by refresh polling), else fetch
  if (canvasState.notes.length === 0 && canvasState.connections.length === 0) {
    await loadCanvas(state);
  }
  renderAll();
}

// --- Called from refresh polling when canvas data changes ---
export function refreshCanvas() {
  const vp = document.getElementById('canvasViewport');
  if (!vp) return; // not on ideas tab
  renderAll();
}

// --- Reset canvas state (called on project switch) ---
export function resetCanvasState() {
  canvasState.notes = [];
  canvasState.connections = [];
  canvasState.selectedIds.clear();
  canvasState.editingId = null;
  canvasState.dragging = null;
  canvasState.connecting = null;
  canvasState.panning = null;
  canvasState.lassoState = null;
  canvasState.pan = { x: 60, y: 60 };
  canvasState.scale = 1.0;
  canvasState.sidebarNoteId = null;
}

// --- Note HTML ---
function noteHTML(note) {
  const rendered = renderNoteMarkdown(note.text || '');
  return `
    <div class="note-header" data-noteid="${note.id}">
      <span class="note-id">${note.id}</span>
      <button class="note-menu-btn" onclick="window.toggleNoteMenu(event, '${note.id}')" title="Menu">⋮</button>
    </div>
    <div class="note-body">
      <div class="note-text md-content">${rendered || '<span style="opacity:0.3;font-size:11px">Double-click to add text\u2026</span>'}</div>
    </div>
    <div class="conn-dot conn-dot-top"    onmousedown="window.startConnectionDrag(event,'${note.id}','top')"></div>
    <div class="conn-dot conn-dot-right"  onmousedown="window.startConnectionDrag(event,'${note.id}','right')"></div>
    <div class="conn-dot conn-dot-bottom" onmousedown="window.startConnectionDrag(event,'${note.id}','bottom')"></div>
    <div class="conn-dot conn-dot-left"   onmousedown="window.startConnectionDrag(event,'${note.id}','left')"></div>`;
}

function createNoteElement(note) {
  const el = document.createElement('div');
  el.id = 'note-' + note.id;
  el.className = `note color-${note.color || 'yellow'}${note.size === 'medium' ? ' size-medium' : ''}`;
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
  if (!canvasState._state?.viewedProject) return;
  api(`/projects/${canvasState._state.viewedProject}/canvas/notes/${note.id}`, {
    method: 'PUT', body: { x: Math.round(note.x), y: Math.round(note.y) }
  }).catch(() => {});
}

// --- Render notes ---
function renderNotes() {
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

// --- Create note ---
async function createNoteAt(x, y) {
  if (!canvasState._state?.viewedProject) return;
  try {
    const res = await api(`/projects/${canvasState._state.viewedProject}/canvas/notes`, {
      method: 'POST',
      body: { text: '', x: Math.round(x), y: Math.round(y), color: 'yellow' }
    });
    if (res.ok) {
      canvasState.notes.push(res.note);
      const vp = document.getElementById('canvasViewport');
      if (vp) {
        vp.appendChild(createNoteElement(res.note));
        renderEmptyState();
        renderPromoteButton();
        // Auto-focus the new note for editing
        setTimeout(() => startNoteEdit(res.note.id), 50);
      }
    }
  } catch {
    toast('Failed to create note', 'error');
  }
}

export function addNote(state) {
  // Toolbar button: place note in visible center of canvas
  const wrap = document.getElementById('canvasWrap');
  if (!wrap) return;
  const cx = (wrap.clientWidth  / 2 - canvasState.pan.x) / canvasState.scale - NOTE_WIDTH / 2;
  const cy = (wrap.clientHeight / 2 - canvasState.pan.y) / canvasState.scale - 40;
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

async function confirmDeleteNote(id) {
  if (!canvasState._state?.viewedProject) return;
  const el = document.getElementById('note-' + id);
  if (el) el.style.opacity = '0.4';
  try {
    const res = await api(
      `/projects/${canvasState._state.viewedProject}/canvas/notes/${id}`,
      { method: 'DELETE' }
    );
    if (res.ok) {
      canvasState.notes = canvasState.notes.filter(n => n.id !== id);
      canvasState.connections = canvasState.connections.filter(
        c => c.from !== id && c.to !== id
      );
      if (el) el.remove();
      renderConnections();
      renderEmptyState();
      renderPromoteButton();
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
  const note = canvasState.notes.find(n => n.id === id);
  if (!note) return;

  if (!body) return;
  body.innerHTML = `<textarea class="note-textarea" id="note-ta-${id}">${escHtml(note.text || '')}</textarea>`;
  const ta = document.getElementById('note-ta-' + id);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);

  ta.addEventListener('blur', () => {
    if (canvasState.editingId === id) saveNoteText(id, ta.value);
  });
  ta.addEventListener('keydown', e => {
    e.stopPropagation(); // prevent canvas keybindings
    if (e.key === 'Escape') ta.blur();
  });
  ta.addEventListener('click', e => e.stopPropagation());
  ta.addEventListener('mousedown', e => e.stopPropagation());

  // Resize note height as user types
  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
    renderConnections(); // redraw lines as note grows
  });
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
  }
  renderConnections();

  if (!canvasState._state?.viewedProject) return;
  try {
    await api(`/projects/${canvasState._state.viewedProject}/canvas/notes/${id}`, {
      method: 'PUT', body: { text }
    });
  } catch { /* silent — data is in memory */ }
}

// --- Sidebar ---
function openSidebar(noteId) {
  const note = canvasState.notes.find(n => n.id === noteId);
  if (!note) return;
  canvasState.sidebarNoteId = noteId;

  const sidebar = document.getElementById('canvasSidebar');
  const colorBar = document.getElementById('sidebarColorBar');
  const noteIdEl = document.getElementById('sidebarNoteId');
  const textarea = document.getElementById('sidebarTextarea');
  if (!sidebar || !textarea) return;

  sidebar.classList.add('open');
  colorBar.className = `canvas-sidebar-color-bar sidebar-color-${note.color || 'yellow'}`;
  noteIdEl.textContent = note.id;
  textarea.value = note.text || '';
  textarea.focus();
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

window.closeSidebar = closeSidebar;

// --- Debounced position save ---
function schedulePositionSave(noteId) {
  clearTimeout(canvasState.posSaveTimers[noteId]);
  canvasState.posSaveTimers[noteId] = setTimeout(async () => {
    const note = canvasState.notes.find(n => n.id === noteId);
    if (!note || !canvasState._state?.viewedProject) return;
    try {
      await api(`/projects/${canvasState._state.viewedProject}/canvas/notes/${noteId}`, {
        method: 'PUT', body: { x: Math.round(note.x), y: Math.round(note.y) }
      });
    } catch { /* silent */ }
  }, 500);
}

/** Immediately persists a note's current canvas position to the server. */
async function saveNotePosition(noteId) {
  const note = canvasState.notes.find(n => n.id === noteId);
  if (!note || !canvasState._state?.viewedProject) return;
  try {
    await api(`/projects/${canvasState._state.viewedProject}/canvas/notes/${noteId}`, {
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
  if (!canvasState._state?.viewedProject) return;
  try {
    await api(`/projects/${canvasState._state.viewedProject}/canvas/notes/${noteId}`, {
      method: 'PUT', body: { color }
    });
  } catch { /* silent */ }
}

async function setNoteSize(noteId, size) {
  const note = canvasState.notes.find(n => n.id === noteId);
  if (!note) return;
  note.size = size;
  const el = document.getElementById('note-' + noteId);
  if (el) {
    el.classList.toggle('size-medium', size === 'medium');
    el.style.width = size === 'medium' ? '280px' : '';
  }
  renderConnections();
  if (!canvasState._state?.viewedProject) return;
  try {
    await api(`/projects/${canvasState._state.viewedProject}/canvas/notes/${noteId}`, {
      method: 'PUT', body: { size }
    });
  } catch { /* silent */ }
}

export function toggleNoteMenu(e, noteId) {
  e.stopPropagation();
  // Close any existing menu
  document.querySelectorAll('.note-menu-dropdown').forEach(m => m.remove());

  const note = canvasState.notes.find(n => n.id === noteId);
  if (!note) return;

  const menu = document.createElement('div');
  menu.className = 'note-menu-dropdown';

  // Color row
  const colorRow = document.createElement('div');
  colorRow.className = 'note-menu-section';
  colorRow.innerHTML = '<span class="note-menu-label">Color</span>';
  const swatchRow = document.createElement('div');
  swatchRow.className = 'note-menu-swatches';
  NOTE_COLORS.forEach(color => {
    const swatch = document.createElement('span');
    swatch.className = `color-swatch color-swatch-${color}${color === note.color ? ' selected' : ''}`;
    swatch.title = color;
    swatch.addEventListener('click', ev => {
      ev.stopPropagation();
      setNoteColor(noteId, color);
      menu.remove();
    });
    swatchRow.appendChild(swatch);
  });
  colorRow.appendChild(swatchRow);
  menu.appendChild(colorRow);

  // Size row
  const sizeRow = document.createElement('div');
  sizeRow.className = 'note-menu-section';
  sizeRow.innerHTML = '<span class="note-menu-label">Size</span>';
  const sizeBtns = document.createElement('div');
  sizeBtns.className = 'note-menu-sizes';
  ['small', 'medium'].forEach(size => {
    const btn = document.createElement('button');
    btn.className = `note-menu-size-btn${(note.size || 'small') === size ? ' active' : ''}`;
    btn.textContent = size.charAt(0).toUpperCase() + size.slice(1);
    btn.addEventListener('click', ev => {
      ev.stopPropagation();
      setNoteSize(noteId, size);
      menu.remove();
    });
    sizeBtns.appendChild(btn);
  });
  sizeRow.appendChild(sizeBtns);
  menu.appendChild(sizeRow);

  // Delete option
  const delBtn = document.createElement('button');
  delBtn.className = 'note-menu-delete';
  delBtn.textContent = 'Delete';
  delBtn.addEventListener('click', ev => {
    ev.stopPropagation();
    menu.remove();
    startDeleteNote(noteId);
  });
  menu.appendChild(delBtn);

  // Position below the menu button
  e.currentTarget.closest('.note-header').appendChild(menu);

  // Close on outside click or Escape
  setTimeout(() => {
    const close = ev => {
      if (!menu.contains(ev.target) && !ev.target.closest('.note-menu-btn')) {
        menu.remove();
        document.removeEventListener('click', close);
        document.removeEventListener('keydown', escClose);
      }
    };
    const escClose = ev => {
      if (ev.key === 'Escape') {
        menu.remove();
        document.removeEventListener('click', close);
        document.removeEventListener('keydown', escClose);
      }
    };
    document.addEventListener('click', close);
    document.addEventListener('keydown', escClose);
  }, 0);
}

window.toggleNoteMenu = toggleNoteMenu;

// --- Canvas mouse/touch events ---
function bindCanvasEvents() {
  const wrap = document.getElementById('canvasWrap');
  if (!wrap) return;
  wrap.addEventListener('dblclick',   onCanvasDblClick);
  wrap.addEventListener('mousedown',  onCanvasMouseDown);
  wrap.addEventListener('mousemove',  onCanvasMouseMove);
  wrap.addEventListener('mouseup',    onCanvasMouseUp);
  wrap.addEventListener('mouseleave', onCanvasMouseUp);
  wrap.addEventListener('wheel',      onCanvasWheel, { passive: false });
  wrap.addEventListener('touchstart', onTouchStart,  { passive: false });
  wrap.addEventListener('touchmove',  onTouchMove,   { passive: false });
  wrap.addEventListener('touchend',   onTouchEnd);
}

function onCanvasDblClick(e) {
  if (e.target.closest('.canvas-toolbar')) return;
  if (e.target.closest('.canvas-sidebar')) return; // Don't process sidebar dblclicks as canvas events

  // Double-click on a note → edit or switch sidebar
  const noteEl = e.target.closest('.note');
  if (noteEl) {
    const noteId = noteEl.id.replace('note-', '');
    // If sidebar is open, switch to this note
    if (canvasState.sidebarNoteId) {
      openSidebar(noteId);
      return;
    }
    startNoteEdit(noteId);
    return;
  }

  // Double-click on empty canvas → create note
  const pos = screenToCanvas(e.clientX, e.clientY);
  createNoteAt(pos.x - NOTE_WIDTH / 2, pos.y - 20);
}

function onCanvasMouseDown(e) {
  if (e.button !== 0) return;

  const connDot = e.target.closest('.conn-dot');
  if (connDot) return; // handled by startConnectionDrag inline handler

  // Ignore clicks on menu elements
  if (e.target.closest('.note-menu-btn') || e.target.closest('.note-menu-dropdown')) return;

  const noteEl = e.target.closest('.note');

  if (noteEl) {
    e.stopPropagation();
    const noteId = noteEl.id.replace('note-', '');
    const note   = canvasState.notes.find(n => n.id === noteId);
    if (!note) return;

    // Close any active edit on another note
    if (canvasState.editingId && canvasState.editingId !== noteId) {
      const ta = document.getElementById('note-ta-' + canvasState.editingId);
      if (ta) saveNoteText(canvasState.editingId, ta.value);
    }

    // If clicking inside a textarea (editing), don't start drag
    if (e.target.closest('.note-textarea')) return;

    // Don't start drag on a note that's being edited (defense-in-depth)
    if (canvasState.editingId === noteId) return;

    // Close sidebar on single click of any note (design: any click on canvas closes sidebar)
    if (canvasState.sidebarNoteId) closeSidebar();

    // Start potential drag from anywhere on the note
    canvasState.dragging = {
      noteId,
      startMouseX: e.clientX, startMouseY: e.clientY,
      startNoteX: note.x,     startNoteY: note.y,
      moved: false
    };

    // If dragging a selected note, store start positions for all selected
    // If dragging an unselected note, it becomes the only selection
    if (!canvasState.selectedIds.has(noteId)) {
      canvasState.selectedIds.clear();
      document.querySelectorAll('.note.selected').forEach(el => el.classList.remove('selected'));
      canvasState.selectedIds.add(noteId);
      noteEl.classList.add('selected');
      renderPromoteButton();
    }

    // Store start positions for all selected notes
    canvasState.dragging.startPositions = new Map();
    for (const selId of canvasState.selectedIds) {
      const selNote = canvasState.notes.find(n => n.id === selId);
      if (selNote) {
        canvasState.dragging.startPositions.set(selId, { x: selNote.x, y: selNote.y });
      }
    }
    return;
  }

  // Empty canvas: deselect + start pan or Shift+lasso
  canvasState.selectedIds.clear();
  document.querySelectorAll('.note.selected').forEach(el => el.classList.remove('selected'));
  renderPromoteButton();

  // Close sidebar when clicking empty canvas
  if (canvasState.sidebarNoteId) closeSidebar();

  // Close any active edit
  if (canvasState.editingId) {
    const ta = document.getElementById('note-ta-' + canvasState.editingId);
    if (ta) saveNoteText(canvasState.editingId, ta.value);
  }

  if (e.shiftKey) {
    const wrap = document.getElementById('canvasWrap');
    const rect = wrap.getBoundingClientRect();
    canvasState.lassoState = {
      startX: e.clientX - rect.left,
      startY: e.clientY - rect.top
    };
  } else {
    canvasState.panning = {
      startX: e.clientX, startY: e.clientY,
      startPanX: canvasState.pan.x, startPanY: canvasState.pan.y
    };
  }
}

function onCanvasMouseMove(e) {
  // Note drag
  if (canvasState.dragging) {
    const d = canvasState.dragging;
    const dx = (e.clientX - d.startMouseX) / canvasState.scale;
    const dy = (e.clientY - d.startMouseY) / canvasState.scale;
    const dist = Math.abs(e.clientX - d.startMouseX) + Math.abs(e.clientY - d.startMouseY);

    if (!d.moved && dist < 5) return;
    d.moved = true;

    // Move all selected notes (multi-select drag)
    if (d.startPositions) {
      for (const [selId, startPos] of d.startPositions) {
        const selNote = canvasState.notes.find(n => n.id === selId);
        if (selNote) {
          selNote.x = startPos.x + dx;
          selNote.y = startPos.y + dy;
          const el = document.getElementById('note-' + selId);
          if (el) { el.style.left = selNote.x + 'px'; el.style.top = selNote.y + 'px'; }
        }
      }
    }
    renderConnections();
    return;
  }

  // Connection drag — update preview path + nearest port snap
  if (canvasState.connecting) {
    const pos     = screenToCanvas(e.clientX, e.clientY);
    const fromPt  = canvasState.connecting.fromPt;
    let tx = pos.x, ty = pos.y;

    // Remove previous snap highlight
    document.querySelectorAll('.conn-dot-snap').forEach(d => d.classList.remove('conn-dot-snap'));

    // Find nearest port on any target note
    let nearestDot = null;
    let nearestDist = Infinity;
    let nearestNoteId = null;

    document.querySelectorAll('.note').forEach(noteEl => {
      if (noteEl.id === 'note-' + canvasState.connecting.fromId) return;
      const targetId = noteEl.id.replace('note-', '');

      ['top', 'right', 'bottom', 'left'].forEach(port => {
        const portPos = getNoteDotPosition(targetId, port);
        if (!portPos) return;
        const d = Math.hypot(pos.x - portPos.x, pos.y - portPos.y);
        if (d < nearestDist) {
          nearestDist = d;
          nearestDot = noteEl.querySelector(`.conn-dot-${port}`);
          nearestNoteId = targetId;
          tx = portPos.x;
          ty = portPos.y;
        }
      });
    });

    // Snap threshold: 60px canvas-space (~close enough to a card)
    if (nearestDist < 60 && nearestDot) {
      nearestDot.classList.add('conn-dot-snap');
      canvasState.connecting.snapTargetId = nearestNoteId;
      canvasState.connecting.snapValid = true;
    } else {
      // Not near any port — follow cursor freely
      tx = pos.x;
      ty = pos.y;
      canvasState.connecting.snapTargetId = null;
      canvasState.connecting.snapValid = false;
    }

    const fromPort = canvasState.connecting.fromPort;
    const orientation = (fromPort === 'top' || fromPort === 'bottom') ? 'vertical' : 'horizontal';

    const prev = document.getElementById('conn-preview');
    if (prev && fromPt) {
      prev.setAttribute('d', manhattanPath(fromPt.x, fromPt.y, tx, ty, orientation));
    }
    return;
  }

  // Pan
  if (canvasState.panning) {
    const d = canvasState.panning;
    canvasState.pan.x = d.startPanX + (e.clientX - d.startX);
    canvasState.pan.y = d.startPanY + (e.clientY - d.startY);
    applyTransform();
    return;
  }

  // Lasso
  if (canvasState.lassoState) {
    const wrap = document.getElementById('canvasWrap');
    const wRect = wrap.getBoundingClientRect();
    const curX = e.clientX - wRect.left;
    const curY = e.clientY - wRect.top;
    const { startX, startY } = canvasState.lassoState;
    const lasso = document.getElementById('canvasLasso');
    if (lasso) {
      const lx = Math.min(startX, curX), ly = Math.min(startY, curY);
      const lw = Math.abs(curX - startX), lh = Math.abs(curY - startY);
      lasso.style.cssText = `display:block;left:${lx}px;top:${ly}px;width:${lw}px;height:${lh}px;`;
      canvasState.lassoState.rect = { x: lx, y: ly, w: lw, h: lh };
    }
  }
}

function onCanvasMouseUp(e) {
  // End note drag or click-to-select
  if (canvasState.dragging) {
    const { noteId, moved, startPositions } = canvasState.dragging;
    canvasState.dragging = null;

    if (moved) {
      // Persist positions for all moved notes
      if (startPositions) {
        for (const selId of startPositions.keys()) {
          saveNotePosition(selId);
        }
      } else {
        saveNotePosition(noteId);
      }
    } else {
      // Click without drag — select/toggle
      const noteEl = document.getElementById('note-' + noteId);
      if (e.shiftKey) {
        // Shift+click: toggle selection
        if (canvasState.selectedIds.has(noteId)) {
          canvasState.selectedIds.delete(noteId);
          noteEl?.classList.remove('selected');
        } else {
          canvasState.selectedIds.add(noteId);
          noteEl?.classList.add('selected');
        }
      } else {
        // Plain click: select only this
        canvasState.selectedIds.clear();
        document.querySelectorAll('.note.selected').forEach(el => el.classList.remove('selected'));
        canvasState.selectedIds.add(noteId);
        noteEl?.classList.add('selected');
      }
      renderPromoteButton();
    }
    return;
  }

  // End connection drag — only commit if cursor was snapped to a valid port
  if (canvasState.connecting) {
    const { fromId, snapTargetId, snapValid } = canvasState.connecting;
    if (snapValid && snapTargetId && snapTargetId !== fromId) {
      saveConnection(fromId, snapTargetId);
    }
    removeTempConnectionLine();
    canvasState.connecting = null;
    return;
  }

  // End pan
  if (canvasState.panning) {
    canvasState.panning = null;
    return;
  }

  // End lasso
  if (canvasState.lassoState) {
    const lasso = document.getElementById('canvasLasso');
    if (lasso) lasso.style.display = 'none';
    if (canvasState.lassoState.rect) applyLassoSelection(canvasState.lassoState.rect);
    canvasState.lassoState = null;
    return;
  }
}

function applyLassoSelection(screenRect) {
  // Convert lasso rect from screen/wrap coordinates to canvas coordinates
  const scale = canvasState.scale;
  const panX  = canvasState.pan.x, panY = canvasState.pan.y;
  const lx1 = (screenRect.x - panX) / scale;
  const ly1 = (screenRect.y - panY) / scale;
  const lx2 = (screenRect.x + screenRect.w - panX) / scale;
  const ly2 = (screenRect.y + screenRect.h - panY) / scale;

  canvasState.selectedIds.clear();
  document.querySelectorAll('.note.selected').forEach(el => el.classList.remove('selected'));

  for (const note of canvasState.notes) {
    const el = document.getElementById('note-' + note.id);
    if (!el) continue;
    const nx1 = note.x, ny1 = note.y;
    const nx2 = note.x + el.offsetWidth, ny2 = note.y + el.offsetHeight;
    // Overlap check
    if (nx1 < lx2 && nx2 > lx1 && ny1 < ly2 && ny2 > ly1) {
      canvasState.selectedIds.add(note.id);
      el.classList.add('selected');
    }
  }
  renderPromoteButton();
}

function onCanvasWheel(e) {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    // Zoom toward cursor
    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    const newScale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, canvasState.scale * factor));
    const wrap = document.getElementById('canvasWrap');
    const rect = wrap.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    canvasState.pan.x = mx - (mx - canvasState.pan.x) * (newScale / canvasState.scale);
    canvasState.pan.y = my - (my - canvasState.pan.y) * (newScale / canvasState.scale);
    canvasState.scale = newScale;
  } else {
    canvasState.pan.x -= e.deltaX;
    canvasState.pan.y -= e.deltaY;
  }
  applyTransform();
}

let _pinchDist = 0;
let _longPressTimer = null;
let _lastTapTime = 0;
let _lastTapTarget = null;

function onTouchStart(e) {
  // Don't preventDefault if touching a textarea — allow native text interaction
  const touchTarget = document.elementFromPoint(e.touches[0].clientX, e.touches[0].clientY);
  if (touchTarget?.closest('.note-textarea') || touchTarget?.closest('.canvas-sidebar-textarea')) {
    return; // Let browser handle textarea touch natively
  }
  e.preventDefault();
  clearTimeout(_longPressTimer);

  if (e.touches.length === 1) {
    const t = e.touches[0];
    const noteEl = document.elementFromPoint(t.clientX, t.clientY)?.closest?.('.note');

    if (noteEl) {
      const noteId = noteEl.id.replace('note-', '');
      const note   = canvasState.notes.find(n => n.id === noteId);
      if (!note) return;

      // Don't interfere with active edit textarea touch interaction
      if (canvasState.editingId === noteId) return;

      // Double-tap detection (300ms)
      const now = Date.now();
      if (_lastTapTarget === noteId && now - _lastTapTime < 300) {
        _lastTapTime = 0;
        _lastTapTarget = null;
        if (canvasState.sidebarNoteId) {
          openSidebar(noteId); // switch sidebar content
        } else {
          startNoteEdit(noteId);
        }
        return;
      }
      _lastTapTime = now;
      _lastTapTarget = noteId;

      // Long-press detection (500ms) → edit
      _longPressTimer = setTimeout(() => {
        if (canvasState.dragging && !canvasState.dragging.moved) {
          canvasState.dragging = null;
          startNoteEdit(noteId);
        }
      }, 500);

      // Start potential drag
      canvasState.dragging = {
        noteId,
        startMouseX: t.clientX, startMouseY: t.clientY,
        startNoteX: note.x,     startNoteY: note.y,
        moved: false
      };

      // Select this note
      canvasState.selectedIds.clear();
      document.querySelectorAll('.note.selected').forEach(el => el.classList.remove('selected'));
      canvasState.selectedIds.add(noteId);
      noteEl.classList.add('selected');
      renderPromoteButton();
      return;
    }

    _lastTapTime = 0;
    _lastTapTarget = null;

    // Close sidebar on canvas tap
    if (canvasState.sidebarNoteId) closeSidebar();

    // Canvas pan
    canvasState.panning = {
      startX: t.clientX, startY: t.clientY,
      startPanX: canvasState.pan.x, startPanY: canvasState.pan.y
    };
  } else if (e.touches.length === 2) {
    clearTimeout(_longPressTimer);
    canvasState.panning = null;
    canvasState.dragging = null;
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    _pinchDist = Math.hypot(dx, dy);
  }
}

function onTouchMove(e) {
  // Don't prevent default if interacting with textarea
  if (canvasState.editingId || canvasState.sidebarNoteId) {
    const touchTarget = document.elementFromPoint(e.touches[0].clientX, e.touches[0].clientY);
    if (touchTarget?.closest('.note-textarea') || touchTarget?.closest('.canvas-sidebar-textarea')) {
      return;
    }
  }
  e.preventDefault();
  if (e.touches.length === 1) {
    const t = e.touches[0];
    if (canvasState.dragging) {
      const d = canvasState.dragging;
      const dist = Math.abs(t.clientX - d.startMouseX) + Math.abs(t.clientY - d.startMouseY);
      if (!d.moved && dist < 5) return;
      d.moved = true;
      clearTimeout(_longPressTimer);

      const dx = (t.clientX - d.startMouseX) / canvasState.scale;
      const dy = (t.clientY - d.startMouseY) / canvasState.scale;
      if (d.startPositions) {
        for (const [selId, startPos] of d.startPositions) {
          const selNote = canvasState.notes.find(n => n.id === selId);
          if (selNote) {
            selNote.x = startPos.x + dx;
            selNote.y = startPos.y + dy;
            const el = document.getElementById('note-' + selId);
            if (el) { el.style.left = selNote.x + 'px'; el.style.top = selNote.y + 'px'; }
          }
        }
      }
      renderConnections();
    } else if (canvasState.panning) {
      const d = canvasState.panning;
      canvasState.pan.x = d.startPanX + (t.clientX - d.startX);
      canvasState.pan.y = d.startPanY + (t.clientY - d.startY);
      applyTransform();
    }
  } else if (e.touches.length === 2) {
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    const newDist = Math.hypot(dx, dy);
    if (_pinchDist > 0) {
      const factor = newDist / _pinchDist;
      const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const my = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      const wrap = document.getElementById('canvasWrap');
      const rect = wrap.getBoundingClientRect();
      const px = mx - rect.left, py = my - rect.top;
      const newScale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, canvasState.scale * factor));
      canvasState.pan.x = px - (px - canvasState.pan.x) * (newScale / canvasState.scale);
      canvasState.pan.y = py - (py - canvasState.pan.y) * (newScale / canvasState.scale);
      canvasState.scale = newScale;
      applyTransform();
    }
    _pinchDist = newDist;
  }
}

function onTouchEnd(e) {
  clearTimeout(_longPressTimer);
  if (e.touches.length === 0) {
    if (canvasState.dragging) {
      const { noteId, moved, startPositions } = canvasState.dragging;
      if (moved) {
        if (startPositions) {
          for (const selId of startPositions.keys()) {
            clearTimeout(canvasState.posSaveTimers[selId]);
            saveNotePosition(selId);
          }
        } else {
          clearTimeout(canvasState.posSaveTimers[noteId]);
          saveNotePosition(noteId);
        }
      } else {
        // Tap without drag — close sidebar if open
        if (canvasState.sidebarNoteId) closeSidebar();
      }
    }
    canvasState.dragging = null;
    canvasState.panning  = null;
    _pinchDist = 0;
  }
}

/**
 * Returns an SVG path `d` string for a 3-segment Manhattan route.
 *
 * @param {number} x1  Source port X (canvas space)
 * @param {number} y1  Source port Y
 * @param {number} x2  Target port X
 * @param {number} y2  Target port Y
 * @param {"horizontal"|"vertical"} orientation  Routing direction based on source port side
 * @returns {string}   SVG path `d` attribute value
 */
function manhattanPath(x1, y1, x2, y2, orientation = 'horizontal') {
  const r   = CORNER_RADIUS;
  const dx  = x2 - x1;
  const dy  = y2 - y1;
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);

  // Degenerate: essentially straight — no bending needed
  if (adx < 2 || ady < 2) return `M ${x1} ${y1} L ${x2} ${y2}`;

  if (orientation === 'vertical') {
    // V→H→V routing (for top/bottom ports)
    const my  = (y1 + y2) / 2;
    const sx  = dx >= 0 ? 1 : -1;
    const sy  = dy >= 0 ? 1 : -1;

    const rv = Math.max(0, Math.min(r, ady / 2 - 2));
    const rh = Math.max(0, Math.min(r, adx / 2 - 2));

    if (rv < 1 || rh < 1) {
      return `M ${x1} ${y1} L ${x1} ${my} L ${x2} ${my} L ${x2} ${y2}`;
    }

    return [
      `M ${x1} ${y1}`,
      `L ${x1} ${my - sy * rv}`,
      `Q ${x1} ${my} ${x1 + sx * rh} ${my}`,
      `L ${x2 - sx * rh} ${my}`,
      `Q ${x2} ${my} ${x2} ${my + sy * rv}`,
      `L ${x2} ${y2}`
    ].join(' ');
  }

  // H→V→H routing (for left/right ports — default)
  const mx  = (x1 + x2) / 2;
  const sx  = dx >= 0 ? 1 : -1;
  const sy  = dy >= 0 ? 1 : -1;

  const rh = Math.max(0, Math.min(r, adx / 2 - 2));
  const rv = Math.max(0, Math.min(r, ady / 2 - 2));

  if (rh < 1 || rv < 1) {
    return `M ${x1} ${y1} L ${mx} ${y1} L ${mx} ${y2} L ${x2} ${y2}`;
  }

  return [
    `M ${x1} ${y1}`,
    `L ${mx - sx * rh} ${y1}`,
    `Q ${mx} ${y1} ${mx} ${y1 + sy * rv}`,
    `L ${mx} ${y2 - sy * rv}`,
    `Q ${mx} ${y2} ${mx + sx * rh} ${y2}`,
    `L ${x2} ${y2}`
  ].join(' ');
}

/**
 * Given two notes (with their DOM element dimensions), returns which sides
 * of each note face each other — used to route the connection.
 *
 * @param {object} noteA  note object {id, x, y, color, ...}
 * @param {object} noteB
 * @param {HTMLElement} elA  DOM element for noteA
 * @param {HTMLElement} elB  DOM element for noteB
 * @returns {{ sideA: string, sideB: string }}  e.g. { sideA: 'right', sideB: 'left' }
 */
function getBestSides(noteA, noteB, elA, elB) {
  const wA = elA.offsetWidth,  hA = elA.offsetHeight;
  const wB = elB.offsetWidth,  hB = elB.offsetHeight;
  const cax = noteA.x + wA / 2,  cay = noteA.y + hA / 2;
  const cbx = noteB.x + wB / 2,  cby = noteB.y + hB / 2;
  const dx = cbx - cax,  dy = cby - cay;

  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? { sideA: 'right',  sideB: 'left'  }
      : { sideA: 'left',   sideB: 'right' };
  }
  return dy >= 0
    ? { sideA: 'bottom', sideB: 'top'    }
    : { sideA: 'top',    sideB: 'bottom' };
}

/**
 * Computes stacked port positions for every connection in canvasState.connections.
 *
 * Algorithm:
 *   1. For each connection, call getBestSides() to decide (sideA, sideB).
 *   2. Group connections by (noteId, side) to know how many share each side.
 *   3. For each group, assign index i and offset around the side center:
 *        offset = (i - (n-1)/2) * PORT_SPACING
 *   4. Return a Map keyed by "fromId:toId" → { ax, ay, bx, by }.
 *
 * @returns {Map<string, {ax:number, ay:number, bx:number, by:number}>}
 */
function computePortPositions() {
  // Step 1: assign sides to every connection
  const assignments = [];
  for (const conn of canvasState.connections) {
    const noteA = canvasState.notes.find(n => n.id === conn.from);
    const noteB = canvasState.notes.find(n => n.id === conn.to);
    const elA   = document.getElementById('note-' + conn.from);
    const elB   = document.getElementById('note-' + conn.to);
    if (!noteA || !noteB || !elA || !elB) continue;
    const { sideA, sideB } = getBestSides(noteA, noteB, elA, elB);
    assignments.push({ conn, noteA, noteB, elA, elB, sideA, sideB });
  }

  // Step 2: group by "noteId:side"
  const sideGroups = new Map(); // "noteId:side" → [assignment, ...]
  for (const a of assignments) {
    const kA = a.conn.from + ':' + a.sideA;
    const kB = a.conn.to   + ':' + a.sideB;
    if (!sideGroups.has(kA)) sideGroups.set(kA, []);
    if (!sideGroups.has(kB)) sideGroups.set(kB, []);
    sideGroups.get(kA).push(a);
    sideGroups.get(kB).push(a);
  }

  // Step 3: compute stacked positions per group
  const portMap = new Map(); // "fromId:toId" → { ax, ay, bx, by }
  for (const [sideKey, group] of sideGroups) {
    const colonIdx = sideKey.indexOf(':');
    const noteId   = sideKey.slice(0, colonIdx);
    const side     = sideKey.slice(colonIdx + 1);
    const note     = canvasState.notes.find(n => n.id === noteId);
    const noteEl   = document.getElementById('note-' + noteId);
    if (!note || !noteEl) continue;

    const w = noteEl.offsetWidth;
    const h = noteEl.offsetHeight;
    const n = group.length;

    group.forEach((a, i) => {
      const offset = (i - (n - 1) / 2) * PORT_SPACING;
      let px, py;
      if (side === 'top')    { px = note.x + w / 2 + offset; py = note.y;     }
      if (side === 'bottom') { px = note.x + w / 2 + offset; py = note.y + h; }
      if (side === 'left')   { px = note.x;     py = note.y + h / 2 + offset; }
      if (side === 'right')  { px = note.x + w; py = note.y + h / 2 + offset; }

      const connKey = a.conn.from + ':' + a.conn.to;
      if (!portMap.has(connKey)) portMap.set(connKey, {});
      const entry = portMap.get(connKey);

      // isFrom: is this noteId the FROM end of the connection?
      if (a.conn.from === noteId) {
        entry.ax = px;
        entry.ay = py;
        entry.sideA = side;
      } else {
        entry.bx = px;
        entry.by = py;
      }
    });
  }

  return portMap;
}

// --- Render connections (underlay SVG) ---
function renderConnections() {
  const svg = document.getElementById('canvasSvg');
  if (!svg) return;

  // Remove all existing connection groups
  svg.querySelectorAll('.conn-line-group').forEach(g => g.remove());

  // Clear old connected-port markers
  document.querySelectorAll('.conn-dot-connected').forEach(d => d.classList.remove('conn-dot-connected'));

  const portMap = computePortPositions();

  for (const conn of canvasState.connections) {
    const ports = portMap.get(conn.from + ':' + conn.to);
    if (!ports || ports.ax == null || ports.bx == null) continue;

    const { ax, ay, bx, by, sideA } = ports;

    // Stroke color from source note's color
    const fromNote  = canvasState.notes.find(n => n.id === conn.from);
    const strokeCol = COLOR_STROKE[fromNote?.color] || 'var(--border-strong)';

    const orientation = (sideA === 'top' || sideA === 'bottom') ? 'vertical' : 'horizontal';
    const pathD = manhattanPath(ax, ay, bx, by, orientation);

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'conn-line-group');

    // Visible path
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', pathD);
    path.setAttribute('class', 'conn-path');
    path.style.stroke = strokeCol;
    path.setAttribute('data-from', conn.from);
    path.setAttribute('data-to',   conn.to);

    // Wide invisible hit target for easier clicking
    const hitPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    hitPath.setAttribute('d', pathD);
    hitPath.setAttribute('class', 'conn-path-hit');
    hitPath.addEventListener('click', e => {
      e.stopPropagation();
      showConnectionDeleteBtn(conn.from, conn.to, { x: ax, y: ay }, { x: bx, y: by });
    });

    g.appendChild(path);
    g.appendChild(hitPath);
    svg.appendChild(g);
  }

  // Mark ports that have connections as always-visible
  const connectedNotes = new Set();
  for (const conn of canvasState.connections) {
    connectedNotes.add(conn.from);
    connectedNotes.add(conn.to);
  }
  for (const noteId of connectedNotes) {
    const el = document.getElementById('note-' + noteId);
    if (!el) continue;
    el.querySelectorAll('.conn-dot').forEach(d => d.classList.add('conn-dot-connected'));
  }
}

// --- Connection drag ---
export function startConnectionDrag(e, noteId, port) {
  e.stopPropagation();
  e.preventDefault();
  const pt = getNoteDotPosition(noteId, port);
  if (!pt) return;
  const note = canvasState.notes.find(n => n.id === noteId);
  canvasState.connecting = { fromId: noteId, fromPort: port, fromPt: { x: pt.x, y: pt.y } };

  // Draw preview path in overlay SVG (above cards)
  const overlay = document.getElementById('canvasSvgOverlay');
  if (overlay) {
    const prev = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    prev.id = 'conn-preview';
    prev.setAttribute('class', 'conn-preview-path');
    prev.setAttribute('d', `M ${pt.x} ${pt.y}`);
    // Color preview line to match source card
    prev.style.stroke = COLOR_STROKE[note?.color] || 'var(--muted)';
    overlay.appendChild(prev);
  }

  // Show all target ports at normal size (no green highlight)
  document.querySelectorAll('.note').forEach(el => {
    if (el.id === 'note-' + noteId) return;
    el.querySelectorAll('.conn-dot').forEach(d => {
      d.classList.add('conn-dot-target-active');
    });
  });
}

function removeTempConnectionLine() {
  const line = document.getElementById('conn-temp');
  if (line) line.remove();
  const prev = document.getElementById('conn-preview');
  if (prev) prev.remove();
  // Remove target port markers
  document.querySelectorAll('.conn-dot-target-active')
    .forEach(d => d.classList.remove('conn-dot-target-active'));
  document.querySelectorAll('.conn-dot-snap')
    .forEach(d => d.classList.remove('conn-dot-snap'));
}

async function saveConnection(fromId, toId) {
  if (!canvasState._state?.viewedProject) return;
  try {
    const res = await api(`/projects/${canvasState._state.viewedProject}/canvas/connections`, {
      method: 'POST', body: { from: fromId, to: toId }
    });
    if (res.ok && !res.duplicate) {
      canvasState.connections.push({ from: fromId, to: toId });

      // Color cascade: get target's color, apply to entire connected component
      const toNote = canvasState.notes.find(n => n.id === toId);
      if (toNote?.color) {
        const component = getConnectedComponent(fromId);
        for (const nodeId of component) {
          const n = canvasState.notes.find(x => x.id === nodeId);
          if (n && n.color !== toNote.color) {
            setNoteColor(nodeId, toNote.color).catch(() => {
              toast('Color cascade failed for ' + nodeId, 'warn');
            });
          }
        }
      }

      renderConnections();
      renderPromoteButton();
    }
  } catch {
    toast('Failed to save connection', 'error');
  }
}

// --- Delete connection ---
function showConnectionDeleteBtn(from, to, pointA, pointB) {
  document.querySelectorAll('.conn-delete-overlay').forEach(el => el.remove());

  // Position delete button at line midpoint in screen space
  const wrap = document.getElementById('canvasWrap');
  const rect = wrap.getBoundingClientRect();
  const midCanvasX = (pointA.x + pointB.x) / 2;
  const midCanvasY = (pointA.y + pointB.y) / 2;
  const screenX = midCanvasX * canvasState.scale + canvasState.pan.x + rect.left;
  const screenY = midCanvasY * canvasState.scale + canvasState.pan.y + rect.top;

  const btn = document.createElement('button');
  btn.className = 'btn btn-danger btn-sm conn-delete-overlay';
  btn.style.cssText = `position:fixed;left:${screenX}px;top:${screenY}px;transform:translate(-50%,-50%);z-index:1000;font-size:10px;padding:3px 8px;`;
  btn.textContent = '\u2715 connection';
  btn.addEventListener('click', async e => {
    e.stopPropagation();
    btn.remove();
    if (!canvasState._state?.viewedProject) return;
    try {
      await api(`/projects/${canvasState._state.viewedProject}/canvas/connections`, {
        method: 'DELETE', body: { from, to }
      });
      canvasState.connections = canvasState.connections.filter(
        c => !((c.from === from && c.to === to) || (c.from === to && c.to === from))
      );
      renderConnections();
      renderPromoteButton();
    } catch { toast('Failed to delete connection', 'error'); }
  });
  document.body.appendChild(btn);

  setTimeout(() => {
    const close = ev => {
      if (!btn.contains(ev.target)) { btn.remove(); document.removeEventListener('click', close); }
    };
    document.addEventListener('click', close);
  }, 0);
}

// --- Cluster detection ---
function getConnectedComponent(startId) {
  const visited = new Set();
  const queue = [startId];
  while (queue.length > 0) {
    const id = queue.shift();
    if (visited.has(id)) continue;
    visited.add(id);
    for (const conn of canvasState.connections) {
      if (conn.from === id && !visited.has(conn.to))   queue.push(conn.to);
      if (conn.to   === id && !visited.has(conn.from)) queue.push(conn.from);
    }
  }
  return visited;
}

function getAllClusters() {
  // Returns array of Sets, one per connected component with ≥2 notes
  const seen = new Set();
  const clusters = [];
  for (const note of canvasState.notes) {
    if (seen.has(note.id)) continue;
    const component = getConnectedComponent(note.id);
    for (const id of component) seen.add(id);
    if (component.size >= 2) clusters.push(component);
  }
  return clusters;
}

// --- Promote button ---
function renderPromoteButton() {
  const vp = document.getElementById('canvasViewport');
  if (!vp) return;
  vp.querySelectorAll('.canvas-promote-btn').forEach(b => b.remove());

  const selIds = [...canvasState.selectedIds];
  if (selIds.length === 0) return; // nothing selected — no button

  // Compute bounding box of all selected notes
  let maxX = -Infinity, maxY = -Infinity;
  for (const id of selIds) {
    const note = canvasState.notes.find(n => n.id === id);
    const el   = document.getElementById('note-' + id);
    if (note && el) {
      maxX = Math.max(maxX, note.x + el.offsetWidth);
      maxY = Math.max(maxY, note.y + el.offsetHeight);
    }
  }
  if (!isFinite(maxX)) return;

  const btn = document.createElement('button');
  btn.className = 'canvas-promote-btn';
  btn.textContent = '\u2192 Task';
  btn.style.left = (maxX - 56) + 'px';
  btn.style.top  = (maxY + 8)  + 'px';
  // Stop mousedown from bubbling to canvasWrap — prevents selectedIds from being cleared
  btn.addEventListener('mousedown', e => e.stopPropagation());
  btn.addEventListener('click', e => {
    e.stopPropagation();
    showPromoteModal(selIds);
  });
  vp.appendChild(btn);
}

// --- Promote modal ---
export function showPromoteModal(noteIds) {
  // Use existing showModal — body contains a mini-form
  showModal(
    'Promote to Task',
    `<div style="display:flex;flex-direction:column;gap:10px;margin-top:4px">
      <input id="promoteTitle" class="task-title-input" placeholder="Task title\u2026"
        style="margin-bottom:0;font-size:13px" autofocus>
      <div class="priority-selector" id="promotePrioritySelector">
        <button class="priority-option"          data-p="low"    onclick="promotePriorityPick('low')">low</button>
        <button class="priority-option selected" data-p="medium" onclick="promotePriorityPick('medium')">medium</button>
        <button class="priority-option"          data-p="high"   onclick="promotePriorityPick('high')">high</button>
      </div>
    </div>`,
    () => {
      const title    = document.getElementById('promoteTitle')?.value?.trim();
      const priority = document.querySelector('.modal .priority-option.selected')?.dataset?.p || 'medium';
      if (!title) { toast('Task title required', 'warn'); return; }
      promoteNotes(noteIds, title, priority);
    },
    'Promote',
    'btn-primary'
  );
  // Expose priority picker to window (inside modal, inline onclick)
  window.promotePriorityPick = (p) => {
    document.querySelectorAll('#promotePrioritySelector .priority-option').forEach(b => {
      b.classList.toggle('selected', b.dataset.p === p);
    });
  };
  setTimeout(() => document.getElementById('promoteTitle')?.focus(), 50);
}

async function promoteNotes(noteIds, title, priority) {
  if (!canvasState._state?.viewedProject) return;
  try {
    const res = await api(`/projects/${canvasState._state.viewedProject}/canvas/promote`, {
      method: 'POST', body: { noteIds, title, priority }
    });
    if (res.ok) {
      // Remove promoted notes from local state
      const deletedSet = new Set(res.deletedNotes || noteIds);
      canvasState.notes = canvasState.notes.filter(n => !deletedSet.has(n.id));
      canvasState.connections = canvasState.connections.filter(
        c => !deletedSet.has(c.from) && !deletedSet.has(c.to)
      );
      canvasState.selectedIds.clear();

      // Re-render canvas
      renderAll();
      toast(`Task ${res.task.id} created`, 'success');
      window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('success');

      // Update tasks state so kanban reflects the new task
      if (canvasState._state) {
        canvasState._state.tasks.push(res.task);
      }
    } else {
      toast(res.error || 'Promote failed', 'error');
    }
  } catch {
    toast('Promote failed', 'error');
  }
}
