/**
 * PriorityPill — color-coded priority indicator with optional click action.
 *
 * Styling follows the Claude-Design handoff bundle (ax-section5 §
 * AxPriorityPill): subtle tinted pill with lowercase label.
 *
 *   low    → slate-tinted (neutral, not ok-green; avoids overlap with
 *            the ok/status palette)
 *   medium → amber-tinted
 *   high   → red-tinted
 *
 * @param {'high'|'medium'|'low'} priority
 * @param {function} [onClick] — makes the pill clickable (button vs span)
 * @param {string} [className] — extra classes
 */
const styles = {
  low:    { color: '#64748b', bg: 'rgba(100,116,139,0.15)' },
  medium: { color: '#f59e0b', bg: 'rgba(245,158,11,0.15)' },
  high:   { color: '#ef4444', bg: 'rgba(239,68,68,0.15)' },
};

export default function PriorityPill({ priority, onClick, className = '' }) {
  const Tag = onClick ? 'button' : 'span';
  const s = styles[priority] || styles.medium;
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={[
        'inline-flex items-center px-[8px] py-[2px]',
        'text-[10px] font-medium tracking-normal lowercase',
        'rounded-full border-0',
        'transition-colors duration-fast',
        onClick && 'cursor-pointer',
        className,
      ].filter(Boolean).join(' ')}
      style={{ color: s.color, background: s.bg }}
    >
      {priority}
    </Tag>
  );
}
