import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp } from './helpers.js';
import { runStage, stopHookSettings } from '../src/runner.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/fake-agent.js');
const FAKE_CODEX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/fake-codex.js');

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

test('passes configured effort to the Claude CLI', async () => {
  process.env.TODOMD_CLAUDE_BIN = FAKE;
  process.env.FAKE_MODE = 'parsing';
  const log = path.join(tmp('effort'), 'argv.jsonl');
  process.env.FAKE_ARGV_LOG = log;
  const { done } = runStage({ cwd: process.cwd(), prompt: 'anything', effort: 'xhigh' });
  await done;
  delete process.env.FAKE_MODE; delete process.env.TODOMD_CLAUDE_BIN; delete process.env.FAKE_ARGV_LOG;
  const argv = JSON.parse(fs.readFileSync(log, 'utf8'));
  assert.deepEqual(argv.slice(argv.indexOf('--effort'), argv.indexOf('--effort') + 2), ['--effort', 'xhigh']);
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

test('Codex Verify retains executable, cwd, exit, stderr, and structured output', async () => {
  process.env.TODOMD_CODEX_BIN = FAKE_CODEX;
  process.env.FAKE_CODEX_STDERR = 'non-fatal warning\n';
  const dir = tmp('codex-ok');
  const logFile = path.join(dir, 'verify.jsonl');
  const { done } = runStage({
    vendor: 'codex', cwd: dir, prompt: 'verify', jsonSchema: { type: 'object' }, logFile,
  });
  const result = await done;
  delete process.env.TODOMD_CODEX_BIN; delete process.env.FAKE_CODEX_STDERR;

  assert.equal(result.envelope.structured_output.verdict, 'pass');
  assert.equal(result.diagnostic.executable, FAKE_CODEX);
  assert.equal(result.diagnostic.cwd, dir);
  assert.equal(result.diagnostic.exitCode, 0);
  assert.equal(result.diagnostic.stderr, 'non-fatal warning\n');
  assert.equal(result.diagnostic.structuredOutput.verdict, 'pass');
  const events = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(events.some((e) => e.type === 'runner-diagnostic' && e.structuredOutput?.verdict === 'pass'));
});

test('Codex Verify preserves a raw final message and unsuccessful exit diagnostic', async () => {
  process.env.TODOMD_CODEX_BIN = FAKE_CODEX;
  process.env.FAKE_CODEX_LAST_MESSAGE = 'transport returned no verdict';
  process.env.FAKE_CODEX_STDERR = 'connection reset by peer\n';
  process.env.FAKE_CODEX_EXIT = '7';
  const dir = tmp('codex-fail');
  const logFile = path.join(dir, 'verify.jsonl');
  const { done } = runStage({
    vendor: 'codex', cwd: dir, prompt: 'verify', jsonSchema: { type: 'object' }, logFile,
  });
  const result = await done;
  delete process.env.TODOMD_CODEX_BIN; delete process.env.FAKE_CODEX_LAST_MESSAGE;
  delete process.env.FAKE_CODEX_STDERR; delete process.env.FAKE_CODEX_EXIT;

  assert.equal(result.envelope.is_error, true);
  assert.equal(result.diagnostic.exitCode, 7);
  assert.equal(result.diagnostic.finalMessage, 'transport returned no verdict');
  assert.equal(result.diagnostic.structuredOutput, null);
  const raw = fs.readFileSync(logFile, 'utf8');
  assert.match(raw, /connection reset by peer/);
  assert.match(raw, /transport returned no verdict/);
});

test('Codex Verify writes a cannot-start diagnostic to the raw run log', async () => {
  process.env.TODOMD_CODEX_BIN = '/nonexistent/todomd-no-such-codex';
  const dir = tmp('codex-spawn');
  const logFile = path.join(dir, 'verify.jsonl');
  const { done } = runStage({
    vendor: 'codex', cwd: dir, prompt: 'verify', jsonSchema: { type: 'object' }, logFile,
  });
  const result = await done;
  delete process.env.TODOMD_CODEX_BIN;

  assert.equal(result.envelope, null);
  assert.equal(result.diagnostic.exitCode, -1);
  assert.ok(result.diagnostic.spawnError);
  const events = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(events.some((e) => e.type === 'runner-diagnostic' && e.spawnError));
});
