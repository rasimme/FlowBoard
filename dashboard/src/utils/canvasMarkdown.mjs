// Note markdown subset — extracted 1:1 from js/canvas/notes.js and
// js/utils.js escHtml (T-340-1). This renderer is deliberately NOT the
// dashboard MarkdownPreview: notes support only bold, italic, links,
// auto-linked URLs, dash/numbered lists and blank-line breaks, with
// HTML escaped before markdown is applied.

export function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Escape a string for safe interpolation inside a double-quoted HTML attribute.
// A stray `"` here is what previously let note text break out of href="…" and
// inject an event handler (stored XSS, T-355).
function escAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderNoteMarkdown(text) {
  if (!text) return '';
  // Process line by line so list items stay together, plain lines use <br>
  const lines = text.split('\n');
  const out = [];
  let inList = false; // false | 'ul' | 'ol'
  for (let i = 0; i < lines.length; i++) {
    // Escape HTML first, then apply markdown (safe order: patterns like ** and [] survive escaping)
    let line = escHtml(lines[i]);
    // Bold
    line = line.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // Italic
    line = line.replace(/\*(.+?)\*/g, '<em>$1</em>');
    // Strip remaining unpaired/empty markers and empty tags
    line = line.replace(/\*+/g, '');
    line = line.replace(/<(strong|em)><\/\1>/g, '');
    // Explicit markdown links [label](url). The url still carries escHtml
    // encoding; decode it only to inspect the real scheme. A non-http(s) scheme
    // is forced under https:// (so a `javascript:`/`data:` link becomes an inert
    // https URL, not an executable one), and the final href is ATTRIBUTE-escaped
    // so a `"` in the note can never close href="…" and inject an event handler
    // (stored XSS, T-355). escAttr re-encodes the decoded value safely.
    line = line.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
      const rawUrl = url.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
      const href = /^https?:\/\//i.test(rawUrl) ? rawUrl : 'https://' + rawUrl;
      return `<a href="${escAttr(href)}" target="_blank" rel="noopener">${label}</a>`;
    });
    // Auto-link bare URLs — only in text segments outside HTML tags. The URL
    // pattern already excludes quotes/angle brackets, but escAttr the href too
    // for a valid, consistently-escaped attribute (e.g. stray `&`).
    line = line.replace(/(<[^>]*>)|(?:https?:\/\/[^\s<>"]+|www\.[^\s<>"]+)/g, (match, tag) => {
      if (tag) return tag; // HTML tag — pass through unchanged
      const href = match.startsWith('http') ? match : 'https://' + match;
      return `<a href="${escAttr(href)}" target="_blank" rel="noopener">${match}</a>`;
    });
    const numListMatch = line.match(/^\d+\. (.*)/);
    if (line.startsWith('- ')) {
      if (inList === 'ol') { out.push('</ol>'); inList = false; }
      if (!inList) { out.push('<ul>'); inList = 'ul'; }
      out.push('<li>' + line.slice(2) + '</li>');
    } else if (numListMatch) {
      if (inList === 'ul') { out.push('</ul>'); inList = false; }
      if (!inList) { out.push('<ol>'); inList = 'ol'; }
      out.push('<li>' + numListMatch[1] + '</li>');
    } else {
      if (inList === 'ul') { out.push('</ul>'); inList = false; }
      if (inList === 'ol') { out.push('</ol>'); inList = false; }
      if (line === '') {
        out.push('<br>');
      } else {
        out.push(line + (i < lines.length - 1 ? '<br>' : ''));
      }
    }
  }
  if (inList === 'ul') out.push('</ul>'); if (inList === 'ol') out.push('</ol>');
  return out.join('');
}
