import Label from './Label.jsx';

/**
 * FormGroup — Wraps a form control with label, error message, and hint text.
 * @param {string} [label] - Label text
 * @param {string} [htmlFor] - Associated input ID
 * @param {boolean} [required] - Show required asterisk on label
 * @param {string} [error] - Error message (shown in red, replaces hint)
 * @param {string} [hint] - Hint text below input (hidden when error present)
 * @param {string} [className] - Extra classes
 * @param {ReactNode} children - Form control(s)
 * @example <FormGroup label="Email" required error="Required"><Input /></FormGroup>
 */
export default function FormGroup({
  label,
  htmlFor,
  required,
  error,
  hint,
  className = '',
  children,
}) {
  return (
    <div className={['flex flex-col gap-1', className].join(' ')}>
      {label && (
        <Label htmlFor={htmlFor} required={required}>
          {label}
        </Label>
      )}
      {children}
      {error && (
        <span className="text-[11px] text-danger">{error}</span>
      )}
      {!error && hint && (
        <span className="text-[11px] text-muted">{hint}</span>
      )}
    </div>
  );
}
