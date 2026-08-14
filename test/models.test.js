import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmp } from './helpers.js';
import { modelsFromHelp, modelsFromAgy, modelsFromCodexDebug, listModels, validateModelRoute } from '../src/models.js';

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

test('modelsFromAgy parses the installed gateway inventory and ignores chatter', () => {
  assert.deepEqual(modelsFromAgy('Fetching available models...\ngemini-3.6-flash-low\tFlash\ngemini-3.1-pro-high Pro\n'),
    ['gemini-3.6-flash-low', 'gemini-3.1-pro-high']);
});

test('modelsFromCodexDebug returns only selectable model slugs', () => {
  const catalog = JSON.stringify({ models: [
    { slug: 'gpt-5.6-sol', visibility: 'list' },
    { slug: 'gpt-5.6-terra', visibility: 'list' },
    { slug: 'gpt-hidden', visibility: 'hide' },
    { slug: 'not-a-codex-family', visibility: 'list' },
  ] });
  assert.deepEqual(modelsFromCodexDebug(catalog), ['gpt-5.6-sol', 'gpt-5.6-terra']);
  assert.deepEqual(modelsFromCodexDebug('not json'), []);
});

test('listModels uses agy models as the authoritative Gemini inventory', () => {
  const dir = tmp('agy-models');
  const bin = path.join(dir, 'fake-agy');
  fs.writeFileSync(bin, '#!/bin/sh\nprintf "gemini-live-low\\tLive\\ngemini-live-high\\tLive\\n"\n', { mode: 0o755 });
  process.env.TODOMD_GEMINI_BIN = bin;
  const models = listModels('gemini', { models: { gemini: ['gemini-stale'] } });
  delete process.env.TODOMD_GEMINI_BIN;
  assert.deepEqual(models, ['gemini-live-low', 'gemini-live-high']);
});

test('validateModelRoute rejects cross-provider models and the disabled Kimi adapter', () => {
  assert.match(validateModelRoute('gemini', 'claude-sonnet-5').error, /belongs to claude/);
  assert.match(validateModelRoute('kimi', 'kimi-k1.5').error, /disabled/);
  assert.equal(validateModelRoute('codex', 'gpt-5.6-sol').ok, true);
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

// `<cli> --help` is a BLOCKING spawn on the server's event loop (up to 4s). A
// CLI that yields no model list used to be re-probed on every picker open —
// each one stalling the whole board.
test('listModels probes the CLI once, then backs off (no re-spawn per request)', () => {
  const dir = tmp('models');
  const counter = path.join(dir, 'probes');
  const bin = path.join(dir, 'fake-codex');
  fs.writeFileSync(bin,
    `#!/usr/bin/env node\n` +
    `require('fs').appendFileSync(${JSON.stringify(counter)}, 'x');\n` +
    `process.stdout.write('usage: codex [options]\\n');\n`, { mode: 0o755 });
  process.env.TODOMD_CODEX_BIN = bin;
  const first = listModels('codex');
  const second = listModels('codex');
  delete process.env.TODOMD_CODEX_BIN;
  assert.deepEqual(second, first);
  assert.ok(first.includes('gpt-5.6-sol'), 'current curated Codex fallback');
  assert.equal(fs.readFileSync(counter, 'utf8'), 'x', 'the CLI is probed once, not once per call');
});
