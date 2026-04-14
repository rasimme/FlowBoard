const variants = {
  default: 'bg-bg-elevated text-muted',
  accent: 'bg-accent-subtle text-accent',
  success: 'bg-ok-subtle text-ok',
  warning: 'bg-warn-subtle text-warn',
  danger: 'bg-danger-subtle text-danger',
  info: 'bg-info-subtle text-info',
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
        'inline-flex items-center px-[11px] py-[5px] text-[12px] font-medium rounded-full',
        variants[variant],
        className,
      ].join(' ')}
      {...props}
    >
      {children}
    </span>
  );
}
