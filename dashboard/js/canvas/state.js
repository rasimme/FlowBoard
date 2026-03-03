// canvas/state.js — Canvas state, constants, and coordinate helpers

import { api, toast, ICONS } from '../utils.js?v=3';

// --- Constants ---
export const NOTE_WIDTH = 160;
export const SCALE_MIN = 0.3;
export const SCALE_MAX = 2.5;
export const NOTE_COLORS = ['grey', 'yellow', 'blue', 'green', 'red', 'teal'];
export const CORNER_RADIUS = 12;
export const PORT_SPACING  = 18;

export const COLOR_STROKE = {
  grey:   'var(--border-strong)',
  yellow: 'var(--warn)',
  blue:   'var(--info)',
  green:  'var(--ok)',
  red:    'var(--danger)',
  teal:   'var(--accent-2)'
};

export const MIN_ESCAPE = 28;
export const MAX_PORTS_PER_SIDE = 5;

// --- State ---
export const canvasState = {
  notes: [],
  connections: [],
  pan: { x: 60, y: 60 },
  scale: 1.0,
  selectedIds: new Set(),
  editingId: null,
  dragging: null,
  connecting: null,
  selectedConn: null,
  panning: null,
  lassoState: null,
  posSaveTimers: {},
  sidebarNoteId: null
};

// --- Coordinate helpers ---
export function screenToCanvas(screenX, screenY) {
  const wrap = document.getElementById('canvasWrap');
  if (!wrap) return { x: 0, y: 0 };
  const rect = wrap.getBoundingClientRect();
  return {
    x: (screenX - rect.left - canvasState.pan.x) / canvasState.scale,
    y: (screenY - rect.top  - canvasState.pan.y) / canvasState.scale
  };
}

export function getNoteCenter(id) {
  const el = document.getElementById('note-' + id);
  const note = canvasState.notes.find(n => n.id === id);
  if (!el || !note) return null;
  return { x: note.x + el.offsetWidth / 2, y: note.y + el.offsetHeight / 2 };
}

export function getNoteDotPosition(noteId, port) {
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
export function applyTransform() {
  const vp = document.getElementById('canvasViewport');
  if (vp) vp.style.transform =
    `translate(${canvasState.pan.x}px, ${canvasState.pan.y}px) scale(${canvasState.scale})`;
}

// --- Load canvas data ---
export async function loadCanvas(state) {
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
