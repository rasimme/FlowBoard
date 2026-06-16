import { Info, AlertTriangle, CheckCircle, XCircle, X } from 'lucide-react';

const variantConfig = {
  info: {
    icon: Info,
    classes: 'bg-info-subtle text-info border-info',
  },
  warn: {
    icon: AlertTriangle,
    classes: 'bg-warn-subtle text-warn border-warn',
  },
  success: {
    icon: CheckCircle,
    classes: 'bg-ok-subtle text-ok border-ok',
  },
  error: {
    icon: XCircle,
    classes: 'bg-danger-subtle text-danger border-danger',
  },
};

/**
 * Alert — Themed notification banner with icon, dismiss button, and action slot.
 * @param {'info'|'warn'|'success'|'error'} [variant='info'] - Semantic color variant
 * @param {string} [title] - Bold title line
 * @param {ReactNode} [action] - Action element (right side)
 * @param {function} [onDismiss] - Shows dismiss X when provided
 * @param {string} [className] - Extra classes
 * @param {ReactNode} children - Alert message body
 * @example <Alert variant="error" title="Oops" onDismiss={close}>Failed.</Alert>
 */
export default function Alert({
  variant = 'info',
  title,
  children,
  action,
  onDismiss,
  className = '',
}) {
  const config = variantConfig[variant] || variantConfig.info;
  const Icon = config.icon;

  return (
    <div
      role="alert"
      className={[
        'flex items-start gap-3 rounded-lg border px-4 py-3',
        config.classes,
        className,
      ].join(' ')}
    >
      <Icon size={16} className="shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0 text-sm">
        {title && <div className="font-semibold mb-0.5">{title}</div>}
        <div className="opacity-90">{children}</div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 bg-transparent border-0 p-0 cursor-pointer text-current opacity-60 hover:opacity-100 transition-opacity duration-fast"
          aria-label="Dismiss"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}
