// canvas/clusters.js — Cluster auto-frames, cluster promote buttons

import { canvasState, COLOR_STROKE } from './state.js?v=1';
import { getAllClusters } from './connections.js?v=3';
import { updateToolbar, renderPromoteButton } from './toolbar.js?v=11';

const FRAME_PAD = 20;

/**
 * Renders SVG frame rects for each cluster.
 * Click/tap on frame → select all notes in cluster.
 * Promote button appears via renderPromoteButton() (toolbar.js) — not here.
 */
export function renderClusterFrames() {
  const svg = document.getElementById('canvasSvg');
  const vp = document.getElementById('canvasViewport');
  if (!svg || !vp) return;

  // Remove old frames
  svg.querySelectorAll('.cluster-frame').forEach(f => f.remove());

  const clusters = getAllClusters();

  for (const cluster of clusters) {
    // Compute bounding box
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const colorCounts = {};

    for (const id of cluster) {
      const note = canvasState.notes.find(n => n.id === id);
      const el = document.getElementById('note-' + id);
      if (!note || !el) continue;
      minX = Math.min(minX, note.x);
      minY = Math.min(minY, note.y);
      maxX = Math.max(maxX, note.x + el.offsetWidth);
      maxY = Math.max(maxY, note.y + el.offsetHeight);
      const c = note.color || 'grey';
      colorCounts[c] = (colorCounts[c] || 0) + 1;
    }
    if (!isFinite(minX)) continue;

    // Dominant color = most frequent note color in cluster
    const dominant = Object.entries(colorCounts)
      .sort((a, b) => b[1] - a[1])[0][0];
    const stroke = COLOR_STROKE[dominant] || 'var(--border-strong)';

    // --- SVG frame rect (rendered in underlay SVG, behind notes) ---
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', minX - FRAME_PAD);
    rect.setAttribute('y', minY - FRAME_PAD);
    rect.setAttribute('width', maxX - minX + FRAME_PAD * 2);
    rect.setAttribute('height', maxY - minY + FRAME_PAD * 2);
    rect.setAttribute('rx', '12');
    rect.setAttribute('class', 'cluster-frame');
    rect.style.stroke = stroke;
    rect.style.fill = stroke;
    // Insert before connection line groups so frames are behind lines
    const firstConn = svg.querySelector('.conn-line-group');
    if (firstConn) svg.insertBefore(rect, firstConn);
    else svg.appendChild(rect);

    // Click on frame → select all notes in cluster
    const clusterIds = [...cluster];
    rect.style.pointerEvents = 'all';
    rect.addEventListener('mousedown', e => {
      e.stopPropagation();
      canvasState.selectedIds.clear();
      document.querySelectorAll('.note.selected').forEach(el => el.classList.remove('selected'));
      for (const id of clusterIds) {
        canvasState.selectedIds.add(id);
        document.getElementById('note-' + id)?.classList.add('selected');
      }
      renderPromoteButton();
      updateToolbar();
    });
    // Touch: tap on frame → select all
    rect.addEventListener('touchstart', e => {
      e.stopPropagation();
      e.preventDefault();
      canvasState.selectedIds.clear();
      document.querySelectorAll('.note.selected').forEach(el => el.classList.remove('selected'));
      for (const id of clusterIds) {
        canvasState.selectedIds.add(id);
        document.getElementById('note-' + id)?.classList.add('selected');
      }
      renderPromoteButton();
      updateToolbar();
    }, { passive: false });
  }
}
