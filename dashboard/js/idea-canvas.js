// idea-canvas.js — Infinite sticky-note canvas

import { api, toast, showModal, escHtml, renderDeleteBtn } from './utils.js?v=3';

// --- Constants ---
const NOTE_WIDTH = 160;
const SCALE_MIN = 0.3;
const SCALE_MAX = 2.5;
const NOTE_COLORS = ['yellow', 'blue', 'green', 'red', 'teal'];

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
  renderConnections();
  applyTransform();
  renderEmptyState();
  renderPromoteButton();
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
        <svg id="canvasSvg" class="canvas-svg"></svg>
      </div>
      <div class="canvas-lasso" id="canvasLasso"></div>
    </div>`;

  bindCanvasEvents();

  if (!state.viewedProject) {
    const vp = document.getElementById('canvasViewport');
    if (vp) vp.innerHTML = `<svg id="canvasSvg" class="canvas-svg"></svg>
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
}

// --- Note HTML ---
function noteHTML(note) {
  const rendered = renderNoteMarkdown(note.text || '');
  return `
    <div class="note-header" data-noteid="${note.id}">
      <span class="note-color-dot" onclick="window.toggleColorPopover(event, '${note.id}')"></span>
      <span class="note-id">${note.id}</span>
      ${renderDeleteBtn(`window.startDeleteNote('${note.id}')`, 'Delete note')}
    </div>
    <div class="note-body">
      <div class="note-text md-content">${rendered || '<span style="opacity:0.3;font-size:11px">Click to add text\u2026</span>'}</div>
    </div>
    <div class="conn-dot conn-dot-top"    onmousedown="window.startConnectionDrag(event,'${note.id}','top')"></div>
    <div class="conn-dot conn-dot-right"  onmousedown="window.startConnectionDrag(event,'${note.id}','right')"></div>
    <div class="conn-dot conn-dot-bottom" onmousedown="window.startConnectionDrag(event,'${note.id}','bottom')"></div>
    <div class="conn-dot conn-dot-left"   onmousedown="window.startConnectionDrag(event,'${note.id}','left')"></div>`;
}

function createNoteElement(note) {
  const el = document.createElement('div');
  el.id = 'note-' + note.id;
  el.className = `note color-${note.color || 'yellow'}`;
  if (canvasState.selectedIds.has(note.id)) el.classList.add('selected');
  el.style.left = note.x + 'px';
  el.style.top  = note.y + 'px';
  el.innerHTML = noteHTML(note);
  // Click on note-body to start editing
  el.querySelector('.note-body').addEventListener('click', e => {
    e.stopPropagation();
    startNoteEdit(note.id);
  });
  return el;
}

// --- Render notes ---
function renderNotes() {
  const vp = document.getElementById('canvasViewport');
  if (!vp) return;
  // Remove old note elements (keep SVG)
  vp.querySelectorAll('.note').forEach(el => el.remove());
  for (const note of canvasState.notes) {
    vp.appendChild(createNoteElement(note));
  }
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
  if (canvasState.editingId === id) return;
  // Save any current edit first
  if (canvasState.editingId) {
    const prevTa = document.getElementById('note-ta-' + canvasState.editingId);
    if (prevTa) saveNoteText(canvasState.editingId, prevTa.value);
  }
  canvasState.editingId = id;
  const el = document.getElementById('note-' + id);
  if (!el) return;
  const note = canvasState.notes.find(n => n.id === id);
  if (!note) return;

  const body = el.querySelector('.note-body');
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
      body.innerHTML = `<div class="note-text md-content">${rendered || '<span style="opacity:0.3;font-size:11px">Click to add text\u2026</span>'}</div>`;
      body.addEventListener('click', e => { e.stopPropagation(); startNoteEdit(id); });
    }
  }
  renderConnections();

  if (!canvasState._state?.viewedProject) return;
  try {
    await api(`/projects/${canvasState._state.viewedProject}/canvas/notes/${id}`, {
      method: 'PUT', body: { text }
    });
  } catch { /* silent — data is in memory */ }
}

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

