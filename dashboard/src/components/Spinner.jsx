/**
 * Spinner — Animated SVG loading indicator.
 * @param {'sm'|'md'|'lg'|number} [size='md'] - Preset (16/20/24px) or explicit pixel size
 * @param {string} [className] - Extra classes
 * @example <Spinner size="sm" />
 * @example <Spinner size={16} />
 */
const sizes = {
  sm: 'w-4 h-4',
  md: 'w-5 h-5',
  lg: 'w-6 h-6',
};

export default function Spinner({ size = 'md', className = '' }) {
  const numeric = typeof size === 'number';
  if (!numeric && !sizes[size] && import.meta.env?.DEV) {
    console.warn(`[Spinner] unknown size "${size}" — falling back to md`);
  }
  return (
    <svg
      className={[
        'animate-spin text-muted',
        numeric ? '' : (sizes[size] || sizes.md),
        className,
      ].join(' ')}
      style={numeric ? { width: size, height: size } : undefined}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle
        className="opacity-25"
        cx="12" cy="12" r="10"
        stroke="currentColor" strokeWidth="3"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}
