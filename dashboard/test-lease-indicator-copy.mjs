import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./src/components/LeaseIndicator.jsx', import.meta.url), 'utf8');

assert.match(source, /title: 'Lease activity is stale'/,
  'stale tooltip describes stale lease activity without a fixed threshold');
assert.doesNotMatch(source, /title: [^\n]*\b\d+\+?\s*(?:min|minutes)\b/i,
  'stale tooltip does not duplicate a numeric threshold');

console.log('✅ LeaseIndicator stale tooltip stays threshold-agnostic');
