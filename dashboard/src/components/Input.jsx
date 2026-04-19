import { forwardRef } from 'react';

/**
 * Input — Themed text input with focus ring and placeholder styling.
 * @param {string} [className] - Extra classes
 * @param {Ref} ref - Forwarded ref
 * @example <Input placeholder="Enter name…" value={v} onChange={handleChange} />
 */
const Input = forwardRef(function Input({
  className = '',
  ...props
}, ref) {
  return (
    <input
      ref={ref}
      className={[
        'w-full px-3 py-2 text-sm rounded-lg',
        'bg-bg-elevated text-text border border-border',
        'placeholder:text-muted',
        'outline-none focus:border-accent-subtle focus:shadow-focus-accent',
        'transition-colors duration-fast',
        className,
      ].join(' ')}
      {...props}
    />
  );
});

export default Input;
