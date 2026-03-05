// canvas/toolbar.js — Floating toolbar, formatting, popovers, clipboard, promote

import { api, toast, showModal, escHtml } from '../utils.js?v=5';
import { canvasState, NOTE_COLORS, applyTransform } from './state.js?v=1';
import {
  setNoteColor, setNoteSize, confirmDeleteNote, startDeleteNote,
  createNoteElement, startNoteEdit, saveNoteText, renderNotes,
  renderEmptyState, checkTruncation
} from './notes.js?v=5';
import { renderConnections } from './connections.js?v=3';

export function updateToolbar() {
  const toolbar = document.getElementById('canvasToolbar');
  if (!toolbar) return;

  // Hide if nothing selected or during connection drag
  if (canvasState.selectedIds.size === 0 || canvasState.connecting) {
    toolbar.style.display = 'none';
    closeToolbarPopovers();
    return;
  }

  // Show/hide format section based on editing state
  const fmtSection = document.getElementById('toolbarFormat');
  if (fmtSection) {
    fmtSection.style.display = canvasState.editingId ? 'flex' : 'none';
  }

  // Compute bounding box of all selected notes in screen space
  const wrap = document.getElementById('canvasWrap');
  if (!wrap) return;
  const wrapRect = wrap.getBoundingClientRect();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (const id of canvasState.selectedIds) {
    const note = canvasState.notes.find(n => n.id === id);
    const el = document.getElementById('note-' + id);
    if (!note || !el) continue;
    const sx = note.x * canvasState.scale + canvasState.pan.x;
    const sy = note.y * canvasState.scale + canvasState.pan.y;
    const sw = el.offsetWidth * canvasState.scale;
    const sh = el.offsetHeight * canvasState.scale;
    minX = Math.min(minX, sx);
    minY = Math.min(minY, sy);
    maxX = Math.max(maxX, sx + sw);
    maxY = Math.max(maxY, sy + sh);
  }
  if (!isFinite(minX)) { toolbar.style.display = 'none'; return; }

  // Show first (off-screen) so offsetWidth is accurate, then position
  toolbar.style.visibility = 'hidden';
  toolbar.style.display = 'flex';

  const tbWidth = toolbar.offsetWidth;
  const tbHeight = toolbar.offsetHeight || 36;
  let tbX = (minX + maxX) / 2 - tbWidth / 2;
  let tbY = minY - 16 - tbHeight;

  // If near top edge, position below instead
  if (tbY < 4) {
    tbY = maxY + 8;
  }

  // Clamp to wrap bounds
  tbX = Math.max(4, Math.min(tbX, wrap.clientWidth - tbWidth - 4));

  toolbar.style.left = tbX + 'px';
  toolbar.style.top = tbY + 'px';
  toolbar.style.visibility = '';
}

export function closeToolbarPopovers() {
  document.querySelectorAll('.toolbar-popover').forEach(p => p.remove());
}

export function showColorPopover() {
  closeToolbarPopovers();
  const toolbar = document.getElementById('canvasToolbar');
  const btn = document.getElementById('tbColor');
  if (!toolbar || !btn) return;

  const pop = document.createElement('div');
  pop.className = 'toolbar-popover';

  // Determine current color (first selected note)
  const firstId = [...canvasState.selectedIds][0];
  const firstNote = canvasState.notes.find(n => n.id === firstId);
  const currentColor = firstNote?.color || 'grey';

  NOTE_COLORS.forEach(color => {
    const swatch = document.createElement('span');
    swatch.className = `color-swatch color-swatch-${color}${color === currentColor ? ' selected' : ''}`;
    swatch.title = color;
    swatch.addEventListener('mousedown', ev => { ev.preventDefault(); ev.stopPropagation(); });
    swatch.addEventListener('touchstart', ev => { ev.stopPropagation(); }, { passive: true });
    swatch.addEventListener('click', ev => {
      ev.stopPropagation();
      for (const id of canvasState.selectedIds) {
        setNoteColor(id, color);
      }
      pop.remove();
      renderConnections(); // refresh port colors
    });
    pop.appendChild(swatch);
  });

  // Position relative to canvasWrap — start off-screen to avoid 0,0 flash
  const wrap = document.getElementById('canvasWrap');
  if (!wrap) return;
  pop.style.position = 'absolute';
  pop.style.left = '-9999px';
  pop.style.top = '-9999px';
  pop.style.zIndex = '40';
  pop.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); });
  pop.addEventListener('touchstart', e => { e.preventDefault(); e.stopPropagation(); }, { passive: false });
  wrap.appendChild(pop);
  // Ensure toolbar visible for accurate getBoundingClientRect measurement
  // (on mobile, toolbar may be hidden between touchend and synthesized click)
  toolbar.style.display = 'flex';
  // Now measure and position
  const btnRect = btn.getBoundingClientRect();
  const wrapRect = wrap.getBoundingClientRect();
  const popW = pop.offsetWidth;
  const centered = btnRect.left - wrapRect.left + btnRect.width / 2 - popW / 2;
  pop.style.left = Math.max(4, centered) + 'px';
  pop.style.top = (btnRect.bottom - wrapRect.top + 10) + 'px';

  // Close on outside click
  setTimeout(() => {
    const close = ev => {
      if (!pop.contains(ev.target) && ev.target !== btn) {
        pop.remove();
        document.removeEventListener('mousedown', close);
      }
    };
    document.addEventListener('mousedown', close);
  }, 0);
}

