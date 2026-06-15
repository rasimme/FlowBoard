/**
 * T-365-1 — create-flow dashboard suggestion logic (DOM-less).
 * The New-Project modal offers the server's best-fit preset for confirmation
 * only when the response is a real, non-default suggestion. The decision is a
 * pure helper so it can be unit-tested without a render harness.
 *
 * Run: node test-overview-suggestion-ui.mjs
 */
import assert from 'node:assert/strict';
import { shouldOfferSuggestion, presetLabel } from './src/utils/overviewSuggestion.js';

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✅ ${msg}`); }
  else { fail++; failures.push(msg); console.log(`  ❌ ${msg}`); }
}

// Offer only for a real, non-default, not-yet-applied suggestion.
ok(shouldOfferSuggestion({ mode: 'suggested', applied: false, preset: 'coding' }) === true,
   'offers for a non-default suggested preset');
ok(shouldOfferSuggestion({ mode: 'suggested', applied: false, preset: 'default' }) === false,
   'does not offer the default preset');
ok(shouldOfferSuggestion({ mode: 'suggested', applied: true, preset: 'coding' }) === false,
   'does not offer when already applied');
ok(shouldOfferSuggestion({ mode: 'auto', applied: true, preset: 'coding' }) === false,
   'does not offer for the headless auto path');
ok(shouldOfferSuggestion(null) === false && shouldOfferSuggestion(undefined) === false,
   'no overview -> no offer');

// Preset labels map to friendly names, with a raw fallback.
ok(presetLabel('coding') === 'Coding' && presetLabel('mission') === 'Mission Control',
   'known presets get friendly labels');
ok(presetLabel('whatever') === 'whatever', 'unknown preset falls back to its raw name');

if (fail === 0) console.log(`\n✅ All ${pass} checks passed`);
else { console.log(`\n❌ ${fail} failed, ${pass} passed`); failures.forEach(f => console.log(`  - ${f}`)); }
process.exit(fail > 0 ? 1 : 0);
