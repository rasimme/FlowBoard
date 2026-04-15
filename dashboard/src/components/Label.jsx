/**
 * Label — Form label with optional required-field asterisk.
 * @param {string} [htmlFor] - Associated input ID
 * @param {boolean} [required] - Show red asterisk
 * @param {string} [className] - Extra classes
 * @param {ReactNode} children - Label text
 * @example <Label htmlFor="email" required>Email</Label>
 */
export default function Label({
  htmlFor,
  required,
  className = '',
  children,
  ...props
}) {
  return (
    <label
      htmlFor={htmlFor}
      className={[
        'block text-xs font-medium text-muted mb-1',
        className,
      ].join(' ')}
      {...props}
    >
      {children}
      {required && <span className="text-danger ml-0.5">*</span>}
    </label>
  );
}
