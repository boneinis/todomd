import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelsFromHelp, listModels } from '../src/models.js';

const CLAUDE_HELP = `Usage: claude [options]
  --fallback-model <model>              ignore this one (e.g. 'nope')
  --model <model>                       Model for the current session. Provide
                                        an alias for the latest model (e.g.
                                        'fable', 'opus', or 'sonnet') or a
                                        model's full name (e.g.
                                        'claude-fable-5').
  --setting-sources <sources>           something else with 'quotes'
`;

test('modelsFromHelp extracts model tokens from the --model block only', () => {
  assert.deepEqual(modelsFromHelp(CLAUDE_HELP), ['fable', 'opus', 'sonnet', 'claude-fable-5']);
});

test('modelsFromHelp returns [] with no --model block and ignores --fallback-model', () => {
  assert.deepEqual(modelsFromHelp('no model flag here'), []);
  assert.deepEqual(modelsFromHelp(`  --fallback-model <m>   e.g. 'opus'`), []);
});

test('listModels: a config `models` override wins (no CLI call)', () => {
  assert.deepEqual(listModels('claude', { models: { claude: ['opus', 'my-custom'] } }), ['opus', 'my-custom']);
});

test('listModels: falls back to the curated list when the CLI is unavailable', () => {
  process.env.TODOMD_CLAUDE_BIN = '/nonexistent/claude-xyz';
  const m = listModels('claude');
  assert.ok(m.includes('opus') && m.includes('sonnet') && m.includes('haiku'), 'curated claude fallback');
  delete process.env.TODOMD_CLAUDE_BIN;
});
