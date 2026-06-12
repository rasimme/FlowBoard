import { useLayoutEffect, useEffect, useRef, useState } from 'react';
import { NOTE_COLORS } from '../../utils/canvasConstants.mjs';

const ICONS = {
  bold: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 4h8a4 4 0 010 8H6z" /><path d="M6 12h9a4 4 0 010 8H6z" /></svg>,
  italic: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="19" y1="4" x2="10" y2="4" /><line x1="14" y1="20" x2="5" y2="20" /><line x1="15" y1="4" x2="9" y2="20" /></svg>,
  bullet: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" /></svg>,
  number: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="10" y1="6" x2="21" y2="6" /><line x1="10" y1="12" x2="21" y2="12" /><line x1="10" y1="18" x2="21" y2="18" /><path d="M4 6h1v4" /><path d="M4 10h2" /><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1" /></svg>,
  link: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" /></svg>,
  color: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="13.5" cy="6.5" r=".5" fill="currentColor" /><circle cx="17.5" cy="10.5" r=".5" fill="currentColor" /><circle cx="8.5" cy="7.5" r=".5" fill="currentColor" /><circle cx="6.5" cy="12.5" r=".5" fill="currentColor" /><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 011.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z" /></svg>,
  size: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" /><line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" /></svg>,
  duplicate: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>,
  trash: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 6h18" /><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2" /><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" /></svg>,
};

/**
 * CanvasToolbar (T-340-5) — floating selection toolbar, React port of the
 * vanilla updateToolbar/showColorPopover/showSizePopover/bindToolbarEvents.
 * Hidden while nothing is selected or during a connection drag; the format
 * section appears in edit mode. Position: centered above the selection
 * bounding box (below when clipped at the top), clamped to the wrap.
 */
export default function CanvasToolbar({
  notes, selectedIds, editingId, connecting, view, getDims, wrapEl,
  onApplyFormat, onSetColor, onSetSize, onDuplicate, onDelete,
}) {
  const ref = useRef(null);
  const [popover, setPopover] = useState(null); // 'color' | 'size' | null

  const visible = selectedIds.size > 0 && !connecting;

  // Close popovers when hidden or selection changes
  useEffect(() => {
    if (!visible) setPopover(null);
  }, [visible]);

  useEffect(() => {
    if (!popover) return undefined;
    const close = (ev) => {
      if (!ref.current?.contains(ev.target)) setPopover(null);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [popover]);

  // Imperative positioning (vanilla updateToolbar math) — measure own size
  // after render, then place. Runs every render; cheap.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !visible || !wrapEl) return;
    const { pan, scale } = view();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const id of selectedIds) {
      const note = notes.find(n => n.id === id);
      const dims = getDims(id);
      if (!note || !dims) continue;
      const sx = note.x * scale + pan.x;
      const sy = note.y * scale + pan.y;
      minX = Math.min(minX, sx);
      minY = Math.min(minY, sy);
      maxX = Math.max(maxX, sx + dims.w * scale);
      maxY = Math.max(maxY, sy + dims.h * scale);
    }
    if (!isFinite(minX)) { el.style.display = 'none'; return; }

    el.style.visibility = 'hidden';
    el.style.display = 'flex';
    const tbWidth = el.offsetWidth;
    const tbHeight = el.offsetHeight || 36;
    let tbX = (minX + maxX) / 2 - tbWidth / 2;
    let tbY = minY - 16 - tbHeight;
    if (tbY < 4) tbY = maxY + 8;
    tbX = Math.max(4, Math.min(tbX, wrapEl.clientWidth - tbWidth - 4));
    el.style.left = tbX + 'px';
    el.style.top = tbY + 'px';
    el.style.visibility = '';
  });

  if (!visible) return null;

  const firstId = [...selectedIds][0];
  const firstNote = notes.find(n => n.id === firstId);
  const currentColor = firstNote?.color || 'grey';
  const currentSize = firstNote?.size || 'small';

  const stop = (e) => { e.stopPropagation(); };
  const noFocusSteal = (e) => { e.preventDefault(); e.stopPropagation(); };

  return (
    <div
      ref={ref}
      className="canvas-floating-toolbar"
      data-canvas-ui
      style={{ display: 'flex' }}
      onMouseDown={stop}
      onTouchStart={stop}
      onWheel={stop}
    >
      {editingId && (
        <div className="toolbar-section toolbar-format" style={{ display: 'flex' }}>
          {['bold', 'italic', 'bullet', 'number', 'link'].map(fmt => (
            <button
              key={fmt}
              className="toolbar-btn"
              title={fmt === 'bullet' ? 'Bullet list' : fmt === 'number' ? 'Numbered list' : fmt[0].toUpperCase() + fmt.slice(1)}
              onMouseDown={noFocusSteal}
              onClick={() => onApplyFormat(fmt)}
            >
              {ICONS[fmt]}
            </button>
          ))}
          <div className="toolbar-separator" />
        </div>
      )}
      <div className="toolbar-section toolbar-props" style={{ position: 'relative' }}>
        <button className="toolbar-btn" title="Color" onMouseDown={noFocusSteal} onClick={() => setPopover(p => p === 'color' ? null : 'color')}>
          {ICONS.color}
        </button>
        <button className="toolbar-btn" title="Size" onMouseDown={noFocusSteal} onClick={() => setPopover(p => p === 'size' ? null : 'size')}>
          {ICONS.size}
        </button>
        <button className="toolbar-btn" title="Duplicate" onMouseDown={noFocusSteal} onClick={onDuplicate}>
          {ICONS.duplicate}
        </button>
        <button className="toolbar-btn toolbar-btn-danger" title="Delete" onMouseDown={noFocusSteal} onClick={onDelete}>
          {ICONS.trash}
        </button>

        {popover === 'color' && (
          <div className="toolbar-popover" style={{ position: 'absolute', top: 'calc(100% + 10px)', left: 0, zIndex: 40 }} onMouseDown={noFocusSteal}>
            {NOTE_COLORS.map(color => (
              <span
                key={color}
                className={`color-swatch color-swatch-${color}${color === currentColor ? ' selected' : ''}`}
                title={color}
                onClick={(e) => { e.stopPropagation(); onSetColor(color); setPopover(null); }}
              />
            ))}
          </div>
        )}
        {popover === 'size' && (
          <div className="toolbar-popover" style={{ position: 'absolute', top: 'calc(100% + 10px)', left: 0, zIndex: 40 }} onMouseDown={noFocusSteal}>
            {['small', 'medium'].map(size => (
              <button
                key={size}
                className={`toolbar-size-btn${currentSize === size ? ' active' : ''}`}
                title={size === 'small' ? 'Small (160px)' : 'Medium (280px)'}
                onClick={(e) => { e.stopPropagation(); onSetSize(size); setPopover(null); }}
              >
                {size === 'small' ? 'S' : 'M'}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