export function showSizePopover() {
  closeToolbarPopovers();
  const toolbar = document.getElementById('canvasToolbar');
  const btn = document.getElementById('tbSize');
  if (!toolbar || !btn) return;

  const firstId = [...canvasState.selectedIds][0];
  const firstNote = canvasState.notes.find(n => n.id === firstId);
  const currentSize = firstNote?.size || 'small';

  const pop = document.createElement('div');
  pop.className = 'toolbar-popover';

  ['small', 'medium'].forEach(size => {
    const sizeBtn = document.createElement('button');
    sizeBtn.className = `toolbar-size-btn${currentSize === size ? ' active' : ''}`;
    sizeBtn.textContent = size === 'small' ? 'S' : 'M';
    sizeBtn.title = size === 'small' ? 'Small (160px)' : 'Medium (280px)';
    sizeBtn.addEventListener('mousedown', ev => { ev.preventDefault(); ev.stopPropagation(); });
    sizeBtn.addEventListener('touchstart', ev => { ev.stopPropagation(); }, { passive: true });
    sizeBtn.addEventListener('click', ev => {
      ev.stopPropagation();
      for (const id of canvasState.selectedIds) {
        setNoteSize(id, size);
      }
      pop.remove();
      requestAnimationFrame(updateToolbar);
    });
    pop.appendChild(sizeBtn);
  });

  // Position relative to canvasWrap — start off-screen to avoid 0,0 flash
  const wrap = document.getElementById('canvasWrap');
  if (!wrap) return;
  pop.style.position = 'absolute';
  pop.style.left = '-9999px';
  pop.style.top = '-9999px';
  pop.style.zIndex = '40';
  pop.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); });
  pop.addEventListener('touchstart', e => { e.preventDefault(); e.stopPropagation(); }, { passive: false });
  wrap.appendChild(pop);
  // Ensure toolbar visible for accurate getBoundingClientRect measurement
  toolbar.style.display = 'flex';
  // Now measure and position
  const btnRect = btn.getBoundingClientRect();
  const wrapRect = wrap.getBoundingClientRect();
  const popW = pop.offsetWidth;
  const centered = btnRect.left - wrapRect.left + btnRect.width / 2 - popW / 2;
  pop.style.left = Math.max(4, centered) + 'px';
  pop.style.top = (btnRect.bottom - wrapRect.top + 10) + 'px';

  setTimeout(() => {
    const close = ev => {
      if (!pop.contains(ev.target) && ev.target !== btn) {
        pop.remove();
        document.removeEventListener('mousedown', close);
      }
    };
    document.addEventListener('mousedown', close);
  }, 0);
}


// --- Clipboard for copy/paste ---
let clipboard = []; // [{text, color, size, offsetX, offsetY}]

// --- Duplicate selected notes ---
export async function duplicateSelected() {
  const ids = [...canvasState.selectedIds];
  if (ids.length === 0) return;
  const project = window.appState?.viewedProject;
  if (!project) return;
  const wasEditing = !!canvasState.editingId;

  // Calculate bounding box center for offset
  const notes = ids.map(id => canvasState.notes.find(n => n.id === id)).filter(Boolean);
  const cx = notes.reduce((s, n) => s + n.x, 0) / notes.length;
  const cy = notes.reduce((s, n) => s + n.y, 0) / notes.length;

  const newIds = new Set();
  for (const note of notes) {
    try {
      const res = await api(`/projects/${project}/canvas/notes`, {
        method: 'POST',
        body: {
          text: note.text || '',
          x: Math.round(note.x + 40),
          y: Math.round(note.y + 40),
          color: note.color || 'grey',
          size: note.size || 'small'
        }
      });
      if (res.ok) {
        canvasState.notes.push(res.note);
        const vp = document.getElementById('canvasViewport');
        if (vp) vp.appendChild(createNoteElement(res.note));
        newIds.add(res.note.id);
      }
    } catch {}
  }

  // Select the new duplicates
  if (newIds.size > 0) {
    canvasState.selectedIds.clear();
    for (const id of newIds) canvasState.selectedIds.add(id);
    document.querySelectorAll('.note.selected').forEach(el => el.classList.remove('selected'));
    for (const id of newIds) {
      document.getElementById('note-' + id)?.classList.add('selected');
    }
    renderConnections();
    renderEmptyState();
    renderPromoteButton();
    updateToolbar();
    if (wasEditing) {
      const firstNewId = [...newIds][0];
      if (firstNewId) startNoteEdit(firstNewId);
    }
  }
}

