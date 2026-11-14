/**
 * Which tasks a session panel shows (T-515-6). Pure and DOM-free so the suite
 * tests it directly.
 *
 * FlowBoard claims belong to an agent, not to one of its sessions, so the
 * panel shows the work the session's agent holds in the session's project.
 */
const PANEL_STATUSES = ['in-progress', 'review'];

/** The project bound to this session, else the agent-wide one, else null. */
export function resolveSessionProject(agents, { agentId, sessionKey } = {}) {
  if (!agentId || !Array.isArray(agents)) return null;
  const row = agents.find((agent) => agent?.agent_id === agentId);
  if (!row) return null;
  const session = sessionKey && Array.isArray(row.sessions)
    ? row.sessions.find((entry) => entry?.sessionKey === sessionKey)
    : null;
  return session?.activeProject || row.active_project || null;
}

/** The agent's claimed tasks: in progress first, then waiting for review. */
export function pickSessionTasks(tasks, agentId) {
  if (!agentId || !Array.isArray(tasks)) return [];
  return tasks
    .filter((task) => task && task.agent === agentId && !task.trashedAt && PANEL_STATUSES.includes(task.status))
    .sort((a, b) => PANEL_STATUSES.indexOf(a.status) - PANEL_STATUSES.indexOf(b.status)
      || String(b.lastCheckpointAt || b.claimedAt || '').localeCompare(String(a.lastCheckpointAt || a.claimedAt || '')));
}

/** Comments and checkpoints as one feed, newest first, bounded. */
export function mergeTaskFeed(comments, checkpoints, limit = 8) {
  const rows = [
    ...(Array.isArray(comments) ? comments : []).map((entry) => ({ kind: 'comment', entry })),
    ...(Array.isArray(checkpoints) ? checkpoints : []).map((entry) => ({ kind: 'checkpoint', entry })),
  ].map(({ kind, entry }) => ({
    kind,
    author: entry?.author || entry?.agent || null,
    text: String(entry?.message || entry?.text || ''),
    timestamp: entry?.timestamp || null,
  })).filter((row) => row.text);
  rows.sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')));
  return rows.slice(0, limit);
}
