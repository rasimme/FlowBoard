const variants = {
  accent: 'bg-accent text-white hover:bg-accent-hover active:bg-accent-hover',
  secondary: 'bg-bg-elevated text-text hover:bg-bg-hover',
  danger: 'bg-danger text-white hover:bg-red-600',
  ghost: [
    'bg-transparent text-text border border-transparent',
    'hover:bg-[#ffffff0f] hover:border-border-strong',
  ].join(' '),
};

const sizes = {
  sm: 'px-[10px] py-[6px] text-[11px]',
  md: 'px-3.5 py-1.5 text-sm',
  lg: 'px-5 py-2 text-base',
  icon: 'w-9 h-9 p-0',
};

export default function Button({
  variant = 'accent',
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
        'inline-flex items-center justify-center gap-1.5 rounded-md',
        'font-medium transition-all duration-fast cursor-pointer',
        'border-0 outline-none focus-visible:shadow-focus-accent',
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
