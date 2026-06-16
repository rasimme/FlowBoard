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
 * directly below).
 *
 * T-409 (review of T-375-3): when the `## Session Log` marker exists, only look
 * for the first `### ` entry AFTER the marker — a `### ` sub-heading inside an
 * earlier entry's body or in pre-marker prose must not pull the insertion point
 * above the Session Log section. Falls back to right-after-marker, then (no
 * marker) before the first `### `, then append.
 */
function insertEntry(content, block) {
  const text = String(content || '');
  const markerIdx = text.indexOf(MARKER);
  if (markerIdx !== -1) {
    const lineEnd = text.indexOf('\n', markerIdx);
    const scanFrom = lineEnd === -1 ? text.length : lineEnd + 1;
    const rel = text.slice(scanFrom).search(/^### /m);
    if (rel !== -1) {
      const at = scanFrom + rel;
      return text.slice(0, at) + block + '\n' + text.slice(at);
    }
    return text.slice(0, scanFrom) + '\n' + block + text.slice(scanFrom);
  }
  const h3 = text.search(/^### /m);
  if (h3 !== -1) {
    return text.slice(0, h3) + block + '\n' + text.slice(h3);
  }
  return text + (text.endsWith('\n') || text === '' ? '' : '\n') + '\n' + block;
}

module.exports = { formatSessionEntry, insertEntry };
