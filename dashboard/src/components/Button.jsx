/**
 * Button — Themed button with variant, size, and disabled support.
 * @param {'accent'|'secondary'|'danger'|'ghost'} [variant='accent'] - Visual style
 * @param {'xs'|'sm'|'md'|'lg'|'icon'} [size='md'] - Size preset
 * @param {string} [type='button'] - HTML button type
 * @param {string} [className] - Extra classes
 * @param {ReactNode} children - Button content
 * @example <Button variant="danger" size="sm">Delete</Button>
 */
const variants = {
  accent: 'bg-accent text-white hover:bg-accent-hover active:bg-accent-hover',
  secondary: 'bg-bg-elevated text-text hover:bg-bg-hover',
  danger: 'bg-danger text-white hover:brightness-110',
  ghost: [
    'bg-transparent text-text border border-transparent',
    'hover:bg-bg-hover hover:border-border-strong',
  ].join(' '),
};

const sizes = {
  xs: 'h-[24px] px-2.5 text-[11px]',
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
        'inline-flex items-center justify-center gap-1.5 rounded-lg',
        'font-medium transition-all duration-fast cursor-pointer',
        'border-0 outline-none appearance-none focus-visible:shadow-focus-accent',
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
