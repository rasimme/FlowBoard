'use strict';

/**
 * Unit tests for rules-api.js — the lazy-load registry for PROJECT-RULES sections.
 * Run: node test-rules-api.js
 */

const rulesApi = require('./rules-api.js');

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.error(`  ❌ ${msg}`);
  }
}

function assertEqual(actual, expected, msg) {
  if (actual === expected) {
    passed++;
    console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.error(`  ❌ ${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function section(name) {
  console.log(`\n## ${name}`);
}

section('listRuleSections()');
{
  const sections = rulesApi.listRuleSections();
  assert(Array.isArray(sections), 'returns an array');
  assert(sections.length >= 7, 'contains at least 7 sections');

  const names = sections.map(s => s.name);
  for (const expected of ['commands', 'api-access', 'hzl', 'canvas', 'files', 'error-handling', 'key-principles']) {
    assert(names.includes(expected), `includes "${expected}"`);
  }

  for (const s of sections) {
    assert(typeof s.name === 'string' && s.name.length > 0, `entry has name: ${s.name}`);
    assert(typeof s.label === 'string' && s.label.length > 0, `entry has label: ${s.name}`);
  }
}

section('readRuleSection() — known sections');
{
  const commands = rulesApi.readRuleSection('commands');
  assert(typeof commands === 'string', 'commands returns string');
  assert(commands && commands.length > 0, 'commands content non-empty');

  const hzl = rulesApi.readRuleSection('hzl');
  assert(typeof hzl === 'string', 'hzl returns string');
  assert(hzl && hzl.length > 0, 'hzl content non-empty');

  const errorHandling = rulesApi.readRuleSection('error-handling');
  assert(typeof errorHandling === 'string', 'error-handling returns string');
  assert(errorHandling && errorHandling.length > 0, 'error-handling content non-empty');

  const keyPrinciples = rulesApi.readRuleSection('key-principles');
  assert(typeof keyPrinciples === 'string', 'key-principles returns string');
  assert(keyPrinciples && keyPrinciples.length > 0, 'key-principles content non-empty');
}

section('readRuleSection() — alias sections (reuse existing docs)');
{
  const apiAccess = rulesApi.readRuleSection('api-access');
  assert(apiAccess && apiAccess.length > 0, 'api-access returns content (alias → tasks-api.md)');
  assert(apiAccess.includes('Tasks API') || apiAccess.includes('tasks'), 'api-access content is tasks-api.md');

  const canvas = rulesApi.readRuleSection('canvas');
  assert(canvas && canvas.length > 0, 'canvas returns content (alias → canvas-and-notes.md)');
  assert(canvas.toLowerCase().includes('canvas'), 'canvas content is canvas-and-notes.md');

  const files = rulesApi.readRuleSection('files');
  assert(files && files.length > 0, 'files returns content (alias → project-files.md)');
}

section('readRuleSection() — unknown sections');
{
  assertEqual(rulesApi.readRuleSection('does-not-exist'), null, 'unknown name returns null');
  assertEqual(rulesApi.readRuleSection(''), null, 'empty string returns null');
  assertEqual(rulesApi.readRuleSection(null), null, 'null returns null');
  assertEqual(rulesApi.readRuleSection(undefined), null, 'undefined returns null');
}

section('readRuleSection() — path traversal safety');
{
  assertEqual(rulesApi.readRuleSection('../../../etc/passwd'), null, 'rejects ../../ traversal');
  assertEqual(rulesApi.readRuleSection('commands/../etc/passwd'), null, 'rejects embedded traversal');
  assertEqual(rulesApi.readRuleSection('/etc/passwd'), null, 'rejects absolute path');
  assertEqual(rulesApi.readRuleSection('..\\..\\etc\\passwd'), null, 'rejects Windows-style traversal');
  assertEqual(rulesApi.readRuleSection('PROJECT-RULES'), null, 'does not expose arbitrary docs by guessing filename');
}

section('buildRulesManifest()');
{
  const manifest = rulesApi.buildRulesManifest();
  assert(typeof manifest === 'string', 'returns string');
  assert(manifest.length > 0, 'non-empty');
  assert(manifest.length < 2000, 'concise (<2000 chars ≈ under 30 lines)');

  for (const name of ['commands', 'api-access', 'hzl', 'canvas', 'files', 'error-handling', 'key-principles']) {
    assert(manifest.includes(name), `manifest lists "${name}"`);
  }

  assert(manifest.includes('GET /api/projects'), 'manifest documents endpoint usage');
  assert(manifest.includes('PROJECT-RULES.md'), 'manifest includes legacy pointer');
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
