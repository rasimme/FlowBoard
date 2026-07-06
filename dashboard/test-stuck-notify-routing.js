'use strict';

// T-434 — buildStuckNotifications() session-safe routing:
//   - a gateway request may NEVER target a live main session key
//     (`agent:<x>:main`) — that key is an interactive conversation, and the
//     gateway's /hooks/agent rolls whatever key it is pointed at (forceNew),
//     wiping that conversation's context (incident 2026-07-06).
//   - tasks owned by the gateway default agent nudge it via /hooks/wake
//     (system event — enqueued into the session WITHOUT resetting it)
//   - tasks owned by any other agent get NO push at all; they are reminded
//     through board state (task comment + /api/status attention)
//   - unowned tasks escalate to the operator ONCE via /hooks/agent on a
//     dedicated throwaway session key
// Pure function so the 5-min scheduler logic is testable without the gateway.

const { buildStuckNotifications, LIVE_MAIN_SESSION_KEY_RE } = require('./stuck-notify.js');

let pass = 0, fail = 0; const failures = [];
function ok(cond, msg) { if (cond) { pass++; console.log(`  ok - ${msg}`); } else { fail++; failures.push(msg); console.log(`  not ok - ${msg}`); } }

const operatorDelivery = { channel: 'telegram', target: 'op-chat-id', to: 'op-chat-id' };

// --- invariant helper: no payload may target a live main session key.
// A missing sessionKey on an agent-turn payload is NOT safe: the gateway
// falls back to hooks.defaultSessionKey, which is exactly how the incident
// reached agent:main:main. Agent payloads must carry an explicit safe key;
// wake payloads must carry none (the endpoint only accepts {text, mode}).
function assertSessionSafe(payloads, label) {
  ok(payloads.every(p => p.endpoint === 'wake'
      ? p.body.sessionKey === undefined
      : typeof p.body.sessionKey === 'string' && !LIVE_MAIN_SESSION_KEY_RE.test(p.body.sessionKey)),
    `${label}: agent payloads carry an explicit non-live sessionKey, wake payloads none`);
}

// --- default-agent owner: one bundled /hooks/wake nudge, no session key ---
{
  const payloads = buildStuckNotifications(
    { stale: [{ id: 'T-1', project: 'p', title: 'A', staleSinceMinutes: 45, agent: 'main' },
              { id: 'T-2', project: 'p', title: 'B', staleSinceMinutes: 50, agent: 'main' }],
      expired: [], routedUnclaimed: [] },
    { operatorDelivery });

  const wakes = payloads.filter(p => p.endpoint === 'wake');
  ok(wakes.length === 1, 'default-agent tasks produce exactly one bundled wake');
  ok(wakes[0] && wakes[0].body.mode === 'now', 'wake uses mode "now" (immediate heartbeat)');
  ok(wakes[0] && /T-1/.test(wakes[0].body.text) && /T-2/.test(wakes[0].body.text), 'wake text lists the stuck tasks');
  ok(wakes[0] && wakes[0].body.sessionKey === undefined, 'wake payload carries no sessionKey (gateway main-session semantics)');
  ok(!payloads.some(p => p.endpoint === 'agent'), 'owned-only round produces no agent-turn escalation');
  assertSessionSafe(payloads, 'default-agent round');
}

// --- other owners (gateway or external): no push at all ---
{
  const payloads = buildStuckNotifications(
    { stale: [{ id: 'T-3', project: 'p', title: 'C', staleSinceMinutes: 45, agent: 'dev-botti' },
              { id: 'T-4', project: 'q', title: 'D', staleSinceMinutes: 99, agent: 'claude-code' }],
      expired: [{ id: 'T-5', project: 'p', title: 'E', agent: 'design-botti' }],
      routedUnclaimed: [{ id: 'T-6', project: 'p', title: 'F', routedAgent: 'dev-botti' }] },
    { operatorDelivery });

  ok(payloads.length === 0, 'non-default owners get no push (board state is their reminder channel)');
}

