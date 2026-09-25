import { apiFetch } from './apiFetch.js';

/**
 * Create a backlog task from the dashboard, with the Specify recovery.
 *
 * Shared by the board's inline New Task form and the framed Specify surface
 * (T-499) so both follow one flow:
 *   - 2xx                       -> { kind: 'created', data }  (data = API body)
 *   - 409 SPECIFY_REQUIRED       -> start a Specify session from the reusable
 *     specifyRequest            -> { kind: 'specify', sessionId }
 *   - anything else             -> throws Error(message)
 *
 * Enforce-mode direct creation returns a reusable request. Starting Specify
 * here is the explicit Dashboard recovery action; the API rejection itself
 * never creates a session or task.
 */
export async function createBacklogTask({ project, title, priority }) {
  const res = await apiFetch(`/api/projects/${project}/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, priority, status: 'backlog' }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok) return { kind: 'created', data };
  if (res.status === 409 && data.code === 'SPECIFY_REQUIRED' && data.specifyRequest) {
    const sessionRes = await apiFetch('/api/specify/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project,
        origin: 'tasks-api',
        agentId: 'human',
        transport: 'dashboard',
        specifyRequest: data.specifyRequest,
      }),
    });
    const sessionData = await sessionRes.json().catch(() => ({}));
    if (!sessionRes.ok || !sessionData.session?.id) {
      throw new Error(sessionData.error || 'Failed to start Specify recovery');
    }
    return { kind: 'specify', sessionId: sessionData.session.id };
  }
  throw new Error(data.error || 'Failed to create task');
}
