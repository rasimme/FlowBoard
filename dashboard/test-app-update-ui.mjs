/**
 * DOM-less tests for the appUpdate UI helpers (T-353):
 * fetchUpdateStatus / runUpdate / pollUntilUpdated. fetch + sleep + now are
 * injected so the restart-poll is deterministic without a real server.
 *
 * Run: node test-app-update-ui.mjs
 */

import {
  fetchUpdateStatus, runUpdate, pollUntilUpdated,
  HEALTH_PATH, INFO_PATH,
} from './src/utils/appUpdate.mjs';

let pass = 0, fail = 0;
const failures = [];
function ok(c, m) { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; failures.push(m); console.log(`  ❌ ${m}`); } }

const jsonRes = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

console.log('# fetchUpdateStatus');
{
  const f = async () => jsonRes(200, { ok: true, running: '5.0.0', installed: '5.1.0', updateAvailable: true, selfUpdateEnabled: true });
  const s = await fetchUpdateStatus({ fetchImpl: f });
  ok(s && s.running === '5.0.0' && s.installed === '5.1.0' && s.updateAvailable === true, 'parses status');
  ok(s && s.selfUpdateEnabled === true, 'parses selfUpdateEnabled=true');

  const disabled = await fetchUpdateStatus({ fetchImpl: async () => jsonRes(200, { ok: true, running: '5.0.0', installed: '5.1.0', updateAvailable: true, selfUpdateEnabled: false }) });
  ok(disabled && disabled.updateAvailable === true && disabled.selfUpdateEnabled === false, 'parses disabled self-update status');

  const noUpdate = await fetchUpdateStatus({ fetchImpl: async () => jsonRes(200, { ok: true, running: '5.0.0', installed: '5.0.0', updateAvailable: false }) });
  ok(noUpdate && noUpdate.updateAvailable === false, 'no-update status');

  ok(await fetchUpdateStatus({ fetchImpl: async () => jsonRes(500, {}) }) === null, 'non-2xx → null');
  ok(await fetchUpdateStatus({ fetchImpl: async () => { throw new Error('net'); } }) === null, 'throw → null');
  ok(await fetchUpdateStatus({ fetchImpl: async () => jsonRes(200, { ok: true }) }) === null, 'missing running → null');
}

console.log('\n# runUpdate');
{
  // T-417-6: Verify confirmation is sent in request body
  let capturedBody = null;
  const captureFetch = async (path, opts) => {
    capturedBody = opts?.body;
    return jsonRes(202, { ok: true, started: true, command: ['node', 'scripts/setup.mjs', '--update'] });
  };

  const okRun = await runUpdate({ fetchImpl: captureFetch });
  ok(okRun.ok === true && okRun.started === true && okRun.command.length === 3, '202 → ok/started/command');
  ok(capturedBody && capturedBody.confirmation === 'update-confirmed', 'sends { confirmation: "update-confirmed" } in request body');

  const dry = await runUpdate({ fetchImpl: async () => jsonRes(202, { ok: true, started: false, dryRun: true, command: [] }) });
  ok(dry.ok === true && dry.started === false, 'dry-run → ok, not started');

  const errRun = await runUpdate({ fetchImpl: async () => jsonRes(500, { ok: false, error: 'boom' }) });
  ok(errRun.ok === false && errRun.error === 'boom', 'server error → {ok:false,error}');

  const netErr = await runUpdate({ fetchImpl: async () => { throw new Error('offline'); } });
  ok(netErr.ok === false && /offline/.test(netErr.error), 'network throw → {ok:false}');

  // 400 response when server rejects confirmation (should be handled)
  const confErr = await runUpdate({ fetchImpl: async () => jsonRes(400, { ok: false, error: 'Missing or invalid confirmation' }) });
  ok(confErr.ok === false && /confirmation/.test(confErr.error), '400 confirmation error → {ok:false,error}');
}

console.log('\n# pollUntilUpdated');
{
  // A fake clock advanced by the injected sleep so timeout logic is deterministic.
  function harness(infoVersionsByCall) {
    let clock = 0;
    let infoCall = 0;
    const sleep = async (ms) => { clock += ms; };
    const now = () => clock;
    const fetchImpl = async (path) => {
      if (path === HEALTH_PATH) return jsonRes(200, { ok: true });
      if (path === INFO_PATH) {
        const v = infoVersionsByCall[Math.min(infoCall, infoVersionsByCall.length - 1)];
        infoCall += 1;
        if (v === 'DOWN') throw new Error('server down');
        return jsonRes(200, { version: v });
      }
      return jsonRes(404, {});
    };
    return { sleep, now, fetchImpl };
  }

  // Old version a couple of polls, then the new build serves → returns new version.
  {
    const h = harness(['5.0.0', '5.0.0', '5.1.0']);
    const v = await pollUntilUpdated({ fromVersion: '5.0.0', ...h, timeoutMs: 60000, intervalMs: 1000 });
    ok(v === '5.1.0', 'returns the new version once it differs');
  }

  // Server unreachable mid-restart (throws) is swallowed, then recovers.
  {
    const h = harness(['DOWN', 'DOWN', '5.2.0']);
    const v = await pollUntilUpdated({ fromVersion: '5.1.0', ...h, timeoutMs: 60000, intervalMs: 1000 });
    ok(v === '5.2.0', 'survives the unreachable restart window');
  }

  // Never changes version → times out → null.
  {
    const h = harness(['5.0.0']);
    const v = await pollUntilUpdated({ fromVersion: '5.0.0', ...h, timeoutMs: 5000, intervalMs: 1000 });
    ok(v === null, 'times out to null when version never changes');
  }
}

console.log(`\n# results: ${pass} passed, ${fail} failed`);
if (fail > 0) { console.log('# failures:'); failures.forEach(f => console.log(`#   - ${f}`)); process.exit(1); }
