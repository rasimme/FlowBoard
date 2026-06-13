import { useCallback, useRef } from 'react';
import {
  notesBounds, minimapTransform, noteMiniRect, viewportFrameRect,
  minimapToWorld, panToCenterWorld,
} from '../../utils/canvasGeometry.mjs';
import { COLOR_STROKE, SCALE_MIN, SCALE_MAX } from '../../utils/canvasConstants.mjs';

/**
 * CanvasMiniMap (T-345-3) — Miro-style overview + visible zoom controls.
 *
 * Read-only over the committed canvas state: it renders every note as a small
 * rectangle (color = note color token) inside a fitted panel and overlays the
 * current viewport as a frame. Clicking or dragging the panel recenters the
 * canvas pan on the picked world point; the −/%/+/Fit bar drives zoom.
 *
 * It never owns view state. Navigation/zoom go back to CanvasView through the
 * `onNavigate` / `onZoom` / `onFit` callbacks, which write the SAME viewRef and
 * call applyTransform + the shared persistView (so there is no second debounce
 * timer racing the wheel/pan one — T-345-2 integration contract).
 *
 * Geometry is pure (canvasGeometry minimap helpers); the only state here is a
 * drag flag in a ref, and a rAF gate so dragging across the panel does not
 * fire a navigate per mousemove. Styling is Tailwind/inline only (no CSS file,
 * Hue owns styles/*.css this session).
 *
 * Position: bottom-right (minimap) / bottom-left (zoom bar). The "+ Note"
 * toolbar lives top-right and the promote button rides the selection in
 * canvas space, so neither overlaps these.
 */

const MAP_W = 180;
const MAP_H = 120;
// Keep the viewport frame this far inside the panel so its square corners
// clear the SVG's rounded corners (--radius-sm = 6px) and stay fully visible.
const FRAME_INSET = 6;

