// CanvasView state store (T-340-2) — pure reducer + viewport math for the
// React canvas. Behavior is extracted 1:1 from the vanilla canvas:
//   - default/reset viewport: js/canvas/state.js resetCanvasState
//   - cursor-anchored zoom:   js/canvas/events.js onCanvasWheel / pinch
//   - fit-to-view:            js/canvas/index.js fitCanvasToNotes
//
// Canvas state is view-local by design (the appStateBridge contract,
// ADR-0019, covers tasks only). Interaction transients (drag, pan, lasso)
// live in refs inside the view, NOT here — only committed state is reduced,
// so mousemove never causes React re-renders.

import { SCALE_MIN, SCALE_MAX, NOTE_WIDTH } from '../utils/canvasConstants.mjs';

export function initialCanvasState() {
  return {
    notes: [],
    connections: [],
    pan: { x: 60, y: 60 },
    scale: 1.0,
    selectedIds: new Set(),
    editingId: null,
    sidebarNoteId: null,
    loading: false,
    error: null,
  };
}

export function canvasReducer(state, action) {
  switch (action.type) {
    case 'load-start':
      return { ...state, loading: true, error: null };
    case 'loaded': {
      const notes = action.notes || [];
      // Reload keeps the selection but drops vanished notes (vanilla
      // refreshCanvas after a promote cleanup).
      const noteIds = new Set(notes.map(n => n.id));
      const selectedIds = new Set([...state.selectedIds].filter(id => noteIds.has(id)));
      return {
        ...state,
        notes,
        connections: action.connections || [],
        selectedIds,
        loading: false,
        error: null,
      };
    }
    case 'load-error':
      // Vanilla loadCanvas: toast + empty arrays — the canvas renders empty.
      return { ...state, notes: [], connections: [], loading: false, error: action.error };
    case 'viewport':
      return { ...state, pan: action.pan, scale: action.scale };
    case 'reset':
      return initialCanvasState();

    // --- Selection (vanilla canvasState.selectedIds semantics) ---
    case 'select-only':
      return { ...state, selectedIds: new Set([action.id]) };
    case 'selection':
      return { ...state, selectedIds: new Set(action.ids) };
    case 'toggle-select': {
      const next = new Set(state.selectedIds);
      if (next.has(action.id)) next.delete(action.id); else next.add(action.id);
      return { ...state, selectedIds: next };
    }
    case 'clear-selection':
      return { ...state, selectedIds: new Set() };

    case 'editing':
      return { ...state, editingId: action.id ?? null };
    case 'sidebar':
      return { ...state, sidebarNoteId: action.id ?? null };

    // --- Note mutations (vanilla createNoteAt / saveNoteText / confirmDeleteNote) ---
    case 'note-created':
      return {
        ...state,
        notes: [...state.notes, action.note],
        selectedIds: new Set([action.note.id]),
      };
    case 'note-patch':
      return {
        ...state,
        notes: state.notes.map(n => (n.id === action.id ? { ...n, ...action.patch } : n)),
      };
    case 'note-deleted': {
      const selectedIds = new Set(state.selectedIds);
      selectedIds.delete(action.id);
      return {
        ...state,
        notes: state.notes.filter(n => n.id !== action.id),
        connections: state.connections.filter(c => c.from !== action.id && c.to !== action.id),
        selectedIds,
        editingId: state.editingId === action.id ? null : state.editingId,
        sidebarNoteId: state.sidebarNoteId === action.id ? null : state.sidebarNoteId,
      };
    }
    case 'notes-moved':
      return {
        ...state,
        notes: state.notes.map(n =>
          action.positions[n.id] ? { ...n, ...action.positions[n.id] } : n
        ),
      };

    // --- Connection mutations (vanilla saveConnection / deleteConnection) ---
    case 'connection-added':
      return { ...state, connections: [...state.connections, action.connection] };
    case 'connection-ports':
      // The server deduplicates A→B/B→A; map the dragged direction onto the
      // stored edge orientation like vanilla saveConnection does.
      return {
        ...state,
        connections: state.connections.map(c => {
          if (c.from === action.from && c.to === action.to) {
            return { ...c, fromPort: action.fromPort || null, toPort: action.toPort || null };
          }
          if (c.from === action.to && c.to === action.from) {
            return { ...c, fromPort: action.toPort || null, toPort: action.fromPort || null };
          }
          return c;
        }),
      };
    case 'connection-deleted':
      return {
        ...state,
        connections: state.connections.filter(
          c => !((c.from === action.from && c.to === action.to) ||
                 (c.from === action.to && c.to === action.from))
        ),
      };

    default:
      return state;
  }
}

