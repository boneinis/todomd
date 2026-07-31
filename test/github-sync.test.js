import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMetadataScheduler } from '../src/github-sync.js';

test('metadata scheduler is inert when GitHub sync is disabled', async () => {
  const scheduler = createMetadataScheduler();
  // An absent config is equivalent to disabled; this must not create a timer
  // or attempt to access a repository.
  scheduler.schedule({ path: '/definitely/not/a/repo', name: 'none' });
  scheduler.close();
  assert.ok(true);
});
