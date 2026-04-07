import { forwardRef } from 'react';

const Input = forwardRef(function Input({
  className = '',
  ...props
}, ref) {
  return (
    <input
      ref={ref}
      className={[
        'w-full px-3 py-2 text-sm rounded-[var(--radius-md)]',
        'bg-[var(--secondary)] text-[var(--text)] border border-[var(--border)]',
        'placeholder:text-[var(--muted)]',
        'outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/30',
        'transition-colors duration-[var(--duration-fast)]',
        className,
      ].join(' ')}
      {...props}
    />
  );
});

export default Input;
