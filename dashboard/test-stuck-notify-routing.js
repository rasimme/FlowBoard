'use strict';

// T-400 — buildStuckNotifications() routing:
//   - tasks WITH a responsible agent wake only that agent's session
//     (channel 'none' = no operator/Telegram delivery)
//   - tasks WITHOUT a responsible agent escalate to the operator ONCE
//     (the configured operator delivery, e.g. telegram → operator)
// Pure function so the 5-min scheduler logic is testable without the gateway.

const { buildStuckNotifications } = require('./stuck-notify.js');

let pass = 0, fail = 0; const failures = [];
function ok(cond, msg) { if (cond) { pass++; console.log(`  ok - ${msg}`); } else { fail++; failures.push(msg); console.log(`  not ok - ${msg}`); } }

const operatorDelivery = { channel: 'telegram', target: 'op-chat-id', to: 'op-chat-id' };

// --- owned tasks: wake the owner, never the operator ---
{
  const payloads = buildStuckNotifications(
    { stale: [{ id: 'T-1', project: 'p', title: 'A', staleSinceMinutes: 45, agent: 'dev-botti' }],
      expired: [{ id: 'T-2', project: 'p', title: 'B', agent: 'design-botti' }],
      routedUnclaimed: [] },
    { operatorDelivery, wakeChannel: 'none' });

  const devb = payloads.find(p => p.agentId === 'dev-botti');
  ok(!!devb, 'owner dev-botti gets a wake payload');
  ok(devb && devb.channel === 'none', 'owner wake uses channel "none" (no outbound delivery)');
  ok(devb && !devb.to && !devb.target, 'owner wake carries no operator target');
  ok(devb && devb.sessionKey === 'agent:dev-botti:main' && devb.wakeMode === 'now', 'owner wake targets agent session with wakeMode now');
  ok(payloads.some(p => p.agentId === 'design-botti'), 'each distinct owner gets its own wake payload');
  ok(!payloads.some(p => p.to === 'op-chat-id' || p.channel === 'telegram'), 'owned-only round sends nothing to the operator');
}

// --- unowned tasks: a single throttled operator escalation ---
{
  const payloads = buildStuckNotifications(
    { stale: [{ id: 'T-9', project: 'p', title: 'orphan', staleSinceMinutes: 90 }], // no agent
      expired: [],
      routedUnclaimed: [{ id: 'T-10', project: 'p', title: 'routed' }] },        // no routedAgent
    { operatorDelivery, wakeChannel: 'none' });

  const esc = payloads.filter(p => p.to === 'op-chat-id');
  ok(esc.length === 1, 'unowned tasks produce exactly one operator escalation');
  ok(esc[0] && esc[0].channel === 'telegram', 'operator escalation uses the configured delivery channel');
  ok(esc[0] && /T-9/.test(esc[0].message) && /T-10/.test(esc[0].message), 'escalation lists the unowned tasks');
  ok(!payloads.some(p => p.agentId), 'no agent wake payloads when nothing is owned');
}

// --- mixed: owners woken silently, orphans escalated, in one round ---
{
  const payloads = buildStuckNotifications(
    { stale: [{ id: 'T-1', project: 'p', title: 'A', staleSinceMinutes: 45, agent: 'dev-botti' },
              { id: 'T-9', project: 'p', title: 'orphan', staleSinceMinutes: 90 }],
      expired: [], routedUnclaimed: [] },
    { operatorDelivery, wakeChannel: 'none' });
  ok(payloads.some(p => p.agentId === 'dev-botti' && p.channel === 'none'), 'mixed: owner woken silently');
  ok(payloads.filter(p => p.to === 'op-chat-id').length === 1, 'mixed: one operator escalation for the orphan');
}

// --- empty input: no payloads ---
ok(buildStuckNotifications({ stale: [], expired: [], routedUnclaimed: [] }, { operatorDelivery }).length === 0,
  'nothing stuck → no notifications');

console.log(fail === 0 ? `\n✅ stuck-notify routing: all ${pass} checks passed` : `\n❌ stuck-notify routing: ${fail} failed, ${pass} passed`);
if (fail) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
