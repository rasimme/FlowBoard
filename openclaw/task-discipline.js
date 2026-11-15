/**
 * Checkpoint and completion discipline through host hooks (T-521).
 *
 * Agents forget checkpoints because nothing in a run reminds them. A reminder
 * in the injected project context is not an option: that document sits in the
 * stable part of the system prompt, and changing it re-sends the whole
 * conversation uncached (T-512). These two hooks leave the prompt prefix
 * alone:
 *
 *  - `after_tool_call` on `exec` observes a successful `git commit` whose
 *    subject names a task the agent holds and records a checkpoint for it.
 *    Server-side only, no tokens.
 *  - `before_agent_finalize` (opt-in) asks for one more model pass when the
 *    agent is about to finish while one of its claims has gone stale. The
 *    instruction is appended at the end of the conversation.
 *
 * This module imports nothing, so it can be unit-tested without the SDK.
 */

export const COMMIT_HOOK = 'after_tool_call';
export const FINALIZE_HOOK = 'before_agent_finalize';
export const REMINDER_KEY = 'flowboard:checkpoint-reminder';
export const MAX_CHECKPOINT_MESSAGE = 256;
const MAX_TASK_IDS = 3;
const MAX_RESULT_TEXT = 20000;
const MAX_REMEMBERED_CALLS = 200;
const TASK_ID = /\bT-\d{1,6}(?:-\d{1,4})?\b/g;

function collectText(value, out, depth = 0) {
  if (out.length >= 200 || depth > 6 || value == null) return;
  if (typeof value === 'string') { out.push(value); return; }
  if (Array.isArray(value)) { for (const item of value) collectText(item, out, depth + 1); return; }
  if (typeof value === 'object') { for (const item of Object.values(value)) collectText(item, out, depth + 1); }
}

function resultText(result) {
  const parts = [];
  collectText(result, parts);
  return parts.join('\n').slice(0, MAX_RESULT_TEXT);
}

function exitedCleanly(result) {
  if (!result || typeof result !== 'object') return false;
  for (const key of ['exitCode', 'exit_code', 'code', 'status']) {
    if (result[key] === 0) return true;
  }
  return Boolean(result.details && typeof result.details === 'object' && exitedCleanly(result.details));
}

/**
 * Read a finished `git commit` out of one exec call.
 *
 * A commit counts only when git confirmed it: either its summary line
 * (`[branch abc1234] subject`) is in the output, or the call reports exit
 * code 0 and the subject is readable from `-m`. A command that merely
 * contains the words is not enough — a failed commit must not checkpoint.
 */
export function readCommit(event) {
  const command = typeof event?.params?.command === 'string' ? event.params.command : '';
  if (!/\bgit\b[^\n]*\bcommit\b/u.test(command) || /--dry-run\b/u.test(command)) return null;
  if (event?.error) return null;
  const summary = /\[[^\]\n]*?\b([0-9a-f]{7,40})\] ([^\n]+)/u.exec(resultText(event.result));
  if (summary) return { sha: summary[1].slice(0, 12), subject: summary[2].trim() };
  if (!exitedCleanly(event.result)) return null;
  const message = /\s-m\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/u.exec(command);
  const subject = (message?.[1] ?? message?.[2] ?? '').split('\n')[0].trim();
  return subject ? { sha: null, subject } : null;
}

export function taskIdsIn(text) {
  return [...new Set(String(text || '').match(TASK_ID) || [])].slice(0, MAX_TASK_IDS);
}

export function agentIdFrom(ctx, sessionKey) {
  if (typeof ctx?.agentId === 'string' && ctx.agentId) return ctx.agentId;
  const match = /^agent:([^:]+):/u.exec(typeof sessionKey === 'string' ? sessionKey : '');
  return match ? match[1] : null;
}

export function checkpointMessage(commit) {
  const text = commit.sha ? `Commit ${commit.sha}: ${commit.subject}` : `Commit: ${commit.subject}`;
  return text.replace(/\s+/gu, ' ').slice(0, MAX_CHECKPOINT_MESSAGE);
}

