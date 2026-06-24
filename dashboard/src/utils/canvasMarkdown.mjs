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

const MARKDOWN_ELEMENT_TAGS = new Set(['strong', 'em', 'a', 'ul', 'ol', 'li']);
const MARKDOWN_ATTRS_BY_TAG = {
  a: new Set(['href', 'target', 'rel']),
};

function decodeHtmlEntities(s) {
  return String(s)
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

function safeParsedHref(rawHref) {
  if (!rawHref) return '';
  return /^https?:\/\//i.test(rawHref) ? rawHref : 'https://' + rawHref;
}

// Parse the limited HTML string produced by renderNoteMarkdown into a structured
// representation for React rendering. Unknown tags are treated as text so this
// parser is not another generic HTML injection surface.
export function parseMarkdownHtml(html) {
  if (!html) return [];

  const elements = [];
  let i = 0;
  let elementKey = 0;

  // Simple HTML parser that builds React-compatible structure
  function parseNode() {
    if (i >= html.length) return null;

    // Text node
    if (html[i] !== '<') {
      const nextTag = html.indexOf('<', i);
      const text = nextTag === -1 ? html.slice(i) : html.slice(i, nextTag);
      i += text.length;
      return text.length > 0 ? decodeHtmlEntities(text) : null;
    }

    // Tag
    const tagEnd = html.indexOf('>', i);
    if (tagEnd === -1) {
      i = html.length;
      return null;
    }

    const tagContent = html.slice(i + 1, tagEnd);

    // Self-closing <br>
    if (tagContent === 'br') {
      i = tagEnd + 1;
      return { type: 'br', key: `mk-${elementKey++}` };
    }

    // Opening tag with optional attributes
    const tagMatch = tagContent.match(/^([a-z]+)([\s\S]*)$/i);
    if (!tagMatch) {
      i = tagEnd + 1;
      return null;
    }

    const tagName = tagMatch[1].toLowerCase();
    const attrStr = tagMatch[2].trim();

    if (!MARKDOWN_ELEMENT_TAGS.has(tagName)) {
      const rawStart = i;
      i = tagEnd + 1;
      const closingTag = `</${tagName}>`;
      const closeIdx = html.toLowerCase().indexOf(closingTag, i);
      if (closeIdx !== -1) {
        i = closeIdx + closingTag.length;
        return decodeHtmlEntities(html.slice(rawStart, i));
      }
      return decodeHtmlEntities(html.slice(rawStart, tagEnd + 1));
    }

    // Parse only the attributes emitted by renderNoteMarkdown.
    const attrs = {};
    const allowedAttrs = MARKDOWN_ATTRS_BY_TAG[tagName] || new Set();
    if (attrStr) {
      const attrRegex = /(\w+)="([^"]*)"/g;
      let match;
      while ((match = attrRegex.exec(attrStr)) !== null) {
        const attrName = match[1];
        if (!allowedAttrs.has(attrName)) continue;
        attrs[attrName] = decodeHtmlEntities(match[2]);
      }
    }
    if (tagName === 'a' && attrs.href) {
      attrs.href = safeParsedHref(attrs.href);
      attrs.target = attrs.target || '_blank';
      attrs.rel = attrs.rel || 'noopener';
    }

    i = tagEnd + 1;

    // Find closing tag and collect children
    const children = [];
    const closingTag = `</${tagName}>`;
    while (i < html.length) {
      if (html.slice(i, i + closingTag.length) === closingTag) {
        i += closingTag.length;
        break;
      }
      const child = parseNode();
      if (child !== null) {
        children.push(child);
      }
    }

    return {
      type: 'element',
      tagName,
      attrs,
      children,
      key: `mk-${elementKey++}`,
    };
  }

  while (i < html.length) {
    const node = parseNode();
    if (node !== null) elements.push(node);
  }

  return elements;
}

// Render parsed markdown nodes to React elements.
// Pass React.createElement as the first argument.
export function renderParsedMarkdown(createElement, nodes) {
  if (!nodes || !nodes.length) return null;

  function renderNode(node) {
    if (typeof node === 'string') {
      return node;
    }

    if (node.type === 'br') {
      return createElement('br', { key: node.key });
    }

    if (node.type === 'element') {
      const { tagName, attrs, children, key } = node;
      const renderedChildren = children.map(renderNode);
      return createElement(tagName, { key, ...attrs }, ...renderedChildren);
    }

    return null;
  }

  const rendered = nodes.map(renderNode).filter(Boolean);
  return rendered.length === 1 ? rendered[0] : rendered;
}