// --- Copy/Paste (Ctrl+C / Ctrl+V) ---
export function copySelectedToClipboard() {
  const ids = [...canvasState.selectedIds];
  if (ids.length === 0) return;
  const notes = ids.map(id => canvasState.notes.find(n => n.id === id)).filter(Boolean);
  const cx = notes.reduce((s, n) => s + n.x, 0) / notes.length;
  const cy = notes.reduce((s, n) => s + n.y, 0) / notes.length;
  clipboard = notes.map(n => ({
    text: n.text || '',
    color: n.color || 'grey',
    size: n.size || 'small',
    offsetX: n.x - cx,
    offsetY: n.y - cy
  }));
}

export async function pasteFromClipboard() {
  if (clipboard.length === 0) return;
  const project = window.appState?.viewedProject;
  if (!project) return;

  // Paste at visible center of canvas
  const wrap = document.getElementById('canvasWrap');
  if (!wrap) return;
  const cx = (wrap.clientWidth  / 2 - canvasState.pan.x) / canvasState.scale;
  const cy = (wrap.clientHeight / 2 - canvasState.pan.y) / canvasState.scale;

  const newIds = new Set();
  for (const item of clipboard) {
    try {
      const res = await api(`/projects/${project}/canvas/notes`, {
        method: 'POST',
        body: {
          text: item.text,
          x: Math.round(cx + item.offsetX),
          y: Math.round(cy + item.offsetY),
          color: item.color,
          size: item.size
        }
      });
      if (res.ok) {
        canvasState.notes.push(res.note);
        const vp = document.getElementById('canvasViewport');
        if (vp) vp.appendChild(createNoteElement(res.note));
        newIds.add(res.note.id);
      }
    } catch {}
  }

  if (newIds.size > 0) {
    canvasState.selectedIds.clear();
    for (const id of newIds) canvasState.selectedIds.add(id);
    document.querySelectorAll('.note.selected').forEach(el => el.classList.remove('selected'));
    for (const id of newIds) {
      document.getElementById('note-' + id)?.classList.add('selected');
    }
    renderConnections();
    renderEmptyState();
    renderPromoteButton();
    updateToolbar();
  }
}

export function toolbarDelete() {
  const ids = [...canvasState.selectedIds];
  if (ids.length === 0) return;

  if (ids.length === 1) {
    startDeleteNote(ids[0]);
  } else {
    showModal(
      'Delete notes?',
      `Delete <strong>${ids.length}</strong> selected notes? This cannot be undone.`,
      async () => {
        for (const id of ids) {
          await confirmDeleteNote(id);
        }
      }
    );
  }
}

export function bindToolbarEvents() {
  const toolbar = document.getElementById('canvasToolbar');
  if (!toolbar) return;

  // Event isolation — prevent canvas interactions
  toolbar.addEventListener('mousedown', e => e.stopPropagation());
  toolbar.addEventListener('touchstart', e => e.stopPropagation(), { passive: false });
  toolbar.addEventListener('wheel', e => e.stopPropagation(), { passive: false });

  // Keep edit mode active when using toolbar actions
  toolbar.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('mousedown', e => e.preventDefault());
    btn.addEventListener('touchstart', e => { e.stopPropagation(); }, { passive: true });
  });

  // Button handlers
  document.getElementById('tbColor')?.addEventListener('click', showColorPopover);
  document.getElementById('tbSize')?.addEventListener('click', showSizePopover);
  document.getElementById('tbDelete')?.addEventListener('click', toolbarDelete);
  document.getElementById('tbDuplicate')?.addEventListener('click', duplicateSelected);

  // Format buttons
  toolbar.querySelectorAll('[data-fmt]').forEach(btn => {
    btn.addEventListener('click', () => applyFormatting(btn.dataset.fmt));
  });
}

// --- Formatting commands ---
export function applyFormatting(type) {
  const ta = document.getElementById('note-ta-' + canvasState.editingId);
  if (!ta) return;
  applyFormattingToTextarea(ta, type);
}

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

// --- Promote button ---
const PLUS_CIRCLE_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>';

