import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';

// T-380: tag block elements with their markdown source line so a click/selection
// in the rendered preview can be mapped back to the source (Notes widget).
const SOURCE_TAGS = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'pre', 'td', 'th'];
function withSourceline(Tag) {
  return function SourcedBlock({ node, children, ...props }) {
    const line = node?.position?.start?.line;
    return <Tag {...props} data-sourceline={line ?? undefined}>{children}</Tag>;
  };
}
const SOURCE_COMPONENTS = Object.fromEntries(SOURCE_TAGS.map(t => [t, withSourceline(t)]));

// `breaks` renders single newlines as line breaks (scratchpad semantics,
// used by the overview notes widget) — file previews keep strict markdown.
// `trackSource` adds data-sourceline attributes (opt-in; off by default).
export default function MarkdownPreview({ content, breaks = false, trackSource = false }) {
  return (
    <div className="md-content">
      <ReactMarkdown
        remarkPlugins={breaks ? [remarkGfm, remarkBreaks] : [remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={{
          a({ href, children, ...props }) {
            return (
              <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
                {children}
              </a>
            );
          },
          ...(trackSource ? SOURCE_COMPONENTS : {}),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
