import { useLayoutEffect, useRef, useState } from 'react';
import { renderNoteMarkdown } from '../../utils/canvasMarkdown.mjs';
import { continueListOnEnter } from '../../state/canvasStore.mjs';

const EMPTY_HINT = '<span style="opacity:0.3;font-size:11px">Double-click to add text…</span>';

/**
 * NoteCard (T-340-3) — React port of the vanilla note element
 * (js/canvas/notes.js noteHTML/createNoteElement/startNoteEdit).
 *
 * Reuses the global .note styling from dashboard.css/canvas.css for pixel
 * parity until the flip commit (T-340-7) converts those styles. Drag is
 * handled by CanvasView (document-level, like the vanilla event delegation);
 * this component owns rendering, truncation and the inline editor.
 */
export default function NoteCard({ note, selected, editing, onSaveText, onLayoutChange, ports, onPortDown }) {
  const bodyRef = useRef(null);
  const taRef = useRef(null);
  const [truncated, setTruncated] = useState(false);
  // Uncontrolled editor: the textarea owns the text while editing (matches
  // vanilla), commit happens on blur/escape via onSaveText.

  // Truncation check (vanilla checkTruncation): after layout, when text/size
  // change and not while editing.
  useLayoutEffect(() => {
    if (editing) return;
    const body = bodyRef.current;
    if (!body) return;
    setTruncated(body.scrollHeight > body.clientHeight + 2);
  }, [note.text, note.size, editing]);

  // Editor focus + auto-grow on entry (vanilla startNoteEdit).
  useLayoutEffect(() => {
    if (!editing) return;
    const ta = taRef.current;
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    autoGrow(ta);
  }, [editing]);

  const autoGrow = (ta) => {
    ta.style.height = '1px';
    ta.style.height = ta.scrollHeight + 'px';
    if (onLayoutChange) onLayoutChange();
  };

  const onKeyDown = (e) => {
    e.stopPropagation(); // prevent canvas keybindings while typing
    if (e.key === 'Escape') {
      e.target.blur();
      return;
    }
    if (e.key === 'Enter') {
      const ta = e.target;
      const cont = continueListOnEnter(ta.value, ta.selectionStart);
      if (cont) {
        e.preventDefault();
        ta.value = cont.value;
        ta.setSelectionRange(cont.selStart, cont.selStart);
        autoGrow(ta);
      }
    }
  };

  const rendered = renderNoteMarkdown(note.text || '');
  const classes = [
    'note',
    `color-${note.color || 'grey'}`,
    note.size === 'medium' ? 'size-medium' : '',
    selected ? 'selected' : '',
    editing ? 'editing' : '',
  ].filter(Boolean).join(' ');

  return (
    <div
      id={`note-${note.id}`}
      data-note-id={note.id}
      data-selected={selected ? 'true' : 'false'}
      className={classes}
      style={{
        left: note.x,
        top: note.y,
        width: note.size === 'medium' ? 280 : undefined,
      }}
    >
      <div className="note-header" data-noteid={note.id}>
        <span className="note-id">{note.id}</span>
      </div>
      <div ref={bodyRef} data-note-body className={`note-body${truncated && !editing ? ' truncated' : ''}`}>
        {editing ? (
          <textarea
            ref={taRef}
            className="note-textarea"
            defaultValue={note.text || ''}
            onBlur={(e) => onSaveText(note.id, e.target.value)}
            onKeyDown={onKeyDown}
            onInput={(e) => autoGrow(e.target)}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          />
        ) : (
          <div
            className="note-text md-content"
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{ __html: rendered || EMPTY_HINT }}
          />
        )}
      </div>
      <div className="note-overflow-fade" aria-hidden="true" />
      {(ports || []).map(p => (
        <div
          key={`${p.side}-${p.slot}`}
          data-dynamic="1"
          data-dot-left={p.left}
          data-dot-top={p.top}
          data-port-side={p.side}
          className={`conn-dot conn-dot-${p.kind} conn-dot-${p.side}`}
          style={{
            left: p.left, top: p.top,
            ...(p.kind === 'connected' ? { background: p.color } : null),
          }}
          onMouseDown={p.kind === 'free' ? (e) => onPortDown(e, note.id, p.side, p) : undefined}
          onTouchStart={p.kind === 'free' ? (e) => onPortDown(e, note.id, p.side, p) : undefined}
        />
      ))}
    </div>
  );
}
