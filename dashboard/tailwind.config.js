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
        accent: 'var(--accent)',
        'text-primary': 'var(--text)',
        'text-muted': 'var(--muted)',
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
