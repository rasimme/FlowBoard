'use strict';

/**
 * T-400 — routing for the 5-minute stuck-check notification.
 *
 * Splits the "wake a hung agent" concern from the "ping the operator" concern,
 * which the old code conflated (every stuck round was delivered to the operator
 * via Telegram, including a blanket fallback to the `main` agent).
 *
 *  - A task WITH a responsible agent wakes only THAT agent's session. The wake
 *    payload uses channel `'none'` so the gateway runs/nudges the agent
 *    (`message` is its inbound prompt) without any outbound Telegram delivery —
 *    the operator stays quiet.
 *  - Tasks WITHOUT a responsible agent (orphaned stale/expired, routed-but-never
 *    -claimed with no routedAgent) escalate to the operator in ONE message,
 *    using the configured operator delivery. The 60-min notification window in
 *    getNotifiableStuckTasks() already throttles repeats.
 *
 * Pure function: returns the array of gateway `/hooks/agent` request bodies, so
 * the scheduler's routing is unit-testable without touching the live gateway.
 *
 * @param {{stale?:Array, expired?:Array, routedUnclaimed?:Array}} lists
 * @param {{operatorDelivery?:object, wakeChannel?:string}} [opts]
 *   operatorDelivery — delivery fields for the operator escalation
 *     (e.g. { channel:'telegram', target, to } from flowboardNotificationDelivery()).
 *   wakeChannel — channel for owner wake payloads. Default 'none' (no outbound).
 * @returns {Array<object>} gateway request bodies
 */
function buildStuckNotifications(lists = {}, opts = {}) {
  const stale = Array.isArray(lists.stale) ? lists.stale : [];
  const expired = Array.isArray(lists.expired) ? lists.expired : [];
  const routedUnclaimed = Array.isArray(lists.routedUnclaimed) ? lists.routedUnclaimed : [];
  const wakeChannel = opts.wakeChannel || 'none';
  const operatorDelivery = opts.operatorDelivery || {};

  const byAgent = {}; // owner agent → entries (silent wake)
  const unowned = []; // no responsible agent → operator escalation
  const pushOwned = (agent, entry) => { (byAgent[agent] = byAgent[agent] || []).push(entry); };

  for (const t of stale) {
    const entry = { type: 'stale', id: t.id, project: t.project, title: t.title, staleSinceMinutes: t.staleSinceMinutes };
    if (t.agent) pushOwned(t.agent, entry); else unowned.push(entry);
  }
  for (const t of expired) {
    const entry = { type: 'lease_expired', id: t.id, project: t.project, title: t.title };
    if (t.agent) pushOwned(t.agent, entry); else unowned.push(entry);
  }
  for (const t of routedUnclaimed) {
    const entry = { type: 'routed_unclaimed', id: t.id, project: t.project, title: t.title };
    if (t.routedAgent) pushOwned(t.routedAgent, entry); else unowned.push(entry);
  }

  const fmt = (t) =>
    t.type === 'stale' ? `⚠️ ${t.id} "${t.title}" — ${t.staleSinceMinutes}min without checkpoint`
    : t.type === 'lease_expired' ? `🔴 ${t.id} "${t.title}" — lease expired`
    : `📨 ${t.id} "${t.title}" — routed to you, never claimed`;

  const payloads = [];

  // Owner wakes — no operator delivery (channel 'none').
  for (const agent of Object.keys(byAgent)) {
    const tasks = byAgent[agent];
    payloads.push({
      message: `🔍 Stuck-Check (${agent}):\n${tasks.map(fmt).join('\n')}`,
      name: 'FlowBoard Stuck-Check',
      channel: wakeChannel,
      wakeMode: 'now',
      stuck: tasks,
      agentId: agent,
      sessionKey: `agent:${agent}:main`,
    });
  }

  // Orphaned tasks — a single operator escalation.
  if (unowned.length) {
    payloads.push({
      message: `🔍 Stuck-Check (unowned):\n${unowned.map(fmt).join('\n')}`,
      name: 'FlowBoard Stuck-Check',
      ...operatorDelivery,
      wakeMode: 'now',
      stuck: unowned,
    });
  }

  return payloads;
}

module.exports = { buildStuckNotifications };