// --- Color popover ---
export function toggleColorPopover(e, noteId) {
  e.stopPropagation();
  document.querySelectorAll('.color-popover').forEach(p => p.remove());

  const dot = e.currentTarget;
  const note = canvasState.notes.find(n => n.id === noteId);
  const popover = document.createElement('div');
  popover.className = 'color-popover';

  NOTE_COLORS.forEach(color => {
    const swatch = document.createElement('span');
    swatch.className = `color-swatch color-swatch-${color}${color === note?.color ? ' selected' : ''}`;
    swatch.title = color;
    swatch.addEventListener('click', ev => {
      ev.stopPropagation();
      setNoteColor(noteId, color);
      popover.remove();
    });
    popover.appendChild(swatch);
  });

  // Position popover below the header
  dot.closest('.note-header').appendChild(popover);
  popover.style.top = '28px';
  popover.style.left = '0';

  setTimeout(() => {
    const close = ev => {
      if (!popover.contains(ev.target)) {
        popover.remove();
        document.removeEventListener('click', close);
      }
    };
    document.addEventListener('click', close);
  }, 0);
}

export async function setNoteColor(noteId, color) {
  const note = canvasState.notes.find(n => n.id === noteId);
  if (!note) return;
  note.color = color;
  const el = document.getElementById('note-' + noteId);
  if (el) {
    el.className = `note color-${color}${canvasState.selectedIds.has(noteId) ? ' selected' : ''}`;
  }
  if (!canvasState._state?.viewedProject) return;
  try {
    await api(`/projects/${canvasState._state.viewedProject}/canvas/notes/${noteId}`, {
      method: 'PUT', body: { color }
    });
  } catch { /* silent */ }
}

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
  if (e.target.closest('.note')) return; // ignore dbl-click on notes
  if (e.target.closest('.canvas-toolbar')) return;
  const pos = screenToCanvas(e.clientX, e.clientY);
  createNoteAt(pos.x - NOTE_WIDTH / 2, pos.y - 20);
}