/**
 * `adapter` needs `getStatus`, `getTask`, `addCheckpoint` and `listStuck`.
 * Every failure is swallowed and logged at debug level: a hook must never
 * break a tool call or a run.
 */
export function createTaskDiscipline({ adapter, logger } = {}) {
  const seen = new Set();
  const debug = (message) => logger?.debug?.(`[flowboard] ${message}`);

  async function onAfterToolCall(event, ctx) {
    try {
      const commit = readCommit(event);
      if (!commit) return;
      const ids = taskIdsIn(commit.subject);
      if (ids.length === 0) return;
      const callId = event.toolCallId || ctx?.toolCallId;
      if (callId) {
        if (seen.has(callId)) return;
        seen.add(callId);
        if (seen.size > MAX_REMEMBERED_CALLS) seen.delete(seen.values().next().value);
      }
      const sessionKey = typeof ctx?.sessionKey === 'string' ? ctx.sessionKey : null;
      const agentId = agentIdFrom(ctx, sessionKey);
      if (!agentId) return;
      const status = await adapter.getStatus(agentId, sessionKey);
      const project = status?.activeProject;
      if (!project) return;
      for (const id of ids) {
        const task = await adapter.getTask(project, id).catch(() => null);
        // Only a live claim of this agent: the commit is evidence of its work.
        if (!task || task.agent !== agentId || !task.claimedAt || task.status !== 'in-progress') continue;
        await adapter.addCheckpoint(project, id, { agent: agentId, message: checkpointMessage(commit), sessionKey });
      }
    } catch (error) {
      debug(`commit checkpoint skipped: ${error?.message || error}`);
    }
  }

  async function onBeforeAgentFinalize(event, ctx) {
    try {
      // The harness is already in a hook-requested pass: never ask twice.
      if (event?.stopHookActive) return undefined;
      const sessionKey = event?.sessionKey || ctx?.sessionKey || null;
      const agentId = agentIdFrom(ctx, sessionKey);
      if (!agentId) return undefined;
      const stuck = await adapter.listStuck();
      const mine = [...(stuck?.stale || []), ...(stuck?.expired || [])].filter((entry) => entry?.agent === agentId);
      const ids = [...new Set(mine.map((entry) => `${entry.project}/${entry.taskId || entry.id}`))].slice(0, 5);
      if (ids.length === 0) return undefined;
      const instruction =
        `You hold FlowBoard claims without a recent checkpoint: ${ids.join(', ')}. ` +
        'Before finishing, record a checkpoint for each, or complete or release it if the work is done or abandoned. ' +
        'If you already did, just finish.';
      return {
        action: 'revise',
        reason: 'FlowBoard claims need a checkpoint or completion',
        retry: { instruction, idempotencyKey: REMINDER_KEY, maxAttempts: 1 },
      };
    } catch (error) {
      debug(`finalize reminder skipped: ${error?.message || error}`);
      return undefined;
    }
  }

  return { onAfterToolCall, onBeforeAgentFinalize };
}

/**
 * Register the hooks a host supports. Returns the names that were registered.
 * `commitCheckpoints` defaults to on; `finalizeReminder` is opt-in because the
 * host only runs it with `hooks.allowConversationAccess` granted.
 */
export function registerTaskDiscipline(api, { adapter, config = {} } = {}) {
  const registered = [];
  if (typeof api?.on !== 'function') return registered;
  const hooks = createTaskDiscipline({ adapter, logger: api.logger });
  const add = (name, handler, options) => {
    try {
      api.on(name, handler, options);
      registered.push(name);
    } catch (error) {
      api.logger?.debug?.(`[flowboard] ${name} not available on this host: ${error?.message || error}`);
    }
  };
  if (config.commitCheckpoints !== false) add(COMMIT_HOOK, hooks.onAfterToolCall, { matcher: ['exec'], timeoutMs: 10000 });
  if (config.finalizeReminder === true) add(FINALIZE_HOOK, hooks.onBeforeAgentFinalize, { timeoutMs: 10000 });
  return registered;
}
