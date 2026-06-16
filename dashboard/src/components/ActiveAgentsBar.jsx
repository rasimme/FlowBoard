import { useMemo } from 'react';
import { useAppState } from '../context/AppStateContext.jsx';
import AgentChip from './AgentChip.jsx';
import { isActivelyClaimed } from '../utils/formatting.js';

/**
 * T-161 C2 Labeled bar — the active-context zone above the kanban.
 *
 * Answers: "Who is currently active on THIS project, and what are they on?"
 *
 * Two layers rendered side-by-side on each pill:
 *   - Layer 1 (project activity): agent.active_project === viewedProject
 *     → drives which pills appear at all
 *   - Layer 2 (task ownership): task.agent === agent.agent_id with task.claimedAt set
 *     → drives the small sub-line under the handle
 *
 * Rules:
 *   - No pills → the bar renders nothing (hidden, not an empty strip)
 *   - Routed agents are NOT shown here — route is soft, claim is hard
 *   - Done / completed tasks are ignored when picking the "current" claim
 *   - If an agent is active on this project but has no current claim in it,
 *     the pill still shows (Layer 1 is the primary driver) with a muted "no
 *     active task" sub-line, so the user can see presence without ownership.
 */
export default function ActiveAgentsBar() {
  const { state } = useAppState();
  const viewedProject = state?.viewedProject;
  const agents = state?.agents || [];
  const tasks = state?.tasks || [];

  const activeHere = useMemo(() => {
    if (!viewedProject) return [];
    const claimedByAgent = new Map();
    for (const t of tasks) {
      if (!isActivelyClaimed(t)) continue;
      // First claim wins if an agent somehow has multiple open claims in the
      // same project — dashboard stays deterministic and doesn't guess.
      if (!claimedByAgent.has(t.agent)) claimedByAgent.set(t.agent, t);
    }
    const rows = [];
    for (const a of agents) {
      if (!a?.agent_id) continue;
      if (a.active_project !== viewedProject) continue;
      rows.push({ agentId: a.agent_id, task: claimedByAgent.get(a.agent_id) || null });
    }
    // Stable order by agent id so the bar doesn't shuffle between polls.
    rows.sort((a, b) => String(a.agentId).localeCompare(String(b.agentId)));
    return rows;
  }, [agents, tasks, viewedProject]);

  if (!viewedProject || activeHere.length === 0) return null;

  return (
    <div className="active-agents-bar" role="region" aria-label="Agents active on this project">
      <div className="active-agents-bar__label">Active on this project</div>
      <div className="active-agents-bar__list">
        {activeHere.map(({ agentId, task }) => (
          <ActiveAgentPill key={agentId} agentId={agentId} task={task} />
        ))}
      </div>
    </div>
  );
}

function formatHandle(agentId) {
  const s = String(agentId || '');
  return s.startsWith('@') ? s : `@${s}`;
}

function ActiveAgentPill({ agentId, task }) {
  const handle = formatHandle(agentId);
  const onClick = task?.id
    ? (e) => {
        e.preventDefault();
        if (window.openTaskDetail) window.openTaskDetail(task.id);
      }
    : undefined;

  return (
    <span
      className={`active-agents-pill${task ? ' has-task' : ''}`}
      onClick={onClick}
      role={task ? 'button' : undefined}
      tabIndex={task ? 0 : undefined}
      onKeyDown={task ? (e) => { if (e.key === 'Enter' || e.key === ' ') onClick?.(e); } : undefined}
      title={task ? `${handle} · ${task.id} ${task.title || ''}` : handle}
    >
      <AgentChip name={agentId} size="sm" />
      <span className="active-agents-pill__meta">
        <span className="active-agents-pill__name">{handle}</span>
        {task ? (
          <span className="active-agents-pill__task">
            <span className="active-agents-pill__task-id">{task.id}</span>
            <span aria-hidden="true"> · </span>
            <span className="active-agents-pill__task-title">{task.title || 'Untitled task'}</span>
          </span>
        ) : (
          <span className="active-agents-pill__task active-agents-pill__task--idle">No active task</span>
        )}
      </span>
    </span>
  );
}
