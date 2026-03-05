// canvas/index.js — Entry point, orchestrator, CSS injection, public API re-exports

import { ICONS } from '../utils.js?v=5';
import { canvasState, loadCanvas, applyTransform, resetCanvasState, SCALE_MIN, SCALE_MAX } from './state.js?v=1';
import { renderNotes, renderEmptyState, addNote, startDeleteNote, setNoteColor,
         startNoteEdit, saveNoteText, closeSidebar } from './notes.js?v=4';
import { renderConnections, startConnectionDrag } from './connections.js?v=3';
import { renderPromoteButton, sendPromote, bindToolbarEvents, updateToolbar, applyFormattingToTextarea } from './toolbar.js?v=6';
import { bindCanvasEvents } from './events.js?v=1';
import { renderClusterFrames } from './clusters.js?v=1';

// Inject canvas.css once at module load
if (!document.querySelector('link[data-canvas]')) {
  const _l = document.createElement('link');
  _l.rel = 'stylesheet';
  _l.href = './styles/canvas.css?v=11';
  _l.dataset.canvas = '1';
  document.head.appendChild(_l);
}

// --- Render all canvas elements ---
function renderAll() {
  renderNotes();
  applyTransform();
  renderEmptyState();
  renderPromoteButton();
  requestAnimationFrame(renderConnections);
}

function fitCanvasToNotes() {
  const wrap = document.getElementById('canvasWrap');
  if (!wrap || canvasState.notes.length === 0) return;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const note of canvasState.notes) {
    const el = document.getElementById('note-' + note.id);
    const w = el?.offsetWidth || 160;
    const h = el?.offsetHeight || 120;
    minX = Math.min(minX, note.x);
    minY = Math.min(minY, note.y);
    maxX = Math.max(maxX, note.x + w);
    maxY = Math.max(maxY, note.y + h);
  }

  const pad = 40;
  const contentW = Math.max(1, maxX - minX + pad * 2);
  const contentH = Math.max(1, maxY - minY + pad * 2);
  const scale = Math.min(wrap.clientWidth / contentW, wrap.clientHeight / contentH, 1);
  const clamped = Math.max(SCALE_MIN, Math.min(SCALE_MAX, scale));
  canvasState.scale = clamped;

  // Always center content bounds, even if clamped
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  canvasState.pan.x = wrap.clientWidth / 2 - centerX * canvasState.scale;
  canvasState.pan.y = wrap.clientHeight / 2 - centerY * canvasState.scale;

  applyTransform();
  requestAnimationFrame(renderConnections);
}

