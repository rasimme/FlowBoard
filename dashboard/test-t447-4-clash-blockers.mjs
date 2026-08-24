import assert from 'node:assert/strict';
import fs from 'node:fs';
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
  /apiFetch\(`\/api\/projects\/\$\{project\}\/tasks\/\$\{t\.id\}\/exception-review`/,
  'DetailPanel uses the canonical API path for exception review');
assert.match(detailPanel,
  /const result = await response\.json\(\)/,
  'DetailPanel awaits and parses the review response JSON');

console.log('T-447-4 clash blocker regressions: all passed');
