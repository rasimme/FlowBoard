import Label from './Label.jsx';

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
