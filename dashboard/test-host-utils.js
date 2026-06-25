'use strict';

/**
 * T-422-5: isLoopbackHost() — the predicate behind the S-24 boot bind guard.
 * "loopback == the operator". Anything that is NOT a loopback bind (0.0.0.0,
 * ::, a routable host, an empty/whitespace host that Node would bind to all
 * interfaces, or garbage) must be treated as non-loopback so the guard
 * fail-closes when auth is off. Unit-tested directly so every host form is
 * covered without spawning a server.
 */

const { isLoopbackHost } = require('./host-utils.js');

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

console.log(`\n# results: ${pass} passed, ${fail} failed`);
if (fail > 0) { console.log('# failures:'); failures.forEach(f => console.log(`#   - ${f}`)); process.exitCode = 1; }
