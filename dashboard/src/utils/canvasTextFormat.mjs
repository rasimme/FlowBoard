// Canvas note text formatting (T-340-5) — verbatim port of the vanilla
// toolbar formatting commands (js/canvas/toolbar.js applyFormattingToTextarea,
// insertLinePrefix, insertNumberedPrefix). The functions operate on any
// textarea-like object ({value, selectionStart, selectionEnd,
// setSelectionRange, focus, dispatchEvent}), which keeps them unit-testable.

export function applyFormattingToTextarea(ta, type) {
  if (!ta) return;
  const start = ta.selectionStart;
  const end   = ta.selectionEnd;
  const val   = ta.value;

  // Helper: wrap selection with inline markers (bold/italic).
  // Trims trailing whitespace/newlines from selection before wrapping
  // (double-click often selects trailing newline which breaks markdown).
  // Check if a string is exactly wrapped with marker (not a longer marker).
  // e.g. isWrapped('**bold**', '**') = true
  //      isWrapped('**bold**', '*')  = false (it's bold, not italic)
  function isWrapped(s, m) {
    const ml = m.length;
    if (s.length <= ml * 2) return false;
    if (s.slice(0, ml) !== m || s.slice(-ml) !== m) return false;
    // For italic (*): block matching **text** (pure bold) but allow ***text*** (bold+italic).
    // Rule: if the very next char after opening marker is ALSO m but the one after is NOT,
    // then it's bold-only → return false.
    if (ml === 1 && s[ml] === m && s[ml + 1] !== m) return false;
    if (ml === 1 && s[s.length - ml - 1] === m && s[s.length - ml - 2] !== m) return false;
    return true;
  }
  // Check if marker surrounds the selection in the full value
  function isSurrounded(v, s, e, m) {
    const ml = m.length;
    if (s < ml) return false;
    if (v.slice(s - ml, s) !== m || v.slice(e, e + ml) !== m) return false;
    if (ml === 1 && (v[s - ml - 1] === m || v[e + ml] === m)) return false;
    return true;
  }

  function wrapInline(marker) {
    const raw = val.substring(start, end);
    const trimmed = raw.trimEnd();
    const trailing = raw.substring(trimmed.length); // trailing \n from double-click

    if (trimmed.length === 0) {
      ta.value = val.substring(0, start) + marker + marker + val.substring(end);
      ta.setSelectionRange(start + marker.length, start + marker.length);
      return;
    }

    // Helper: strip list prefix from a line, returning [prefix, content]
    function splitListPrefix(l) {
      const m = l.match(/^(- |\d+\. )/);
      return m ? [m[1], l.slice(m[1].length)] : ['', l];
    }
    // Check if a line's content (after list prefix) is wrapped
    function lineIsWrapped(l) {
      const [, content] = splitListPrefix(l);
      return isWrapped(content, marker);
    }
    // Wrap content after list prefix
    function wrapLine(l) {
      const [pfx, content] = splitListPrefix(l);
      return pfx + marker + content + marker;
    }
    // Unwrap content after list prefix
    function unwrapLine(l) {
      const [pfx, content] = splitListPrefix(l);
      return isWrapped(content, marker) ? pfx + content.slice(marker.length, -marker.length) : l;
    }

    const lines = trimmed.split('\n');
    if (lines.length > 1) {
      // Multi-line: toggle per line
      const allWrapped = lines.every(l => l.trim() === '' || lineIsWrapped(l));
      const result = allWrapped
        ? lines.map(l => lineIsWrapped(l) ? unwrapLine(l) : l).join('\n')
        : lines.map(l => (lineIsWrapped(l) || l.trim() === '') ? l : wrapLine(l)).join('\n');
      ta.value = val.substring(0, start) + result + trailing + val.substring(end);
      ta.setSelectionRange(start, start + result.length);
      return;
    }

    // Single line: toggle off if content (after list prefix) is wrapped
    if (lineIsWrapped(trimmed)) {
      const unwrapped = unwrapLine(trimmed);
      ta.value = val.substring(0, start) + unwrapped + trailing + val.substring(end);
      ta.setSelectionRange(start, start + unwrapped.length);
      return;
    }
    // Or if marker surrounds the selection in the text (user selected only inner text)
    if (isSurrounded(val, start, end, marker)) {
      ta.value = val.substring(0, start - marker.length) + trimmed + trailing + val.substring(end + marker.length);
      ta.setSelectionRange(start - marker.length, start - marker.length + trimmed.length);
      return;
    }
    // Otherwise: wrap (respecting list prefix)
    const wrapped = wrapLine(trimmed);
    ta.value = val.substring(0, start) + wrapped + trailing + val.substring(end);
    ta.setSelectionRange(start, start + wrapped.length);
  }

  switch (type) {
    case 'bold':   wrapInline('**'); break;
    case 'italic': wrapInline('*');  break;
    case 'bullet': insertLinePrefix(ta, '- ');  break;
    case 'number': insertNumberedPrefix(ta);     break;
    case 'link': {
      const sel = val.substring(start, end).trimEnd();
      const trailing = val.substring(start + sel.length, end);
      // Toggle off: if selection matches [Name](url), unwrap to just Name
      const linkMatch = sel.match(/^\[([^\]]+)\]\([^)]+\)$/);
      if (linkMatch) {
        ta.value = val.substring(0, start) + linkMatch[1] + trailing + val.substring(end);
        ta.setSelectionRange(start, start + linkMatch[1].length);
      } else if (sel.length > 0) {
        ta.value = val.substring(0, start) + '[' + sel + '](url)' + trailing + val.substring(end);
        const urlStart = start + 1 + sel.length + 2;
        ta.setSelectionRange(urlStart, urlStart + 3);
      } else {
        ta.value = val.substring(0, start) + '[title](url)' + val.substring(end);
        const urlStart = start + 7;
        ta.setSelectionRange(urlStart, urlStart + 3);
      }
      break;
    }
  }
  ta.dispatchEvent(new Event('input')); // trigger autoGrow
  ta.focus();
}

