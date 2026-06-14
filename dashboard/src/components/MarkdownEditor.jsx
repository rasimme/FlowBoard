import { forwardRef, useImperativeHandle, useMemo, useRef } from 'react';
import { Bold, Code2, Heading1, Italic, Link, List, ListChecks, Quote, Table2 } from 'lucide-react';
import CodeMirror from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';

function insertText(text) {
  return (view) => {
    view.dispatch(view.state.replaceSelection(text));
    return true;
  };
}

function replaceSelection(view, insert, selectionStart, selectionEnd) {
  const { from, to } = view.state.selection.main;

  view.dispatch({
    changes: { from, to, insert },
    selection: {
      anchor: from + selectionStart,
      head: from + selectionEnd,
    },
    scrollIntoView: true,
  });
  view.focus();
}

function wrapSelection(view, before, after = before, placeholder = 'text') {
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to) || placeholder;
  const insert = `${before}${selected}${after}`;
  const selectionStart = before.length;
  const selectionEnd = before.length + selected.length;

  replaceSelection(view, insert, selectionStart, selectionEnd);
}

function prefixSelectedLines(view, prefix) {
  const { from, to } = view.state.selection.main;
  const startLine = view.state.doc.lineAt(from);
  const endLine = view.state.doc.lineAt(to);
  const selectedBlock = view.state.sliceDoc(startLine.from, endLine.to);
  const insert = selectedBlock
    .split('\n')
    .map((line) => line.startsWith(prefix) ? line : `${prefix}${line}`)
    .join('\n');

  view.dispatch({
    changes: { from: startLine.from, to: endLine.to, insert },
    selection: {
      anchor: from + prefix.length,
      head: to + prefix.length,
    },
    scrollIntoView: true,
  });
  view.focus();
}

function numberSelectedLines(view) {
  const { from, to } = view.state.selection.main;
  const startLine = view.state.doc.lineAt(from);
  const endLine = view.state.doc.lineAt(to);
  const selectedBlock = view.state.sliceDoc(startLine.from, endLine.to);
  let n = 0;
  const insert = selectedBlock
    .split('\n')
    .map((line) => {
      n += 1;
      return /^\d+\.\s/.test(line) ? line : `${n}. ${line}`;
    })
    .join('\n');

  view.dispatch({
    changes: { from: startLine.from, to: endLine.to, insert },
    selection: {
      anchor: startLine.from,
      head: startLine.from + insert.length,
    },
    scrollIntoView: true,
  });
  view.focus();
}

function insertTable(view) {
  const table = [
    '| Column | Value |',
    '| --- | --- |',
    '|  |  |',
  ].join('\n');

  replaceSelection(view, table, 2, 8);
}

/**
 * MarkdownEditor — CodeMirror-based markdown editor.
 *
 * T-345-1: used in the canvas sidebar. T-345-9 added additive props so the
 * same editor can be used inline on a canvas card WITHOUT its built-in toolbar
 * (which is too tall for a 160px card); the floating CanvasToolbar drives
 * formatting through the imperative handle instead.
 *
 * Additive props (all default to the prior behaviour):
 *   - `hideToolbar` (default false): do not render the built-in
 *     `.markdown-editor-toolbar`. Existing callers (NoteSidebar) keep the bar.
 *   - `compact` (default false): smaller font/padding for a card-sized editor.
 *   - `onReady(api)`: called once the CodeMirror view exists, with the same
 *     command API exposed via ref (see below).
 *
 * Imperative handle (via forwardRef): `{ bold, italic, bulletList,
 * numberedList, link, focus }`. Each runs the same wrapSelection/
 * prefixSelectedLines commands the built-in toolbar uses, on the live view.
 */
