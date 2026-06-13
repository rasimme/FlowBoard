import { useEffect, useLayoutEffect, useReducer, useRef, useCallback, useState } from 'react';
import { useAppState } from '../context/AppStateContext.jsx';
import { useSpecify } from '../context/SpecifyContext.jsx';
import { Modal, Button, Spinner } from '../components/index.js';
import {
  initialCanvasState, canvasReducer, zoomAt, fitToNotes, addNotePosition,
  viewStorageKey, parseStoredView, clampScale,
} from '../state/canvasStore.mjs';
import {
  createNoteAt, saveNoteText, saveNotePosition, deleteNote, repositionZeroNote,
  saveConnection, deleteConnection, setNoteColor, setNoteSize, duplicateNotes, pasteNotes,
  sendPromote,
} from '../state/canvasMutations.mjs';
import { applyFormattingToTextarea } from '../utils/canvasTextFormat.mjs';
import {
  screenToCanvas, routePath, stackOffset, portDotCss, buildConnectedPorts,
} from '../utils/canvasGeometry.mjs';
import { NOTE_WIDTH, MAX_PORTS_PER_SIDE, COLOR_STROKE } from '../utils/canvasConstants.mjs';
import NoteCard from '../components/canvas/NoteCard.jsx';
import NoteSidebar from '../components/canvas/NoteSidebar.jsx';
import ConnectionLayer from '../components/canvas/ConnectionLayer.jsx';
import CanvasToolbar from '../components/canvas/CanvasToolbar.jsx';
import CanvasMiniMap from '../components/canvas/CanvasMiniMap.jsx';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * CanvasView (T-340-2/-3/-4) — React port of the vanilla Idea Canvas.
 *
 * Parity reference: js/canvas/. Multi-select/toolbar (T-340-5) and promote
 * (T-340-6) land next.
 *
 * Interaction transients (pan, pinch, drag, connect) live in refs and write
 * to the DOM directly; committed state changes go through the reducer. The
 * connection preview path is imperative (vanilla pattern) — React re-renders
 * the declarative layers via dragTick/layoutTick at most once per rAF.
 * Styling reuses the global .canvas-viewport/.note CSS until the flip commit
 * (T-340-7); the root deliberately avoids the `canvas-wrap` class.
 */
const FRAME_PAD = 20; // must match ConnectionLayer cluster frames

