import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp } from './helpers.js';
import { runStage, stopHookSettings } from '../src/runner.js';

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

// the jsonl tee is telemetry: an unwritable path (full disk, read-only mount,
// a stray FILE where the runs dir should be) must not take the server down —
// without an 'error' listener a stream error is an uncaught exception
test('an unwritable jsonl log path does not kill the run (or the process)', async () => {
  process.env.TODOMD_CLAUDE_BIN = FAKE;
  process.env.FAKE_MODE = 'parsing';
  const blocker = path.join(tmp('logdir'), 'not-a-dir');
  fs.writeFileSync(blocker, 'i am a file');
  const { done } = runStage({
    cwd: process.cwd(), prompt: 'anything', logFile: path.join(blocker, 'run.jsonl'),
  });
  const { envelope, exitCode } = await done;
  delete process.env.FAKE_MODE; delete process.env.TODOMD_CLAUDE_BIN;
  assert.equal(exitCode, 0);
  assert.equal(envelope?.subtype, 'success', 'the run completes; only the transcript is lost');
});

test('the Stop-hook settings file is written 0600 (it carries a shell command)', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX permission bits');
  process.env.TODOMD_CLAUDE_BIN = FAKE;
  process.env.FAKE_MODE = 'parsing';
  const modeFile = path.join(tmp('settings'), 'mode');
  process.env.FAKE_STAT_SETTINGS = modeFile;
  const { done } = runStage({
    cwd: process.cwd(), prompt: 'anything', settings: stopHookSettings('npm test'),
  });
  await done;
  delete process.env.FAKE_MODE; delete process.env.TODOMD_CLAUDE_BIN; delete process.env.FAKE_STAT_SETTINGS;
  assert.equal(fs.readFileSync(modeFile, 'utf8'), '600', 'world-readable /tmp must not expose the hook command');
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
