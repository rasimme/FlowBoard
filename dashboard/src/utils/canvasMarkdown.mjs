// Note markdown subset — extracted 1:1 from js/canvas/notes.js and
// js/utils.js escHtml (T-340-1). This renderer is deliberately NOT the
// dashboard MarkdownPreview: notes support only bold, italic, links,
// auto-linked URLs, dash/numbered lists and blank-line breaks, with
// HTML escaped before markdown is applied.

export function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
    // Explicit markdown links [label](url) — unescape URL for href (& → &amp; is valid in href)
    line = line.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
      // url may have &amp; from escHtml — decode for href
      const rawUrl = url.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
      const href = /^https?:\/\//.test(rawUrl) ? rawUrl : 'https://' + rawUrl;
      return `<a href="${href}" target="_blank" rel="noopener">${label}</a>`;
    });
    // Auto-link bare URLs — only in text segments outside HTML tags
    line = line.replace(/(<[^>]*>)|(?:https?:\/\/[^\s<>"]+|www\.[^\s<>"]+)/g, (match, tag) => {
      if (tag) return tag; // HTML tag — pass through unchanged
      const href = match.startsWith('http') ? match : 'https://' + match;
      return `<a href="${href}" target="_blank" rel="noopener">${match}</a>`;
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
