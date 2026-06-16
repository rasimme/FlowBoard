// T-380 — pure helpers mapping rendered-markdown source positions to CodeMirror
// document offsets. Lines are 1-based (matches react-markdown node.position),
// columns 0-based. Best-effort: exact when unambiguous, else line-range.

/** Character offset of (line, col) in `text`. Clamps line and col to bounds. */
export function posToOffset(text, line, col = 0) {
  const lines = String(text ?? '').split('\n');
  const L = Math.min(Math.max(1, line | 0), lines.length);
  let off = 0;
  for (let i = 0; i < L - 1; i++) off += lines[i].length + 1; // +1 for '\n'
  const c = Math.min(Math.max(0, col | 0), lines[L - 1].length);
  return off + c;
}

/**
 * Resolve a rendered selection to a source { from, to } offset range.
 * If `selectedText` occurs exactly once within the startLine..endLine slice,
 * map to those exact offsets; otherwise fall back to the full line range.
 */
export function resolveSelection(text, startLine, endLine, selectedText) {
  const src = String(text ?? '');
  const lines = src.split('\n');
  const from0 = posToOffset(src, startLine, 0);
  const endL = Math.min(Math.max(1, endLine | 0), lines.length);
  const to0 = posToOffset(src, endL, lines[endL - 1].length);

  const sel = String(selectedText ?? '').trim();
  if (sel) {
    const slice = src.slice(from0, to0);
    const first = slice.indexOf(sel);
    if (first !== -1 && slice.indexOf(sel, first + 1) === -1) {
      return { from: from0 + first, to: from0 + first + sel.length };
    }
  }
  return { from: from0, to: to0 };
}

/**
 * Best-effort column for a click: locate the last rendered word before the
 * caret within the source line and return the offset just past it. Markdown
 * syntax (**, [], etc.) lives only in the source, so this lands the cursor near
 * the clicked word rather than exactly on it. Falls back to 0 (line start).
 */
export function estimateColumn(sourceLine, renderedBefore) {
  const src = String(sourceLine ?? '');
  const words = String(renderedBefore ?? '').match(/[\p{L}\p{N}]+/gu);
  if (!words || !words.length) return 0;
  const last = words[words.length - 1];
  const idx = src.indexOf(last);
  return idx === -1 ? 0 : idx + last.length;
}
