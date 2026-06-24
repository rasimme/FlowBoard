'use strict';

/**
 * T-417-16: append-only destructive-action audit log.
 *
 * Answers the ClawHub "Excessive Agency / no traceability" concern: every
 * destructive API action is recorded as one append-only JSONL line. The logger
 * MUST be fail-soft — a logging error can never break the request it audits.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { auditDestructive, resolveActor } = require('./audit-log.js');

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.error(`  ❌ ${m}`); } }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-audit-'));
const dir = path.join(tmp, '.audit');

console.log('# audit-log (T-417-16)');

// 1. appends one JSONL line with the expected fields + creates .audit/
const r1 = auditDestructive({ action: 'task.hard-delete', project: 'p1', target: 'T-9', actor: 'agent-x' }, { dir });
ok(r1 === true, 'returns true on success');
ok(fs.existsSync(path.join(dir, 'destructive.log')), '.audit/destructive.log created');
const lines1 = fs.readFileSync(path.join(dir, 'destructive.log'), 'utf8').trim().split('\n');
ok(lines1.length === 1, 'exactly one line appended');
const e1 = JSON.parse(lines1[0]);
ok(e1.action === 'task.hard-delete' && e1.project === 'p1' && e1.target === 'T-9' && e1.actor === 'agent-x',
  'entry records action/project/target/actor');
ok(typeof e1.ts === 'string' && !Number.isNaN(Date.parse(e1.ts)), 'entry has an ISO timestamp');

// 2. append-only (does not overwrite)
auditDestructive({ action: 'trash.empty', project: 'p1', target: null, actor: 'agent-y' }, { dir });
const lines2 = fs.readFileSync(path.join(dir, 'destructive.log'), 'utf8').trim().split('\n');
ok(lines2.length === 2, 'second call appends (append-only)');

// 3. fail-soft: an unwritable log path must NOT throw into the caller
let threw = false;
try { auditDestructive({ action: 'x', project: 'p', target: 't', actor: 'a' }, { dir: '/dev/null/cannot-write' }); }
catch { threw = true; }
ok(threw === false, 'never throws when the log cannot be written (fail-soft)');

// 4. actor resolution precedence
ok(resolveActor({ user: { agentId: 'a1' }, body: { actor: 'b1' } }) === 'a1', 'resolveActor prefers req.user.agentId');
ok(resolveActor({ body: { actor: 'b1' } }) === 'b1', 'resolveActor falls back to body.actor');
ok(resolveActor({}) === 'localhost-unauth', 'resolveActor defaults to localhost-unauth');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n✅ ${pass} passed, ❌ ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
