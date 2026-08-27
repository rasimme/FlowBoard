'use strict';

/**
 * T-422-5: isLoopbackHost() — the predicate behind the S-24 boot bind guard.
 * "loopback == the operator". Anything that is NOT a loopback bind (0.0.0.0,
 * ::, a routable host, an empty/whitespace host that Node would bind to all
 * interfaces, or garbage) must be treated as non-loopback so the guard
 * fail-closes when auth is off. Unit-tested directly so every host form is
 * covered without spawning a server.
 */

const { isDirectLoopbackRequest, isLoopbackHost } = require('./host-utils.js');

let pass = 0, fail = 0;
const failures = [];
function ok(c, m) { if (c) { pass++; console.log(`  ok - ${m}`); } else { fail++; failures.push(m); console.log(`  not ok - ${m}`); } }

console.log('# host-utils isLoopbackHost (T-422-5)');

// LOOPBACK -> true (the safe local-operator binds)
for (const h of ['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1', '127.0.0.5', '127.1', '127.255.255.254', 'LOCALHOST', '  127.0.0.1  ']) {
  ok(isLoopbackHost(h) === true, `loopback -> true: ${JSON.stringify(h)}`);
}

// NON-LOOPBACK -> false (bind-all, routable, empty/whitespace, garbage, non-string)
for (const h of ['0.0.0.0', '::', '', '   ', '192.168.1.5', '10.0.0.1', '172.16.0.9', 'example.com', '::ffff:192.168.1.1', '127.foo', '0', '1.2.3.4', null, undefined, 123]) {
  ok(isLoopbackHost(h) === false, `non-loopback -> false: ${JSON.stringify(h)}`);
}

console.log('\n# host-utils isDirectLoopbackRequest');
ok(isDirectLoopbackRequest({ socket: { remoteAddress: '127.0.0.1' }, headers: {} }) === true,
  'direct IPv4 loopback request is accepted');
ok(isDirectLoopbackRequest({ socket: { remoteAddress: '::1' }, headers: {} }) === true,
  'direct IPv6 loopback request is accepted');
ok(isDirectLoopbackRequest({ socket: { remoteAddress: '198.51.100.10' }, headers: {} }) === false,
  'routable socket peer is rejected');
ok(isDirectLoopbackRequest({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'cf-ray': 'tunnel' } }) === false,
  'tunnel-marked request is rejected even when proxy socket is loopback');
for (const header of [
  'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded',
  'via', 'x-real-ip', 'cf-connecting-ip', 'cf-visitor', 'cf-ray', 'x-tunnel-id',
  'x-envoy-external-address', 'x-envoy-original-path', 'x-proxy-client-ip',
  'x-original-url', 'x-forwarding-chain', 'x-request-id',
]) {
  ok(isDirectLoopbackRequest({ socket: { remoteAddress: '127.0.0.1' }, headers: { [header]: 'synthetic' } }) === false,
    `forwarded/proxy/tunnel/unknown header is rejected: ${header}`);
}
ok(isDirectLoopbackRequest({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'X-Forwarded-For': 'synthetic' } }) === false,
  'header-name casing cannot bypass forwarded-header rejection');
ok(isDirectLoopbackRequest({ socket: { remoteAddress: '192.0.2.10' }, headers: { 'x-forwarded-for': '127.0.0.1' } }) === false,
  'forwarded loopback value cannot bypass non-loopback socket rejection');
ok(isDirectLoopbackRequest({
  socket: { remoteAddress: '127.0.0.1' },
  headers: {
    accept: '*/*',
    'accept-encoding': 'gzip, deflate, br',
    'accept-language': 'en-US,en;q=0.9',
    connection: 'keep-alive',
    'content-length': '2',
    'content-type': 'application/json',
    host: '127.0.0.1:18790',
    origin: 'http://127.0.0.1:18790',
    priority: 'u=1, i',
    referer: 'http://127.0.0.1:18790/',
    'sec-ch-ua': '"Chromium";v="1"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'user-agent': 'Mozilla/5.0',
    'x-flowboard-client': 'dashboard',
    'x-requested-with': 'XMLHttpRequest',
    'x-telegram-init-data': 'query_id=synthetic',
  },
}) === true, 'normal browser and FlowBoard client headers are allowed');
ok(isDirectLoopbackRequest({
  socket: { remoteAddress: '127.0.0.1' },
  headers: new Headers({ 'Content-Type': 'application/json', 'X-Envoy-External-Address': '198.51.100.10' }),
}) === false, 'Headers objects cannot bypass the strict proxy-header policy');

console.log(`\n# results: ${pass} passed, ${fail} failed`);
if (fail > 0) { console.log('# failures:'); failures.forEach(f => console.log(`#   - ${f}`)); process.exitCode = 1; }
