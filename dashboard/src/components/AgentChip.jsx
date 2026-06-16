/**
 * Agent identity primitives.
 *
 * AGENT_PALETTE: 8 deliberately muted, dark-theme-safe tones from the shared
 * --hue-1..8 design tokens. Kept separate from status colors so agent identity
 * never reads as a warning, OK, or danger signal.
 *
 * agentColor(name): deterministic djb2-style hash → palette index. Same name
 * always resolves to the same tone across sessions, projects, users.
 *
 * AgentChip: the core identity atom (xs/sm/md/lg, solid/soft/ring).
 * AgentChipStack: overlapping chips for multi-agent contexts (never sidebar).
 */

export const AGENT_PALETTE = [
  { name: 'slate',      bg: 'var(--hue-1)', fg: 'var(--hue-1-fg)', soft: 'var(--hue-1-soft)', ring: 'var(--hue-1-ring)', ringSoft: 'var(--hue-1-ring-soft)' },
  { name: 'teal',       bg: 'var(--hue-2)', fg: 'var(--hue-2-fg)', soft: 'var(--hue-2-soft)', ring: 'var(--hue-2-ring)', ringSoft: 'var(--hue-2-ring-soft)' },
  { name: 'periwinkle', bg: 'var(--hue-3)', fg: 'var(--hue-3-fg)', soft: 'var(--hue-3-soft)', ring: 'var(--hue-3-ring)', ringSoft: 'var(--hue-3-ring-soft)' },
  { name: 'sage',       bg: 'var(--hue-4)', fg: 'var(--hue-4-fg)', soft: 'var(--hue-4-soft)', ring: 'var(--hue-4-ring)', ringSoft: 'var(--hue-4-ring-soft)' },
  { name: 'plum',       bg: 'var(--hue-5)', fg: 'var(--hue-5-fg)', soft: 'var(--hue-5-soft)', ring: 'var(--hue-5-ring)', ringSoft: 'var(--hue-5-ring-soft)' },
  { name: 'bronze',     bg: 'var(--hue-6)', fg: 'var(--hue-6-fg)', soft: 'var(--hue-6-soft)', ring: 'var(--hue-6-ring)', ringSoft: 'var(--hue-6-ring-soft)' },
  { name: 'steel',      bg: 'var(--hue-7)', fg: 'var(--hue-7-fg)', soft: 'var(--hue-7-soft)', ring: 'var(--hue-7-ring)', ringSoft: 'var(--hue-7-ring-soft)' },
  { name: 'dusk',       bg: 'var(--hue-8)', fg: 'var(--hue-8-fg)', soft: 'var(--hue-8-soft)', ring: 'var(--hue-8-ring)', ringSoft: 'var(--hue-8-ring-soft)' },
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
  pulse = false,
  pulseDelay = null,
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
        position: 'relative',
        zIndex: 1,
        ...(style || {}),
      }}
    >
      {agentInitials(name)}
    </span>
  );

  // Wrap with a pulsing halo when the task is actively claimed. Caller passes
  // pulse={isActivelyClaimed(task)} so the chip itself doesn't need to know
  // about the task model.
  const visible = pulse
    ? (
      <span
        className="agent-chip-pulse-wrap"
        style={{
          ['--agent-pulse-color']: c.ring,
          ...(pulseDelay !== null ? { ['--agent-pulse-delay']: pulseDelay } : {}),
        }}
      >
        <span className="agent-chip-pulse-halo" aria-hidden="true" />
        {chip}
      </span>
    )
    : chip;

  if (!showName) return visible;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      {visible}
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