/**
 * List continuation on Enter inside the note textarea (verbatim behavior from
 * the vanilla startNoteEdit keydown handler): "- " and "N. " prefixes
 * continue; an empty list line exits the list by removing its prefix.
 * Returns null when the default Enter behavior should apply.
 */
export function continueListOnEnter(value, selStart) {
  const lineStart = value.lastIndexOf('\n', selStart - 1) + 1;
  const line = value.substring(lineStart, selStart);

  const bulletMatch = line.match(/^(- )(.*)/);
  const numberMatch = line.match(/^(\d+)\. (.*)/);

  if (bulletMatch) {
    if (bulletMatch[2].trim() === '') {
      return {
        value: value.substring(0, lineStart) + value.substring(selStart),
        selStart: lineStart,
      };
    }
    const insert = '\n- ';
    return {
      value: value.substring(0, selStart) + insert + value.substring(selStart),
      selStart: selStart + insert.length,
    };
  }
  if (numberMatch) {
    if (numberMatch[2].trim() === '') {
      return {
        value: value.substring(0, lineStart) + value.substring(selStart),
        selStart: lineStart,
      };
    }
    const insert = '\n' + (parseInt(numberMatch[1], 10) + 1) + '. ';
    return {
      value: value.substring(0, selStart) + insert + value.substring(selStart),
      selStart: selStart + insert.length,
    };
  }
  return null;
}

/**
 * Placement for the toolbar "+ Note" button (vanilla addNote): visible
 * viewport center, offset 30px per successive note, cycling after 8.
 */
export function addNotePosition(viewportW, viewportH, pan, scale, counter) {
  const offset = (counter % 8) * 30;
  return {
    x: (viewportW / 2 - pan.x) / scale - NOTE_WIDTH / 2 + offset,
    y: (viewportH / 2 - pan.y) / scale - 40 + offset,
  };
}

export function clampScale(scale) {
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, scale));
}

/**
 * Escape precedence (T-345-5). Pure decision helper: given the current
 * canvas UI state, returns the single action Escape should perform, in the
 * order most-transient-first → least-transient. The caller (CanvasView) maps
 * the returned tag to the matching dispatch/setState.
 *
 *   1. 'close-connection' — a connection delete overlay is open (most local)
 *   2. 'close-sidebar'    — the note sidebar is open
 *   3. 'clear-selection'  — notes are selected
 *   4. null               — nothing to do (let the event bubble)
 *
 * Editing (textarea/CodeMirror) is intentionally NOT handled here: an active
 * editor owns its own Escape (commit/cancel), so CanvasView short-circuits
 * before consulting this helper while `editingId` is set. Connecting/pan/drag
 * transients live in refs and are cancelled on pointerup, not via Escape.
 */
export function escapePrecedence({ hasSelectedConnection, sidebarNoteId, selectionCount } = {}) {
  if (hasSelectedConnection) return 'close-connection';
  if (sidebarNoteId) return 'close-sidebar';
  if (selectionCount > 0) return 'clear-selection';
  return null;
}

/**
 * Undo-restore planner (T-345-5). Pure: takes the buffered snapshot of
 * just-deleted notes + their connections (captured BEFORE the delete) and the
 * old→new id map produced by re-creating the notes (POST assigns fresh ids —
 * canvas note ids are a monotonic per-project sequence, never reused). Returns
 * the connection list to re-create, with every endpoint remapped to its new
 * id. Connections whose endpoints aren't both in the map are dropped (their
 * other note still lives — the live edge was already kept, or it can't be
 * faithfully restored). Bidirectional dedup is the server's job, so we don't
 * dedup here.
 */
