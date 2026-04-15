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
