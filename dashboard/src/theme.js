/**
 * FlowBoard Theme Contract
 *
 * Single source of truth: CSS custom properties in dashboard/styles/dashboard.css
 * Tailwind config (tailwind.config.js) maps these tokens for use in className strings.
 *
 * This file documents the token system for React developers. It does NOT define
 * values — values live in dashboard.css. Import this for reference or programmatic use.
 */

// --- Icon conventions ---
// Library: lucide-react (stroke-based, 1.5px default, currentColor)
// Import icons directly: import { Menu, X } from 'lucide-react';
// Standard sizes: size={14} small context, size={16} default, size={18} header/nav
// Color: inherits via CSS text color (text-muted, text-text, text-accent, etc.)
// No wrapper needed — lucide-react handles viewBox, stroke-width, linecap/linejoin.

export const ICON_SIZES = {
  sm: 14,
  md: 16,
  lg: 18,
};

// --- Color tokens (Tailwind class prefixes) ---
// bg-bg, bg-bg-accent, bg-bg-elevated, bg-bg-hover
// bg-card, bg-card-highlight
// text-text, text-text-strong, text-muted
// border-border, border-border-strong
// bg-accent, text-accent, bg-accent-hover, bg-accent-subtle
// bg-accent-2, bg-accent-2-subtle
// bg-ok, bg-ok-subtle, text-ok
// bg-warn, bg-warn-subtle, text-warn
// bg-danger, bg-danger-subtle, text-danger
// bg-info, bg-info-subtle, text-info

// --- Radius tokens (Tailwind) ---
// rounded-sm (6px), rounded-md (8px), rounded-lg (12px), rounded-full (9999px)

// --- Shadow tokens (Tailwind) ---
// shadow-sm, shadow-md, shadow-lg, shadow-card
// shadow-focus-accent (focus ring), shadow-focus-danger

// --- Duration tokens (Tailwind) ---
// duration-fast (0.15s), duration-normal (0.2s), duration-slow (0.35s)

// --- Easing ---
// ease-out (custom cubic-bezier)

// --- Animation ---
// animate-slide-in-right, animate-scale-in

// --- Status colors (CSS only, not in Tailwind) ---
// Used in legacy kanban columns via inline style or CSS class.
// --status-backlog, --status-open, --status-in-progress,
// --status-review, --status-done, --status-blocked
export const STATUS_COLORS = {
  backlog: 'var(--status-backlog)',
  open: 'var(--status-open)',
  'in-progress': 'var(--status-in-progress)',
  review: 'var(--status-review)',
  done: 'var(--status-done)',
  blocked: 'var(--status-blocked)',
};
