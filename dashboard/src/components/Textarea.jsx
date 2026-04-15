import { forwardRef } from 'react';

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
        'w-full px-3 py-2 text-sm rounded-md resize-y',
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

export default Textarea;
