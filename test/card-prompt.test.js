import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../public/card-prompt.js';

const { deriveTitle, buildDescription } = globalThis.todoCardPrompt;

test('prompt-first card derives a concise title from the first meaningful line', () => {
  assert.equal(deriveTitle('\n## Fix interrupted builds\n\nKeep the worktree.'), 'Fix interrupted builds');
  assert.equal(deriveTitle('- [ ] Preserve partial changes'), 'Preserve partial changes');
  assert.equal(deriveTitle('ignored prompt', '  Deliberate title  '), 'Deliberate title');
  assert.equal(deriveTitle('a'.repeat(140)).length, 120);
});

test('prompt-first card preserves the prompt and appends optional advanced context', () => {
  assert.equal(buildDescription('  Keep the whole prompt.  '), 'Keep the whole prompt.');
  assert.equal(
    buildDescription('Keep the whole prompt.', '  Existing API must stay compatible.  '),
    'Keep the whole prompt.\n\nAdditional context:\nExisting API must stay compatible.',
  );
});