export default function CanvasMiniMap({
  notes, getView, getDims, wrapSize, scale,
  // viewTick changes on every committed viewport change so this subtree
  // re-reads getView() for the frame; it is intentionally not read directly.
  viewTick, // eslint-disable-line no-unused-vars
  onNavigate, onZoom, onFit,
}) {
  const svgRef = useRef(null);
  const draggingRef = useRef(false);
  const rafRef = useRef(0);
  const pendingRef = useRef(null);

  const bounds = notesBounds(notes, getDims);
  const mm = bounds ? minimapTransform(bounds, MAP_W, MAP_H) : null;

  let frame = null;
  if (mm && wrapSize && wrapSize.w > 0 && wrapSize.h > 0) {
    const view = getView ? getView() : null;
    if (view) {
      frame = viewportFrameRect(view.pan, view.scale, wrapSize.w, wrapSize.h, mm, MAP_W, MAP_H, FRAME_INSET);
    }
  }

  // Map a pointer event to panel-local pixels, then recenter the canvas on the
  // corresponding world point. rAF-throttled like the canvas dragTick so a
  // drag across the panel produces at most one navigate per frame.
  const navigateFromEvent = useCallback((clientX, clientY) => {
    if (!mm || !bounds || !wrapSize) return;
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const mx = clientX - rect.left;
    const my = clientY - rect.top;
    const world = minimapToWorld(mx, my, bounds, mm);
    const view = getView ? getView() : null;
    const sc = view ? view.scale : 1;
    pendingRef.current = panToCenterWorld(world.x, world.y, sc, wrapSize.w, wrapSize.h);
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      const pan = pendingRef.current;
      pendingRef.current = null;
      if (pan && onNavigate) onNavigate(pan);
    });
  }, [mm, bounds, wrapSize, getView, onNavigate]);

  const onPointerDown = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    draggingRef.current = true;
    navigateFromEvent(e.clientX, e.clientY);
  }, [navigateFromEvent]);

  const onPointerMove = useCallback((e) => {
    if (!draggingRef.current) return;
    navigateFromEvent(e.clientX, e.clientY);
  }, [navigateFromEvent]);

  const endDrag = useCallback(() => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; }
    if (pendingRef.current && onNavigate) onNavigate(pendingRef.current);
    pendingRef.current = null;
    // Gesture ended → persist the viewport (CanvasView reuses its debounced
    // persistView inside onNavigate, so the final pan is what gets stored).
  }, [onNavigate]);

  const pct = Math.round((scale || 1) * 100);
  const canZoomOut = (scale || 1) > SCALE_MIN + 1e-6;
  const canZoomIn = (scale || 1) < SCALE_MAX - 1e-6;

  const btnStyle = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 28, height: 28, border: '1px solid var(--border)', background: 'var(--card)',
    color: 'var(--text)', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
    fontSize: 16, lineHeight: 1, userSelect: 'none', padding: 0,
  };
  const disabledStyle = { opacity: 0.4, cursor: 'default' };

  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };

  return (
    <>
      {/* Zoom controls — bottom-left */}
      <div
        data-canvas-ui
        data-zoom-controls
        style={{
          position: 'absolute', left: 12, bottom: 12, zIndex: 20,
          display: 'flex', alignItems: 'center', gap: 4,
          padding: 4, background: 'var(--card)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-lg)',
        }}
        onMouseDown={stop}
        onTouchStart={stop}
      >
        <button
          type="button" data-zoom-out title="Zoom out" aria-label="Zoom out"
          style={canZoomOut ? btnStyle : { ...btnStyle, ...disabledStyle }}
          disabled={!canZoomOut}
          onClick={(e) => { stop(e); onZoom && onZoom(0.9); }}
        >−</button>
        <span
          data-zoom-pct
          style={{ minWidth: 44, textAlign: 'center', fontSize: 12, color: 'var(--text)', userSelect: 'none' }}
        >{pct}%</span>
        <button
          type="button" data-zoom-in title="Zoom in" aria-label="Zoom in"
          style={canZoomIn ? btnStyle : { ...btnStyle, ...disabledStyle }}
          disabled={!canZoomIn}
          onClick={(e) => { stop(e); onZoom && onZoom(1.1); }}
        >+</button>
        <button
          type="button" data-zoom-fit title="Fit to notes" aria-label="Fit to notes"
          style={{ ...btnStyle, width: 'auto', padding: '0 10px', fontSize: 12 }}
          onClick={(e) => { stop(e); onFit && onFit(); }}
        >Fit</button>
      </div>

      {/* Minimap — bottom-right */}
      <div
        data-canvas-ui
        data-minimap
        style={{
          position: 'absolute', right: 12, bottom: 12, zIndex: 20,
          padding: 4, background: 'var(--card)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-lg)',
          lineHeight: 0,
        }}
        onMouseDown={stop}
        onTouchStart={stop}
      >
        <svg
          ref={svgRef}
          width={MAP_W}
          height={MAP_H}
          style={{ display: 'block', borderRadius: 'var(--radius-sm)', background: 'var(--bg)', cursor: 'pointer', touchAction: 'none' }}
          onMouseDown={onPointerDown}
          onMouseMove={onPointerMove}
          onMouseUp={endDrag}
          onMouseLeave={endDrag}
          onTouchStart={(e) => { const t = e.touches[0]; if (t) onPointerDown({ preventDefault: () => e.preventDefault(), stopPropagation: () => e.stopPropagation(), clientX: t.clientX, clientY: t.clientY }); }}
          onTouchMove={(e) => { const t = e.touches[0]; if (t) onPointerMove({ clientX: t.clientX, clientY: t.clientY }); }}
          onTouchEnd={endDrag}
        >
          {mm && notes.map((note) => {
            const r = noteMiniRect(note, getDims, mm);
            const col = COLOR_STROKE[note.color] || 'var(--border-strong)';
            return (
              <rect
                key={note.id}
                data-mini-note={note.id}
                x={r.x} y={r.y} width={r.w} height={r.h}
                rx={1}
                fill={col}
                fillOpacity={0.85}
              />
            );
          })}
          {frame && frame.w > 0 && frame.h > 0 && (
            <rect
              data-mini-viewport
              x={frame.x} y={frame.y} width={frame.w} height={frame.h}
              rx={2}
              fill="var(--accent)"
              fillOpacity={0.12}
              stroke="var(--accent)"
              strokeWidth={1.5}
              pointerEvents="none"
            />
          )}
        </svg>
      </div>
    </>
  );
}