export function renderPromoteButton() {
  const vp = document.getElementById('canvasViewport');
  if (!vp) return;
  vp.querySelectorAll('.canvas-promote-btn').forEach(b => b.remove());

  // Don't render during drag, connection draw, or edit mode
  if (canvasState.dragging?.moved || canvasState.connecting || canvasState.editingId) return;

  const selIds = [...canvasState.selectedIds];
  if (selIds.length === 0) { updateToolbar(); return; }

  // Compute bounding box of all selected notes
  let maxX = -Infinity, maxY = -Infinity;
  for (const id of selIds) {
    const note = canvasState.notes.find(n => n.id === id);
    const el   = document.getElementById('note-' + id);
    if (note && el) {
      maxX = Math.max(maxX, note.x + el.offsetWidth);
      maxY = Math.max(maxY, note.y + el.offsetHeight);
    }
  }
  if (!isFinite(maxX)) return;

  // Detect if selected notes are part of a cluster
  const idSet = new Set(selIds);
  const hasClusterConn = canvasState.connections.some(
    c => idSet.has(c.from) && idSet.has(c.to)
  );
  const mode = hasClusterConn ? 'cluster' : 'single';

  const btn = document.createElement('button');
  btn.className = 'canvas-promote-btn';
  btn.innerHTML = `${PLUS_CIRCLE_ICON} Task`;
  btn.style.left = (maxX - 56) + 'px';
  btn.style.top  = (maxY + 8)  + 'px';
  btn.addEventListener('mousedown', e => e.stopPropagation());
  btn.addEventListener('touchstart', e => e.stopPropagation(), { passive: false });
  btn.addEventListener('click', e => {
    e.stopPropagation();
    const noteCount = selIds.length;
    const label = noteCount === 1 ? 'this idea' : `these ${noteCount} ideas`;
    showModal(
      'Create Task',
      `Create task from ${label}? The agent will decide the task structure. Notes will be removed from canvas after creation.`,
      () => sendPromote(selIds, mode),
      'Create Task',
      'btn-primary'
    );
  });
  vp.appendChild(btn);

  updateToolbar();
}

// --- Promote to task (agent-assisted via session bridge) ---
export async function sendPromote(noteIds, mode = 'single') {
  const project = window.appState?.viewedProject;
  if (!project) return;

  // Collect note data, filter empty notes
  const notes = noteIds
    .map(id => canvasState.notes.find(n => n.id === id))
    .filter(n => n && n.text?.trim());
  if (notes.length === 0) {
    toast('No notes with text to promote', 'warn');
    return;
  }

  // Collect connections within the selected set
  const idSet = new Set(noteIds);
  const connections = canvasState.connections.filter(
    c => idSet.has(c.from) && idSet.has(c.to)
  );

  // Show persistent loading toast
  const loadingEl = document.createElement('div');
  loadingEl.className = 'toast loading';
  loadingEl.innerHTML = '<span class="toast-spinner"></span> Creating task…';
  document.getElementById('toastContainer').appendChild(loadingEl);

  try {
    const res = await api(`/projects/${project}/canvas/promote`, {
      method: 'POST',
      body: {
        notes: notes.map(n => ({ id: n.id, text: n.text, color: n.color || 'grey' })),
        connections: connections.map(c => ({ from: c.from, to: c.to })),
        mode
      }
    });
    if (!res.ok) {
      loadingEl.remove();
      toast(res.error || 'Promote failed', 'error');
      return;
    }
    window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('success');

    // Poll: wait for notes to disappear from canvas (agent batch-deletes them)
    const promotedIds = new Set(notes.map(n => n.id));
    let elapsed = 0;
    const poll = setInterval(async () => {
      elapsed += 3000;
      try {
        const data = await api(`/projects/${project}/canvas`);
        const remaining = (data.notes || []).filter(n => promotedIds.has(n.id));
        if (remaining.length === 0) {
          clearInterval(poll);
          loadingEl.classList.remove('loading');
          loadingEl.classList.add('success');
          loadingEl.innerHTML = '✓ Task created';
          setTimeout(() => { loadingEl.classList.add('removing'); setTimeout(() => loadingEl.remove(), 200); }, 3000);
          // Refresh canvas to remove promoted notes
          if (window.refreshCanvas) window.refreshCanvas();
        }
      } catch { /* ignore poll errors */ }
      if (elapsed >= 60000) {
        clearInterval(poll);
        loadingEl.classList.remove('loading');
        loadingEl.classList.add('warn');
        loadingEl.textContent = 'Task creation in progress…';
        setTimeout(() => { loadingEl.classList.add('removing'); setTimeout(() => loadingEl.remove(), 200); }, 5000);
      }
    }, 3000);
  } catch {
    loadingEl.remove();
    toast('Promote failed', 'error');
  }
}
