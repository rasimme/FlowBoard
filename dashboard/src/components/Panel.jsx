import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

export default function Panel({
  title,
  subtitle,
  collapsible = false,
  defaultCollapsed = false,
  className = '',
  children,
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  return (
    <div
      className={[
        'bg-card border border-border rounded-md shadow-md',
        className,
      ].join(' ')}
    >
      <div
        className={[
          'flex items-center justify-between gap-3 px-5 py-3',
          collapsible ? 'cursor-pointer select-none' : '',
        ].join(' ')}
        onClick={collapsible ? () => setCollapsed((c) => !c) : undefined}
      >
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-text-strong m-0 leading-snug">
            {title}
          </h3>
          {subtitle && (
            <p className="text-xs text-muted m-0 mt-0.5 leading-snug">
              {subtitle}
            </p>
          )}
        </div>
        {collapsible && (
          <span className="shrink-0 text-muted">
            {collapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
          </span>
        )}
      </div>
      {!collapsed && (
        <div className="px-5 pb-4 border-t border-border pt-3">{children}</div>
      )}
    </div>
  );
}
