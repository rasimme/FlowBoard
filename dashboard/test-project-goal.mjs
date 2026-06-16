import assert from 'node:assert/strict';
import { extractGoal } from './src/utils/projectGoal.mjs';

// T-382: the goal must not be truncated at a literal "Z" (the old \Z bug).
const depot = '# Depot — Finanzen\n\n## Ziel\nZentrale Wissensbasis für alle Finanzthemen: Depot, Krypto.\n\n## Scope\n- a\n';
assert.equal(
  extractGoal(depot),
  'Zentrale Wissensbasis für alle Finanzthemen: Depot, Krypto.',
  'depot goal starting with "Z" extracts in full (regression: \\Z-as-literal-Z)',
);

// "Z" inside the body must not cut it short either
assert.equal(extractGoal('## Ziel\nFoo Zar baz.\n\n## Next\n'), 'Foo Zar baz.', 'Z mid-body kept');

// Goal/Ziel as the LAST section (no following ## , the old \Z fallthrough case)
assert.equal(extractGoal('# T\n\n## Goal\nShip it.'), 'Ship it.', 'goal as last section');

// English heading
assert.equal(extractGoal('## Goal\nDo the thing.\n\n## More\nx'), 'Do the thing.', 'English Goal heading');

// No Ziel/Goal heading → intro fallback (text before first ## , minus the # title line)
assert.equal(extractGoal('# Title\nSome intro line.\n\n## Other\nx'), 'Some intro line.', 'intro fallback');

// markdown stripped + trimmed
assert.equal(extractGoal('## Ziel\n**Bold** and `code`.\n'), 'Bold and code.', 'markdown chars stripped');

// genuinely empty / title-only → empty
assert.equal(extractGoal('# Title'), '', 'title only → empty');
assert.equal(extractGoal(''), '', 'empty input → empty');
assert.equal(extractGoal(null), '', 'null input → empty');

console.log('# project-goal: all assertions passed');
