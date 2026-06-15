'use strict';

/**
 * T-375-3 — SESSIONS.md entry formatting + insertion (pure, file-agnostic).
 *
 * SESSIONS.md is an append-only, newest-first session timeline. New entries are
 * inserted directly under the `## Session Log` header; older entries are never
 * edited. The HTTP layer (POST /api/projects/:name/sessions) handles file I/O,
 * validation and header bootstrap.
 */

const MARKER = '## Session Log';

/** Build one dated session entry block. Heading uses `title` if given, else the agent id. */
function formatSessionEntry({ date, agent, summary, title }) {
  const heading = `### ${date} — ${title || agent}`;
  return `${heading}\n\n${String(summary || '').trim()}\n`;
}

/**
 * Insert an entry newest-first. Robust across both SESSIONS.md shapes in the
 * wild (`## Session Log` marker, or scaffolded `# Sessions — X` with entries
 * directly below): insert before the first existing `### ` entry; else after
 * the marker; else append.
 */
function insertEntry(content, block) {
  const text = String(content || '');
  const h3 = text.match(/^### /m);
  if (h3 && h3.index !== undefined) {
    return text.slice(0, h3.index) + block + '\n' + text.slice(h3.index);
  }
  const idx = text.indexOf(MARKER);
  if (idx !== -1) {
    const lineEnd = text.indexOf('\n', idx);
    const insertAt = lineEnd === -1 ? text.length : lineEnd + 1;
    return text.slice(0, insertAt) + '\n' + block + text.slice(insertAt);
  }
  return text + (text.endsWith('\n') || text === '' ? '' : '\n') + '\n' + block;
}

module.exports = { formatSessionEntry, insertEntry, MARKER };
