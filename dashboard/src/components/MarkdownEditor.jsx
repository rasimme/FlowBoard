import { useMemo, useRef } from 'react';
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

function insertTable(view) {
  const table = [
    '| Column | Value |',
    '| --- | --- |',
    '|  |  |',
  ].join('\n');

  replaceSelection(view, table, 2, 8);
}

export default function MarkdownEditor({
  value,
  onChange,
  onSave,
  onCancel,
  className = '',
}) {
  const viewRef = useRef(null);

  const extensions = useMemo(() => [
    markdown(),
    EditorView.lineWrapping,
    EditorView.theme({
      '&': {
        height: '100%',
        backgroundColor: 'var(--bg)',
        color: 'var(--text)',
        fontSize: '13px',
      },
      '.cm-scroller': {
        fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
        lineHeight: '1.6',
      },
      '.cm-content': {
        padding: '18px 24px',
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
  ], [onCancel, onSave]);

  const runCommand = (command) => {
    const view = viewRef.current;
    if (!view) return;
    command(view);
  };

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
    <div className={`markdown-editor ${className}`.trim()}>
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
      <div className="markdown-editor-body">
        <CodeMirror
          value={value}
          height="100%"
          theme="dark"
          extensions={extensions}
          onChange={onChange}
          onCreateEditor={(view) => {
            viewRef.current = view;
          }}
          autoFocus
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
}
