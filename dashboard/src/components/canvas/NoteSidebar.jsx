import { useLayoutEffect, useRef } from 'react';
import { applyFormattingToTextarea } from '../../utils/canvasTextFormat.mjs';

const FMT_ICONS = {
  bold: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 4h8a4 4 0 010 8H6z" /><path d="M6 12h9a4 4 0 010 8H6z" /></svg>,
  italic: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="19" y1="4" x2="10" y2="4" /><line x1="14" y1="20" x2="5" y2="20" /><line x1="15" y1="4" x2="9" y2="20" /></svg>,
  bullet: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" /></svg>,
  number: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="10" y1="6" x2="21" y2="6" /><line x1="10" y1="12" x2="21" y2="12" /><line x1="10" y1="18" x2="21" y2="18" /><path d="M4 6h1v4" /><path d="M4 10h2" /><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1" /></svg>,
  link: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" /></svg>,
};

/**
 * NoteSidebar (T-340-3/-5) — React port of the vanilla canvas sidebar
 * (js/canvas/notes.js openSidebar/closeSidebar + index.js sidebar format
 * buttons): the full-text editor for truncated notes.
 * Reuses the global .canvas-sidebar styles until the flip commit.
 */
export default function NoteSidebar({ note, onSave, onClose }) {
  const taRef = useRef(null);
  const open = !!note;

  useLayoutEffect(() => {
    if (!open) return;
    const ta = taRef.current;
    if (!ta) return;
    ta.value = note.text || '';
    // Prevent browser scroll/viewport adjustments when focusing (vanilla parity)
    try {
      ta.focus({ preventScroll: true });
    } catch {
      ta.focus();
    }
  }, [open, note?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      className={`canvas-sidebar${open ? ' open' : ''}`}
      data-canvas-ui
      onMouseDown={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
      onTouchMove={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div className="canvas-sidebar-header">
        <span className={`canvas-sidebar-color-bar sidebar-color-${note?.color || 'grey'}`} id="sidebarColorBar" />
        <span className="canvas-sidebar-id">{note?.id || ''}</span>
        <button className="canvas-sidebar-close" onClick={onClose}>✕</button>
      </div>
      <div className="canvas-sidebar-body">
        <div className="canvas-sidebar-format">
          {Object.keys(FMT_ICONS).map(fmt => (
            <button
              key={fmt}
              className="toolbar-btn"
              title={fmt === 'bullet' ? 'Bullet list' : fmt === 'number' ? 'Numbered list' : fmt[0].toUpperCase() + fmt.slice(1)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => applyFormattingToTextarea(taRef.current, fmt)}
            >
              {FMT_ICONS[fmt]}
            </button>
          ))}
        </div>
        <textarea
          ref={taRef}
          className="canvas-sidebar-textarea"
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Escape') onClose();
          }}
          onBlur={(e) => {
            if (note) onSave(note.id, e.target.value);
          }}
        />
      </div>
    </div>
  );
}
