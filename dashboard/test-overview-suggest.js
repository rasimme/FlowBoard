'use strict';

// T-365 Increment 2 — best-fit preset inference (the deterministic "floor").
// suggestPreset maps shallow project-creation signals (name/displayName/
// description/group + optional github binding) to a preset name and a short
// human rationale. It is best-effort and meant to be overridable by an agent.

const { suggestPreset, PRESETS } = require('./overview.js');

let pass = 0;
let fail = 0;
const failures = [];

function ok(condition, message) {
  if (condition) {
    pass++;
    console.log(`  ok - ${message}`);
  } else {
    fail++;
    failures.push(message);
    console.log(`  not ok - ${message}`);
  }
}

function section(name, fn) {
  try { fn(); }
  catch (e) { fail++; failures.push(`${name}: ${e.message}`); console.log(`  not ok - ${name}: ${e.message}`); }
}

console.log('# Overview suggestPreset (T-365)');

// A bound GitHub repo is the strongest coding signal.
section('github binding -> coding', () => {
  const s = suggestPreset({ name: 'whatever', github: { repo: 'owner/x' } });
  ok(s && s.preset === 'coding', 'a bound repo suggests the coding preset');
  ok(typeof s.rationale === 'string' && s.rationale.length > 0, 'a rationale is returned');
});

// Code/repo language in the text suggests coding.
section('code keywords -> coding', () => {
  ok(suggestPreset({ name: 'api-gateway', description: 'backend service' }).preset === 'coding',
     'code keywords suggest coding');
});

// Document/knowledge language suggests knowledge.
section('knowledge keywords -> knowledge', () => {
  ok(suggestPreset({ name: 'handbook', description: 'research wiki and notes' }).preset === 'knowledge',
     'knowledge keywords suggest knowledge');
});

// Coordination/ops language suggests mission control.
section('coordination keywords -> mission', () => {
  ok(suggestPreset({ description: 'orchestrating many parallel agents' }).preset === 'mission',
     'coordination keywords suggest mission');
});

// No signal falls back to the default preset.
section('no signal -> default', () => {
  const s = suggestPreset({ name: 'misc-thing' });
  ok(s.preset === 'default', 'no recognizable signal falls back to default');
});

// Whatever is suggested must be a real, registered preset.
section('always a registered preset', () => {
  for (const sig of [{}, { name: 'x' }, { github: { repo: 'a/b' } }, { description: 'notes' }]) {
    const s = suggestPreset(sig);
    ok(PRESETS[s.preset] !== undefined, `suggested "${s.preset}" is a registered preset`);
  }
});

if (fail === 0) {
  console.log(`\n✅ All ${pass} checks passed`);
} else {
  console.log(`\n❌ ${fail} failed, ${pass} passed`);
  failures.forEach(f => console.log(`  - ${f}`));
}
process.exit(fail > 0 ? 1 : 0);
