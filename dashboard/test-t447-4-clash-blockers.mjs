import assert from 'node:assert/strict';
import fs from 'node:fs';
import { apiJson } from './src/utils/apiFetch.js';
import { boardTopLevelTasks, tasksForExceptionReview } from './src/utils/exceptionReview.mjs';

const parent = { id: 'T-447-4-1', parentId: null, exceptionReview: null };
const delegated = {
  id: 'T-447-4-1-1',
  parentId: parent.id,
  exceptionReview: { status: 'pending' },
};
const reviewed = {
  id: 'T-447-4-1-2',
  parentId: parent.id,
  exceptionReview: { status: 'reviewed' },
};

const pending = tasksForExceptionReview([parent, delegated, reviewed], true);
assert.deepEqual(pending.map(task => task.id), [delegated.id],
  'exception filter retains pending delegated subtasks');
assert.deepEqual(boardTopLevelTasks(pending, true), pending,
  'exception view does not discard pending tasks with parentId');
assert.deepEqual(boardTopLevelTasks([parent, delegated], false), [parent],
  'normal board view still limits cards to top-level tasks');

const detailPanel = fs.readFileSync(new URL('./src/components/DetailPanel.jsx', import.meta.url), 'utf8');
assert.match(detailPanel,
  /import \{ apiJson as apiFetch \} from '\.\.\/utils\/apiFetch\.js'/,
  'DetailPanel keeps the parsed JSON API wrapper for all CRUD calls');
assert.match(detailPanel,
  /apiFetch\(`\/projects\/\$\{project\}\/tasks\/\$\{t\.id\}\/exception-review`/,
  'DetailPanel uses the legacy path that apiJson normalizes for exception review');
assert.match(detailPanel,
  /const result = await apiFetch\(`\/projects\/\$\{project\}\/tasks\/\$\{t\.id\}\/exception-review`[\s\S]*?\n\s*\}\);[\s\S]*?if \(result\?\.error\)/,
  'DetailPanel consumes the parsed review response from apiJson');

global.window = { location: { origin: 'http://127.0.0.1:18790' }, Telegram: {} };
let requestPath = null;
global.fetch = async (path) => {
  requestPath = path;
  return new Response(JSON.stringify({ ok: true, task: { id: 'T-447-4-review' } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
const reviewResult = await apiJson('/projects/demo/tasks/T-447-4-review/exception-review', { method: 'POST' });
assert.equal(requestPath, '/api/projects/demo/tasks/T-447-4-review/exception-review',
  'apiJson normalizes the old /projects path before fetch');
assert.deepEqual(reviewResult.task, { id: 'T-447-4-review' },
  'apiJson returns parsed JSON for the review action');

console.log('T-447-4 clash blocker regressions: all passed');
