export default function DataList({
  items = [],
  dense = false,
  className = '',
}) {
  return (
    <dl
      className={[
        'grid grid-cols-[auto_1fr] m-0',
        dense ? 'gap-x-4 gap-y-1' : 'gap-x-6 gap-y-2',
        className,
      ].join(' ')}
    >
      {items.map(({ label, value }, i) => (
        <div key={i} className="contents">
          <dt
            className={[
              'text-muted font-medium',
              dense ? 'text-xs' : 'text-sm',
            ].join(' ')}
          >
            {label}
          </dt>
          <dd
            className={[
              'text-text m-0',
              dense ? 'text-xs' : 'text-sm',
            ].join(' ')}
          >
            {value != null && value !== '' ? value : '—'}
          </dd>
        </div>
      ))}
    </dl>
  );
}