export function insertLinePrefix(ta, prefix) {
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const val = ta.value;

  // Detect and strip the other list type before applying
  const otherPrefix = prefix === '- ' ? /^\d+\. / : /^- /;
  function stripOther(line) {
    return line.replace(otherPrefix, '');
  }

  // Find start of current line
  let lineStart = val.lastIndexOf('\n', start - 1) + 1;

  if (start === end) {
    const lineEnd = val.indexOf('\n', lineStart) === -1 ? val.length : val.indexOf('\n', lineStart);
    const line = val.substring(lineStart, lineEnd);
    if (line.startsWith(prefix)) {
      // Toggle off: remove prefix
      ta.value = val.substring(0, lineStart) + val.substring(lineStart + prefix.length);
      ta.setSelectionRange(Math.max(lineStart, start - prefix.length), Math.max(lineStart, start - prefix.length));
    } else if (otherPrefix.test(line)) {
      // Replace other list type with this one
      const stripped = stripOther(line);
      ta.value = val.substring(0, lineStart) + prefix + stripped + val.substring(lineEnd);
      ta.setSelectionRange(lineStart + prefix.length + stripped.length, lineStart + prefix.length + stripped.length);
    } else {
      ta.value = val.substring(0, lineStart) + prefix + val.substring(lineStart);
      ta.setSelectionRange(start + prefix.length, start + prefix.length);
    }
  } else {
    const rawEnd = end;
    const trimEnd = val[rawEnd - 1] === '\n' ? rawEnd - 1 : rawEnd;
    const trailing = val.substring(trimEnd, rawEnd);
    const before = val.substring(0, lineStart);
    const selectedLines = val.substring(lineStart, trimEnd);
    const after = val.substring(rawEnd);
    const lines = selectedLines.split('\n');
    const allPrefixed = lines.every(l => l.startsWith(prefix));
    const result = allPrefixed
      ? lines.map(l => l.substring(prefix.length)).join('\n')
      : lines.map(l => l.startsWith(prefix) ? l : prefix + stripOther(l)).join('\n');
    ta.value = before + result + trailing + after;
    ta.setSelectionRange(lineStart, lineStart + result.length);
  }
  ta.focus();
}

export function insertNumberedPrefix(ta) {
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const val = ta.value;

  function stripBullet(line) { return line.replace(/^- /, ''); }

  let lineStart = val.lastIndexOf('\n', start - 1) + 1;

  if (start === end) {
    const lineEnd = val.indexOf('\n', lineStart) === -1 ? val.length : val.indexOf('\n', lineStart);
    const line = val.substring(lineStart, lineEnd);
    const numMatch = line.match(/^\d+\. /);
    if (numMatch) {
      // Toggle off
      ta.value = val.substring(0, lineStart) + val.substring(lineStart + numMatch[0].length);
      ta.setSelectionRange(Math.max(lineStart, start - numMatch[0].length), Math.max(lineStart, start - numMatch[0].length));
    } else {
      // Replace bullet if present, then add number (continue from previous)
      const stripped = stripBullet(line);
      // Check previous line for numbering
      const prevLineEnd = lineStart - 1;
      const prevLineStart = prevLineEnd > 0 ? val.lastIndexOf('\n', prevLineEnd - 1) + 1 : 0;
      const prevLine = prevLineEnd > 0 ? val.substring(prevLineStart, prevLineEnd) : '';
      const prevNum = prevLine.match(/^(\d+)\. /);
      const num = prevNum ? parseInt(prevNum[1], 10) + 1 : 1;
      const prefix = num + '. ';
      ta.value = val.substring(0, lineStart) + prefix + stripped + val.substring(lineEnd);
      ta.setSelectionRange(lineStart + prefix.length + stripped.length, lineStart + prefix.length + stripped.length);
    }
  } else {
    const rawEnd = end;
    const trimEnd = val[rawEnd - 1] === '\n' ? rawEnd - 1 : rawEnd;
    const trailing = val.substring(trimEnd, rawEnd);
    const before = val.substring(0, lineStart);
    const selectedLines = val.substring(lineStart, trimEnd);
    const after = val.substring(rawEnd);
    const lines = selectedLines.split('\n');
    const allNumbered = lines.every(l => /^\d+\. /.test(l));
    const result = allNumbered
      ? lines.map(l => l.replace(/^\d+\. /, '')).join('\n')
      : (() => {
          // Check line above selection for numbering context
          const prevEnd = lineStart - 1;
          const prevStart = prevEnd > 0 ? val.lastIndexOf('\n', prevEnd - 1) + 1 : 0;
          const prevLine = prevEnd > 0 ? val.substring(prevStart, prevEnd) : '';
          const prevNum = prevLine.match(/^(\d+)\. /);
          const startNum = prevNum ? parseInt(prevNum[1], 10) + 1 : 1;
          return lines.map((line, i) => `${startNum + i}. ${stripBullet(line.replace(/^\d+\. /, ''))}`).join('\n');
        })();
    ta.value = before + result + trailing + after;
    ta.setSelectionRange(lineStart, lineStart + result.length);
  }
  ta.focus();
}
