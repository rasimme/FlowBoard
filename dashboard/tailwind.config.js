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
        bg: {
          DEFAULT: '#12141a',
          elevated: '#1a1d25',
          hover: '#262a35',
        },
        card: '#181b22',
        accent: {
          DEFAULT: '#ff5c5c',
          hover: '#ff7070',
          subtle: 'rgba(255, 92, 92, 0.15)',
          2: '#14b8a6',
        },
        text: {
          DEFAULT: '#e4e4e7',
          strong: '#fafafa',
        },
        muted: '#71717a',
        border: {
          DEFAULT: '#27272a',
          strong: '#3f3f46',
        },
        ok: {
          DEFAULT: '#22c55e',
          subtle: 'rgba(34, 197, 94, 0.12)',
        },
        warn: {
          DEFAULT: '#f59e0b',
          subtle: 'rgba(245, 158, 11, 0.12)',
        },
        danger: {
          DEFAULT: '#ef4444',
          subtle: 'rgba(239, 68, 68, 0.12)',
        },
        info: {
          DEFAULT: '#3b82f6',
          subtle: 'rgba(59, 130, 246, 0.12)',
        },
      },
      fontFamily: {
        sans: ['Space Grotesk', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      borderRadius: {
        sm: '6px',
        md: '8px',
        lg: '12px',
        full: '9999px',
      },
      boxShadow: {
        card: '0 12px 28px rgba(0, 0, 0, 0.35)',
        'focus-accent': '0 0 0 3px color-mix(in srgb, #ff5c5c 25%, transparent)',
        'focus-danger': '0 0 0 3px color-mix(in srgb, #ef4444 25%, transparent)',
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
        'slide-in-right': 'slide-in-right 0.3s ease-out',
        'scale-in': 'scale-in 150ms ease-out',
      },
      transitionDuration: {
        fast: '150ms',
      },
    },
  },
  plugins: [],
};
