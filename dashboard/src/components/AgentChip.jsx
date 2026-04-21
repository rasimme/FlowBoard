/**
 * Agent identity primitives.
 *
 * AGENT_PALETTE: 8 deliberately muted, dark-theme-safe tones. Kept separate
 * from status colors (green/yellow/orange/red/blue) so agent identity never
 * reads as a warning, OK, or danger signal.
 *
 * agentColor(name): deterministic djb2-style hash → palette index. Same name
 * always resolves to the same tone across sessions, projects, users.
 *
 * AgentChip: the core identity atom (xs/sm/md/lg, solid/soft/ring).
 * AgentChipStack: overlapping chips for multi-agent contexts (never sidebar).
 */

export const AGENT_PALETTE = [
  { name: 'slate',      bg: '#5b6b82', fg: '#e6ecf5', soft: 'rgba(91,107,130,0.18)',  ring: '#7d8da6' },
  { name: 'teal',       bg: '#3e7a78', fg: '#dff0ee', soft: 'rgba(62,122,120,0.18)',  ring: '#5a9694' },
  { name: 'periwinkle', bg: '#6b6fa8', fg: '#e7e8f7', soft: 'rgba(107,111,168,0.18)', ring: '#8a8fc5' },
  { name: 'sage',       bg: '#607a5c', fg: '#e2ecde', soft: 'rgba(96,122,92,0.18)',   ring: '#7f997a' },
  { name: 'plum',       bg: '#7e5a7a', fg: '#efe2ed', soft: 'rgba(126,90,122,0.18)',  ring: '#9d7899' },
  { name: 'bronze',     bg: '#8a6a4a', fg: '#f2e6d6', soft: 'rgba(138,106,74,0.18)',  ring: '#a88968' },
  { name: 'steel',      bg: '#4e6e7a', fg: '#dfe9ee', soft: 'rgba(78,110,122,0.18)',  ring: '#6d8b97' },
  { name: 'dusk',       bg: '#6a5f82', fg: '#ebe6f2', soft: 'rgba(106,95,130,0.18)',  ring: '#897ea3' },
];

export function agentHash(name) {
  let h = 5381;
  const s = String(name || '');
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h;
}

export function agentColor(name) {
  return AGENT_PALETTE[agentHash(name) % AGENT_PALETTE.length];
}

// "@dev-botti" → "DB", "@claude" → "CL", "alex" → "AL"
export function agentInitials(name) {
  const clean = String(name || '').replace(/^@/, '');
  const parts = clean.split(/[-_.\s]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  if (clean.length >= 2) return clean.slice(0, 2).toUpperCase();
  return (clean[0] || '?').toUpperCase();
}

const SIZE_DIM = { xs: 16, sm: 20, md: 24, lg: 32 };
const SIZE_FONT = { xs: 8, sm: 9.5, md: 11, lg: 13 };

export default function AgentChip({
  name,
  size = 'sm',
  variant = 'solid',
  showName = false,
  title,
  style,
}) {
  const c = agentColor(name);
  const dims = SIZE_DIM[size] ?? SIZE_DIM.sm;
  const font = SIZE_FONT[size] ?? SIZE_FONT.sm;

  let bg;
  let fg;
  let border = 'none';
  if (variant === 'soft') {
    bg = c.soft;
    fg = c.ring;
  } else if (variant === 'ring') {
    bg = 'transparent';
    fg = c.ring;
    border = `1.5px solid ${c.ring}`;
  } else {
    bg = c.bg;
    fg = c.fg;
  }

  const chip = (
    <span
      title={title ?? name}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: dims,
        height: dims,
        borderRadius: '50%',
        background: bg,
        color: fg,
        border,
        fontSize: font,
        fontWeight: 600,
        letterSpacing: 0.2,
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        flexShrink: 0,
        userSelect: 'none',
        lineHeight: 1,
        ...(style || {}),
      }}
    >
      {agentInitials(name)}
    </span>
  );

  if (!showName) return chip;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      {chip}
      <span style={{ fontSize: 12, color: 'var(--text)', fontFamily: '"JetBrains Mono", monospace' }}>
        {String(name).startsWith('@') ? name : `@${name}`}
      </span>
    </span>
  );
}

export function AgentChipStack({ names, max = 3, size = 'sm', variant = 'solid' }) {
  const shown = names.slice(0, max);
  const overflow = names.length - shown.length;
  const dims = SIZE_DIM[size] ?? SIZE_DIM.sm;
  const font = SIZE_FONT[size] ?? SIZE_FONT.sm;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center' }}>
      {shown.map((n, i) => (
        <span
          key={n}
          style={{
            marginLeft: i === 0 ? 0 : -6,
            display: 'inline-flex',
            borderRadius: '50%',
            boxShadow: '0 0 0 2px var(--bg)',
          }}
        >
          <AgentChip name={n} size={size} variant={variant} />
        </span>
      ))}
      {overflow > 0 && (
        <span
          style={{
            marginLeft: -6,
            width: dims,
            height: dims,
            borderRadius: '50%',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--secondary)',
            color: 'var(--muted)',
            fontSize: font,
            fontWeight: 600,
            boxShadow: '0 0 0 2px var(--bg)',
          }}
        >
          +{overflow}
        </span>
      )}
    </span>
  );
}
