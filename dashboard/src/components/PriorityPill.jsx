/**
 * PriorityPill — Color-coded priority indicator with optional click action.
 * Unlike Badge (solid bg + text), PriorityPill uses colored border + subtle bg
 * matching the legacy kanban priority-pill pattern.
 * @param {'high'|'medium'|'low'} priority - Priority level
 * @param {function} [onClick] - Makes the pill clickable (button vs span)
 * @param {string} [className] - Extra classes
 * @example <PriorityPill priority="high" />
 * @example <PriorityPill priority="medium" onClick={handleClick} />
 */
const styles = {
  high: 'text-danger border-danger-border bg-danger-subtle',
  medium: 'text-warn border-warn-border bg-warn-subtle',
  low: 'text-ok border-ok-border bg-ok-subtle',
};

export default function PriorityPill({ priority, onClick, className = '' }) {
  const Tag = onClick ? 'button' : 'span';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={[
        'inline-flex items-center px-[10px] py-[4px] text-[11px] font-medium',
        'rounded-full border transition-colors duration-fast',
        onClick && 'cursor-pointer',
        styles[priority] || styles.medium,
        className,
      ].filter(Boolean).join(' ')}
    >
      {priority}
    </Tag>
  );
}
