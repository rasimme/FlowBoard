import { Lock } from 'lucide-react';

/**
 * BlockedChip — small pill shown in the task Meta-Row when `task.blocked`
 * is true. Replaces the earlier inline "Blocked" text label that truncated
 * the title on narrow cards.
 *
 * Design matches the `AxBlockedChip` from the Claude-Design handoff bundle
 * (ax-section5 § Blocked): slate-tinted neutral pill with a lock icon.
 * Deliberately not using the warn/danger palette — blocked is a persistent
 * context signal, not an acute warning.
 *
 * The `count` prop is reserved for dependency-based blockers (T-154);
 * while only the bool `task.blocked` exists, the chip reads "blocked".
 */
export default function BlockedChip({ count, className = '' }) {
  const label = typeof count === 'number' && count > 0 ? `blocked × ${count}` : 'blocked';
  return (
    <span
      className={[
        'inline-flex items-center gap-[4px]',
        'px-[8px] py-[2px] rounded-full',
        'bg-[rgba(100,116,139,0.18)] text-[#94a3b8]',
        'text-[10px] font-medium',
        className,
      ].filter(Boolean).join(' ')}
      title={label}
    >
      <Lock size={9} strokeWidth={2.5} />
      {label}
    </span>
  );
}
