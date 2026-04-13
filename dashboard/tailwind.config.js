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
        // Map to existing CSS custom properties from dashboard.css
        surface: 'var(--card)',
        'surface-alt': 'var(--bg-elevated)',
        border: 'var(--border)',
        'border-strong': 'var(--border-strong)',
        accent: 'var(--accent)',
        'accent-subtle': 'var(--accent-subtle)',
        'text-primary': 'var(--text)',
        'text-muted': 'var(--muted)',
        'text-strong': 'var(--text-strong)',
        'bg-hover': 'var(--bg-hover)',
        secondary: 'var(--secondary)',
        danger: 'var(--danger)',
        success: 'var(--ok)',
        warning: 'var(--warn)',
      },
      fontFamily: {
        sans: ['Space Grotesk', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
    },
  },
  plugins: [],
};
