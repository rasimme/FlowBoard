import { useCallback, useEffect, useRef, useState } from 'react';
import MarkdownEditor from '../MarkdownEditor.jsx';

/**
 * NoteSidebar (T-340-3/-5, T-345-1) — React port of the vanilla canvas sidebar
 * (js/canvas/notes.js openSidebar/closeSidebar): the full-text editor for
 * truncated notes.
 *
 * T-345-1: the plain <textarea> + self-built format buttons were replaced with
 * the shared CodeMirror-based MarkdownEditor (same editor base as the file
 * viewer, with markdown syntax colouring for **bold**, *italic*, links,
 * lists). The inline edit textarea on the card still uses canvasTextFormat.mjs
 * via the floating toolbar — only the sidebar is decoupled here.
 *
 * Save semantics are preserved: the latest value is persisted via
 * onSave(note.id, value) on Close (✕ / Escape) and on editor blur, and the
 * note text is loaded + focused when the sidebar opens (MarkdownEditor
 * autoFocus). Wheel/MouseDown propagation is still stopped on the sidebar so
 * CodeMirror keystrokes never trigger canvas shortcuts.
 */
export default function NoteSidebar({ note, onSave, onClose }) {
  const open = !!note;
  const [value, setValue] = useState(note?.text || '');
  // Keep the latest value in a ref so blur/close/escape handlers (which are
  // created once per open) always persist the current text, not a stale closure.
  const valueRef = useRef(value);
  valueRef.current = value;
  const noteRef = useRef(note);
  noteRef.current = note;

  // Load the note text when a (different) note opens.
  useEffect(() => {
    if (open) setValue(note.text || '');
  }, [open, note?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const persist = useCallback(() => {
    const n = noteRef.current;
    if (n) onSave(n.id, valueRef.current);
  }, [onSave]);

  const handleClose = useCallback(() => {
    persist();
    onClose();
  }, [persist, onClose]);

  // Persist whatever is in the editor when the sidebar unmounts/closes
  // (covers the close-on-outside-interaction path in CanvasView, where note
  // becomes null BEFORE this cleanup runs — so noteRef is already null and
  // persist() would no-op. Capture the open note's id here instead).
  useEffect(() => {
    if (!open || !note) return undefined;
    const openId = note.id;
    return () => { onSave(openId, valueRef.current); };
  }, [open, note?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      className={`canvas-sidebar${open ? ' open' : ''}`}
      data-canvas-ui
      onMouseDown={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
      onTouchMove={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        // CodeMirror handles Escape via onCancel; this guard stops any other
        // key from bubbling out to the canvas keyboard shortcuts.
        e.stopPropagation();
      }}
    >
      <div className="canvas-sidebar-header">
        <span className={`canvas-sidebar-color-bar sidebar-color-${note?.color || 'grey'}`} id="sidebarColorBar" />
        <span className="canvas-sidebar-id">{note?.id || ''}</span>
        <button className="canvas-sidebar-close" onClick={handleClose}>✕</button>
      </div>
      {/* Inline flex layout so the MarkdownEditor fills the sidebar body and
          scrolls on long text. Height is driven here (props/inline style),
          never via styles/*.css. */}
      <div
        className="canvas-sidebar-body"
        style={{ display: 'flex', flexDirection: 'column', minHeight: 0, padding: 0 }}
      >
        {open && (
          // onBlur bubbles from CodeMirror's focusout; persist on blur to keep
          // the textarea's save-on-blur semantics without touching MarkdownEditor.
          <div
            style={{ flex: '1 1 auto', minHeight: 0, display: 'flex' }}
            onBlur={persist}
          >
            <MarkdownEditor
              className="canvas-sidebar-editor"
              value={value}
              onChange={setValue}
              onSave={persist}
              onCancel={handleClose}
            />
          </div>
        )}
      </div>
    </div>
  );
}
