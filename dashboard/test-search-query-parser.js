'use strict';

// T-369 — Smart search query parser (operators + task-id detection).

const { parseQuery } = require('./smart-search');

let pass = 0;
let fail = 0;
const failures = [];

function ok(condition, message) {
  if (condition) { pass++; console.log(`  ok - ${message}`); }
  else { fail++; failures.push(message); console.log(`  not ok - ${message}`); }
}
function eq(actual, expected, message) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), `${message} (got ${JSON.stringify(actual)})`);
}

console.log('# Smart search — query parser (T-369)');

// --- task-id detection / normalization ---
eq(parseQuery('369').idQuery, 'T-369', 'bare number → T-369');
eq(parseQuery('T-369').idQuery, 'T-369', 'T-369 → T-369');
eq(parseQuery('t369').idQuery, 'T-369', 't369 → T-369');
eq(parseQuery('t-369').idQuery, 'T-369', 't-369 → T-369');
eq(parseQuery('13').idQuery, 'T-13', 'leading-zero-insensitive: 13 → T-13');
eq(parseQuery('042').idQuery, 'T-42', 'leading zeros stripped: 042 → T-42');
eq(parseQuery('T-042-1').idQuery, 'T-42-1', 'subtask id normalized (zeros stripped)');
eq(parseQuery('auth bug').idQuery, null, 'free text → no id');
eq(parseQuery('').idQuery, null, 'empty → no id');

// --- free text remainder ---
eq(parseQuery('auth bug').text, 'auth bug', 'free text passes through');
eq(parseQuery('status:review auth').text, 'auth', 'operator stripped from text');
eq(parseQuery('  status:review   ').text, '', 'operator-only → empty text');

// --- status operator (+ alias, + multiple = OR) ---
eq(parseQuery('status:review').filters.status, ['review'], 'status:review');
eq(parseQuery('status:wip').filters.status, ['in-progress'], 'status:wip alias → in-progress');
eq(parseQuery('status:review status:done').filters.status, ['review', 'done'], 'multiple status = OR');

// --- project / agent operators ---
eq(parseQuery('project:FlowBoard x').filters.project, 'FlowBoard', 'project raw (resolved later)');
eq(parseQuery('project:FlowBoard x').text, 'x', 'project stripped from text');
eq(parseQuery('agent:claude-code-3').filters.agent, 'claude-code-3', 'agent id lowercased-passthrough');
eq(parseQuery('agent:NONE').filters.agent, 'none', 'agent:none sentinel (lowercased)');
eq(parseQuery('agent:unclaimed').filters.agent, 'none', 'agent:unclaimed → none sentinel');

// --- is: / has: facets ---
eq(parseQuery('is:blocked is:unclaimed').filters.is, ['blocked', 'unclaimed'], 'is facets collected');
eq(parseQuery('has:spec').filters.hasSpec, true, 'has:spec → hasSpec true');
eq(parseQuery('auth').filters.hasSpec, false, 'no has:spec → false');

// --- unknown key is treated as free text, not an operator ---
eq(parseQuery('foo:bar baz').filters.status, [], 'unknown key not a status');
ok(parseQuery('foo:bar baz').text.includes('foo:bar'), 'unknown key stays in free text');

console.log(`\n# parser: ${pass} passed, ${fail} failed`);
if (fail > 0) { console.error('FAILURES:\n' + failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
