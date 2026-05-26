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

section('normalization and shape validation');
{
  assertEqual(identity.classifyAgentId(' dev-botti ').id, 'dev-botti', 'agent ids are trimmed');
  assertEqual(identity.classifyAgentId(undefined).ok, false, 'undefined rejected');
  assertEqual(identity.classifyAgentId(null).ok, false, 'null rejected');
  assertEqual(identity.classifyAgentId(123).ok, false, 'non-string numeric id rejected by kebab-case rule');
  assertEqual(identity.classifyAgentId('Claude-Code').ok, false, 'uppercase rejected');
  assertEqual(identity.classifyAgentId('1-agent').ok, false, 'leading digit rejected');
  assertEqual(identity.classifyAgentId('agent-').ok, false, 'trailing hyphen rejected');
  assertEqual(identity.classifyAgentId('a'.repeat(64)).ok, true, '64-char id accepted');
  assertEqual(identity.classifyAgentId('a'.repeat(65)).ok, false, '65-char id rejected');
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

section('server-facing helpers');
{
  const badAgent = identity.validateAgentId('main-workspace', 'agent');
  assertEqual(badAgent.ok, false, 'validateAgentId rejects bad id');
  assert(badAgent.error.startsWith('agent '), 'validateAgentId uses caller label in error');

  const knownMeta = identity.responseMeta(identity.validateAgentId('dev-botti'));
  assertEqual(knownMeta.kind, 'known', 'responseMeta exposes known kind');
  assertEqual(Object.prototype.hasOwnProperty.call(knownMeta, 'warning'), false, 'known responseMeta omits warning');

  const externalMeta = identity.responseMeta(identity.validateAgentId('qwen-worker'));
  assertEqual(externalMeta.kind, 'external', 'responseMeta exposes external kind');
  assert(!!externalMeta.warning, 'external responseMeta includes warning');

  assertEqual(identity.responseMeta({ ok: false }), undefined, 'responseMeta ignores invalid identities');
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
