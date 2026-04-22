import { forwardRef } from 'react';

/**
 * Textarea — Multi-line text input with themed styling and resizable handle.
 * @param {number} [rows=3] - Visible rows
 * @param {string} [className] - Extra classes
 * @param {Ref} ref - Forwarded ref
 * @example <Textarea placeholder="Notes…" rows={4} />
 */
const Textarea = forwardRef(function Textarea({
  className = '',
  rows = 3,
  ...props
}, ref) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      className={[
        'w-full px-3 py-2 text-sm rounded-lg resize-none',
        'bg-bg text-text border border-border appearance-none',
        'placeholder:text-muted',
        'outline-none focus:border-accent',
        'transition-colors duration-fast',
        className,
      ].join(' ')}
      {...props}
    />
  );
});

export default Textarea;
