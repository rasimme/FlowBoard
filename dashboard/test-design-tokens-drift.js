'use strict';

// T-273 — Design token drift guard.
// Every `var(--token)` used without a fallback in the stylesheets or in
// tailwind.config.js must be defined in styles/*.css. Runtime-injected
// variables (e.g. --agent-pulse-color from AgentChip inline styles) are
// exempt because they always carry a CSS fallback value.

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;

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

function cssFiles() {
  const dir = path.join(ROOT, 'styles');
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.css'))
    .map(f => path.join(dir, f));
}

// The hue/identity palette is referenced from JS too (AgentChip AGENT_PALETTE,
// canvasConstants COLOR_STROKE, inline-style var() in canvas components). A
// typo there (e.g. var(--hue-9-ring)) resolves to nothing at runtime and the
// CSS-only scan would miss it — so walk src/ for var() usages as well.
function srcJsFiles() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(js|mjs|jsx)$/.test(e.name)) out.push(full);
    }
  };
  walk(path.join(ROOT, 'src'));
  return out;
}

function collectDefinitions(sources) {
  const defined = new Set();
  for (const { text } of sources) {
    for (const m of text.matchAll(/(?:^|[\s;{])(--[\w-]+)\s*:/g)) {
      defined.add(m[1]);
    }
  }
  return defined;
}

function collectUsages(file, text) {
  const usages = [];
  for (const m of text.matchAll(/var\(\s*(--[\w-]+)\s*(,?)/g)) {
    usages.push({ file, token: m[1], hasFallback: m[2] === ',' });
  }
  return usages;
}

function run() {
  console.log('# Design token drift');

  const styleSources = cssFiles().map(file => ({ file, text: fs.readFileSync(file, 'utf8') }));
  const defined = collectDefinitions(styleSources);
  ok(defined.size > 0, `found ${defined.size} token definitions in styles/`);

  const usages = [];
  for (const { file, text } of styleSources) {
    usages.push(...collectUsages(path.relative(ROOT, file), text));
  }
  const twPath = path.join(ROOT, 'tailwind.config.js');
  usages.push(...collectUsages('tailwind.config.js', fs.readFileSync(twPath, 'utf8')));
  // Also scan src/ JS/JSX so palette typos in COLOR_STROKE / AGENT_PALETTE /
  // inline-style var() are caught, not just CSS-side usages.
  let srcUsageCount = 0;
  for (const file of srcJsFiles()) {
    const u = collectUsages(path.relative(ROOT, file), fs.readFileSync(file, 'utf8'));
    srcUsageCount += u.length;
    usages.push(...u);
  }
  ok(usages.length > 0, `found ${usages.length} var() usages across styles/, tailwind.config.js and src/ (${srcUsageCount} in JS)`);

  const undefinedStrict = usages.filter(u => !u.hasFallback && !defined.has(u.token));
  for (const u of undefinedStrict) {
    ok(false, `${u.file}: var(${u.token}) has no fallback and no definition in styles/`);
  }
  ok(undefinedStrict.length === 0, 'every fallback-less var() usage resolves to a defined token');

  if (fail === 0) {
    console.log(`\n✅ All ${pass} checks passed`);
  } else {
    console.log(`\n❌ ${fail} failed, ${pass} passed`);
    failures.forEach(f => console.log(`  - ${f}`));
  }
  process.exit(fail > 0 ? 1 : 0);
}

run();
