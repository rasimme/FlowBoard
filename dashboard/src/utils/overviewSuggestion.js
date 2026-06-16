/**
 * overviewSuggestion — create-flow helpers for the server's best-fit dashboard
 * suggestion (T-365). `POST /api/projects` returns an `overview` hint
 * `{ preset, rationale, applied, mode }`; the New-Project modal offers it for
 * confirmation only when it is a real, non-default, not-yet-applied suggestion
 * (the headless `auto` path applies it server-side and needs no UI).
 */

const PRESET_LABELS = {
  default: 'Standard',
  coding: 'Coding',
  knowledge: 'Knowledge',
  mission: 'Mission Control',
};

/** Should the create flow offer this overview hint for the user to confirm? */
export function shouldOfferSuggestion(overview) {
  return !!overview
    && overview.mode === 'suggested'
    && overview.applied === false
    && typeof overview.preset === 'string'
    && overview.preset !== 'default';
}

/** Friendly label for a preset name, falling back to the raw name. */
export function presetLabel(name) {
  return PRESET_LABELS[name] || name;
}
