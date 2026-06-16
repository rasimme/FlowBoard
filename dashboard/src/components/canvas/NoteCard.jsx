import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { renderNoteMarkdown } from '../../utils/canvasMarkdown.mjs';
import MarkdownEditor from '../MarkdownEditor.jsx';

const EMPTY_HINT = '<span style="opacity:0.3;font-size:11px">Double-click to add text…</span>';

// T-345-9: scoped overrides for the inline (compact) MarkdownEditor on a card.
// The global .markdown-editor / .cm-editor rules (styles/dashboard.css) force
// height:100% + an opaque var(--bg) background, which is wrong for an editor
// embedded in a coloured, content-sized card. These rules are intentionally
// kept in the component (not styles/*.css — out of scope for this task) and
// only target the inline editor inside .note-editor-inline, so the sidebar /
// file editor usage is untouched.
const INLINE_EDITOR_STYLE_ID = 'note-inline-editor-style';
const INLINE_EDITOR_CSS = `
.note-editor-inline .markdown-editor {
  height: auto; background: transparent; overflow: visible;
}
.note-editor-inline .markdown-editor-body { min-height: 0; }
.note-editor-inline .markdown-editor-body > div { height: auto; }
.note-editor-inline .markdown-editor .cm-editor {
  height: auto; background: transparent;
}
.note-editor-inline .cm-scroller { overflow: visible; }
`;

function ensureInlineEditorStyle() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(INLINE_EDITOR_STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = INLINE_EDITOR_STYLE_ID;
  el.textContent = INLINE_EDITOR_CSS;
  document.head.appendChild(el);
}

/**
 * NoteCard (T-340-3) — React port of the vanilla note element
 * (js/canvas/notes.js noteHTML/createNoteElement/startNoteEdit).
 *
 * Reuses the global .note styling from dashboard.css/canvas.css for pixel
 * parity until the flip commit (T-340-7) converts those styles. Drag is
 * handled by CanvasView (document-level, like the vanilla event delegation);
 * this component owns rendering, truncation and the inline editor.
 */
export default function NoteCard({ note, selected, editing, onSaveText, onLayoutChange, onEditorReady, ports, onPortDown }) {
  const bodyRef = useRef(null);
  const [truncated, setTruncated] = useState(false);

  // T-345-9: the inline editor is the CodeMirror-based MarkdownEditor (without
  // its built-in toolbar — the floating CanvasToolbar drives formatting). The
  // editor's value is held locally while editing; the commit happens on
  // blur/Escape via onSaveText(id, value) — same save semantics as the former
  // <textarea>. A ref keeps the latest value for the blur/Escape handlers.
  const [editValue, setEditValue] = useState(note.text || '');
  const valueRef = useRef(editValue);
  valueRef.current = editValue;
  const savedRef = useRef(false);

  // Load the note text into the editor each time editing (re)starts.
  useEffect(() => {
    if (editing) {
      ensureInlineEditorStyle();
      setEditValue(note.text || '');
      savedRef.current = false;
    }
  }, [editing, note.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Truncation check (vanilla checkTruncation): after layout, when text/size
  // change and not while editing.
  useLayoutEffect(() => {
    if (editing) return;
    const body = bodyRef.current;
    if (!body) return;
    setTruncated(body.scrollHeight > body.clientHeight + 2);
  }, [note.text, note.size, editing]);

  // Commit the current editor text and close the editor (onSaveText dispatches
  // editing:null). Guarded so blur + Escape don't double-commit.
  const commit = useCallback(() => {
    if (savedRef.current) return;
    savedRef.current = true;
    onSaveText(note.id, valueRef.current);
  }, [onSaveText, note.id]);

  // Memoize the markdown parse so a canvas commit (drag/selection/port re-render)
  // doesn't re-parse every note's text — only re-runs when this note's text
  // changes (T-355). The component still re-renders so live ports/position stay
  // correct during drag; only the parse is skipped.
  const rendered = useMemo(() => renderNoteMarkdown(note.text || ''), [note.text]);
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
          // Inline CodeMirror editor (T-345-9). data-note-editor marks the
          // interactive editing surface so CanvasView's gesture guards (which
          // used to look for .note-textarea) skip it; the floating toolbar
          // reaches the editor via the command API handed up through
          // onEditorReady. Save on blur / Escape mirrors the old textarea.
          <div
            className="note-editor-inline"
            data-note-editor
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onBlur={commit}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <MarkdownEditor
              hideToolbar
              compact
              autoFocus={false}
              value={editValue}
              onChange={(v) => { setEditValue(v); if (onLayoutChange) onLayoutChange(); }}
              onSave={commit}
              onCancel={commit}
              onReady={(api) => {
                if (onEditorReady) onEditorReady(note.id, api);
                // Focus once on entry (vanilla startNoteEdit). We do NOT use
                // CodeMirror autoFocus here: it re-grabs focus on every
                // re-render (e.g. when the floating toolbar mounts/unmounts or
                // selection clears), which would prevent the editor from ever
                // blurring — so clicking outside would never commit.
                api.focus();
              }}
            />
          </div>
        ) : (
          <div
            className="note-text md-content"
            // T-345-6: the rendered markdown is display-only on the card —
            // pointer-events:none so clicks/double-clicks (incl. on links or
            // formatted spans) always reach the .note/.note-body and route
            // through CanvasView's mousedown/dblclick. Without this, a
            // double-click on a link selected the link / its target="_blank"
            // intercepted the gesture and the edit/sidebar never opened. Links
            // are followed from the sidebar (the editing/reading surface for
            // long notes), not from the card. The textarea editor is
            // unaffected (it is rendered in the other branch, fully interactive).
            style={{ pointerEvents: 'none' }}
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
