'use strict';

/**
 * T-434 — session-safe routing for the 5-minute stuck-check notification.
 *
 * Hard rule: a gateway request may NEVER target a live main session key
 * (`agent:<x>:main`). The gateway's `/hooks/agent` endpoint always runs an
 * isolated agent turn and force-rolls whatever session key it is pointed at,
 * wiping that conversation's context. Pointing it at the operator's (or any
 * agent's) main session reset the live conversation every scheduler round
 * and injected unrelated project context into it (incident 2026-07-06).
 *
 * Routing (replaces the T-400 owner-wake/agent-turn design):
 *  - Tasks owned by the gateway DEFAULT agent (`opts.wakeAgent`, default
 *    `'main'`) are bundled into one `/hooks/wake` payload — a system event
 *    the gateway enqueues into the existing main session WITHOUT resetting
 *    it; `mode: 'now'` asks for an immediate heartbeat so the reminder is
 *    processed in-context.
 *  - Tasks owned by ANY OTHER agent (other gateway agents, external agents
 *    such as Claude Code) get no push: `/hooks/wake` cannot address them and
 *    `/hooks/agent` must not. Their reminder is board state — the scheduler
 *    posts a task comment and `/api/status` serves `attention.stuckTasks`
 *    (see T-434 spec), which every agent reads on its next FlowBoard touch.
 *  - Tasks WITHOUT a responsible agent escalate to the operator in ONE
 *    `/hooks/agent` triage turn on a dedicated throwaway session key
 *    (`opts.escalationSessionKey`, default `agent:main:flowboard-stuck-check`)
 *    that is nobody's conversation, delivered via the configured operator
 *    channel. The 60-min window in getNotifiableStuckTasks() throttles repeats.
 *
 * Pure function: returns `[{ endpoint: 'wake'|'agent', body }]` so the
 * scheduler's routing is unit-testable without touching the live gateway.
 *
 * @param {{stale?:Array, expired?:Array, routedUnclaimed?:Array, workState?:Array}} lists
 * @param {{operatorDelivery?:object, wakeAgent?:string, escalationSessionKey?:string}} [opts]
 *   operatorDelivery — delivery fields for the operator escalation
 *     (e.g. { channel:'telegram', target, to } from flowboardNotificationDelivery()).
 *   wakeAgent — gateway default agent reachable via /hooks/wake. Default 'main'.
 *   escalationSessionKey — throwaway session key for the escalation turn.
 * @returns {Array<{endpoint:'wake'|'agent', body:object}>} gateway requests
 */

// Live interactive session keys — never a valid notification target.
const LIVE_MAIN_SESSION_KEY_RE = /^agent:[^:]+:main$/;

const DEFAULT_ESCALATION_SESSION_KEY = 'agent:main:flowboard-stuck-check';

function buildStuckNotifications(lists = {}, opts = {}) {
  const stale = Array.isArray(lists.stale) ? lists.stale : [];
  const expired = Array.isArray(lists.expired) ? lists.expired : [];
  const routedUnclaimed = Array.isArray(lists.routedUnclaimed) ? lists.routedUnclaimed : [];
  const workState = Array.isArray(lists.workState) ? lists.workState : [];
  const wakeAgent = opts.wakeAgent || 'main';
  const escalationSessionKey = opts.escalationSessionKey || DEFAULT_ESCALATION_SESSION_KEY;
  const operatorDelivery = opts.operatorDelivery || {};

  if (LIVE_MAIN_SESSION_KEY_RE.test(escalationSessionKey)) {
    throw new Error(`escalationSessionKey must not target a live main session key: ${escalationSessionKey}`);
  }

  const defaultAgentTasks = []; // owned by the gateway default agent → /hooks/wake
  const unowned = [];           // no responsible agent → operator escalation
  const seen = new Set();       // one delivery per task per evaluation

  const route = (agent, entry) => {
    const key = `${entry.project}:${entry.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (!agent) unowned.push(entry);
    else if (agent === wakeAgent) defaultAgentTasks.push(entry);
    // other owners: no push — board state (comment + status attention) reminds them
  };

  for (const t of stale) {
    route(t.agent, { type: 'stale', id: t.id, project: t.project, title: t.title, staleSinceMinutes: t.staleSinceMinutes });
  }
  for (const t of expired) {
    route(t.agent, { type: 'lease_expired', id: t.id, project: t.project, title: t.title });
  }
  for (const t of routedUnclaimed) {
    route(t.routedAgent, { type: 'routed_unclaimed', id: t.id, project: t.project, title: t.title });
  }
  for (const t of workState) {
    route(t.agent, {
      type: t.reason || t.workState || 'work_state',
      id: t.id,
      project: t.project,
      title: t.title,
      workState: t.workState,
      checkAgainAt: t.checkAgainAt || null,
    });
  }

  const fmt = (t) =>
    t.type === 'stale' ? `⚠️ ${t.project}/${t.id} "${t.title}" — ${t.staleSinceMinutes}min without checkpoint`
    : t.type === 'lease_expired' ? `🔴 ${t.project}/${t.id} "${t.title}" — lease expired`
    : t.type === 'routed_unclaimed' ? `📨 ${t.project}/${t.id} "${t.title}" — routed, never claimed`
    : `⏳ ${t.project}/${t.id} "${t.title}" — work state ${t.workState || t.type}`;

  const payloads = [];

  // Default-agent nudge — one bundled system event, session preserved.
  if (defaultAgentTasks.length) {
    payloads.push({
      endpoint: 'wake',
      body: {
        text: `🔍 FlowBoard stuck reminder (${wakeAgent}):\n${defaultAgentTasks.map(fmt).join('\n')}\nWrite a checkpoint or release each task.`,
        mode: 'now',
      },
    });
  }

  // Orphaned tasks — a single operator escalation on a throwaway key.
  if (unowned.length) {
    payloads.push({
      endpoint: 'agent',
      body: {
        message: `🔍 Stuck-Check (unowned):\n${unowned.map(fmt).join('\n')}`,
        name: 'FlowBoard Stuck-Check',
        ...operatorDelivery,
        wakeMode: 'now',
        stuck: unowned,
        agentId: wakeAgent,
        sessionKey: escalationSessionKey,
      },
    });
  }

  return payloads;
}

module.exports = { buildStuckNotifications, LIVE_MAIN_SESSION_KEY_RE };
