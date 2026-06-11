import { forwardRef } from 'react';

/**
 * Input — Themed text input with focus ring and placeholder styling.
 * @param {string} [className] - Extra classes
 * @param {Ref} ref - Forwarded ref
 * @example <Input placeholder="Enter name…" value={v} onChange={handleChange} />
 */
const sizes = {
  sm: 'h-[28px] px-2 text-[11px] rounded-md',
  md: 'px-3 py-2 text-sm rounded-lg',
};

const Input = forwardRef(function Input({
  size = 'md',
  className = '',
  ...props
}, ref) {
  return (
    <input
      ref={ref}
      className={[
        'w-full font-sans',
        sizes[size] || sizes.md,
        'bg-bg text-text border border-solid border-border appearance-none',
        'placeholder:text-muted',
        'outline-none focus:border-accent',
        'transition-colors duration-fast',
        className,
      ].join(' ')}
      {...props}
    />
  );
});

export default Input;
