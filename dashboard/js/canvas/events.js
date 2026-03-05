// canvas/events.js — Mouse, touch, wheel, pinch-zoom, lasso, keyboard events

import {
  canvasState, screenToCanvas, NOTE_WIDTH, SCALE_MIN, SCALE_MAX, applyTransform
} from './state.js?v=1';
import {
  createNoteAt, startNoteEdit, saveNoteText, closeSidebar, openSidebar,
  saveNotePosition
} from './notes.js?v=2';
import {
  renderConnections, removeTempConnectionLine, saveConnection, routePath,
  deleteConnection
} from './connections.js?v=3';
import {
  updateToolbar, renderPromoteButton, toolbarDelete,
  copySelectedToClipboard, pasteFromClipboard, duplicateSelected
} from './toolbar.js?v=10';

// AbortController for document-level listeners (re-created on each bindCanvasEvents)
let _canvasAbort = null;
let _renderPending = false;

export function bindCanvasEvents() {
  // Abort previous document-level listeners to prevent accumulation across tab switches
  if (_canvasAbort) _canvasAbort.abort();
  _canvasAbort = new AbortController();
  const signal = _canvasAbort.signal;

  const wrap = document.getElementById('canvasWrap');
  if (!wrap) return;
  wrap.addEventListener('dblclick',   onCanvasDblClick);
  wrap.addEventListener('mousedown',  onCanvasMouseDown);
  wrap.addEventListener('mousemove',  onCanvasMouseMove);
  wrap.addEventListener('mouseup',    onCanvasMouseUp);
  wrap.addEventListener('mouseleave', onCanvasMouseUp);
  // Capture-phase: intercept wheel before notes consume it (non-selected notes → canvas pan)
  wrap.addEventListener('wheel', e => {
    const noteEl = e.target.closest?.('.note');
    const noteBody = e.target.closest?.('.note-body');
    // Only let selected scrollable notes handle their own wheel
    if (noteEl?.classList.contains('selected') && noteBody && noteBody.scrollHeight > noteBody.clientHeight) {
      return; // let note scroll
    }
    // Everything else → canvas handles it
    e.preventDefault();
    e.stopPropagation();
    onCanvasWheel(e);
  }, { passive: false, capture: true });

  wrap.addEventListener('touchstart', onTouchStart,  { passive: false });
  wrap.addEventListener('touchmove',  onTouchMove,   { passive: false });
  wrap.addEventListener('touchend',   onTouchEnd);

  // Scrollable note-body: intercept wheel to scroll content instead of canvas zoom
  wrap.addEventListener('wheel', e => {
    const body = e.target.closest('.note .note-body');
    if (body && body.scrollHeight > body.clientHeight) {
      e.stopPropagation(); // scroll note content, not canvas zoom
    }
  }, { passive: false, capture: true });

  // Delete/Backspace key: trigger delete modal for selected notes
  document.addEventListener('keydown', e => {
    // Don't intercept if user is typing in an input/textarea
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (canvasState.editingId) return;

    // Ctrl+C: copy selected notes
    if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
      if (canvasState.selectedIds.size > 0) {
        e.preventDefault();
        copySelectedToClipboard();
      }
      return;
    }
    // Ctrl+V: paste
    if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
      e.preventDefault();
      pasteFromClipboard();
      return;
    }
    // Ctrl+D: duplicate
    if ((e.ctrlKey || e.metaKey) && e.key === 'd') {
      if (canvasState.selectedIds.size > 0) {
        e.preventDefault();
        duplicateSelected();
      }
      return;
    }

    // Delete/Backspace: delete selected notes or connection
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    // Connection selected?
    if (canvasState.selectedConn) {
      e.preventDefault();
      const { from, to } = canvasState.selectedConn;
      canvasState.selectedConn = null;
      document.querySelectorAll('.conn-delete-overlay').forEach(el => el.remove());
      deleteConnection(from, to);
      return;
    }
    if (canvasState.selectedIds.size === 0) return;
    e.preventDefault();
    toolbarDelete();
  }, { signal });
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

  // Ignore clicks on floating toolbar
  if (e.target.closest('.canvas-floating-toolbar')) return;

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

    // Ctrl/Cmd+Click: toggle note in multi-selection
    if (e.ctrlKey || e.metaKey) {
      if (canvasState.selectedIds.has(noteId)) {
        canvasState.selectedIds.delete(noteId);
        noteEl.classList.remove('selected');
      } else {
        canvasState.selectedIds.add(noteId);
        noteEl.classList.add('selected');
      }
      renderPromoteButton();
      updateToolbar();
      return; // don't start drag on Ctrl+Click
    }

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
    if (!d.moved) {
      // Note drag started — dismiss any open connection delete button
      document.querySelectorAll('.conn-delete-overlay').forEach(el => el.remove());
      canvasState.selectedConn = null;
      // Hide promote buttons during drag
      document.querySelectorAll('.canvas-promote-btn, .cluster-promote-btn').forEach(b => b.style.display = 'none');
    }
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
    if (!_renderPending) { _renderPending = true; requestAnimationFrame(() => { _renderPending = false; renderConnections(); }); }
    updateToolbar();
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
    let nearestPort = null;

    document.querySelectorAll('.note').forEach(noteEl => {
      if (noteEl.id === 'note-' + canvasState.connecting.fromId) return;
      const targetId = noteEl.id.replace('note-', '');
      const targetNote = canvasState.notes.find(n => n.id === targetId);
      if (!targetNote) return;
      const tBl = noteEl.clientLeft || 1;
      const tBt = noteEl.clientTop || 1;

      // Only 3 sides (no top), snap to the FREE dot (last slot) on each side
      ['right', 'bottom', 'left'].forEach(port => {
        const freeDot = noteEl.querySelector(`.conn-dot-free.conn-dot-${port}`);
        if (!freeDot) return;
        const dLeft = parseFloat(freeDot.dataset.dotLeft);
        const dTop  = parseFloat(freeDot.dataset.dotTop);
        if (isNaN(dLeft) || isNaN(dTop)) return;
        // Canvas coords: X = note.x + clientLeft + CSS_left, Y = note.y + clientTop + CSS_top
        const portPos = { x: targetNote.x + tBl + dLeft, y: targetNote.y + tBt + dTop };
        const d = Math.hypot(pos.x - portPos.x, pos.y - portPos.y);
        if (d < nearestDist) {
          nearestDist = d;
          nearestDot = freeDot;
          nearestNoteId = targetId;
          nearestPort = port;
          tx = portPos.x;
          ty = portPos.y;
        }
      });
    });

    // Snap threshold: 60px canvas-space (~close enough to a card)
    if (nearestDist < 60 && nearestDot) {
      nearestDot.classList.add('conn-dot-snap');
      // Lift snap-target note above overlay SVG so its dot is visible above the preview line
      const snapNoteEl = nearestDot.closest('.note');
      if (snapNoteEl && snapNoteEl !== canvasState.connecting._noteEl) {
        if (canvasState.connecting._prevSnapNoteEl && canvasState.connecting._prevSnapNoteEl !== snapNoteEl) {
          canvasState.connecting._prevSnapNoteEl.style.zIndex = '';
        }
        snapNoteEl.style.zIndex = '3';
        canvasState.connecting._prevSnapNoteEl = snapNoteEl;
      }
      canvasState.connecting.snapTargetId = nearestNoteId;
      canvasState.connecting.snapValid = true;
      canvasState.connecting.snapPort = nearestPort;
    } else {
      // Not near any port — follow cursor freely
      tx = pos.x;
      ty = pos.y;
      canvasState.connecting.snapTargetId = null;
      canvasState.connecting.snapValid = false;
    }

    const fromPort = canvasState.connecting.fromPort;
    const oriA = (fromPort === 'top' || fromPort === 'bottom') ? 'vertical' : 'horizontal';
    // When snapped to a target port, use its orientation; otherwise default to same as source
    const oriB = nearestPort
      ? ((nearestPort === 'top' || nearestPort === 'bottom') ? 'vertical' : 'horizontal')
      : oriA;

    const prev = document.getElementById('conn-preview');
    if (prev && fromPt) {
      // Pass target card half-width for bottom-dot routing
      let previewHW = 0;
      if (nearestPort === 'bottom') {
        const tNEl = document.getElementById('note-' + canvasState.connecting.snapTargetId);
        if (tNEl) previewHW = tNEl.offsetWidth / 2;
      }
      prev.setAttribute('d', routePath(fromPt.x, fromPt.y, tx, ty, fromPort, nearestPort, previewHW));
    }
    return;
  }

  // Pan
  if (canvasState.panning) {
    const d = canvasState.panning;
    canvasState.pan.x = d.startPanX + (e.clientX - d.startX);
    canvasState.pan.y = d.startPanY + (e.clientY - d.startY);
    applyTransform();
    updateToolbar();
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
      // Re-show promote buttons after drag
      renderPromoteButton();
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
      } else if (e.ctrlKey || e.metaKey) {
        // Ctrl/Cmd+Click on mouseup: toggle (mirrors mousedown handler)
        // (already handled in mousedown, but guard here too to prevent clear)
      } else {
        // Plain click: select only this
        canvasState.selectedIds.clear();
        document.querySelectorAll('.note.selected').forEach(el => el.classList.remove('selected'));
        canvasState.selectedIds.add(noteId);
        noteEl?.classList.add('selected');
      }
      renderPromoteButton();
      updateToolbar();
    }
    return;
  }

  // End connection drag — only commit if cursor was snapped to a valid port
  if (canvasState.connecting) {
    // Clear active-dot class from the dragged dot
    if (canvasState.connecting._activeDotEl) {
      canvasState.connecting._activeDotEl.classList.remove('conn-dot-active');
    }
    if (canvasState.connecting._noteEl) canvasState.connecting._noteEl.style.zIndex = '';
    if (canvasState.connecting._prevSnapNoteEl) canvasState.connecting._prevSnapNoteEl.style.zIndex = '';
    if (canvasState.connecting._activeDotEl) canvasState.connecting._activeDotEl.classList.remove('conn-dot-active');
    const { fromId, fromPort, snapTargetId, snapValid, snapPort } = canvasState.connecting;
    if (snapValid && snapTargetId && snapTargetId !== fromId) {
      saveConnection(fromId, snapTargetId, fromPort, snapPort);
    }
    removeTempConnectionLine();
    canvasState.connecting = null;
    updateToolbar(); // restore toolbar after connection drag
    renderPromoteButton(); // re-show promote buttons after connection drag
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
  e.preventDefault?.();
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
  updateToolbar();
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
  // Connection dot touched — let the dot's own ontouchstart handler manage it
  if (touchTarget?.closest('.conn-dot')) {
    return;
  }
  // If touching inside a selected note-body, let browser handle scroll.
  // Selected notes have overflow-y:auto, so check if content exceeds visible area.
  const touchNote = touchTarget?.closest('.note');
  const touchBody = touchTarget?.closest('.note .note-body');
  if (touchBody && touchNote?.classList.contains('selected') && !touchTarget?.closest('.note-header')) {
    touchBody.style.overflowY = 'auto';
    if (touchBody.scrollHeight > touchBody.clientHeight) {
      canvasState._nativeScroll = true;
      return; // native touch scroll on note content
    }
  }
  canvasState._nativeScroll = false;
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

      // Start potential drag — include startPositions for all selected notes (mirrors mouse drag)
      const startPositions = new Map();
      const idsToTrack = canvasState.selectedIds.has(noteId)
        ? [...canvasState.selectedIds]
        : [noteId];
      for (const id of idsToTrack) {
        const n = canvasState.notes.find(n => n.id === id);
        if (n) startPositions.set(id, { x: n.x, y: n.y });
      }
      canvasState.dragging = {
        noteId,
        startMouseX: t.clientX, startMouseY: t.clientY,
        startNoteX: note.x,     startNoteY: note.y,
        moved: false,
        startPositions
      };

      // Select this note
      canvasState.selectedIds.clear();
      document.querySelectorAll('.note.selected').forEach(el => el.classList.remove('selected'));
      canvasState.selectedIds.add(noteId);
      noteEl.classList.add('selected');
      renderPromoteButton();
      return;
    }

    // Double-tap on empty canvas → create note
    const now2 = Date.now();
    if (_lastTapTarget === '__canvas__' && now2 - _lastTapTime < 300) {
      _lastTapTime = 0;
      _lastTapTarget = null;
      const pos = screenToCanvas(t.clientX, t.clientY);
      createNoteAt(pos.x - NOTE_WIDTH / 2, pos.y - 20);
      return;
    }
    _lastTapTime = now2;
    _lastTapTarget = '__canvas__';

    // Close sidebar, exit edit, and deselect on empty canvas tap
    if (canvasState.sidebarNoteId) closeSidebar();
    if (canvasState.editingId) {
      const ta = document.getElementById('note-ta-' + canvasState.editingId);
      if (ta) saveNoteText(canvasState.editingId, ta.value);
    }
    if (canvasState.selectedIds.size > 0) {
      canvasState.selectedIds.clear();
      document.querySelectorAll('.note.selected').forEach(el => el.classList.remove('selected'));
      renderPromoteButton();
    }

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
  // Allow native scroll on selected note content
  if (canvasState._nativeScroll) return;
  e.preventDefault();
  if (e.touches.length === 1) {
    const t = e.touches[0];

    // Connection drag via touch — delegate to shared mouse handler
    if (canvasState.connecting) {
      onCanvasMouseMove({ clientX: t.clientX, clientY: t.clientY, target: document.elementFromPoint(t.clientX, t.clientY) });
      return;
    }

    if (canvasState.dragging) {
      const d = canvasState.dragging;
      const dist = Math.abs(t.clientX - d.startMouseX) + Math.abs(t.clientY - d.startMouseY);
      if (!d.moved && dist < 5) return;
      if (!d.moved) {
        // Touch drag started — hide promote buttons
        document.querySelectorAll('.canvas-promote-btn, .cluster-promote-btn').forEach(b => b.style.display = 'none');
      }
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
      if (!_renderPending) { _renderPending = true; requestAnimationFrame(() => { _renderPending = false; renderConnections(); }); }
      updateToolbar();
    } else if (canvasState.panning) {
      const d = canvasState.panning;
      canvasState.pan.x = d.startPanX + (t.clientX - d.startX);
      canvasState.pan.y = d.startPanY + (t.clientY - d.startY);
      applyTransform();
      updateToolbar();
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
      updateToolbar();
    }
    _pinchDist = newDist;
  }
}

function onTouchEnd(e) {
  clearTimeout(_longPressTimer);
  canvasState._nativeScroll = false;
  if (e.touches.length === 0) {
    // Finish connection drag via touch
    if (canvasState.connecting) {
      onCanvasMouseUp({ clientX: e.changedTouches[0]?.clientX, clientY: e.changedTouches[0]?.clientY });
      return;
    }
    if (canvasState.dragging) {
      const { noteId, moved, startPositions } = canvasState.dragging;
      canvasState.dragging = null;
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
        // Re-show promote buttons after touch drag (selection preserved)
        renderPromoteButton();
      } else {
        // Tap without drag — close sidebar if open
        if (canvasState.sidebarNoteId) closeSidebar();
      }
      canvasState.panning = null;
      _pinchDist = 0;
      return;
    }
    canvasState.panning  = null;
    _pinchDist = 0;
  }
}
