// T-515-6: which project and tasks the native session panel shows.
import assert from 'node:assert/strict';
import { mergeTaskFeed, pickSessionTasks, resolveSessionProject } from '../openclaw/native-ui/session-tasks.js';

const agents = [
  { agent_id: 'a', active_project: 'wide', sessions: [{ sessionKey: 's1', activeProject: 'bound' }] },
  { agent_id: 'b', active_project: null, sessions: [] },
];
assert.equal(resolveSessionProject(agents, { agentId: 'a', sessionKey: 's1' }), 'bound', 'session binding wins');
assert.equal(resolveSessionProject(agents, { agentId: 'a', sessionKey: 'other' }), 'wide', 'falls back to the agent binding');
assert.equal(resolveSessionProject(agents, { agentId: 'b', sessionKey: 's1' }), null, 'another agent\'s session key grants nothing');
assert.equal(resolveSessionProject(agents, { agentId: 'zz' }), null);
assert.equal(resolveSessionProject(null, { agentId: 'a' }), null);

const tasks = [
  { id: 'T-1', agent: 'a', status: 'review', claimedAt: '2026-01-01' },
  { id: 'T-2', agent: 'a', status: 'in-progress', lastCheckpointAt: '2026-01-02' },
  { id: 'T-3', agent: 'a', status: 'in-progress', lastCheckpointAt: '2026-01-03' },
  { id: 'T-4', agent: 'b', status: 'in-progress' },
  { id: 'T-5', agent: 'a', status: 'done' },
  { id: 'T-6', agent: 'a', status: 'in-progress', trashedAt: '2026-01-01' },
];
assert.deepEqual(pickSessionTasks(tasks, 'a').map((t) => t.id), ['T-3', 'T-2', 'T-1'], 'in progress first, newest first, then review');
assert.deepEqual(pickSessionTasks(tasks, null), []);

const feed = mergeTaskFeed(
  [{ author: 'human', message: 'c1', timestamp: '2026-01-02' }, { message: '' }],
  [{ agent: 'a', message: 'k1', timestamp: '2026-01-03' }],
);
assert.deepEqual(feed.map((r) => [r.kind, r.author, r.text]), [['checkpoint', 'a', 'k1'], ['comment', 'human', 'c1']]);
assert.equal(mergeTaskFeed(Array.from({ length: 20 }, (_, i) => ({ message: `m${i}`, timestamp: String(i).padStart(2, '0') })), [], 5).length, 5);
console.log('✅ native session tasks: all checks passed');
