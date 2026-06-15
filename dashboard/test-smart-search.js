'use strict';

// T-369 — Smart search matcher + ranker (pure, in-memory).

const { rankTasks } = require('./smart-search');

let pass = 0, fail = 0;
const failures = [];
function ok(c, m) { if (c) { pass++; console.log(`  ok - ${m}`); } else { fail++; failures.push(m); console.log(`  not ok - ${m}`); } }
const ids = (rows) => rows.map(r => r.id);

const TASKS = [
  { id: 'T-369', title: 'Smarte Suche', status: 'in-progress', project: 'flowboard', agent: 'claude-code-3', specFile: 'specs/x.md', tags: ['v5', 'search'], created: '2026-06-15', priority: 'medium' },
  { id: 'T-13', title: 'User authentication flow', status: 'review', project: 'flowboard', agent: null, specFile: null, tags: [], created: '2026-06-01', priority: 'high' },
  { id: 'T-42', title: 'Checkpoint cleanup', status: 'done', project: 'flowboard', agent: null, specFile: null, tags: [], created: '2026-05-20', priority: 'low' },
  { id: 'T-7', title: 'Search', status: 'backlog', project: 'flowboard', agent: null, specFile: null, tags: [], created: '2026-04-01', priority: 'medium' },
  { id: 'T-8', title: 'Search palette improvements', status: 'backlog', project: 'flowboard', agent: null, specFile: null, tags: [], created: '2026-04-02', priority: 'medium' },
  { id: 'T-9', title: 'auth', status: 'done', project: 'flowboard', agent: null, specFile: null, tags: [], created: '2026-04-03', priority: 'medium' },
  { id: 'T-10', title: 'auth', status: 'in-progress', project: 'flowboard', agent: 'dev-botti', specFile: null, tags: [], created: '2026-04-03', priority: 'medium' },
  { id: 'T-11', title: 'Mobile layout', status: 'blocked', project: 'other', agent: null, specFile: null, blocked: true, tags: [], created: '2026-04-04', priority: 'medium' },
];

console.log('# Smart search — matcher + ranker (T-369)');

// --- task-id query ---
{
  const r = rankTasks(TASKS, '369');
  ok(r.length >= 1 && r[0].id === 'T-369', 'bare number finds T-369 as top hit');
  ok(r[0].exact === true, 'exact id hit is flagged exact');
}
ok(rankTasks(TASKS, 'T-369')[0].id === 'T-369', 'T-369 finds T-369');
ok(ids(rankTasks(TASKS, '36')).includes('T-369'), 'id prefix 36 finds T-369');

// --- infix / partial-word ---
ok(ids(rankTasks(TASKS, 'thent')).includes('T-13'), 'infix "thent" → authentication');

// --- typo tolerance ---
ok(ids(rankTasks(TASKS, 'chekpoint')).includes('T-42'), 'typo "chekpoint" → Checkpoint');
ok(ids(rankTasks(TASKS, 'serach')).includes('T-7') || ids(rankTasks(TASKS, 'serach')).includes('T-8'), 'typo "serach" → Search');

// --- negative: nonsense matches nothing ---
ok(rankTasks(TASKS, 'zzzzz').length === 0, 'nonsense query → no results');

// --- ranking: exact title before partial ---
{
  const r = ids(rankTasks(TASKS, 'search')).filter(id => id === 'T-7' || id === 'T-8');
  ok(r[0] === 'T-7' && r[1] === 'T-8', 'exact title "Search" ranks before partial');
}

// --- ranking: status tie-break (active before done at equal text score) ---
{
  const r = ids(rankTasks(TASKS, 'auth')).filter(id => id === 'T-9' || id === 'T-10');
  ok(r[0] === 'T-10' && r[1] === 'T-9', 'in-progress ranks before done at tie');
}

// --- operator filters ---
ok(rankTasks(TASKS, 'status:review').every(t => t.status === 'review'), 'status:review filters by status');
ok(rankTasks(TASKS, 'status:review').length === 1, 'status:review returns the one review task');
ok(rankTasks(TASKS, 'is:blocked').every(t => t.blocked === true), 'is:blocked filters blocked');
ok(rankTasks(TASKS, 'is:unclaimed').every(t => !t.agent), 'is:unclaimed → no agent');
ok(rankTasks(TASKS, 'has:spec').every(t => t.specFile), 'has:spec → only tasks with a spec');
ok(rankTasks(TASKS, 'agent:dev-botti').every(t => t.agent === 'dev-botti'), 'agent filter');
ok(rankTasks(TASKS, 'project:other').every(t => t.project === 'other'), 'project filter');

// --- operator + free text combined ---
{
  const r = rankTasks(TASKS, 'status:in-progress auth');
  ok(r.length === 1 && r[0].id === 'T-10', 'status + free text narrows correctly');
}

// --- operator-only returns filtered set (no text scoring) ---
ok(rankTasks(TASKS, 'is:unclaimed').length >= 3, 'operator-only returns all matches');

console.log(`\n# ranker: ${pass} passed, ${fail} failed`);
if (fail > 0) { console.error('FAILURES:\n' + failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
