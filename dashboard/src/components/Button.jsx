const variants = {
  primary: 'bg-accent text-white hover:brightness-110',
  secondary: 'bg-[var(--secondary)] text-[var(--text)] hover:bg-[var(--bg-hover)]',
  danger: 'bg-danger text-white hover:brightness-110',
  ghost: 'bg-transparent text-[var(--text)] hover:bg-[var(--bg-hover)]',
};

const sizes = {
  sm: 'px-2.5 py-1 text-xs',
  md: 'px-3.5 py-1.5 text-sm',
  lg: 'px-5 py-2 text-base',
};

export default function Button({
  variant = 'primary',
  size = 'md',
  type = 'button',
  className = '',
  children,
  ...props
}) {
  return (
    <button
      type={type}
      className={[
        'inline-flex items-center justify-center gap-1.5 rounded-[var(--radius-md)]',
        'font-medium transition-all duration-[var(--duration-fast)] cursor-pointer',
        'border-0 outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        variants[variant],
        sizes[size],
        className,
      ].join(' ')}
      {...props}
    >
      {children}
    </button>
  );
}