// --- Main entry point called from switchTab ---
async function renderIdeaCanvas(state) {
  const content = document.getElementById('content');
  content.style.overflow = 'hidden';

  content.innerHTML = `
    <div class="canvas-wrap" id="canvasWrap">
      <div class="canvas-toolbar">
        <button class="btn btn-primary btn-sm" data-action="add-note">+ Note</button>
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
      <div class="canvas-floating-toolbar" id="canvasToolbar" style="display:none">
        <div class="toolbar-section toolbar-format" id="toolbarFormat" style="display:none">
          <button class="toolbar-btn" data-fmt="bold" title="Bold"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4h8a4 4 0 010 8H6z"/><path d="M6 12h9a4 4 0 010 8H6z"/></svg></button>
          <button class="toolbar-btn" data-fmt="italic" title="Italic"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="4" x2="10" y2="4"/><line x1="14" y1="20" x2="5" y2="20"/><line x1="15" y1="4" x2="9" y2="20"/></svg></button>
          <button class="toolbar-btn" data-fmt="bullet" title="Bullet list"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg></button>
          <button class="toolbar-btn" data-fmt="number" title="Numbered list"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><path d="M4 6h1v4"/><path d="M4 10h2"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/></svg></button>
          <button class="toolbar-btn" data-fmt="link" title="Link"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg></button>
          <div class="toolbar-separator"></div>
        </div>
        <div class="toolbar-section toolbar-props">
          <button class="toolbar-btn" id="tbColor" title="Color"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 011.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/></svg></button>
          <button class="toolbar-btn" id="tbSize" title="Size"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg></button>
          <button class="toolbar-btn" id="tbDuplicate" title="Duplicate"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg></button>
          <button class="toolbar-btn toolbar-btn-danger" id="tbDelete" title="Delete"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg></button>
        </div>
      </div>
      <div class="canvas-sidebar" id="canvasSidebar">
        <div class="canvas-sidebar-header">
          <span class="canvas-sidebar-color-bar" id="sidebarColorBar"></span>
          <span class="canvas-sidebar-id" id="sidebarNoteId"></span>
          <button class="canvas-sidebar-close" data-action="close-sidebar">\u2715</button>
        </div>
        <div class="canvas-sidebar-body">
          <div class="canvas-sidebar-format">
            <button class="toolbar-btn" data-sidebar-fmt="bold" title="Bold"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4h8a4 4 0 010 8H6z"/><path d="M6 12h9a4 4 0 010 8H6z"/></svg></button>
            <button class="toolbar-btn" data-sidebar-fmt="italic" title="Italic"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="4" x2="10" y2="4"/><line x1="14" y1="20" x2="5" y2="20"/><line x1="15" y1="4" x2="9" y2="20"/></svg></button>
            <button class="toolbar-btn" data-sidebar-fmt="bullet" title="Bullet list"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg></button>
            <button class="toolbar-btn" data-sidebar-fmt="number" title="Numbered list"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><path d="M4 6h1v4"/><path d="M4 10h2"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/></svg></button>
            <button class="toolbar-btn" data-sidebar-fmt="link" title="Link"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg></button>
          </div>
          <textarea class="canvas-sidebar-textarea" id="sidebarTextarea"></textarea>
        </div>
      </div>
    </div>`;

  bindCanvasEvents();
  bindToolbarEvents();

  // Canvas wrap delegation (toolbar + sidebar actions)
  const wrap = document.getElementById('canvasWrap');
  wrap.addEventListener('mousedown', e => {
    if (e.target.closest('[data-sidebar-fmt]')) e.preventDefault();
  });
  wrap.addEventListener('click', e => {
    const fmtBtn = e.target.closest('[data-sidebar-fmt]');
    if (fmtBtn) {
      const ta = document.getElementById('sidebarTextarea');
      applyFormattingToTextarea(ta, fmtBtn.dataset.sidebarFmt);
      return;
    }
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const { action } = el.dataset;
    if (action === 'add-note') addNote(state);
    if (action === 'close-sidebar') closeSidebar();
  });
  // Touch support for add-note button (prevent ghost tap)
  wrap.addEventListener('touchend', e => {
    const el = e.target.closest('[data-action="add-note"]');
    if (el) { e.preventDefault(); addNote(state); }
  });

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

  // Sidebar event isolation
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
      <div class="canvas-empty"><div class="canvas-empty-icon">${ICONS.lightbulb}</div><div>Select a project</div></div>`;
    return;
  }

  if (canvasState.notes.length === 0 && canvasState.connections.length === 0) {
    await loadCanvas(state);
  }
  renderAll();
  fitCanvasToNotes();
}

// --- Called from refresh polling when canvas data changes ---
function refreshCanvas() {
  const vp = document.getElementById('canvasViewport');
  if (!vp) return;
  // Clear selection — promoted notes may no longer exist
  canvasState.selectedIds.clear();
  document.querySelectorAll('.note.selected').forEach(el => el.classList.remove('selected'));
  renderAll();
  renderPromoteButton();
  updateToolbar();
}

// --- Public API re-exports ---
export {
  canvasState,
  renderIdeaCanvas,
  refreshCanvas,
  resetCanvasState,
  addNote,
  startDeleteNote,
  setNoteColor,
  startNoteEdit,
  saveNoteText,
  startConnectionDrag,
  sendPromote
};
