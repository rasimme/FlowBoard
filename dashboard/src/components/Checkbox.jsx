import { Check } from 'lucide-react';

export default function Checkbox({
  checked,
  onChange,
  label,
  disabled,
  className = '',
  ...props
}) {
  return (
    <label
      className={[
        'inline-flex items-center gap-2 text-sm text-text cursor-pointer select-none',
        disabled && 'opacity-50 cursor-not-allowed',
        className,
      ].filter(Boolean).join(' ')}
    >
      <span
        className={[
          'inline-flex items-center justify-center w-4 h-4 rounded-sm border transition-colors duration-fast',
          checked
            ? 'bg-accent border-accent text-white'
            : 'bg-bg-elevated border-border hover:border-border-strong',
        ].join(' ')}
      >
        {checked && <Check size={12} strokeWidth={2.5} />}
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        className="sr-only"
        {...props}
      />
      {label && <span>{label}</span>}
    </label>
  );
}
