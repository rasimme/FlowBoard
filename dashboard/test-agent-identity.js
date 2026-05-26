'use strict';

const identity = require('./agent-identity.js');

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); }
}

function assertEqual(actual, expected, msg) {
  assert(actual === expected, `${msg}${actual === expected ? '' : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}

function section(name) { console.log(`\n## ${name}`); }

section('known stable identities');
{
  const dev = identity.classifyAgentId('dev-botti');
  assertEqual(dev.ok, true, 'dev-botti accepted');
  assertEqual(dev.kind, 'known', 'dev-botti classified as known');

  const human = identity.classifyAgentId('human');
  assertEqual(human.ok, true, 'human accepted');
  assertEqual(human.kind, 'known', 'human classified as known');
}

section('external stable identities');
{
  const ext = identity.classifyAgentId('qwen-worker');
  assertEqual(ext.ok, true, 'unknown stable external id accepted');
  assertEqual(ext.kind, 'external', 'unknown stable id classified as external');
  assert(!!ext.warning, 'external id carries warning');
}

section('generated or placeholder identities');
{
  assertEqual(identity.classifyAgentId('codex-workspace').ok, false, 'runtime-workspace id rejected');
  assertEqual(identity.classifyAgentId('workspace-dev-botti').ok, false, 'workspace-prefixed id rejected');
  assertEqual(identity.classifyAgentId('t198-replay-1777837445357').ok, false, 'replay timestamp id rejected');
  assertEqual(identity.classifyAgentId('<agentId>').ok, false, 'placeholder rejected');
  assertEqual(identity.classifyAgentId('default').ok, false, 'default pseudo-id rejected');
}

section('test fixtures remain allowed');
{
  const test = identity.classifyAgentId('test-agent-no-project-1779828294952');
  assertEqual(test.ok, true, 'test fixture id accepted');
  assertEqual(test.kind, 'test', 'test fixture classified as test');
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
