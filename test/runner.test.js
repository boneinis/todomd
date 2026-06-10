import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStage } from '../src/runner.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/fake-agent.js');

test('stream-json: captures session id, final envelope, and flushes a trailing newline-less event', async () => {
  process.env.TODOMD_CLAUDE_BIN = FAKE;
  process.env.FAKE_MODE = 'parsing';
  const events = [];
  const { done } = runStage({
    cwd: process.cwd(), prompt: 'anything', onEvent: (e) => events.push(e),
  });
  const { envelope, sessionId, exitCode } = await done;
  delete process.env.FAKE_MODE; delete process.env.TODOMD_CLAUDE_BIN;
  assert.equal(exitCode, 0);
  assert.equal(sessionId, 'fake-session-0001');
  assert.ok(envelope, 'final result envelope must be parsed even without a trailing newline');
  assert.equal(envelope.subtype, 'success');
  // the multibyte assistant text decoded cleanly (no replacement chars)
  const txt = events.find((e) => e.type === 'assistant')?.message?.content?.[0]?.text;
  assert.equal(txt, 'héllo 日本語');
});

test('spawn error (missing binary) reports spawnError, not a crash', async () => {
  process.env.TODOMD_CLAUDE_BIN = '/nonexistent/todomd-no-such-bin';
  const { done } = runStage({ cwd: process.cwd(), prompt: 'x' });
  const r = await done;
  delete process.env.TODOMD_CLAUDE_BIN;
  assert.equal(r.envelope, null);
  assert.ok(r.spawnError);
});

test('buffered mode (--json-schema) returns structured_output', async () => {
  process.env.TODOMD_CLAUDE_BIN = FAKE;
  process.env.FAKE_VERDICT = 'pass';
  const { done } = runStage({
    cwd: process.cwd(), prompt: '/todomd-verify task-0001',
    jsonSchema: { type: 'object' },
  });
  const { envelope } = await done;
  delete process.env.FAKE_VERDICT; delete process.env.TODOMD_CLAUDE_BIN;
  assert.equal(envelope.structured_output.verdict, 'pass');
});
