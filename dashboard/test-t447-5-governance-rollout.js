'use strict';

// T-447-5 unit coverage: project-scoped persistence, legacy compatibility,
// verified-human mutation, and append-only rollout telemetry.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const governance = require('./governance');
const policyLedger = require('./policy-ledger');

const values = new Map();
const store = {
  getSetting(key) { return values.get(key) ?? null; },
  setSetting(key, value) { values.set(key, String(value)); },
};
const human = { kind: 'human', verified: true, actor: 'telegram:42', humanId: '42' };
const agent = { kind: 'agent', verified: false, actor: 'agent:codex' };

assert.equal(governance.getGovernanceMode(store, 'alpha'), 'compat', 'missing project defaults to compat');
assert.equal(governance.getGovernanceMode(store, 'beta'), 'compat', 'projects start independently in compat');

let result = governance.setGovernanceMode({
  store, project: 'alpha', principal: agent, nextMode: 'enforce', now: Date.parse('2026-08-24T20:00:00.000Z'),
});
assert.equal(result.ok, false);
assert.equal(result.code, 'mode_change_requires_verified_human');
assert.equal(governance.getGovernanceMode(store, 'alpha'), 'compat', 'agent cannot mutate mode');

result = governance.setGovernanceMode({
  store, project: 'alpha', principal: human, nextMode: 'enforce', now: Date.parse('2026-08-24T20:01:00.000Z'),
});
assert.equal(result.ok, true);
assert.equal(governance.getGovernanceMode(store, 'alpha'), 'enforce');
assert.equal(governance.getGovernanceMode(store, 'beta'), 'compat', 'mode is project-scoped');
assert.deepEqual(governance.getGovernanceModeAudit(store, 'alpha'), {
  actor: 'telegram:42', humanId: '42', changedAt: '2026-08-24T20:01:00.000Z', mode: 'enforce',
});

result = governance.setGovernanceMode({ store, project: 'alpha', principal: human, nextMode: 'compat', now: Date.parse('2026-08-24T20:02:00.000Z') });
assert.equal(result.ok, true, 'verified human can manually roll back');
assert.equal(governance.getGovernanceMode(store, 'alpha'), 'compat');
assert.equal(governance.getGovernanceModeAudit(store, 'alpha').mode, 'compat');

// Existing T-447-1 installations used an instance-wide key. Reads preserve
// that value until the project receives its first explicit setting.
values.set('governance_mode', 'enforce');
assert.equal(governance.getGovernanceMode(store, 'legacy-project'), 'enforce');
assert.equal(governance.projectSettingKey('legacy-project'), 'governance_mode:legacy-project');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-governance-ledger-'));
try {
  const entry = policyLedger.appendPolicyRecord('alpha', {
    decision: 'would_block', origin: 'tasks-api', code: 'SPECIFY_REQUIRED', governanceMode: 'compat',
  }, { dir });
  assert.equal(entry.governanceMode, 'compat');
  assert.equal(policyLedger.readPolicyLedger({ dir })[0].governanceMode, 'compat');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('T-447-5 governance rollout unit tests: all passed');
