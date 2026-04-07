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
        // Map to existing CSS custom properties for consistency
        surface: 'var(--surface)',
        'surface-alt': 'var(--surface-alt)',
        border: 'var(--border)',
        accent: 'var(--accent)',
        'accent-hover': 'var(--accent-hover)',
        'text-primary': 'var(--text)',
        'text-muted': 'var(--muted)',
        danger: 'var(--danger)',
        success: 'var(--success)',
        warning: 'var(--warning)',
      },
      fontFamily: {
        sans: ['Space Grotesk', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
    },
  },
  plugins: [],
};