function onCanvasMouseDown(e) {
  // Ignore right-click
  if (e.button !== 0) return;

  const connDot = e.target.closest('.conn-dot');
  if (connDot) return; // handled by startConnectionDrag inline handler

  const header  = e.target.closest('.note-header');
  const noteEl  = e.target.closest('.note');

  if (header && noteEl) {
    // Note drag
    e.stopPropagation();
    const noteId = noteEl.id.replace('note-', '');
    const note   = canvasState.notes.find(n => n.id === noteId);
    if (!note) return;
    // Close any active edit
    if (canvasState.editingId && canvasState.editingId !== noteId) {
      const ta = document.getElementById('note-ta-' + canvasState.editingId);
      if (ta) saveNoteText(canvasState.editingId, ta.value);
    }
    canvasState.dragging = {
      noteId,
      startMouseX: e.clientX, startMouseY: e.clientY,
      startNoteX: note.x,     startNoteY: note.y
    };
    if (!e.shiftKey) {
      canvasState.selectedIds.clear();
      document.querySelectorAll('.note.selected').forEach(el => el.classList.remove('selected'));
    }
    canvasState.selectedIds.add(noteId);
    noteEl.classList.add('selected');
    renderPromoteButton();
    return;
  }

  if (noteEl) {
    // Click on note body → select (edit handled by click listener on note-body)
    if (!e.shiftKey) {
      canvasState.selectedIds.clear();
      document.querySelectorAll('.note.selected').forEach(el => el.classList.remove('selected'));
    }
    const noteId = noteEl.id.replace('note-', '');
    canvasState.selectedIds.add(noteId);
    noteEl.classList.add('selected');
    renderPromoteButton();
    return;
  }

  // Empty canvas: deselect + start pan or Shift+lasso
  canvasState.selectedIds.clear();
  document.querySelectorAll('.note.selected').forEach(el => el.classList.remove('selected'));
  renderPromoteButton();

  if (e.shiftKey) {
    // Start lasso selection
    const wrap = document.getElementById('canvasWrap');
    const rect = wrap.getBoundingClientRect();
    canvasState.lassoState = {
      startX: e.clientX - rect.left,
      startY: e.clientY - rect.top
    };
  } else {
    // Pan
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
    const note = canvasState.notes.find(n => n.id === d.noteId);
    if (note) {
      note.x = d.startNoteX + dx;
      note.y = d.startNoteY + dy;
      const el = document.getElementById('note-' + d.noteId);
      if (el) { el.style.left = note.x + 'px'; el.style.top = note.y + 'px'; }
      renderConnections();
      schedulePositionSave(d.noteId);
    }
    return;
  }

  // Connection drag
  if (canvasState.connecting) {
    const pos = screenToCanvas(e.clientX, e.clientY);
    const line = document.getElementById('conn-temp');
    if (line) { line.setAttribute('x2', pos.x); line.setAttribute('y2', pos.y); }
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
  // End note drag
  if (canvasState.dragging) {
    canvasState.dragging = null;
    return;
  }

  // End connection drag
  if (canvasState.connecting) {
    const targetNote = e.target.closest?.('.note');
    if (targetNote) {
      const targetId = targetNote.id.replace('note-', '');
      if (targetId !== canvasState.connecting.fromId) {
        saveConnection(canvasState.connecting.fromId, targetId);
      }
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

let _pinchDist = 0;  // last pinch distance

function onTouchStart(e) {
  e.preventDefault();
  if (e.touches.length === 1) {
    const t = e.touches[0];
    // Single touch on note header → note drag; else canvas pan
    const header = document.elementFromPoint(t.clientX, t.clientY)?.closest?.('.note-header');
    const noteEl = header?.closest('.note');
    if (header && noteEl) {
      const noteId = noteEl.id.replace('note-', '');
      const note   = canvasState.notes.find(n => n.id === noteId);
      if (note) {
        canvasState.dragging = {
          noteId,
          startMouseX: t.clientX, startMouseY: t.clientY,
          startNoteX: note.x,     startNoteY: note.y
        };
        return;
      }
    }
    canvasState.panning = {
      startX: t.clientX, startY: t.clientY,
      startPanX: canvasState.pan.x, startPanY: canvasState.pan.y
    };
  } else if (e.touches.length === 2) {
    canvasState.panning = null;
    canvasState.dragging = null;
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    _pinchDist = Math.hypot(dx, dy);
  }
}

function onTouchMove(e) {
  e.preventDefault();
  if (e.touches.length === 1) {
    const t = e.touches[0];
    if (canvasState.dragging) {
      const d = canvasState.dragging;
      const note = canvasState.notes.find(n => n.id === d.noteId);
      if (note) {
        note.x = d.startNoteX + (t.clientX - d.startMouseX) / canvasState.scale;
        note.y = d.startNoteY + (t.clientY - d.startMouseY) / canvasState.scale;
        const el = document.getElementById('note-' + d.noteId);
        if (el) { el.style.left = note.x + 'px'; el.style.top = note.y + 'px'; }
        renderConnections();
        schedulePositionSave(d.noteId);
      }
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
  if (e.touches.length === 0) {
    canvasState.dragging = null;
    canvasState.panning  = null;
    _pinchDist = 0;
  }
}

// --- Render connections ---
function renderConnections() {
  const svg = document.getElementById('canvasSvg');
  if (!svg) return;
  // Remove all connection lines (keep conn-temp if exists)
  svg.querySelectorAll('.conn-line-group').forEach(g => g.remove());

  for (const conn of canvasState.connections) {
    const a = getNoteCenter(conn.from);
    const b = getNoteCenter(conn.to);
    if (!a || !b) continue;

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.className = 'conn-line-group';

    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', a.x); line.setAttribute('y1', a.y);
    line.setAttribute('x2', b.x); line.setAttribute('y2', b.y);
    line.setAttribute('class', 'conn-line');
    line.setAttribute('data-from', conn.from);
    line.setAttribute('data-to', conn.to);

    // Wider invisible hit area for easier clicking
    const hitLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    hitLine.setAttribute('x1', a.x); hitLine.setAttribute('y1', a.y);
    hitLine.setAttribute('x2', b.x); hitLine.setAttribute('y2', b.y);
    hitLine.setAttribute('stroke', 'transparent');
    hitLine.setAttribute('stroke-width', '12');
    hitLine.style.cursor = 'pointer';
    hitLine.style.pointerEvents = 'stroke';
    hitLine.addEventListener('click', e => {
      e.stopPropagation();
      showConnectionDeleteBtn(conn.from, conn.to, a, b);
    });

    g.appendChild(line);
    g.appendChild(hitLine);
    svg.appendChild(g);
  }
}

// --- Connection drag ---
export function startConnectionDrag(e, noteId, port) {
  e.stopPropagation();
  e.preventDefault();
  const pt = getNoteDotPosition(noteId, port);
  if (!pt) return;
  canvasState.connecting = { fromId: noteId };

  const svg = document.getElementById('canvasSvg');
  if (!svg) return;
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  line.id = 'conn-temp';
  line.setAttribute('class', 'conn-line-temp');
  line.setAttribute('x1', pt.x); line.setAttribute('y1', pt.y);
  line.setAttribute('x2', pt.x); line.setAttribute('y2', pt.y);
  svg.appendChild(line);
}

function removeTempConnectionLine() {
  const line = document.getElementById('conn-temp');
  if (line) line.remove();
}

async function saveConnection(fromId, toId) {
  if (!canvasState._state?.viewedProject) return;
  try {
    const res = await api(`/projects/${canvasState._state.viewedProject}/canvas/connections`, {
      method: 'POST', body: { from: fromId, to: toId }
    });
    if (res.ok && !res.duplicate) {
      canvasState.connections.push({ from: fromId, to: toId });

      // Color inheritance: target note inherits source color if target is still default yellow
      const fromNote = canvasState.notes.find(n => n.id === fromId);
      const toNote   = canvasState.notes.find(n => n.id === toId);
      if (toNote?.color === 'yellow' && fromNote?.color && fromNote.color !== 'yellow') {
        await setNoteColor(toId, fromNote.color);
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

  const clusters = getAllClusters();

  // Also show promote for a multi-note manual selection (even if not connected)
  const selIds = [...canvasState.selectedIds];
  if (selIds.length >= 2) {
    const selSet = new Set(selIds);
    // Only add if not already covered by a cluster
    const alreadyCovered = clusters.some(c => selIds.every(id => c.has(id)));
    if (!alreadyCovered) clusters.push(selSet);
  }

  // Also allow single-note promote
  if (selIds.length === 1) {
    clusters.push(new Set(selIds));
  }

  for (const cluster of clusters) {
    const ids = [...cluster];
    let maxX = -Infinity, maxY = -Infinity;
    for (const id of ids) {
      const note = canvasState.notes.find(n => n.id === id);
      const el   = document.getElementById('note-' + id);
      if (note && el) {
        maxX = Math.max(maxX, note.x + el.offsetWidth);
        maxY = Math.max(maxY, note.y + el.offsetHeight);
      }
    }
    if (!isFinite(maxX)) continue;

    const btn = document.createElement('button');
    btn.className = 'canvas-promote-btn';
    btn.textContent = '\u2192 Task';
    btn.style.left = (maxX - 56) + 'px';
    btn.style.top  = (maxY + 8)  + 'px';
    btn.addEventListener('click', e => {
      e.stopPropagation();
      showPromoteModal(ids);
    });
    vp.appendChild(btn);
  }
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
