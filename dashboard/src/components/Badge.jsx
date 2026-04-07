const variants = {
  default: 'bg-[var(--secondary)] text-[var(--muted)]',
  accent: 'bg-[var(--accent-subtle)] text-accent',
  success: 'bg-[var(--ok-subtle)] text-[var(--ok)]',
  warning: 'bg-[var(--warn-subtle)] text-[var(--warn)]',
  danger: 'bg-[var(--danger-subtle)] text-danger',
  info: 'bg-[var(--info-subtle)] text-[var(--info)]',
};

export default function Badge({
  variant = 'default',
  className = '',
  children,
  ...props
}) {
  return (
    <span
      className={[
        'inline-flex items-center px-2 py-0.5 text-xs font-medium rounded-[var(--radius-full)]',
        variants[variant],
        className,
      ].join(' ')}
      {...props}
    >
      {children}
    </span>
  );
}
