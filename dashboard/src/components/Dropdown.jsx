import { useState, useRef, useEffect } from 'react';
import { ChevronDown } from 'lucide-react';

export default function Dropdown({
  value,
  onChange,
  options = [],
  placeholder = 'Select…',
  disabled,
  className = '',
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const selected = options.find((o) => (typeof o === 'object' ? o.value : o) === value);
  const displayLabel = selected
    ? (typeof selected === 'object' ? selected.label : selected)
    : placeholder;

  return (
    <div ref={ref} className={['relative', className].join(' ')}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((p) => !p)}
        className={[
          'w-full flex items-center justify-between gap-2 px-3 py-2 text-sm rounded-md',
          'bg-bg-elevated border border-border text-text',
          'outline-none focus:border-accent-subtle focus:shadow-focus-accent',
          'transition-colors duration-fast cursor-pointer',
          'disabled:opacity-50 disabled:cursor-not-allowed',
          !selected && 'text-muted',
        ].filter(Boolean).join(' ')}
      >
        <span className="truncate">{displayLabel}</span>
        <ChevronDown size={14} className={[
          'text-muted transition-transform duration-fast flex-shrink-0',
          open && 'rotate-180',
        ].join(' ')} />
      </button>

      {open && (
        <ul className="absolute z-50 mt-1 w-full max-h-48 overflow-y-auto rounded-md border border-border bg-bg-elevated shadow-md py-1 list-none m-0 p-0">
          {options.map((opt) => {
            const optValue = typeof opt === 'object' ? opt.value : opt;
            const optLabel = typeof opt === 'object' ? opt.label : opt;
            const isActive = optValue === value;
            return (
              <li
                key={optValue}
                onClick={() => { onChange(optValue); setOpen(false); }}
                className={[
                  'px-3 py-1.5 text-sm cursor-pointer transition-colors duration-fast',
                  isActive ? 'bg-accent-subtle text-accent' : 'text-text hover:bg-bg-hover',
                ].join(' ')}
              >
                {optLabel}
              </li>
            );
          })}
          {options.length === 0 && (
            <li className="px-3 py-1.5 text-sm text-muted">No options</li>
          )}
        </ul>
      )}
    </div>
  );
}