export function remapRestoredConnections(connections, idMap) {
  if (!Array.isArray(connections) || !idMap) return [];
  const get = (id) => (idMap instanceof Map ? idMap.get(id) : idMap[id]);
  const out = [];
  for (const c of connections) {
    const from = get(c.from);
    const to = get(c.to);
    if (!from || !to || from === to) continue;
    out.push({ from, to, fromPort: c.fromPort || null, toPort: c.toPort || null });
  }
  return out;
}

/**
 * Build the delete snapshot (T-345-5) for the Undo buffer: the full note
 * records to re-POST and the connections that touch any deleted note. Pure —
 * no IDs are assigned here. `ids` is the set/array being deleted.
 */
export function buildDeleteSnapshot(notes, connections, ids) {
  const idSet = ids instanceof Set ? ids : new Set(ids);
  const snapNotes = notes
    .filter(n => idSet.has(n.id))
    .map(n => ({
      oldId: n.id,
      text: n.text || '',
      x: Math.round(n.x),
      y: Math.round(n.y),
      color: n.color || 'grey',
      size: n.size || 'small',
    }));
  const snapConns = (connections || [])
    .filter(c => idSet.has(c.from) || idSet.has(c.to))
    .map(c => ({ from: c.from, to: c.to, fromPort: c.fromPort || null, toPort: c.toPort || null }));
  return { notes: snapNotes, connections: snapConns };
}

/**
 * Cursor-anchored zoom: returns the new {pan, scale} such that the canvas
 * point under (px, py) — coordinates relative to the wrap element — stays
 * fixed. Verbatim math from the vanilla wheel/pinch handlers.
 */
export function zoomAt(pan, scale, factor, px, py) {
  const newScale = clampScale(scale * factor);
  return {
    pan: {
      x: px - (px - pan.x) * (newScale / scale),
      y: py - (py - pan.y) * (newScale / scale),
    },
    scale: newScale,
  };
}

/**
 * sessionStorage key for the persisted per-project viewport (T-345-2).
 * One slot per project so switching projects restores the right view.
 */
export function viewStorageKey(project) {
  return `flowboard.canvas.view.${project}`;
}

/**
 * Parse a persisted viewport value (T-345-2). Accepts either the raw JSON
 * string from sessionStorage or an already-parsed object. Returns a sanitized
 * `{ pan: {x, y}, scale }` with scale run through clampScale, or null when the
 * value is missing/corrupt/non-finite — callers then fall back to fitToNotes.
 */
export function parseStoredView(raw) {
  if (raw == null) return null;
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object') return null;
  const { pan, scale } = obj;
  if (!pan || typeof pan !== 'object') return null;
  const { x, y } = pan;
  if (typeof x !== 'number' || !Number.isFinite(x)) return null;
  if (typeof y !== 'number' || !Number.isFinite(y)) return null;
  if (typeof scale !== 'number' || !Number.isFinite(scale)) return null;
  return { pan: { x, y }, scale: clampScale(scale) };
}

/**
 * Fit-to-view: centers the note bounds in the viewport at a scale that shows
 * everything (capped at 1, clamped to the zoom range). Returns null when
 * there is nothing to fit. getDims(noteId) may return null — vanilla falls
 * back to 160x120 when the element is not measurable yet.
 */
export function fitToNotes(notes, getDims, viewportW, viewportH) {
  if (!notes || notes.length === 0) return null;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const note of notes) {
    const d = getDims(note.id);
    const w = d?.w || 160;
    const h = d?.h || 120;
    minX = Math.min(minX, note.x);
    minY = Math.min(minY, note.y);
    maxX = Math.max(maxX, note.x + w);
    maxY = Math.max(maxY, note.y + h);
  }

  const pad = 40;
  const contentW = Math.max(1, maxX - minX + pad * 2);
  const contentH = Math.max(1, maxY - minY + pad * 2);
  const scale = Math.min(viewportW / contentW, viewportH / contentH, 1);
  const clamped = clampScale(scale);

  // Always center content bounds, even if clamped
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  return {
    pan: {
      x: viewportW / 2 - centerX * clamped,
      y: viewportH / 2 - centerY * clamped,
    },
    scale: clamped,
  };
}
