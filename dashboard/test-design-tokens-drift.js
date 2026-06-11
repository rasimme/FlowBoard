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
  ok(usages.length > 0, `found ${usages.length} var() usages across styles/ and tailwind.config.js`);

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
