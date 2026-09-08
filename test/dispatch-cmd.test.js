import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cmdDispatch } from '../src/templates.js';

test('cmdDispatch: substitutes absolute paths and removes npx todomd', () => {
  const result = cmdDispatch('/abs/node', '/abs/bin/todomd.js');
  assert.ok(!result.includes('npx todomd'), 'must not contain npx todomd');
  assert.ok(result.includes('/abs/node'), 'must contain the node binary path');
  assert.ok(result.includes('/abs/bin/todomd.js'), 'must contain the todomd bin path');
});

test('cmdDispatch: preserves fanout and advance instructions (structural integrity)', () => {
  const result = cmdDispatch('npx', 'todomd');
  assert.match(result, /fanout/, 'fanout instruction must be present');
  assert.match(result, /advance/, 'advance instruction must be present');
});

test('budget transactions use supervised admission and do not prescribe raw stale-lock theft', () => {
  const result = cmdDispatch('/abs/node', '/abs/todomd.js');
  assert.match(result, /budget-write/);
  assert.match(result, /LOCK … UNLOCK means one transaction script/);
  assert.match(result, /Long plan\/build\/verify work remains outside/);
  assert.doesNotMatch(result, /until mkdir|rm -rf \.todomd\/\.lock|auto-expires after 5 minutes/);
});
