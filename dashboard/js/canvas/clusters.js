// canvas/clusters.js — Cluster auto-frames, cluster promote buttons

import { canvasState, COLOR_STROKE } from './state.js?v=1';
import { getAllClusters } from './connections.js?v=3';
import { updateToolbar, renderPromoteButton, sendPromote } from './toolbar.js?v=3';

const FRAME_PAD = 20;
const PLUS_CIRCLE = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>';

/**
 * Renders SVG frame rects + HTML promote buttons for each cluster.
 * Called from renderConnections() so frames stay in sync with connection changes.
 */
export function renderClusterFrames() {
  const svg = document.getElementById('canvasSvg');
  const vp = document.getElementById('canvasViewport');
  if (!svg || !vp) return;

  // Remove old frames and cluster buttons
  svg.querySelectorAll('.cluster-frame').forEach(f => f.remove());
  vp.querySelectorAll('.cluster-promote-btn').forEach(b => b.remove());

  // Don't render promote buttons during drag or connection draw
  const isDragging = !!(canvasState.dragging?.moved) || !!canvasState.connecting;

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

    // --- HTML promote button (hidden, shown on hover) ---
    // Skip button creation during drag/connection operations
    if (isDragging) continue;
    const clusterIds = [...cluster];
    const btn = document.createElement('button');
    btn.className = 'cluster-promote-btn';
    btn.innerHTML = `${PLUS_CIRCLE} Task`;
    btn.style.left = (maxX - 56) + 'px';
    btn.style.top = (maxY + FRAME_PAD + 4) + 'px';
    // Prevent canvas mousedown from clearing selection
    btn.addEventListener('mousedown', e => e.stopPropagation());
    btn.addEventListener('touchstart', e => e.stopPropagation(), { passive: false });
    btn.addEventListener('click', e => {
      e.stopPropagation();
      sendPromote(clusterIds, 'cluster');
    });
    vp.appendChild(btn);

    // Hover interaction (desktop): show button on frame hover
    rect.style.pointerEvents = 'all';
    rect.addEventListener('mouseenter', () => btn.classList.add('visible'));
    rect.addEventListener('mouseleave', () => {
      // Delay to allow cursor to move from frame to button
      setTimeout(() => {
        if (!btn.matches(':hover')) btn.classList.remove('visible');
      }, 80);
    });
    btn.addEventListener('mouseleave', () => {
      // Delay to allow cursor to move from button back to frame
      setTimeout(() => {
        if (!rect.matches(':hover')) btn.classList.remove('visible');
      }, 80);
    });

    // Click on frame → select all notes in cluster
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
