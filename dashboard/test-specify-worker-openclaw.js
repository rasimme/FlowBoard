'use strict';

const { createOpenClawCliAdapter, buildWorkerPrompt, extractJsonObject } = require('./specify-worker-openclaw');

let pass = 0, fail = 0, failures = [];

function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✅ ${msg}`); }
  else { fail++; failures.push(msg); console.log(`  ❌ ${msg}`); }
}

function section(title) { console.log(`\n## ${title}\n`); }

const SAMPLE_REQUEST = {
  sessionId: 'specify-123-1',
  project: 'demo',
  origin: 'canvas',
  directive: 'next',
  input: {
    sourceNoteIds: ['n1'],
    sourceDescription: '- n1 (yellow): "Build a CSV export for the report page"\nConnections: none',
    previousClarifications: [],
    proposalDraft: null,
  },
};

// ---------------------------------------------------------------------------
section('Prompt Building');

const prompt = buildWorkerPrompt(SAMPLE_REQUEST);
ok(prompt.includes('CSV export'), 'prompt contains the note text');
ok(prompt.includes('"directive": "next"'), 'prompt carries the directive');
ok(prompt.includes('EXACTLY ONE JSON object'), 'prompt demands strict JSON output');
ok(prompt.includes('AT MOST 4'), 'prompt states the question cap');
ok(prompt.includes('skip-remaining'), 'prompt explains directive semantics');

// ---------------------------------------------------------------------------
section('JSON Extraction');

ok(extractJsonObject('{"action":"done"}')?.action === 'done', 'plain JSON parsed');
ok(extractJsonObject('```json\n{"action":"done"}\n```')?.action === 'done', 'fenced JSON parsed');
ok(extractJsonObject('Here you go:\n{"action":"question","question":{"text":"x?"}}\nThanks!')?.action === 'question',
  'JSON with surrounding prose parsed');
ok(extractJsonObject('{"a":{"b":"{not json}"},"action":"done"}')?.action === 'done',
  'nested braces inside strings handled');
ok(extractJsonObject('no json here') === null, 'no JSON → null');
ok(extractJsonObject('{"broken": ') === null, 'truncated JSON → null');
ok(extractJsonObject('') === null, 'empty string → null');

// ---------------------------------------------------------------------------
section('Adapter call() — success path');

function fakeExec(responseFactory) {
  const calls = [];
  const exec = async (cli, args, timeoutMs) => {
    calls.push({ cli, args, timeoutMs });
    return responseFactory({ cli, args, timeoutMs });
  };
  exec.calls = calls;
  return exec;
}

(async () => {
  const workerJson = {
    action: 'question',
    ambiguityScan: { identifiedGaps: ['scope'], confidence: 0.5 },
    question: {
      text: 'Which report formats are needed?',
      options: [{ key: 'A', label: 'CSV only' }, { key: 'B', label: 'CSV + XLSX' }],
      recommended: 'A',
      affectedFields: ['FR-001'],
    },
  };

  const okExec = fakeExec(() => ({
    err: null,
    stdout: JSON.stringify({
      runId: 'r1',
      status: 'ok',
      result: { payloads: [{ text: JSON.stringify(workerJson) }] },
    }),
    stderr: '',
  }));

  const adapter = createOpenClawCliAdapter({ agentId: 'main', timeoutSec: 60, exec: okExec });
  const res = await adapter.call('specify-123-1', SAMPLE_REQUEST);

  ok(res.action === 'question', 'returns parsed worker response');
  ok(res.question.options.length === 2, 'options preserved');

  const args = okExec.calls[0].args;
  ok(args[0] === 'agent', 'invokes openclaw agent subcommand');
  ok(args.includes('--agent') && args[args.indexOf('--agent') + 1] === 'main', 'targets configured agent');
  ok(args.includes('--session-key') && args[args.indexOf('--session-key') + 1] === 'agent:main:flowboard-specify-specify-123-1',
    'isolated per-session session key');
  ok(args.includes('--json'), 'requests JSON output');
  ok(args.includes('--timeout') && args[args.indexOf('--timeout') + 1] === '60', 'passes timeout seconds');
  ok(okExec.calls[0].timeoutMs === 75 * 1000, 'process timeout has slack over CLI timeout');

  // -------------------------------------------------------------------------
  section('Adapter call() — error paths');

  const timeoutExec = fakeExec(() => ({ err: Object.assign(new Error('killed'), { killed: true }), stdout: '', stderr: '' }));
  const timeoutAdapter = createOpenClawCliAdapter({ agentId: 'main', timeoutSec: 60, exec: timeoutExec });
  const timeoutRes = await timeoutAdapter.call('s1', SAMPLE_REQUEST);
  ok(timeoutRes.action === 'error' && /timed out/.test(timeoutRes.message), 'process timeout → error with timeout message');

  const badStdoutExec = fakeExec(() => ({ err: null, stdout: 'not json at all', stderr: '' }));
  const badStdoutAdapter = createOpenClawCliAdapter({ exec: badStdoutExec });
  const badStdoutRes = await badStdoutAdapter.call('s2', SAMPLE_REQUEST);
  ok(badStdoutRes.action === 'error' && /unparseable CLI output/.test(badStdoutRes.message), 'garbage stdout → error');

  const failedRunExec = fakeExec(() => ({ err: null, stdout: JSON.stringify({ status: 'error', summary: 'gateway down' }), stderr: '' }));
  const failedRunAdapter = createOpenClawCliAdapter({ exec: failedRunExec });
  const failedRunRes = await failedRunAdapter.call('s3', SAMPLE_REQUEST);
  ok(failedRunRes.action === 'error' && /gateway down/.test(failedRunRes.message), 'failed gateway run → error with detail');

  const proseExec = fakeExec(() => ({
    err: null,
    stdout: JSON.stringify({ status: 'ok', result: { payloads: [{ text: 'Sorry, I can only chat.' }] } }),
    stderr: '',
  }));
  const proseAdapter = createOpenClawCliAdapter({ exec: proseExec });
  const proseRes = await proseAdapter.call('s4', SAMPLE_REQUEST);
  ok(proseRes.action === 'error' && /no parseable JSON/.test(proseRes.message), 'prose-only reply → error');

  // -------------------------------------------------------------------------
  section('Env defaults');

  const envExec = fakeExec(() => ({ err: null, stdout: JSON.stringify({ status: 'ok', result: { payloads: [{ text: '{"action":"done"}' }] } }), stderr: '' }));
  process.env.SPECIFY_WORKER_AGENT = 'custom-worker';
  process.env.SPECIFY_WORKER_TIMEOUT = '45';
  const envAdapter = createOpenClawCliAdapter({ exec: envExec });
  await envAdapter.call('s5', SAMPLE_REQUEST);
  const envArgs = envExec.calls[0].args;
  ok(envArgs[envArgs.indexOf('--agent') + 1] === 'custom-worker', 'SPECIFY_WORKER_AGENT respected');
  ok(envArgs[envArgs.indexOf('--timeout') + 1] === '45', 'SPECIFY_WORKER_TIMEOUT respected');
  delete process.env.SPECIFY_WORKER_AGENT;
  delete process.env.SPECIFY_WORKER_TIMEOUT;

  // -------------------------------------------------------------------------
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log('Failures:', failures);
    process.exit(1);
  }
})();
