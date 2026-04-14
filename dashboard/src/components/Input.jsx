import { forwardRef } from 'react';

const Input = forwardRef(function Input({
  className = '',
  ...props
}, ref) {
  return (
    <input
      ref={ref}
      className={[
        'w-full px-3 py-2 text-sm rounded-md',
        'bg-bg-elevated text-text border border-border',
        'placeholder:text-muted',
        'outline-none focus:border-accent/50 focus:shadow-focus-accent',
        'transition-colors duration-fast',
        className,
      ].join(' ')}
      {...props}
    />
  );
});

export default Input;
