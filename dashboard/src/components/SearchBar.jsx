import { forwardRef } from 'react';
import { Search, X } from 'lucide-react';

/**
 * SearchBar — Text input with search icon and clearable value.
 * @param {string} value - Current search text
 * @param {function} onChange - Input change handler
 * @param {function} [onClear] - Custom clear handler (defaults to empty onChange)
 * @param {string} [placeholder='Search…'] - Placeholder text
 * @param {string} [className] - Extra classes
 * @param {Ref} ref - Forwarded ref
 * @example <SearchBar value={q} onChange={setQ} placeholder="Search tasks…" />
 */
const SearchBar = forwardRef(function SearchBar({
  value,
  onChange,
  onClear,
  placeholder = 'Search…',
  className = '',
  ...props
}, ref) {
  return (
    <div className={['relative', className].join(' ')}>
      <Search
        size={14}
        className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none"
      />
      <input
        ref={ref}
        type="text"
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        className={[
          'w-full pl-8 pr-8 py-2 text-sm rounded-lg',
          'bg-bg-elevated text-text border border-border',
          'placeholder:text-muted',
          'outline-none focus:border-accent-subtle focus:shadow-focus-accent',
          'transition-colors duration-fast',
        ].join(' ')}
        {...props}
      />
      {value && (
        <button
          type="button"
          onClick={onClear || (() => onChange?.({ target: { value: '' } }))}
          className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded-sm text-muted hover:text-text transition-colors duration-fast cursor-pointer bg-transparent border-0"
          aria-label="Clear search"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
});

export default SearchBar;
