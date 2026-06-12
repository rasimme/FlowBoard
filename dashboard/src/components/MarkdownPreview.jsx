import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';

// `breaks` renders single newlines as line breaks (scratchpad semantics,
// used by the overview notes widget) — file previews keep strict markdown.
export default function MarkdownPreview({ content, breaks = false }) {
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
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
