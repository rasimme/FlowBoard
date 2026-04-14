/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{js,jsx}'],
  // Disable preflight to avoid conflicts with legacy dashboard.css
  corePlugins: {
    preflight: false,
  },
  theme: {
    extend: {
      colors: {
        // All colors reference CSS custom properties in dashboard.css (single source of truth).
        // Trade-off: Tailwind opacity modifiers (e.g. bg-accent/50) won't work —
        // use explicit subtle/hover token variants instead.
        bg: {
          DEFAULT: 'var(--bg)',
          accent: 'var(--bg-accent)',
          elevated: 'var(--bg-elevated)',
          hover: 'var(--bg-hover)',
        },
        card: {
          DEFAULT: 'var(--card)',
          highlight: 'var(--card-highlight)',
        },
        secondary: 'var(--secondary)',
        accent: {
          DEFAULT: 'var(--accent)',
          hover: 'var(--accent-hover)',
          subtle: 'var(--accent-subtle)',
          2: 'var(--accent-2)',
          '2-subtle': 'var(--accent-2-subtle)',
        },
        text: {
          DEFAULT: 'var(--text)',
          strong: 'var(--text-strong)',
        },
        muted: 'var(--muted)',
        border: {
          DEFAULT: 'var(--border)',
          strong: 'var(--border-strong)',
        },
        ok: {
          DEFAULT: 'var(--ok)',
          subtle: 'var(--ok-subtle)',
        },
        warn: {
          DEFAULT: 'var(--warn)',
          subtle: 'var(--warn-subtle)',
        },
        danger: {
          DEFAULT: 'var(--danger)',
          subtle: 'var(--danger-subtle)',
        },
        info: {
          DEFAULT: 'var(--info)',
          subtle: 'var(--info-subtle)',
        },
      },
      fontFamily: {
        sans: ['Space Grotesk', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        full: 'var(--radius-full)',
      },
      boxShadow: {
        sm: 'var(--shadow-sm)',
        md: 'var(--shadow-md)',
        lg: 'var(--shadow-lg)',
        card: '0 12px 28px rgba(0, 0, 0, 0.35)',
        'focus-accent': '0 0 0 3px color-mix(in srgb, var(--accent) 25%, transparent)',
        'focus-danger': '0 0 0 3px color-mix(in srgb, var(--danger) 25%, transparent)',
      },
      keyframes: {
        'slide-in-right': {
          from: { transform: 'translateX(100%)' },
          to: { transform: 'translateX(0)' },
        },
        'scale-in': {
          from: { transform: 'scale(0.95)', opacity: '0' },
          to: { transform: 'scale(1)', opacity: '1' },
        },
      },
      animation: {
        'slide-in-right': 'slide-in-right var(--duration-slow) var(--ease-out)',
        'scale-in': 'scale-in var(--duration-fast) var(--ease-out)',
      },
      transitionDuration: {
        fast: 'var(--duration-fast)',
        normal: 'var(--duration-normal)',
        slow: 'var(--duration-slow)',
      },
      transitionTimingFunction: {
        out: 'var(--ease-out)',
      },
    },
  },
  plugins: [],
};
