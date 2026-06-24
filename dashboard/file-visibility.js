'use strict';

/**
 * T-375-1 — Project file-editor visibility allowlist.
 *
 * The file editor surfaces the *knowledge layer* only: Markdown documents
 * (PROJECT.md, SESSIONS.md, DECISIONS.md, context/*.md, specs/*.md). Everything
 * else — operational JSON (overview.json, specs/_index.json, canvas.json) and
 * migration/backup/tmp artifacts (*.pre-db.bak, *.migrated, *.tmp) — is hidden
 * by default so the tree stays clean and the root doesn't accumulate clutter.
 * Hidden files remain reachable via `?includeHidden=true`.
 *
 * @param {string} relPath project-relative path
 * @returns {boolean} true if the file should appear in the editor by default
 */
function isEditorVisible(relPath) {
  const normalized = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (/^(PROJECT|SESSIONS|DECISIONS)\.md$/i.test(normalized)) return true;
  if (/^context\/[^/]+\.md$/i.test(normalized)) return true;
  if (/^specs\/[^/]+\.md$/i.test(normalized)) return true;
  return false;
}

module.exports = { isEditorVisible };
