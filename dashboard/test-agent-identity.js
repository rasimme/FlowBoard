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
  const main = identity.classifyAgentId('main');
  assertEqual(main.ok, true, 'main accepted');
  assertEqual(main.kind, 'known', 'main classified as known');

  const human = identity.classifyAgentId('human');
  assertEqual(human.ok, true, 'human accepted');
  assertEqual(human.kind, 'known', 'human classified as known');
}

section('managed identities from configuration');
{
  const previous = process.env.FLOWBOARD_MANAGED_AGENT_IDS;
  process.env.FLOWBOARD_MANAGED_AGENT_IDS = 'alpha-agent,beta-worker';

  const managed = identity.classifyAgentId('alpha-agent');
  assertEqual(managed.ok, true, 'configured managed agent accepted');
  assertEqual(managed.kind, 'managed', 'configured managed agent classified as managed');

  assertEqual(identity.classifyAgentId('alpha-agent-main').ok, false, 'managed suffix variant rejected');
  assertEqual(identity.classifyAgentId('prod-alpha-agent').ok, false, 'managed prefix variant rejected');

  const external = identity.classifyAgentId('gamma-agent-main');
  assertEqual(external.ok, true, 'distinct external agent still accepted');
  assertEqual(external.kind, 'external', 'distinct external agent remains external');

  if (previous === undefined) delete process.env.FLOWBOARD_MANAGED_AGENT_IDS;
  else process.env.FLOWBOARD_MANAGED_AGENT_IDS = previous;
}

section('normalization and shape validation');
{
  assertEqual(identity.classifyAgentId(' main ').id, 'main', 'agent ids are trimmed');
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
  assertEqual(identity.classifyAgentId('workspace-alpha-agent').ok, false, 'workspace-prefixed id rejected');
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

  const knownMeta = identity.responseMeta(identity.validateAgentId('main'));
  assertEqual(knownMeta.kind, 'known', 'responseMeta exposes known kind');
  assertEqual(Object.prototype.hasOwnProperty.call(knownMeta, 'warning'), false, 'known responseMeta omits warning');

  const previous = process.env.FLOWBOARD_MANAGED_AGENT_IDS;
  process.env.FLOWBOARD_MANAGED_AGENT_IDS = 'alpha-agent';
  const managedMeta = identity.responseMeta(identity.validateAgentId('alpha-agent'));
  assertEqual(managedMeta.kind, 'managed', 'responseMeta exposes managed kind');
  assertEqual(Object.prototype.hasOwnProperty.call(managedMeta, 'warning'), false, 'managed responseMeta omits warning');
  if (previous === undefined) delete process.env.FLOWBOARD_MANAGED_AGENT_IDS;
  else process.env.FLOWBOARD_MANAGED_AGENT_IDS = previous;

  const externalMeta = identity.responseMeta(identity.validateAgentId('qwen-worker'));
  assertEqual(externalMeta.kind, 'external', 'responseMeta exposes external kind');
  assert(!!externalMeta.warning, 'external responseMeta includes warning');

  assertEqual(identity.responseMeta({ ok: false }), undefined, 'responseMeta ignores invalid identities');
}

section('resolveActivityAuthor() — T-232 comment attribution');
{
  // validated agent wins and is normalized via validateAgentId
  const a = identity.resolveActivityAuthor({ agent: 'claude' });
  assertEqual(a.ok, true, 'agent-only resolves ok');
  assertEqual(a.author, 'claude', 'agent becomes the author');

  // agent wins over a free-form author when both are present
  const both = identity.resolveActivityAuthor({ agent: 'main', author: 'someone-else' });
  assertEqual(both.author, 'main', 'validated agent wins over free-form author');

  // free-form author passes through when no agent (UI/human path)
  const human = identity.resolveActivityAuthor({ author: 'Ada' });
  assertEqual(human.ok, true, 'author-only resolves ok');
  assertEqual(human.author, 'Ada', 'free-form author passes through unchanged');

  // nothing provided → null (legitimately unattributed; UI renders "flowboard")
  assertEqual(identity.resolveActivityAuthor({}).author, null, 'no agent/author → null author');
  assertEqual(identity.resolveActivityAuthor().author, null, 'no body → null author');
  assertEqual(identity.resolveActivityAuthor({ agent: '' }).author, null, 'blank agent falls through to author/null');

  // invalid agent is rejected (not silently dropped, unlike the old bug)
  const bad = identity.resolveActivityAuthor({ agent: 'Not A Valid ID!!' });
  assertEqual(bad.ok, false, 'invalid agent is rejected');
  assert(bad.error && bad.error.startsWith('agent '), 'rejection uses the "agent" label');
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
