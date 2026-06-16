/**
 * T-230: unit tests for fetchWithRetry in the project-context hook.
 * Verifies transient failures (connection refused during a KeepAlive restart,
 * 5xx from a still-starting server) are retried, while a definitive 4xx is not.
 * Run: node test-project-context-retry.mjs
 */
import { fetchWithRetry } from '../hooks/project-context/handler.js';

let passed = 0;
let failed = 0;
function check(cond, msg) {
  if (cond) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); }
}

const noSleep = () => Promise.resolve();

// 1) returns immediately on first success (no retry)
{
  let calls = 0;
  const res = await fetchWithRetry('u', { sleep: noSleep, fetchImpl: async () => { calls++; return { ok: true, status: 200 }; } });
  check(res.ok && calls === 1, 'returns on first success without retrying');
}

// 2) retries thrown errors, then succeeds on the 3rd attempt
{
  let calls = 0;
  const res = await fetchWithRetry('u', { sleep: noSleep, fetchImpl: async () => { calls++; if (calls < 3) throw new Error('ECONNREFUSED'); return { ok: true, status: 200 }; } });
  check(res.ok && calls === 3, 'retries thrown errors then succeeds');
}

// 3) retries a 5xx, then succeeds
{
  let calls = 0;
  const res = await fetchWithRetry('u', { sleep: noSleep, fetchImpl: async () => { calls++; return calls < 2 ? { ok: false, status: 503 } : { ok: true, status: 200 }; } });
  check(res.ok && calls === 2, 'retries 5xx then succeeds');
}

// 4) does NOT retry a definitive 4xx
{
  let calls = 0;
  const res = await fetchWithRetry('u', { sleep: noSleep, fetchImpl: async () => { calls++; return { ok: false, status: 404 }; } });
  check(res.status === 404 && calls === 1, '4xx is definitive — no retry');
}

// 5) throws after exhausting all attempts (1 initial + 2 retries = 3)
{
  let calls = 0;
  let threw = false;
  try {
    await fetchWithRetry('u', { sleep: noSleep, fetchImpl: async () => { calls++; throw new Error('down'); } });
  } catch { threw = true; }
  check(threw && calls === 3, 'throws after exhausting all attempts');
}

// 6) returns the last 5xx response when every attempt is 5xx
{
  let calls = 0;
  const res = await fetchWithRetry('u', { sleep: noSleep, fetchImpl: async () => { calls++; return { ok: false, status: 500 }; } });
  check(res.status === 500 && calls === 3, 'returns last 5xx after exhausting retries');
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