export default function CanvasView() {
  const { state } = useAppState();
  const specify = useSpecify();
  const viewedProject = state?.viewedProject;

  const [canvas, dispatch] = useReducer(canvasReducer, undefined, initialCanvasState);
  const [deleteTarget, setDeleteTarget] = useState(null); // {ids: [...]}
  const [promoteTarget, setPromoteTarget] = useState(null); // {ids, mode}
  const [selectedConn, setSelectedConn] = useState(null); // {from, to, mid:{x,y}}
  const [connecting, setConnecting] = useState(false);
  const [, setDragTick] = useState(0);
  const [, setLayoutTick] = useState(0);
  // Minimap (T-345-3): re-render the overview/zoom-readout when the committed
  // viewport changes (it lives in viewRef, outside React); track wrap size for
  // the viewport-frame math.
  const [viewTick, setViewTick] = useState(0);
  const [wrapSize, setWrapSize] = useState({ w: 0, h: 0 });

  const wrapRef = useRef(null);
  const viewportRef = useRef(null);
  const overlayRef = useRef(null);
  const lassoRef = useRef(null);
  const clipboardRef = useRef([]); // [{text, color, size, offsetX, offsetY}]
  const viewRef = useRef({ pan: { x: 60, y: 60 }, scale: 1.0 });
  const gestureRef = useRef({
    panning: null, pinchDist: 0, drag: null, connecting: null, lasso: null, rafPending: false,
    lastTapTime: 0, lastTapTarget: null, longPressTimer: null, nativeScroll: false,
  });
  const dimsRef = useRef(new Map());
  const fittedRef = useRef(null);
  const persistTimerRef = useRef(null);
  const addNoteCounterRef = useRef(0);
  const canvasRef = useRef(canvas);
  canvasRef.current = canvas;
  const selectedConnRef = useRef(selectedConn);
  selectedConnRef.current = selectedConn;

  const bumpDragTick = useCallback(() => {
    const g = gestureRef.current;
    if (g.rafPending) return;
    g.rafPending = true;
    requestAnimationFrame(() => { g.rafPending = false; setDragTick(t => t + 1); });
  }, []);

  // Minimap (T-345-3): nudge React after a committed viewport change so the
  // overview frame + zoom % re-read viewRef. Cheap (the minimap is the only
  // viewTick consumer); gesture-driven changes call this at gesture end, not
  // per mousemove, to avoid expensive re-renders while dragging/panning.
  const bumpView = useCallback(() => setViewTick(t => t + 1), []);

  const applyTransform = useCallback(() => {
    const vp = viewportRef.current;
    const { pan, scale } = viewRef.current;
    if (vp) vp.style.transform = `translate(${pan.x}px, ${pan.y}px) scale(${scale})`;
    // The floating toolbar tracks the selection in screen space (vanilla
    // calls updateToolbar from every transform change) — rAF-throttled.
    if (canvasRef.current?.selectedIds.size > 0) bumpDragTick();
  }, [bumpDragTick]);

  // Persist the committed viewport per project (T-345-2), debounced so a burst
  // of wheel/pan/pinch events only writes once the gesture settles. Browser
  // session scope (sessionStorage) — survives tab switch/reload, not restart.
  const persistView = useCallback(() => {
    if (!viewedProject) return;
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null;
      try {
        const { pan, scale } = viewRef.current;
        sessionStorage.setItem(viewStorageKey(viewedProject), JSON.stringify({ pan, scale }));
      } catch { /* storage unavailable/quota — viewport persistence is best-effort */ }
    }, 250);
  }, [viewedProject]);

  const toCanvas = useCallback((clientX, clientY) => {
    const rect = wrapRef.current.getBoundingClientRect();
    const { pan, scale } = viewRef.current;
    return screenToCanvas(clientX, clientY, rect, pan, scale);
  }, []);

  const getDims = useCallback((id) => dimsRef.current.get(id) || null, []);
  const positionOf = useCallback((id) => gestureRef.current.drag?.live?.[id] || null, []);

  // --- Create + auto-edit ---
  const createAndEdit = useCallback(async (x, y) => {
    const note = await createNoteAt(viewedProject, dispatch, x, y);
    if (note) setTimeout(() => dispatch({ type: 'editing', id: note.id }), 50);
  }, [viewedProject]);

  const onSaveText = useCallback((id, text) => {
    saveNoteText(viewedProject, dispatch, id, text);
  }, [viewedProject]);

  const startEdit = useCallback((id) => {
    const body = wrapRef.current?.querySelector(`[data-note-id="${CSS.escape(id)}"] [data-note-body]`);
    if (body?.classList.contains('truncated')) {
      dispatch({ type: 'sidebar', id });
      return;
    }
    if (canvasRef.current.sidebarNoteId) dispatch({ type: 'sidebar', id: null });
    dispatch({ type: 'editing', id });
  }, []);

  // --- Load + reset on project switch ---
  useEffect(() => {
    if (persistTimerRef.current) { clearTimeout(persistTimerRef.current); persistTimerRef.current = null; }
    dispatch({ type: 'reset' });
    viewRef.current = { pan: { x: 60, y: 60 }, scale: 1.0 };
    fittedRef.current = null;
    dimsRef.current = new Map();
    setSelectedConn(null);
    applyTransform();
    if (!viewedProject) return undefined;

    let cancelled = false;
    dispatch({ type: 'load-start' });
    (async () => {
      try {
        const res = await fetch(`/api/projects/${viewedProject}/canvas`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        dispatch({ type: 'loaded', notes: data.notes || [], connections: data.connections || [] });
      } catch (err) {
        if (cancelled) return;
        if (window.showToast) window.showToast('Failed to load canvas', 'error');
        dispatch({ type: 'load-error', error: err.message });
      }
    })();
    return () => { cancelled = true; };
  }, [viewedProject, applyTransform]);

  // Overview quick action "New Note" — consumed like window._scrollToTaskId.
  useEffect(() => {
    if (window._pendingNewNote && viewedProject && !canvas.loading) {
      delete window._pendingNewNote;
      onAddNote();
    }
  });

  // --- Reload after a completed Specify session (promoted notes vanish) ---
  useEffect(() => {
    if (!viewedProject) return undefined;
    const reload = async () => {
      try {
        const res = await fetch(`/api/projects/${viewedProject}/canvas`);
        if (!res.ok) return;
        const data = await res.json();
        dispatch({ type: 'loaded', notes: data.notes || [], connections: data.connections || [] });
      } catch { /* next manual interaction refetches */ }
    };
    window.addEventListener('flowboard:canvas-reload', reload);
    return () => window.removeEventListener('flowboard:canvas-reload', reload);
  }, [viewedProject]);

  // --- Measure note dimensions after every render (drives geometry) ---
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    let changed = false;
    const seen = new Set();
    for (const el of wrap.querySelectorAll('[data-note-id]')) {
      const id = el.dataset.noteId;
      seen.add(id);
      const dims = {
        w: el.offsetWidth, h: el.offsetHeight,
        bl: el.clientLeft || 1, bt: el.clientTop || 1,
      };
      const prev = dimsRef.current.get(id);
      if (!prev || prev.w !== dims.w || prev.h !== dims.h || prev.bl !== dims.bl || prev.bt !== dims.bt) {
        dimsRef.current.set(id, dims);
        changed = true;
      }
    }
    for (const id of [...dimsRef.current.keys()]) {
      if (!seen.has(id)) { dimsRef.current.delete(id); changed = true; }
    }
    if (changed) setLayoutTick(t => t + 1);
  });

  // --- Restore persisted viewport, else zero-note scatter + fit once per project ---
  useLayoutEffect(() => {
    if (canvas.loading || !viewedProject) return;
    const wrap = wrapRef.current;
    if (!wrap) return;

    // Restore the saved per-project viewport once, before any fit (T-345-2).
    // A stored view needs no note dimensions, so this also covers empty
    // canvases — only when there is no valid stored value do we fall back to
    // fit-to-view (which itself needs notes). fittedRef marks "viewport
    // decided for this project" for both the restore and the fit path.
    if (fittedRef.current !== viewedProject) {
      let stored = null;
      try {
        stored = parseStoredView(sessionStorage.getItem(viewStorageKey(viewedProject)));
      } catch { stored = null; }
      if (stored) {
        viewRef.current = stored;
        applyTransform();
        fittedRef.current = viewedProject;
        bumpView();
        return;
      }
    }

    if (canvas.notes.length === 0) return;

    const zeros = canvas.notes.filter(n => n.x === 0 && n.y === 0);
    if (zeros.length > 0) {
      const { pan, scale } = viewRef.current;
      for (const n of zeros) {
        repositionZeroNote(viewedProject, dispatch, n, wrap.clientWidth, wrap.clientHeight, pan, scale);
      }
      return;
    }

    if (fittedRef.current === viewedProject) return;
    const fit = fitToNotes(canvas.notes, getDims, wrap.clientWidth, wrap.clientHeight);
    if (fit) {
      viewRef.current = fit;
      applyTransform();
    }
    fittedRef.current = viewedProject;
    bumpView();
  }, [canvas.notes, canvas.loading, viewedProject, applyTransform, getDims, bumpView]);

  // --- Wheel: pan / Ctrl+wheel: zoom ---
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return undefined;

    const onWheel = (e) => {
      const noteEl = e.target.closest?.('.note');
      const noteBody = e.target.closest?.('[data-note-body]');
      if (noteEl?.dataset.selected === 'true' && noteBody && noteBody.scrollHeight > noteBody.clientHeight) {
        return;
      }
      if (e.target.closest?.('[data-canvas-ui]')) return;
      e.preventDefault();
      e.stopPropagation();

      const v = viewRef.current;
      if (e.ctrlKey || e.metaKey) {
        const rect = wrap.getBoundingClientRect();
        const factor = e.deltaY > 0 ? 0.9 : 1.1;
        viewRef.current = zoomAt(v.pan, v.scale, factor, e.clientX - rect.left, e.clientY - rect.top);
      } else {
        viewRef.current = { ...v, pan: { x: v.pan.x - e.deltaX, y: v.pan.y - e.deltaY } };
      }
      applyTransform();
      persistView(); // debounced — persists once the wheel burst settles
      bumpView();    // live zoom % + minimap frame feedback
    };

    wrap.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => wrap.removeEventListener('wheel', onWheel, { capture: true });
  }, [applyTransform, persistView, bumpView]);

  // --- Track wrap pixel size for the minimap viewport-frame math (T-345-3) ---
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return undefined;
    const measure = () => setWrapSize(prev => {
      const w = wrap.clientWidth, h = wrap.clientHeight;
      return (prev.w === w && prev.h === h) ? prev : { w, h };
    });
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [viewedProject]);

  // --- Clipboard helpers (vanilla copySelectedToClipboard / paste / duplicate) ---
  const copySelected = useCallback(() => {
    const c = canvasRef.current;
    const ids = [...c.selectedIds];
    if (ids.length === 0) return;
    const notes = ids.map(id => c.notes.find(n => n.id === id)).filter(Boolean);
    const cx = notes.reduce((s, n) => s + n.x, 0) / notes.length;
    const cy = notes.reduce((s, n) => s + n.y, 0) / notes.length;
    clipboardRef.current = notes.map(n => ({
      text: n.text || '', color: n.color || 'grey', size: n.size || 'small',
      offsetX: n.x - cx, offsetY: n.y - cy,
    }));
  }, []);

  const pasteClipboard = useCallback(() => {
    const wrap = wrapRef.current;
    if (!wrap || clipboardRef.current.length === 0) return;
    const { pan, scale } = viewRef.current;
    const cx = (wrap.clientWidth / 2 - pan.x) / scale;
    const cy = (wrap.clientHeight / 2 - pan.y) / scale;
    pasteNotes(viewedProject, dispatch, clipboardRef.current, cx, cy);
  }, [viewedProject]);

  const duplicateSelected = useCallback(async () => {
    const c = canvasRef.current;
    const notes = [...c.selectedIds].map(id => c.notes.find(n => n.id === id)).filter(Boolean);
    if (notes.length === 0) return;
    const wasEditing = !!c.editingId;
    const newIds = await duplicateNotes(viewedProject, dispatch, notes);
    if (wasEditing && newIds[0]) dispatch({ type: 'editing', id: newIds[0] });
  }, [viewedProject]);

  // --- Keyboard: Ctrl+C/V/D, Delete/Backspace (connection before notes) ---
  useEffect(() => {
    const onKeyDown = (e) => {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (canvasRef.current.editingId) return;

      if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
        if (canvasRef.current.selectedIds.size > 0) {
          e.preventDefault();
          copySelected();
        }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
        e.preventDefault();
        pasteClipboard();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'd') {
        if (canvasRef.current.selectedIds.size > 0) {
          e.preventDefault();
          duplicateSelected();
        }
        return;
      }

      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      if (selectedConnRef.current) {
        e.preventDefault();
        const { from, to } = selectedConnRef.current;
        setSelectedConn(null);
        deleteConnection(viewedProject, dispatch, from, to);
        return;
      }
      const ids = [...canvasRef.current.selectedIds];
      if (ids.length === 0) return;
      e.preventDefault();
      setDeleteTarget({ ids });
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [viewedProject, copySelected, pasteClipboard, duplicateSelected]);

  // --- Connection delete button: click outside closes (vanilla overlay) ---
  useEffect(() => {
    if (!selectedConn) return undefined;
    const close = (ev) => {
      if (!ev.target.closest?.('[data-conn-delete]')) setSelectedConn(null);
    };
    const id = setTimeout(() => {
      document.addEventListener('click', close);
      document.addEventListener('touchstart', close);
    }, 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener('click', close);
      document.removeEventListener('touchstart', close);
    };
  }, [selectedConn]);

  // --- Connection drag (vanilla startConnectionDrag / preview / snap) ---
  const onPortDown = useCallback((e, noteId, side, port) => {
    e.stopPropagation();
    if (e.preventDefault) e.preventDefault();
    const note = canvasRef.current.notes.find(n => n.id === noteId);
    const dims = getDims(noteId);
    if (!note || !dims) return;

    const fromPt = { x: note.x + dims.bl + port.left, y: note.y + dims.bt + port.top };
    const noteEl = wrapRef.current?.querySelector(`[data-note-id="${CSS.escape(noteId)}"]`);
    if (noteEl) noteEl.style.zIndex = '3';
    const dotEl = e.currentTarget;
    dotEl.classList.add('conn-dot-active');

    // Show all target ports on other notes
    wrapRef.current?.querySelectorAll('.note').forEach(el => {
      if (el.dataset.noteId === noteId) return;
      el.querySelectorAll('.conn-dot').forEach(d => d.classList.add('conn-dot-target-active'));
    });

    // Preview path in the overlay SVG (imperative, vanilla pattern)
    const overlay = overlayRef.current;
    let prev = null;
    if (overlay) {
      prev = document.createElementNS(SVG_NS, 'path');
      prev.setAttribute('class', 'conn-preview-path');
      prev.setAttribute('d', `M ${fromPt.x} ${fromPt.y}`);
      prev.style.stroke = COLOR_STROKE[note.color] || 'var(--muted)';
      overlay.appendChild(prev);
    }

    gestureRef.current.connecting = {
      fromId: noteId, fromPort: side, fromPt,
      snapTargetId: null, snapValid: false, snapPort: null,
      previewEl: prev, srcNoteEl: noteEl, activeDotEl: dotEl, prevSnapNoteEl: null,
    };
    setConnecting(true); // hides toolbar + promote (vanilla updateToolbar)
  }, [getDims]);

  const moveConnect = useCallback((clientX, clientY) => {
    const c = gestureRef.current.connecting;
    if (!c) return;
    const pos = toCanvas(clientX, clientY);
    let tx = pos.x, ty = pos.y;

    wrapRef.current?.querySelectorAll('.conn-dot-snap').forEach(d => d.classList.remove('conn-dot-snap'));

    // Nearest FREE dot on any other note (3 sides, vanilla snap logic)
    const liveNotes = canvasRef.current.notes;
    const connectedPorts = buildConnectedPorts(liveNotes, canvasRef.current.connections, getDims);
    let nearest = null;
    let nearestDist = Infinity;
    for (const note of liveNotes) {
      if (note.id === c.fromId) continue;
      const dims = getDims(note.id);
      if (!dims) continue;
      for (const side of ['right', 'bottom', 'left']) {
        const count = (connectedPorts.get(note.id + ':' + side) || []).length;
        if (count >= MAX_PORTS_PER_SIDE) continue;
        const css = portDotCss(side, dims, stackOffset(count));
        const portPos = { x: note.x + dims.bl + css.left, y: note.y + dims.bt + css.top };
        const d = Math.hypot(pos.x - portPos.x, pos.y - portPos.y);
        if (d < nearestDist) {
          nearestDist = d;
          nearest = { noteId: note.id, side, portPos };
        }
      }
    }

    if (nearest && nearestDist < 60) {
      tx = nearest.portPos.x; ty = nearest.portPos.y;
      c.snapTargetId = nearest.noteId;
      c.snapValid = true;
      c.snapPort = nearest.side;
      const dotEl = wrapRef.current?.querySelector(
        `[data-note-id="${CSS.escape(nearest.noteId)}"] .conn-dot-free[data-port-side="${nearest.side}"]`
      );
      if (dotEl) {
        dotEl.classList.add('conn-dot-snap');
        const snapNoteEl = dotEl.closest('.note');
        if (snapNoteEl && snapNoteEl !== c.srcNoteEl) {
          if (c.prevSnapNoteEl && c.prevSnapNoteEl !== snapNoteEl) c.prevSnapNoteEl.style.zIndex = '';
          snapNoteEl.style.zIndex = '3';
          c.prevSnapNoteEl = snapNoteEl;
        }
      }
    } else {
      c.snapTargetId = null;
      c.snapValid = false;
      c.snapPort = null;
    }

    if (c.previewEl) {
      let previewHW = 0;
      if (c.snapPort === 'bottom') {
        const tDims = getDims(c.snapTargetId);
        if (tDims) previewHW = tDims.w / 2;
      }
      c.previewEl.setAttribute('d', routePath(c.fromPt.x, c.fromPt.y, tx, ty, c.fromPort, c.snapPort, previewHW));
    }
  }, [toCanvas, getDims]);

  const endConnect = useCallback(() => {
    const c = gestureRef.current.connecting;
    if (!c) return false;
    gestureRef.current.connecting = null;
    setConnecting(false);
    c.activeDotEl?.classList.remove('conn-dot-active');
    if (c.srcNoteEl) c.srcNoteEl.style.zIndex = '';
    if (c.prevSnapNoteEl) c.prevSnapNoteEl.style.zIndex = '';
    c.previewEl?.remove();
    const wrap = wrapRef.current;
    wrap?.querySelectorAll('.conn-dot-target-active').forEach(d => d.classList.remove('conn-dot-target-active'));
    wrap?.querySelectorAll('.conn-dot-snap').forEach(d => d.classList.remove('conn-dot-snap'));
    if (c.snapValid && c.snapTargetId && c.snapTargetId !== c.fromId) {
      saveConnection(viewedProject, dispatch, c.fromId, c.snapTargetId, c.fromPort, c.snapPort);
    }
    return true;
  }, [viewedProject]);

  // --- Note drag (shared mouse + touch) ---
  const beginNoteDrag = useCallback((noteId, clientX, clientY) => {
    const c = canvasRef.current;
    const ids = c.selectedIds.has(noteId) ? [...c.selectedIds] : [noteId];
    const startPositions = {};
    for (const id of ids) {
      const n = c.notes.find(x => x.id === id);
      if (n) startPositions[id] = { x: n.x, y: n.y };
    }
    gestureRef.current.drag = {
      noteId, startMouseX: clientX, startMouseY: clientY,
      startPositions, live: {}, moved: false,
    };
  }, []);

  const moveNoteDrag = useCallback((clientX, clientY) => {
    const d = gestureRef.current.drag;
    if (!d) return;
    const { scale } = viewRef.current;
    const dist = Math.abs(clientX - d.startMouseX) + Math.abs(clientY - d.startMouseY);
    if (!d.moved && dist < 5) return;
    if (!d.moved) setSelectedConn(null); // dismiss delete overlay on drag start
    d.moved = true;
    const dx = (clientX - d.startMouseX) / scale;
    const dy = (clientY - d.startMouseY) / scale;
    for (const [id, start] of Object.entries(d.startPositions)) {
      const x = start.x + dx;
      const y = start.y + dy;
      d.live[id] = { x, y };
      const el = wrapRef.current?.querySelector(`[data-note-id="${CSS.escape(id)}"]`);
      if (el) { el.style.left = x + 'px'; el.style.top = y + 'px'; }
    }
    bumpDragTick(); // connections follow per rAF
  }, [bumpDragTick]);

  const endNoteDrag = useCallback((shiftKey) => {
    const d = gestureRef.current.drag;
    if (!d) return false;
    gestureRef.current.drag = null;
    if (d.moved) {
      dispatch({ type: 'notes-moved', positions: d.live });
      for (const [id, pos] of Object.entries(d.live)) {
        saveNotePosition(viewedProject, { id, ...pos });
      }
    } else if (shiftKey) {
      // Shift+click without drag: toggle selection (vanilla mouseup)
      dispatch({ type: 'toggle-select', id: d.noteId });
    } else {
      dispatch({ type: 'select-only', id: d.noteId });
    }
    return true;
  }, [viewedProject]);

  // --- Lasso (vanilla shift+drag on empty canvas) ---
  const moveLasso = useCallback((clientX, clientY) => {
    const g = gestureRef.current;
    if (!g.lasso) return;
    const rect = wrapRef.current.getBoundingClientRect();
    const curX = clientX - rect.left;
    const curY = clientY - rect.top;
    const lx = Math.min(g.lasso.startX, curX), ly = Math.min(g.lasso.startY, curY);
    const lw = Math.abs(curX - g.lasso.startX), lh = Math.abs(curY - g.lasso.startY);
    const el = lassoRef.current;
    if (el) el.style.cssText = `display:block;left:${lx}px;top:${ly}px;width:${lw}px;height:${lh}px;`;
    g.lasso.rect = { x: lx, y: ly, w: lw, h: lh };
  }, []);

  const endLasso = useCallback(() => {
    const g = gestureRef.current;
    if (!g.lasso) return false;
    const { rect } = g.lasso;
    g.lasso = null;
    if (lassoRef.current) lassoRef.current.style.display = 'none';
    if (rect) {
      const { pan, scale } = viewRef.current;
      const lx1 = (rect.x - pan.x) / scale;
      const ly1 = (rect.y - pan.y) / scale;
      const lx2 = (rect.x + rect.w - pan.x) / scale;
      const ly2 = (rect.y + rect.h - pan.y) / scale;
      const ids = [];
      for (const note of canvasRef.current.notes) {
        const dims = getDims(note.id);
        if (!dims) continue;
        const nx1 = note.x, ny1 = note.y;
        const nx2 = note.x + dims.w, ny2 = note.y + dims.h;
        if (nx1 < lx2 && nx2 > lx1 && ny1 < ly2 && ny2 > ly1) ids.push(note.id);
      }
      dispatch({ type: 'selection', ids });
    }
    return true;
  }, [getDims]);

  // --- Mouse ---
  const onMouseDown = useCallback((e) => {
    if (e.button !== 0) return;
    if (e.target.closest('[data-canvas-ui]')) return;
    if (e.target.closest('.conn-dot')) return; // handled by onPortDown

    const noteEl = e.target.closest('.note');
    if (noteEl) {
      e.stopPropagation();
      if (e.target.closest('.note-textarea')) return;
      const noteId = noteEl.dataset.noteId;
      if (canvasRef.current.editingId === noteId) return;
      if (canvasRef.current.sidebarNoteId) dispatch({ type: 'sidebar', id: null });

      if (e.ctrlKey || e.metaKey) {
        dispatch({ type: 'toggle-select', id: noteId });
        return;
      }
      if (!canvasRef.current.selectedIds.has(noteId)) {
        dispatch({ type: 'select-only', id: noteId });
        const n = canvasRef.current.notes.find(x => x.id === noteId);
        gestureRef.current.drag = {
          noteId, startMouseX: e.clientX, startMouseY: e.clientY,
          startPositions: n ? { [noteId]: { x: n.x, y: n.y } } : {},
          live: {}, moved: false,
        };
        return;
      }
      beginNoteDrag(noteId, e.clientX, e.clientY);
      return;
    }

    dispatch({ type: 'clear-selection' });
    if (canvasRef.current.sidebarNoteId) dispatch({ type: 'sidebar', id: null });

    if (e.shiftKey) {
      const rect = wrapRef.current.getBoundingClientRect();
      gestureRef.current.lasso = {
        startX: e.clientX - rect.left,
        startY: e.clientY - rect.top,
        rect: null,
      };
      return;
    }
    gestureRef.current.panning = {
      startX: e.clientX, startY: e.clientY,
      startPanX: viewRef.current.pan.x, startPanY: viewRef.current.pan.y,
    };
  }, [beginNoteDrag]);

  const onMouseMove = useCallback((e) => {
    const g = gestureRef.current;
    if (g.connecting) { moveConnect(e.clientX, e.clientY); return; }
    if (g.drag) { moveNoteDrag(e.clientX, e.clientY); return; }
    if (g.lasso) { moveLasso(e.clientX, e.clientY); return; }
    if (g.panning) {
      viewRef.current = {
        ...viewRef.current,
        pan: {
          x: g.panning.startPanX + (e.clientX - g.panning.startX),
          y: g.panning.startPanY + (e.clientY - g.panning.startY),
        },
      };
      applyTransform();
    }
  }, [applyTransform, moveConnect, moveNoteDrag]);

  const onMouseUp = useCallback((e) => {
    if (endConnect()) return;
    if (endNoteDrag(e.shiftKey)) return;
    if (endLasso()) return;
    if (gestureRef.current.panning) {
      gestureRef.current.panning = null;
      persistView(); // pan gesture ended → persist viewport
      bumpView();    // refresh minimap frame after the pan
    }
  }, [endConnect, endNoteDrag, endLasso, persistView, bumpView]);

  const onDblClick = useCallback((e) => {
    if (e.target.closest('[data-canvas-ui]')) return;
    const noteEl = e.target.closest('.note');
    if (noteEl) {
      const noteId = noteEl.dataset.noteId;
      if (canvasRef.current.sidebarNoteId) {
        dispatch({ type: 'sidebar', id: noteId });
        return;
      }
      startEdit(noteId);
      return;
    }
    const pos = toCanvas(e.clientX, e.clientY);
    createAndEdit(pos.x - NOTE_WIDTH / 2, pos.y - 20);
  }, [toCanvas, createAndEdit, startEdit]);

  // --- Touch ---
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return undefined;
    const g = gestureRef.current;

    const onTouchStart = (e) => {
      const t = e.touches[0];
      const target = document.elementFromPoint(t.clientX, t.clientY);
      if (target?.closest('.note-textarea') || target?.closest('.canvas-sidebar-textarea')) return;
      if (target?.closest('[data-canvas-ui]')) return;
      if (target?.closest('.conn-dot')) return; // port touch handled by onPortDown

      const touchNote = target?.closest('.note');
      const touchBody = target?.closest('[data-note-body]');
      if (touchBody && touchNote?.dataset.selected === 'true' && !target?.closest('.note-header')) {
        touchBody.style.overflowY = 'auto';
        if (touchBody.scrollHeight > touchBody.clientHeight) {
          g.nativeScroll = true;
          return;
        }
      }
      g.nativeScroll = false;
      e.preventDefault();
      clearTimeout(g.longPressTimer);

      if (e.touches.length === 1) {
        if (touchNote) {
          const noteId = touchNote.dataset.noteId;
          if (canvasRef.current.editingId === noteId) return;

          const now = Date.now();
          if (g.lastTapTarget === noteId && now - g.lastTapTime < 300) {
            g.lastTapTime = 0;
            g.lastTapTarget = null;
            if (canvasRef.current.sidebarNoteId) {
              dispatch({ type: 'sidebar', id: noteId });
            } else {
              startEdit(noteId);
            }
            return;
          }
          g.lastTapTime = now;
          g.lastTapTarget = noteId;

          g.longPressTimer = setTimeout(() => {
            if (g.drag && !g.drag.moved) {
              g.drag = null;
              startEdit(noteId);
            }
          }, 500);

          beginNoteDrag(noteId, t.clientX, t.clientY);
          dispatch({ type: 'select-only', id: noteId });
          return;
        }

        const now2 = Date.now();
        if (g.lastTapTarget === '__canvas__' && now2 - g.lastTapTime < 300) {
          g.lastTapTime = 0;
          g.lastTapTarget = null;
          const pos = toCanvas(t.clientX, t.clientY);
          createAndEdit(pos.x - NOTE_WIDTH / 2, pos.y - 20);
          return;
        }
        g.lastTapTime = now2;
        g.lastTapTarget = '__canvas__';

        if (canvasRef.current.sidebarNoteId) dispatch({ type: 'sidebar', id: null });
        if (canvasRef.current.selectedIds.size > 0) dispatch({ type: 'clear-selection' });

        g.panning = {
          startX: t.clientX, startY: t.clientY,
          startPanX: viewRef.current.pan.x, startPanY: viewRef.current.pan.y,
        };
      } else if (e.touches.length === 2) {
        clearTimeout(g.longPressTimer);
        g.panning = null;
        g.drag = null;
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        g.pinchDist = Math.hypot(dx, dy);
      }
    };

    const onTouchMove = (e) => {
      if (g.nativeScroll) return;
      if (canvasRef.current.editingId || canvasRef.current.sidebarNoteId) {
        const target = document.elementFromPoint(e.touches[0].clientX, e.touches[0].clientY);
        if (target?.closest('.note-textarea') || target?.closest('.canvas-sidebar-textarea')) return;
      }
      e.preventDefault();
      if (e.touches.length === 1) {
        const t = e.touches[0];
        if (g.connecting) { moveConnect(t.clientX, t.clientY); return; }
        if (g.drag) {
          const wasMoved = g.drag.moved;
          moveNoteDrag(t.clientX, t.clientY);
          if (!wasMoved && g.drag?.moved) clearTimeout(g.longPressTimer);
        } else if (g.panning) {
          viewRef.current = {
            ...viewRef.current,
            pan: {
              x: g.panning.startPanX + (t.clientX - g.panning.startX),
              y: g.panning.startPanY + (t.clientY - g.panning.startY),
            },
          };
          applyTransform();
        }
      } else if (e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const newDist = Math.hypot(dx, dy);
        if (g.pinchDist > 0) {
          const rect = wrap.getBoundingClientRect();
          const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
          const my = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;
          const v = viewRef.current;
          viewRef.current = zoomAt(v.pan, v.scale, newDist / g.pinchDist, mx, my);
          applyTransform();
        }
        g.pinchDist = newDist;
      }
    };

    const onTouchEnd = (e) => {
      clearTimeout(g.longPressTimer);
      g.nativeScroll = false;
      if (e.touches.length === 0) {
        if (endConnect()) { g.panning = null; g.pinchDist = 0; return; }
        if (g.drag) {
          const wasMoved = g.drag.moved;
          endNoteDrag(false);
          if (!wasMoved && canvasRef.current.sidebarNoteId) {
            dispatch({ type: 'sidebar', id: null });
          }
        }
        // Pan or pinch ended → persist the viewport (T-345-2).
        if (g.panning || g.pinchDist > 0) { persistView(); bumpView(); }
        g.panning = null;
        g.pinchDist = 0;
      }
    };

    wrap.addEventListener('touchstart', onTouchStart, { passive: false });
    wrap.addEventListener('touchmove', onTouchMove, { passive: false });
    wrap.addEventListener('touchend', onTouchEnd);
    return () => {
      wrap.removeEventListener('touchstart', onTouchStart);
      wrap.removeEventListener('touchmove', onTouchMove);
      wrap.removeEventListener('touchend', onTouchEnd);
    };
  }, [applyTransform, beginNoteDrag, moveNoteDrag, endNoteDrag, toCanvas, createAndEdit, startEdit, moveConnect, endConnect, persistView, bumpView]);

  useLayoutEffect(() => { applyTransform(); });

  // Flush any pending viewport write when the canvas unmounts (T-345-2).
  useEffect(() => () => {
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
  }, []);

  // --- Toolbar "+ Note" ---
  const onAddNote = useCallback(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const { pan, scale } = viewRef.current;
    const pos = addNotePosition(wrap.clientWidth, wrap.clientHeight, pan, scale, addNoteCounterRef.current++);
    createAndEdit(pos.x, pos.y);
  }, [createAndEdit]);

  // --- Minimap + zoom controls (T-345-3) ---
  // All three reuse the committed viewRef/applyTransform path and the shared
  // (debounced) persistView — no second persistence timer (T-345-2 contract).
  // fittedRef is left untouched so these never re-trigger the once-per-project
  // restore/fit decision.

  // Minimap click/drag → recenter pan on the picked world point.
  const onMiniNavigate = useCallback((pan) => {
    const v = viewRef.current;
    viewRef.current = { ...v, pan };
    applyTransform();
    persistView();
    bumpView();
  }, [applyTransform, persistView, bumpView]);

  // Zoom −/+ : cursor-anchored on the viewport center (no pointer in play).
  const onZoomButton = useCallback((factor) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const v = viewRef.current;
    viewRef.current = zoomAt(v.pan, v.scale, factor, wrap.clientWidth / 2, wrap.clientHeight / 2);
    applyTransform();
    persistView();
    bumpView();
  }, [applyTransform, persistView, bumpView]);

  // "Fit": fit-to-notes, same path as the initial fit. Does NOT reset fittedRef
  // (the per-project restore/fit decision stays made — T-345-2 contract).
  const onFit = useCallback(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const fit = fitToNotes(canvasRef.current.notes, getDims, wrap.clientWidth, wrap.clientHeight);
    if (!fit) return;
    viewRef.current = fit;
    applyTransform();
    persistView();
    bumpView();
  }, [applyTransform, persistView, bumpView, getDims]);

  // --- Connection select → delete button (vanilla showConnectionDeleteBtn) ---
  const onSelectConnection = useCallback((from, to, pathEl) => {
    let mid = null;
    if (pathEl?.getTotalLength) {
      const p = pathEl.getPointAtLength(pathEl.getTotalLength() / 2);
      mid = { x: p.x, y: p.y };
    }
    if (!mid) return;
    setSelectedConn({ from, to, mid });
  }, []);

  const onSelectCluster = useCallback((ids) => {
    dispatch({ type: 'selection', ids });
  }, []);

  // --- Delete notes confirm ---
  const confirmDelete = useCallback(async () => {
    const ids = deleteTarget?.ids || [];
    setDeleteTarget(null);
    for (const id of ids) {
      // eslint-disable-next-line no-await-in-loop
      await deleteNote(viewedProject, dispatch, id);
    }
  }, [deleteTarget, viewedProject]);

  if (!viewedProject) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-sm" data-react-canvas>
        Select a project
      </div>
    );
  }

  // --- Ports per note (vanilla renderPorts: connected dots + one free dot) ---
  const connectedPorts = buildConnectedPorts(
    canvas.notes.map(n => {
      const pos = positionOf(n.id);
      return pos ? { ...n, ...pos } : n;
    }),
    canvas.connections,
    getDims
  );
  const portsFor = (note) => {
    const dims = getDims(note.id);
    if (!dims) return [];
    const ports = [];
    for (const side of ['right', 'bottom', 'left']) {
      const conns = connectedPorts.get(note.id + ':' + side) || [];
      const total = conns.length < MAX_PORTS_PER_SIDE ? conns.length + 1 : conns.length;
      for (let i = 0; i < total; i++) {
        const css = portDotCss(side, dims, stackOffset(i));
        ports.push({
          side, slot: i, left: css.left, top: css.top,
          kind: i < conns.length ? 'connected' : 'free',
          color: i < conns.length ? conns[i].color : undefined,
        });
      }
    }
    return ports;
  };

  const sidebarNote = canvas.notes.find(n => n.id === canvas.sidebarNoteId) || null;
  const deleteSingle = deleteTarget?.ids.length === 1
    ? canvas.notes.find(n => n.id === deleteTarget.ids[0])
    : null;

  // --- Promote button (vanilla renderPromoteButton): bounding box of the
  // selection, cluster mode when a connection lies inside the selection. ---
  let promoteBtn = null;
  if (canvas.selectedIds.size > 0 && !connecting && !canvas.editingId && !gestureRef.current.drag?.moved) {
    const selIds = [...canvas.selectedIds];
    let maxX = -Infinity, maxY = -Infinity;
    for (const id of selIds) {
      const note = canvas.notes.find(n => n.id === id);
      const dims = getDims(id);
      const pos = positionOf(id) || note;
      if (note && dims && pos) {
        maxX = Math.max(maxX, pos.x + dims.w);
        maxY = Math.max(maxY, pos.y + dims.h);
      }
    }
    if (isFinite(maxX)) {
      const idSet = new Set(selIds);
      const mode = canvas.connections.some(c => idSet.has(c.from) && idSet.has(c.to)) ? 'cluster' : 'single';
      const style = mode === 'cluster'
        ? { left: maxX + FRAME_PAD, top: maxY + FRAME_PAD + 8, transform: 'translateX(-100%)' }
        : { left: maxX - 56, top: maxY + 8 };
      const noteCount = selIds.length;
      const label = noteCount === 1 ? 'this idea' : `these ${noteCount} ideas`;
      promoteBtn = (
        <button
          className="canvas-promote-btn"
          style={style}
          onMouseDown={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            setPromoteTarget({ ids: selIds, mode, label });
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="16" /><line x1="8" y1="12" x2="16" y2="12" />
          </svg>
          {' '}Task
        </button>
      );
    }
  }

  return (
    <div
      ref={wrapRef}
      data-react-canvas
      className="relative w-full h-full overflow-hidden select-none bg-bg"
      style={{ cursor: 'default' }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
      onDoubleClick={onDblClick}
    >
      <div className="canvas-toolbar" data-canvas-ui>
        <button className="btn btn-primary btn-sm" onClick={onAddNote}>+ Note</button>
      </div>

      {/* Minimap + visible zoom controls (T-345-3). Screen-fixed (outside the
          transformed .canvas-viewport); reads the committed viewRef. viewTick
          (bumped at gesture end / zoom / fit) is the key so this subtree
          re-reads viewRef on every committed viewport change. */}
      <CanvasMiniMap
        notes={canvas.notes}
        getView={() => viewRef.current}
        getDims={getDims}
        wrapSize={wrapSize}
        scale={viewRef.current.scale}
        viewTick={viewTick}
        onNavigate={onMiniNavigate}
        onZoom={onZoomButton}
        onFit={onFit}
      />

      <div ref={lassoRef} className="canvas-lasso" style={{ display: 'none' }} />

      <CanvasToolbar
        notes={canvas.notes}
        selectedIds={canvas.selectedIds}
        editingId={canvas.editingId}
        connecting={connecting}
        view={() => viewRef.current}
        getDims={getDims}
        wrapEl={wrapRef.current}
        onApplyFormat={(fmt) => {
          const ta = wrapRef.current?.querySelector('.note-textarea');
          if (ta) applyFormattingToTextarea(ta, fmt);
        }}
        onSetColor={(color) => {
          for (const id of canvas.selectedIds) setNoteColor(viewedProject, dispatch, id, color);
        }}
        onSetSize={(size) => {
          for (const id of canvas.selectedIds) setNoteSize(viewedProject, dispatch, id, size);
        }}
        onDuplicate={duplicateSelected}
        onDelete={() => setDeleteTarget({ ids: [...canvas.selectedIds] })}
      />

      <div ref={viewportRef} className="canvas-viewport">
        <ConnectionLayer
          notes={canvas.notes}
          connections={canvas.connections}
          positionOf={positionOf}
          getDims={getDims}
          onSelectConnection={onSelectConnection}
          onSelectCluster={onSelectCluster}
        />

        {canvas.notes.map(note => (
          <NoteCard
            key={note.id}
            note={note}
            selected={canvas.selectedIds.has(note.id)}
            editing={canvas.editingId === note.id}
            onSaveText={onSaveText}
            onLayoutChange={() => setLayoutTick(t => t + 1)}
            ports={portsFor(note)}
            onPortDown={onPortDown}
          />
        ))}

        <svg ref={overlayRef} className="canvas-svg canvas-svg-overlay" />

        {promoteBtn}

        {selectedConn && (
          <button
            data-conn-delete
            className="btn btn-danger btn-sm conn-delete-overlay"
            title="Delete connection"
            style={{
              position: 'absolute', left: selectedConn.mid.x, top: selectedConn.mid.y,
              transform: 'translate(-50%,-50%)', zIndex: 40, padding: '5px 7px', lineHeight: 0,
            }}
            onMouseDown={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              const { from, to } = selectedConn;
              setSelectedConn(null);
              deleteConnection(viewedProject, dispatch, from, to);
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M3 6h18" /><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2" /><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
            </svg>
          </button>
        )}
      </div>

      {canvas.notes.length === 0 && !canvas.loading && (
        <div className="canvas-empty">
          <div className="canvas-empty-icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 18h6" /><path d="M10 22h4" /><path d="M12 2a7 7 0 00-4 12.7V17h8v-2.3A7 7 0 0012 2z" />
            </svg>
          </div>
          <div>Double-click to create your first idea</div>
          <div style={{ fontSize: 12, opacity: 0.6 }}>or use the + Note button</div>
        </div>
      )}

      <NoteSidebar
        note={sidebarNote}
        onSave={onSaveText}
        onClose={() => dispatch({ type: 'sidebar', id: null })}
      />

      <Modal
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title={deleteTarget?.ids.length === 1 ? 'Delete note?' : 'Delete notes?'}
        actions={
          <>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="danger" onClick={confirmDelete}>Delete</Button>
          </>
        }
      >
        {deleteSingle ? (
          <p className="m-0">
            <strong>{deleteSingle.id}</strong>: {(deleteSingle.text || '(empty)').slice(0, 60)}
            <br />This action cannot be undone.
          </p>
        ) : (
          <p className="m-0">
            Delete <strong>{deleteTarget?.ids.length}</strong> selected notes? This cannot be undone.
          </p>
        )}
      </Modal>

      <Modal
        open={!!promoteTarget}
        onClose={() => setPromoteTarget(null)}
        title="Create Task"
        actions={
          <>
            <Button variant="ghost" onClick={() => setPromoteTarget(null)}>Cancel</Button>
            <Button onClick={() => {
              const { ids, mode } = promoteTarget;
              setPromoteTarget(null);
              sendPromote(viewedProject, canvas.notes, canvas.connections, ids, mode, specify.show);
            }}>Create Task</Button>
          </>
        }
      >
        <p className="m-0">
          Create task from {promoteTarget?.label}? The agent will decide the task structure.
          Notes will be removed from canvas after creation.
        </p>
      </Modal>

      {canvas.loading && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <Spinner size="md" />
        </div>
      )}
    </div>
  );
}
