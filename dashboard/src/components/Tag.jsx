import { X } from 'lucide-react';

const variants = {
  default: 'bg-bg-elevated text-text border-border',
  accent: 'bg-accent-subtle text-accent border-accent-subtle',
  success: 'bg-ok-subtle text-ok border-ok-subtle',
  warning: 'bg-warn-subtle text-warn border-warn-subtle',
  danger: 'bg-danger-subtle text-danger border-danger-subtle',
  info: 'bg-info-subtle text-info border-info-subtle',
};

export default function Tag({
  variant = 'default',
  onRemove,
  className = '',
  children,
  ...props
}) {
  return (
    <span
      className={[
        'inline-flex items-center gap-1 px-2 py-0.5 text-[12px] font-medium rounded-sm border',
        variants[variant],
        className,
      ].join(' ')}
      {...props}
    >
      {children}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full hover:bg-bg-hover transition-colors duration-fast cursor-pointer bg-transparent border-0 p-0 text-current"
          aria-label="Remove"
        >
          <X size={10} />
        </button>
      )}
    </span>
  );
}
