'use strict';

// T-447-5 unit coverage: project-scoped persistence, safe legacy migration,
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

// A pre-T-447-5 install may still have a global enforce value and audit row.
// Those legacy values are inert until a verified human explicitly selects a
// project through the scoped API; they must not affect either project or an
// unscoped read.
values.set('governance_mode', 'enforce');
values.set('governance_mode__last_change', JSON.stringify({
  actor: 'telegram:legacy', humanId: 'legacy',
  changedAt: '2026-08-24T19:00:00.000Z', mode: 'enforce',
}));
assert.equal(governance.getGovernanceMode(store, 'alpha'), 'compat', 'missing project defaults to compat');
assert.equal(governance.getGovernanceMode(store, 'beta'), 'compat', 'projects start independently in compat');
assert.equal(governance.getGovernanceMode(store), 'compat', 'unscoped reads default to compat');
assert.equal(governance.getGovernanceModeAudit(store, 'alpha'), null, 'legacy audit cannot leak into alpha');
assert.equal(governance.getGovernanceModeAudit(store, 'beta'), null, 'legacy audit cannot leak into beta');
assert.equal(governance.getGovernanceModeAudit(store), null, 'legacy audit cannot leak into unscoped state');
assert.equal(governance.projectSettingKey('legacy-project'), 'governance_mode:legacy-project');
assert.equal(governance.scopedProjectSettingKey(), null, 'unscoped state has no project setting key');

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

assert.equal(governance.getGovernanceMode(store, 'beta'), 'compat', 'alpha cannot change beta');
assert.equal(governance.getGovernanceMode(store), 'compat', 'project changes cannot affect unscoped state');
assert.equal(governance.getGovernanceModeAudit(store, 'beta'), null, 'alpha audit cannot leak into beta');
assert.equal(governance.getGovernanceModeAudit(store), null, 'project audit cannot leak into unscoped state');

result = governance.setGovernanceMode({ store, principal: human, nextMode: 'enforce' });
assert.equal(result.ok, false);
assert.equal(result.code, 'project_required_for_governance_mode', 'unscoped mode changes are rejected');
assert.equal(governance.getGovernanceMode(store), 'compat');

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
