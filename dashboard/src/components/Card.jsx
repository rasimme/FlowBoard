/**
 * Card — Container with optional header/body/footer sections.
 * @param {string} [title] - Header title
 * @param {string} [subtitle] - Header subtitle
 * @param {ReactNode} [actions] - Header action buttons
 * @param {ReactNode} [footer] - Footer content
 * @param {string} [className] - Extra classes
 * @param {ReactNode} children - Body content
 * @example <Card title="Task" footer={<Button>Action</Button>}>Body</Card>
 */
export default function Card({
  title,
  subtitle,
  actions,
  footer,
  className = '',
  children,
}) {
  return (
    <div
      className={[
        'bg-card border border-border rounded-md shadow-md overflow-hidden',
        className,
      ].join(' ')}
    >
      {(title || subtitle || actions) && (
        <div className="flex items-start justify-between gap-3 px-4 pt-4 pb-0">
          <div className="min-w-0">
            {title && (
              <h3 className="text-sm font-semibold text-text-strong m-0 leading-snug">
                {title}
              </h3>
            )}
            {subtitle && (
              <p className="text-xs text-muted m-0 mt-0.5 leading-snug">
                {subtitle}
              </p>
            )}
          </div>
          {actions && <div className="flex items-center gap-1.5 shrink-0">{actions}</div>}
        </div>
      )}
      <div className="px-4 py-3">{children}</div>
      {footer && (
        <div className="px-4 py-3 border-t border-border">{footer}</div>
      )}
    </div>
  );
}
