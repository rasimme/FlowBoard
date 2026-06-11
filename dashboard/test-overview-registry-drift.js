'use strict';

// T-305-7 — Overview registry drift guard.
// The trusted registry exists in three places that must stay in lockstep:
// the server catalog (overview.js), the frontend registry
// (src/components/overview/registry.js) and the agent-facing rule section
// (docs/project-mode/overview.md). New widget types must land in all three.

const fs = require('fs');
const path = require('path');
const overview = require('./overview.js');

let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✅ ${msg}`); }
  else      { fail++; failures.push(msg); console.log(`  ❌ ${msg}`); }
}

console.log('# Overview registry drift (T-305)');

const serverTypes = Object.keys(overview.WIDGET_TYPES).sort();

// Frontend registry — parse the source (it imports JSX, so no require here)
const regSrc = fs.readFileSync(path.join(__dirname, 'src/components/overview/registry.js'), 'utf8');
const clientTypes = [...regSrc.matchAll(/^\s*'([\w-]+)':\s*\w+Widget,/gm)].map(m => m[1]).sort();

ok(serverTypes.length >= 7, `server catalog has ${serverTypes.length} widget types`);
ok(JSON.stringify(serverTypes) === JSON.stringify(clientTypes),
  `frontend registry matches the server catalog (server: ${serverTypes.join(',')} | client: ${clientTypes.join(',')})`);

// Presets reference only registered types and validate against the schema
for (const [name] of Object.entries(overview.PRESETS)) {
  const config = overview.presetConfig(name);
  const result = overview.validateOverview(config);
  ok(result.ok, `preset "${name}" validates against the registry${result.ok ? '' : ': ' + result.errors.join('; ')}`);
  const unknown = config.widgets.filter(w => !overview.WIDGET_TYPES[w.type]);
  ok(unknown.length === 0, `preset "${name}" references only registered types`);
}

// Default and minimum sizes stay within the grid contract
for (const [type, def] of Object.entries(overview.WIDGET_TYPES)) {
  const s = def.defaultSize || {};
  ok(Number.isInteger(s.w) && s.w >= 1 && s.w <= 12 && Number.isInteger(s.h) && s.h >= 1,
    `defaultSize of "${type}" fits the grid (${s.w}x${s.h})`);
  const m = def.minSize || {};
  ok(Number.isInteger(m.w) && m.w >= 1 && m.w <= s.w && Number.isInteger(m.h) && m.h >= 1 && m.h <= s.h,
    `minSize of "${type}" is set and <= defaultSize (${m.w}x${m.h})`);
}

// Presets respect each widget's minimum size
for (const [name] of Object.entries(overview.PRESETS)) {
  const config = overview.presetConfig(name);
  const tooSmall = config.widgets.filter(w => {
    const m = overview.WIDGET_TYPES[w.type]?.minSize || { w: 1, h: 1 };
    return w.grid.w < m.w || w.grid.h < m.h;
  });
  ok(tooSmall.length === 0, `preset "${name}" respects widget minSizes${tooSmall.length ? ' (' + tooSmall.map(w => w.id).join(',') + ')' : ''}`);
}

// Agent rule section documents every type
const ruleDoc = fs.readFileSync(path.join(__dirname, '../docs/project-mode/overview.md'), 'utf8');
for (const type of serverTypes) {
  ok(ruleDoc.includes('`' + type + '`'), `rule section documents widget type "${type}"`);
}
for (const presetName of Object.keys(overview.PRESETS)) {
  ok(ruleDoc.includes(presetName), `rule section mentions preset "${presetName}"`);
}

if (fail === 0) {
  console.log(`\n✅ All ${pass} checks passed`);
} else {
  console.log(`\n❌ ${fail} failed, ${pass} passed`);
  failures.forEach(f => console.log(`  - ${f}`));
}
process.exit(fail > 0 ? 1 : 0);
