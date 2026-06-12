// Canvas constants — extracted 1:1 from js/canvas/state.js (T-340-1).
// The vanilla canvas is the behavioral reference for the React migration;
// values here must not drift from it while js/canvas/ still exists.

export const NOTE_WIDTH = 160;
export const SCALE_MIN = 0.3;
export const SCALE_MAX = 2.5;
export const NOTE_COLORS = ['grey', 'yellow', 'blue', 'green', 'red', 'teal'];
export const CORNER_RADIUS = 12;
export const PORT_SPACING  = 18;

export const COLOR_STROKE = {
  grey:   'var(--border-strong)',
  yellow: 'var(--warn)',
  blue:   'var(--info)',
  green:  'var(--ok)',
  red:    'var(--danger)',
  teal:   'var(--accent-2)'
};

export const MIN_ESCAPE = 28;
export const MAX_PORTS_PER_SIDE = 5;