const MarkdownEditor = forwardRef(function MarkdownEditor({
  value,
  onChange,
  onSave,
  onCancel,
  className = '',
  hideToolbar = false,
  compact = false,
  autoFocus = true,
  onReady,
}, ref) {
  const viewRef = useRef(null);

  const extensions = useMemo(() => [
    markdown(),
    EditorView.lineWrapping,
    EditorView.theme({
      '&': {
        // Compact (inline card) editor grows with its content so the card keeps
        // its natural size; the sidebar editor fills its panel (height:100%).
        height: compact ? 'auto' : '100%',
        // Inline editor sits inside a coloured card — keep it transparent so the
        // card colour shows through and the card optic is unchanged.
        backgroundColor: compact ? 'transparent' : 'var(--bg)',
        color: 'var(--text)',
        fontSize: compact ? '12px' : '13px',
      },
      '.cm-scroller': {
        fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
        lineHeight: compact ? '1.45' : '1.6',
      },
      '.cm-content': {
        padding: compact ? '4px 6px' : '18px 24px',
        caretColor: 'var(--accent)',
      },
      '.cm-line': {
        padding: '0',
      },
      '.cm-gutters': {
        backgroundColor: 'var(--bg)',
        borderRight: '1px solid var(--border)',
        color: 'var(--muted)',
      },
      '.cm-activeLine': {
        backgroundColor: 'var(--card-highlight)',
      },
      '.cm-activeLineGutter': {
        backgroundColor: 'var(--card-highlight)',
      },
      '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
        backgroundColor: 'var(--accent-subtle)',
      },
      '&.cm-focused': {
        outline: 'none',
      },
    }),
    Prec.highest(keymap.of([
      { key: 'Tab', run: insertText('  ') },
      {
        key: 'Mod-s',
        run() {
          onSave?.();
          return true;
        },
      },
      {
        key: 'Escape',
        run() {
          onCancel?.();
          return true;
        },
      },
    ])),
  ], [onCancel, onSave, compact]);

  const runCommand = (command) => {
    const view = viewRef.current;
    if (!view) return;
    command(view);
  };

  // Command API exposed to outside drivers (T-345-9: the floating
  // CanvasToolbar). Same primitives as the built-in toolbar buttons; each
  // focuses the view so a toolbar click (which steals no focus via
  // preventDefault) keeps editing in the card.
  const commandApi = useMemo(() => ({
    bold: () => runCommand((view) => wrapSelection(view, '**')),
    italic: () => runCommand((view) => wrapSelection(view, '*')),
    bulletList: () => runCommand((view) => prefixSelectedLines(view, '- ')),
    numberedList: () => runCommand(numberSelectedLines),
    link: () => runCommand((view) => wrapSelection(view, '[', '](url)', 'link')),
    focus: () => viewRef.current?.focus(),
  }), []);

  useImperativeHandle(ref, () => commandApi, [commandApi]);

  const tools = [
    {
      label: 'Bold',
      icon: Bold,
      command: (view) => wrapSelection(view, '**'),
    },
    {
      label: 'Italic',
      icon: Italic,
      command: (view) => wrapSelection(view, '*'),
    },
    {
      label: 'Link',
      icon: Link,
      command: (view) => wrapSelection(view, '[', '](url)', 'link'),
    },
    {
      label: 'Code',
      icon: Code2,
      command: (view) => wrapSelection(view, '`'),
    },
    {
      label: 'Heading',
      icon: Heading1,
      command: (view) => prefixSelectedLines(view, '# '),
    },
    {
      label: 'Quote',
      icon: Quote,
      command: (view) => prefixSelectedLines(view, '> '),
    },
    {
      label: 'List',
      icon: List,
      command: (view) => prefixSelectedLines(view, '- '),
    },
    {
      label: 'Checklist',
      icon: ListChecks,
      command: (view) => prefixSelectedLines(view, '- [ ] '),
    },
    {
      label: 'Table',
      icon: Table2,
      command: insertTable,
    },
  ];

  return (
    <div className={`markdown-editor${compact ? ' markdown-editor-compact' : ''} ${className}`.trim()}>
      {!hideToolbar && (
        <div className="markdown-editor-toolbar" aria-label="Markdown formatting">
          {tools.map(({ label, icon: Icon, command }) => (
            <button
              key={label}
              type="button"
              className="markdown-editor-tool"
              title={label}
              aria-label={label}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => runCommand(command)}
            >
              <Icon size={15} strokeWidth={1.8} />
            </button>
          ))}
        </div>
      )}
      <div className="markdown-editor-body">
        <CodeMirror
          value={value}
          height={compact ? undefined : '100%'}
          minHeight={compact ? '40px' : undefined}
          theme="dark"
          extensions={extensions}
          onChange={onChange}
          onCreateEditor={(view) => {
            viewRef.current = view;
            onReady?.(commandApi);
          }}
          autoFocus={autoFocus}
          basicSetup={{
            lineNumbers: false,
            foldGutter: false,
            highlightActiveLine: true,
            highlightActiveLineGutter: false,
            highlightSelectionMatches: true,
            bracketMatching: true,
            closeBrackets: true,
            autocompletion: false,
            indentOnInput: true,
            searchKeymap: true,
          }}
        />
      </div>
    </div>
  );
});

export default MarkdownEditor;
