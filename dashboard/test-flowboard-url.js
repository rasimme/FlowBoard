'use strict';

const {
  DEFAULT_DASHBOARD_BASE_URL,
  joinApiPath,
  normalizeBaseUrl,
  readPort,
  renderSnippetBaseUrl,
  resolveDashboardBaseUrl,
  resolveDashboardPort,
} = require('./flowboard-url.cjs');

let pass = 0;
let fail = 0;
const failures = [];

function ok(condition, message) {
  if (condition) {
    pass++;
    console.log(`  ok - ${message}`);
  } else {
    fail++;
    failures.push(message);
    console.log(`  not ok - ${message}`);
  }
}

console.log('# FlowBoard URL helper');

ok(readPort('18843') === 18843, 'readPort accepts numeric strings');
ok(readPort(18844) === 18844, 'readPort accepts numbers');
ok(readPort('0') === null, 'readPort rejects port 0');
ok(readPort('65536') === null, 'readPort rejects ports above 65535');
ok(readPort('abc') === null, 'readPort rejects non-numeric values');

ok(normalizeBaseUrl('http://localhost:18843/') === 'http://localhost:18843', 'normalizeBaseUrl trims trailing slash');
ok(normalizeBaseUrl('https://flowboard.local/api/') === 'https://flowboard.local/api', 'normalizeBaseUrl preserves a path prefix');
ok(normalizeBaseUrl('ftp://flowboard.local') === null, 'normalizeBaseUrl rejects non-http protocols');
ok(normalizeBaseUrl('not a url') === null, 'normalizeBaseUrl rejects invalid URLs');

ok(resolveDashboardPort({ dashboardPort: 18845 }, { FLOWBOARD_PORT: '18846' }) === 18845, 'dashboardPort config beats FLOWBOARD_PORT');
ok(resolveDashboardPort({}, { FLOWBOARD_PORT: '18846' }) === 18846, 'FLOWBOARD_PORT is used when config is absent');
ok(resolveDashboardPort({}, { FLOWBOARD_PORT: 'bad' }) === 18790, 'invalid FLOWBOARD_PORT falls back to default');

ok(
  resolveDashboardBaseUrl({ dashboardBaseUrl: 'https://flowboard.example/base/' }, { FLOWBOARD_BASE_URL: 'http://localhost:18847' }) === 'https://flowboard.example/base',
  'dashboardBaseUrl config has highest precedence'
);
ok(
  resolveDashboardBaseUrl({ dashboardPort: 18848 }, { FLOWBOARD_BASE_URL: 'http://localhost:18847', FLOWBOARD_API: 'http://localhost:18846' }) === 'http://localhost:18847',
  'FLOWBOARD_BASE_URL beats FLOWBOARD_API and port-only config'
);
ok(
  resolveDashboardBaseUrl({ dashboardPort: 18848 }, { FLOWBOARD_API: 'http://localhost:18846' }) === 'http://localhost:18846',
  'FLOWBOARD_API beats port-only config'
);
ok(
  resolveDashboardBaseUrl({ dashboardPort: 18848 }, { FLOWBOARD_API: 'http://localhost:18846' }, { includeLegacyApi: false }) === 'http://localhost:18848',
  'FLOWBOARD_API can be ignored for server-owned discovery'
);
ok(
  resolveDashboardBaseUrl({ dashboardPort: 18848 }, {}) === 'http://localhost:18848',
  'dashboardPort builds the localhost fallback'
);
ok(
  resolveDashboardBaseUrl({}, {}) === DEFAULT_DASHBOARD_BASE_URL,
  'empty config and env use the default base URL'
);

ok(
  joinApiPath('http://localhost:18843/', '/api/info') === 'http://localhost:18843/api/info',
  'joinApiPath avoids double slashes'
);
ok(
  joinApiPath('https://flowboard.example/base', 'api/info') === 'https://flowboard.example/base/api/info',
  'joinApiPath preserves path prefixes'
);

const rendered = renderSnippetBaseUrl(
  'a http://localhost:18790 b http://127.0.0.1:18790 c http://localhost:18790',
  'http://localhost:18843/'
);
ok(!rendered.includes('http://localhost:18790'), 'renderSnippetBaseUrl replaces localhost default URLs');
ok(!rendered.includes('http://127.0.0.1:18790'), 'renderSnippetBaseUrl replaces 127.0.0.1 default URLs');
ok((rendered.match(/http:\/\/localhost:18843/g) || []).length === 2, 'renderSnippetBaseUrl keeps localhost replacements on localhost');
ok((rendered.match(/http:\/\/127\.0\.0\.1:18843/g) || []).length === 1, 'renderSnippetBaseUrl preserves 127.0.0.1 replacements on localhost defaults');

const renderedCustom = renderSnippetBaseUrl(
  'a http://localhost:18790 b http://127.0.0.1:18790',
  'https://flowboard.example/custom/'
);
ok((renderedCustom.match(/https:\/\/flowboard\.example\/custom/g) || []).length === 2, 'custom base URL replaces both default loopback host forms');

if (fail === 0) console.log(`\n✅ All ${pass} checks passed`);
else {
  console.log(`\n❌ ${fail} failed, ${pass} passed`);
  failures.forEach(failure => console.log(`  - ${failure}`));
}
process.exit(fail > 0 ? 1 : 0);
