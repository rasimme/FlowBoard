import assert from 'node:assert/strict';

import { apiFetch } from './src/utils/apiFetch.js';
import { resolveDashboardAgentIdentity } from './src/utils/projectSelection.mjs';
import { safeExternalHttpUrl } from './src/utils/safeExternalUrl.mjs';

console.log('# client security hardening (T-428-2, T-428-3, T-428-5)');

assert.equal(safeExternalHttpUrl('https://example.com'), 'https://example.com');
assert.equal(safeExternalHttpUrl('http://example.com'), 'http://example.com');
assert.equal(safeExternalHttpUrl('example.com'), 'https://example.com');
assert.equal(safeExternalHttpUrl('  example.com  '), 'https://example.com');
assert.equal(safeExternalHttpUrl('javascript:alert(1)'), '');
assert.equal(safeExternalHttpUrl('data:text/html,<script>alert(1)</script>'), '');
assert.equal(safeExternalHttpUrl('mailto:test@example.com'), '');
assert.equal(safeExternalHttpUrl('blob:http://example.com/id'), '');
assert.equal(safeExternalHttpUrl('JavaScript:alert(1)'), '');
assert.equal(safeExternalHttpUrl(''), '');

const calls = [];
global.window = {
  location: { origin: 'http://127.0.0.1:3000' },
  Telegram: { WebApp: { initData: 'signed-init-data' } },
};
global.fetch = async (path, opts) => {
  calls.push({ path, opts });
  return { ok: true, json: async () => ({ ok: true }) };
};

await apiFetch('/api/projects');
assert.equal(calls.at(-1).opts.credentials, 'include');
assert.equal(calls.at(-1).opts.headers['X-Telegram-Init-Data'], 'signed-init-data');

await apiFetch('http://127.0.0.1:3000/api/projects');
assert.equal(calls.at(-1).opts.credentials, 'include');
assert.equal(calls.at(-1).opts.headers['X-Telegram-Init-Data'], 'signed-init-data');

await apiFetch('/static/file.js');
assert.equal(calls.at(-1).opts.credentials, 'omit');
assert.equal(calls.at(-1).opts.headers['X-Telegram-Init-Data'], undefined);

await apiFetch('https://attacker.example/api/steal');
assert.equal(calls.at(-1).opts.credentials, 'omit');
assert.equal(calls.at(-1).opts.headers['X-Telegram-Init-Data'], undefined);

assert.deepEqual(
  resolveDashboardAgentIdentity({
    authAgentId: 'auth-agent',
    telegramWebApp: { initDataUnsafe: { start_param: 'agent=telegram-agent' } },
    urlSearch: '?agentId=url-agent',
    storedAgentId: 'stored-agent',
  }),
  { agentId: 'auth-agent', source: 'auth', chatBound: false }
);

assert.equal(
  resolveDashboardAgentIdentity({
    telegramWebApp: { initDataUnsafe: { start_param: 'agent=telegram-agent' } },
    urlSearch: '?agentId=url-agent',
    storedAgentId: 'stored-agent',
  }).source,
  'stored'
);

assert.equal(
  resolveDashboardAgentIdentity({
    urlSearch: '?agentId=url-agent',
    storedAgentId: 'stored-agent',
  }).source,
  'stored'
);

assert.equal(
  resolveDashboardAgentIdentity({
    urlSearch: '?agentId=url-agent',
  }).source,
  'url'
);

assert.equal(resolveDashboardAgentIdentity({ storedAgentId: 'stored-agent' }).source, 'stored');

console.log('client security hardening tests passed');
