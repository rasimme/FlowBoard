'use strict';

// T-365-3 (Increment 5) — "still default but the project now has content" nudge.
// When a project never tailored its overview (still the default fallback) yet
// has accumulated tasks, GET overview surfaces a gentle one-off hint with the
// best-fit preset, so an agent is reminded to tailor it at a useful moment.
// The decision is a pure helper; the endpoint just attaches what it returns.

const { buildNudge } = require('./overview.js');

let pass = 0;
let fail = 0;
const failures = [];
function ok(c, m) {
  if (c) { pass++; console.log(`  ok - ${m}`); }
  else { fail++; failures.push(m); console.log(`  not ok - ${m}`); }
}

console.log('# Overview still-default nudge (T-365-3)');

// A tailored layout (preset or custom written to file) is never nudged.
ok(buildNudge({ source: 'file' }, { description: 'backend service' }, 9) === null,
   'a written layout (source:file) is never nudged');

// Default fallback but no content yet -> no nudge (nothing to tailor around).
ok(buildNudge({ source: 'default' }, { description: 'backend service' }, 0) === null,
   'default with zero tasks is not nudged');

// Default fallback + content + a concrete better fit -> nudge with the suggestion.
const n = buildNudge({ source: 'default' }, { name: 'api', description: 'backend service' }, 7);
ok(n && n.suggested && n.suggested.preset === 'coding', 'default+content+better-fit nudges with the best-fit preset');
ok(n && n.taskCount === 7 && typeof n.reason === 'string' && n.reason.length > 0,
   'nudge carries the task count and a reason');

// Default fallback + content but the best fit IS default -> no nudge (nothing better to offer).
ok(buildNudge({ source: 'default' }, { name: 'misc-thing' }, 12) === null,
   'no nudge when the best fit is itself the default');

if (fail === 0) console.log(`\n✅ All ${pass} checks passed`);
else { console.log(`\n❌ ${fail} failed, ${pass} passed`); failures.forEach(f => console.log(`  - ${f}`)); }
process.exit(fail > 0 ? 1 : 0);