// --- unowned tasks: a single escalation on a dedicated throwaway key ---
{
  const payloads = buildStuckNotifications(
    { stale: [{ id: 'T-9', project: 'p', title: 'orphan', staleSinceMinutes: 90 }], // no agent
      expired: [],
      routedUnclaimed: [{ id: 'T-10', project: 'p', title: 'routed' }] },        // no routedAgent
    { operatorDelivery });

  const esc = payloads.filter(p => p.endpoint === 'agent');
  ok(esc.length === 1, 'unowned tasks produce exactly one operator escalation');
  ok(esc[0] && esc[0].body.sessionKey === 'agent:main:flowboard-stuck-check', 'escalation runs on the dedicated throwaway session key');
  ok(esc[0] && esc[0].body.channel === 'telegram' && esc[0].body.to === 'op-chat-id', 'escalation uses the configured operator delivery');
  ok(esc[0] && /T-9/.test(esc[0].body.message) && /T-10/.test(esc[0].body.message), 'escalation lists the unowned tasks');
  ok(esc[0] && esc[0].body.wakeMode === 'now', 'escalation uses wakeMode now');
  assertSessionSafe(payloads, 'unowned round');
}

// --- mixed: default-agent nudged, others silent, orphans escalated ---
{
  const payloads = buildStuckNotifications(
    { stale: [{ id: 'T-1', project: 'p', title: 'A', staleSinceMinutes: 45, agent: 'main' },
              { id: 'T-3', project: 'p', title: 'C', staleSinceMinutes: 50, agent: 'dev-botti' },
              { id: 'T-9', project: 'p', title: 'orphan', staleSinceMinutes: 90 }],
      expired: [], routedUnclaimed: [] },
    { operatorDelivery });

  ok(payloads.filter(p => p.endpoint === 'wake').length === 1, 'mixed: one wake for the default agent');
  ok(payloads.filter(p => p.endpoint === 'agent').length === 1, 'mixed: one escalation for the orphan');
  ok(payloads.length === 2, 'mixed: no payload for the non-default owner');
  assertSessionSafe(payloads, 'mixed round');
}

// --- custom default agent via opts.wakeAgent ---
{
  const payloads = buildStuckNotifications(
    { stale: [{ id: 'T-1', project: 'p', title: 'A', staleSinceMinutes: 45, agent: 'ops' },
              { id: 'T-2', project: 'p', title: 'B', staleSinceMinutes: 50, agent: 'main' }],
      expired: [], routedUnclaimed: [] },
    { operatorDelivery, wakeAgent: 'ops' });

  ok(payloads.length === 1 && payloads[0].endpoint === 'wake' && /T-1/.test(payloads[0].body.text),
    'wakeAgent override: only the configured default agent is nudged');
  ok(!payloads.some(p => /T-2/.test(p.body.text || '')), 'wakeAgent override: tasks owned by other agents stay push-free');
}

// --- spread order: operator delivery config cannot smuggle in a session key ---
{
  const payloads = buildStuckNotifications(
    { stale: [{ id: 'T-9', project: 'p', title: 'orphan', staleSinceMinutes: 90 }], expired: [], routedUnclaimed: [] },
    { operatorDelivery: { ...operatorDelivery, sessionKey: 'agent:main:main', agentId: 'evil' } });

  const esc = payloads.find(p => p.endpoint === 'agent');
  ok(esc && esc.body.sessionKey === 'agent:main:flowboard-stuck-check',
    'operatorDelivery.sessionKey cannot override the throwaway escalation key');
  ok(esc && esc.body.agentId === 'main', 'operatorDelivery.agentId cannot override the escalation agent');
}

// --- guard: a live main key can never be configured as escalation target ---
{
  let threw = false;
  try {
    buildStuckNotifications(
      { stale: [{ id: 'T-9', project: 'p', title: 'orphan', staleSinceMinutes: 90 }], expired: [], routedUnclaimed: [] },
      { operatorDelivery, escalationSessionKey: 'agent:main:main' });
  } catch { threw = true; }
  ok(threw, 'escalationSessionKey matching agent:<x>:main is rejected');
}

// --- empty input: no payloads ---
ok(buildStuckNotifications({ stale: [], expired: [], routedUnclaimed: [] }, { operatorDelivery }).length === 0,
  'nothing stuck → no notifications');

console.log(fail === 0 ? `\n✅ stuck-notify routing: all ${pass} checks passed` : `\n❌ stuck-notify routing: ${fail} failed, ${pass} passed`);
if (fail) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
