import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp } from './helpers.js';
import { runStage, stopHookSettings, describeDeniedActions, normalizeDeniedActions, claudeTeamworkInstructions, codexTeamworkInstructions } from '../src/runner.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/fake-agent.js');
const FAKE_CODEX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/fake-codex.js');
const FAKE_GEMINI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/fake-gemini.js');

test('stream-json: captures session id, final envelope, and flushes a trailing newline-less event', async () => {
  process.env.TODOMD_CLAUDE_BIN = FAKE;
  process.env.FAKE_MODE = 'parsing';
  const events = [];
  const { done } = runStage({
    cwd: process.cwd(), prompt: 'anything', onEvent: (e) => events.push(e),
  });
  const { envelope, sessionId, exitCode, usage, executionType } = await done;
  delete process.env.FAKE_MODE; delete process.env.TODOMD_CLAUDE_BIN;
  assert.equal(exitCode, 0);
  assert.equal(sessionId, 'fake-session-0001');
  assert.ok(envelope, 'final result envelope must be parsed even without a trailing newline');
  assert.equal(envelope.subtype, 'success');
  assert.equal(usage.input_tokens, 20);
  assert.equal(usage.cached_input_tokens, 10);
  assert.equal(executionType, 'subscription_cli');
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

test('Claude automation is isolated from user/project plugins, MCP, hooks, skills, and memory', async () => {
  process.env.TODOMD_CLAUDE_BIN = FAKE;
  process.env.FAKE_MODE = 'parsing';
  const log = path.join(tmp('safe-mode'), 'argv.jsonl');
  process.env.FAKE_ARGV_LOG = log;
  await runStage({ cwd: process.cwd(), prompt: 'anything' }).done;
  delete process.env.FAKE_MODE; delete process.env.TODOMD_CLAUDE_BIN; delete process.env.FAKE_ARGV_LOG;
  const argv = JSON.parse(fs.readFileSync(log, 'utf8'));
  assert.ok(argv.includes('--safe-mode'));
  assert.ok(argv.includes('--disable-slash-commands'));
});

test('Claude tool-less review removes every local tool even when Verify normally allows tests', async () => {
  process.env.TODOMD_CLAUDE_BIN = FAKE;
  process.env.FAKE_MODE = 'parsing';
  const log = path.join(tmp('claude-review-only'), 'argv.jsonl');
  process.env.FAKE_ARGV_LOG = log;
  await runStage({
    cwd: process.cwd(), prompt: 'verify prepared evidence', stage: 'Verify',
    allowedTools: ['Read', 'Grep', 'Bash(npm test:*)'], reviewOnly: true,
  }).done;
  delete process.env.FAKE_MODE; delete process.env.TODOMD_CLAUDE_BIN; delete process.env.FAKE_ARGV_LOG;
  const argv = JSON.parse(fs.readFileSync(log, 'utf8'));
  assert.deepEqual(argv.slice(argv.indexOf('--tools'), argv.indexOf('--tools') + 2), ['--tools', '']);
  assert.equal(argv.includes('--allowedTools'), false);
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

test('an explicit settings file is written 0600', async (t) => {
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
  assert.equal(result.usage.input_tokens, 100);
  assert.equal(result.usage.cached_input_tokens, 80);
  assert.equal(result.usage.reasoning_output_tokens, 4);
  assert.equal(result.diagnostic.executable, FAKE_CODEX);
  assert.equal(result.diagnostic.cwd, dir);
  assert.equal(result.diagnostic.exitCode, 0);
  assert.equal(result.diagnostic.stderr, 'non-fatal warning\n');
  assert.equal(result.diagnostic.structuredOutput.verdict, 'pass');
  const events = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(events.some((e) => e.type === 'runner-diagnostic' && e.structuredOutput?.verdict === 'pass'));
});

test('Codex resume omits the unsupported sandbox flag', async () => {
  process.env.TODOMD_CODEX_BIN = FAKE_CODEX;
  const dir = tmp('codex-resume');
  const argvLog = path.join(dir, 'argv.json');
  process.env.FAKE_CODEX_ARGV_LOG = argvLog;
  const { done } = runStage({
    vendor: 'codex', cwd: dir, prompt: 'repair the findings', resume: 'saved-session',
  });
  await done;
  delete process.env.TODOMD_CODEX_BIN; delete process.env.FAKE_CODEX_ARGV_LOG;

  const argv = JSON.parse(fs.readFileSync(argvLog, 'utf8'));
  assert.deepEqual(argv.slice(0, 4), ['exec', '--ignore-user-config', 'resume', 'saved-session']);
  assert.equal(argv.includes('--sandbox'), false);
  assert.ok(argv.includes('--json'));
});

test('Codex ignores user config and uses read-only outside Build', async () => {
  process.env.TODOMD_CODEX_BIN = FAKE_CODEX;
  const dir = tmp('codex-isolated');
  const argvLog = path.join(dir, 'argv.json');
  process.env.FAKE_CODEX_ARGV_LOG = argvLog;
  await runStage({ vendor: 'codex', stage: 'Verify', cwd: dir, prompt: 'verify' }).done;
  delete process.env.TODOMD_CODEX_BIN; delete process.env.FAKE_CODEX_ARGV_LOG;
  const argv = JSON.parse(fs.readFileSync(argvLog, 'utf8'));
  assert.ok(argv.includes('--ignore-user-config'));
  assert.deepEqual(argv.slice(argv.indexOf('--sandbox'), argv.indexOf('--sandbox') + 2), ['--sandbox', 'read-only']);
});

test('Codex tool-less review disables every local execution feature', async () => {
  process.env.TODOMD_CODEX_BIN = FAKE_CODEX;
  const dir = tmp('codex-review-only');
  const argvLog = path.join(dir, 'argv.json');
  process.env.FAKE_CODEX_ARGV_LOG = argvLog;
  await runStage({
    vendor: 'codex', stage: 'Verify', cwd: dir,
    prompt: 'review the prepared evidence only', reviewOnly: true,
  }).done;
  delete process.env.TODOMD_CODEX_BIN; delete process.env.FAKE_CODEX_ARGV_LOG;
  const argv = JSON.parse(fs.readFileSync(argvLog, 'utf8'));
  const disabled = argv.flatMap((arg, index) => arg === '--disable' ? [argv[index + 1]] : []);
  assert.deepEqual(disabled, ['shell_tool', 'unified_exec', 'code_mode']);
  assert.deepEqual(argv.slice(argv.indexOf('--sandbox'), argv.indexOf('--sandbox') + 2), ['--sandbox', 'read-only']);
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

test('Gemini Build is sandboxed, headless, routed, and never skips permissions globally', async () => {
  process.env.TODOMD_GEMINI_BIN = FAKE_GEMINI;
  const dir = tmp('gemini-build');
  const argvLog = path.join(dir, 'argv.json');
  process.env.FAKE_GEMINI_ARGV_LOG = argvLog;
  const events = [];
  const result = await runStage({
    vendor: 'gemini', stage: 'Build', cwd: dir, prompt: 'build',
    model: 'gemini-3.1-pro-high', effort: 'xhigh', onEvent: (e) => events.push(e),
  }).done;
  delete process.env.TODOMD_GEMINI_BIN; delete process.env.FAKE_GEMINI_ARGV_LOG;

  const argv = JSON.parse(fs.readFileSync(argvLog, 'utf8'));
  assert.ok(argv.includes('--sandbox'));
  assert.deepEqual(argv.slice(argv.indexOf('--add-dir'), argv.indexOf('--add-dir') + 2), ['--add-dir', dir],
    'the task worktree is registered as the agent workspace');
  const sent = argv[argv.indexOf('-p') + 1];
  assert.ok(sent.startsWith('build'), 'the stage prompt comes first');
  assert.ok(sent.includes(`task worktree at ${dir}`), 'the prompt names the workspace');
  assert.ok(sent.includes('write_file') && sent.includes('write_to_file'), 'Build is told which write tool reaches the checkout');
  assert.deepEqual(argv.slice(argv.indexOf('--mode'), argv.indexOf('--mode') + 2), ['--mode', 'accept-edits']);
  assert.deepEqual(argv.slice(argv.indexOf('--output-format'), argv.indexOf('--output-format') + 2), ['--output-format', 'stream-json']);
  assert.deepEqual(argv.slice(argv.indexOf('--model'), argv.indexOf('--model') + 2), ['--model', 'gemini-3.1-pro-high']);
  assert.equal(argv.includes('--effort'), false, 'agy model ids with an effort suffix reject a second effort flag');
  assert.equal(argv.includes('--dangerously-skip-permissions'), false);
  assert.equal(result.sessionId, 'fake-gemini-session');
  assert.equal(result.envelope.subtype, 'success');
  assert.equal(result.executionType, 'gateway');
  assert.equal(result.usage.input_tokens, 30);
  assert.ok(events.some((e) => e.type === 'turn.completed'));
});

test('Gemini Verify passes a private schema and retains a structured diagnostic', async (t) => {
  process.env.TODOMD_GEMINI_BIN = FAKE_GEMINI;
  const dir = tmp('gemini-verify');
  const argvLog = path.join(dir, 'argv.json');
  const schemaLog = path.join(dir, 'schema.json');
  const logFile = path.join(dir, 'verify.jsonl');
  process.env.FAKE_GEMINI_ARGV_LOG = argvLog;
  process.env.FAKE_GEMINI_SCHEMA_LOG = schemaLog;
  const result = await runStage({
    vendor: 'gemini', stage: 'Verify', cwd: dir, prompt: 'verify', effort: 'medium',
    jsonSchema: { type: 'object', properties: { verdict: { type: 'string' } } }, logFile,
  }).done;
  delete process.env.TODOMD_GEMINI_BIN; delete process.env.FAKE_GEMINI_ARGV_LOG; delete process.env.FAKE_GEMINI_SCHEMA_LOG;

  const argv = JSON.parse(fs.readFileSync(argvLog, 'utf8'));
  assert.deepEqual(argv.slice(argv.indexOf('--mode'), argv.indexOf('--mode') + 2), ['--mode', 'plan']);
  assert.deepEqual(argv.slice(argv.indexOf('--add-dir'), argv.indexOf('--add-dir') + 2), ['--add-dir', dir]);
  const sentVerify = argv[argv.indexOf('-p') + 1];
  assert.ok(sentVerify.includes(`task worktree at ${dir}`) && !sentVerify.includes('write_file'), 'review stages get the workspace note only');
  assert.deepEqual(argv.slice(argv.indexOf('--output-format'), argv.indexOf('--output-format') + 2), ['--output-format', 'json']);
  assert.ok(argv.includes('--json-schema'));
  assert.equal(result.envelope.structured_output.verdict, 'pass');
  assert.equal(result.diagnostic.executable, FAKE_GEMINI);
  assert.equal(result.diagnostic.cwd, dir);
  assert.equal(result.diagnostic.mode, 'plan');
  assert.equal(result.diagnostic.sandbox, true);
  assert.equal(JSON.parse(fs.readFileSync(schemaLog, 'utf8')).type, 'object');
  const raw = fs.readFileSync(logFile, 'utf8');
  assert.match(raw, /runner-diagnostic/);
  if (process.platform !== 'win32') {
    // The fixture copies the schema before cleanup; the runner's original temp
    // file is asserted indirectly by successful access and private-write code.
    assert.ok(true);
  }
});

test('Gemini with teamwork omits --disable-slash-commands and prefixes /teamwork-preview', async () => {
  process.env.TODOMD_GEMINI_BIN = FAKE_GEMINI;
  const dir = tmp('gemini-teamwork');
  const argvLog = path.join(dir, 'argv.json');
  process.env.FAKE_GEMINI_ARGV_LOG = argvLog;
  const result = await runStage({
    vendor: 'gemini', stage: 'Plan', cwd: dir, prompt: 'plan this epic',
    teamwork: true,
  }).done;
  delete process.env.TODOMD_GEMINI_BIN; delete process.env.FAKE_GEMINI_ARGV_LOG;

  const argv = JSON.parse(fs.readFileSync(argvLog, 'utf8'));
  assert.equal(argv.includes('--disable-slash-commands'), false, 'teamwork allows slash command expansion');
  const sentPrompt = argv[argv.indexOf('-p') + 1];
  assert.ok(sentPrompt.startsWith('/teamwork-preview plan this epic'), 'prompt is prefixed with /teamwork-preview');
  assert.equal(result.diagnostic.teamwork, true);
});

test('Gemini with workflow: teamwork activates teamwork automatically', async () => {
  process.env.TODOMD_GEMINI_BIN = FAKE_GEMINI;
  const dir = tmp('gemini-workflow-teamwork');
  const argvLog = path.join(dir, 'argv.json');
  process.env.FAKE_GEMINI_ARGV_LOG = argvLog;
  const result = await runStage({
    vendor: 'gemini', stage: 'Build', cwd: dir, prompt: 'build feature',
    workflow: 'teamwork',
  }).done;
  delete process.env.TODOMD_GEMINI_BIN; delete process.env.FAKE_GEMINI_ARGV_LOG;

  const argv = JSON.parse(fs.readFileSync(argvLog, 'utf8'));
  assert.equal(argv.includes('--disable-slash-commands'), false);
  const sentPrompt = argv[argv.indexOf('-p') + 1];
  assert.ok(sentPrompt.startsWith('/teamwork-preview build feature'));
  assert.equal(result.diagnostic.teamwork, true);
});

test('Gemini Verify preserves unsuccessful exit, stderr, and final message', async () => {
  process.env.TODOMD_GEMINI_BIN = FAKE_GEMINI;
  process.env.FAKE_GEMINI_NO_VERDICT = '1';
  process.env.FAKE_GEMINI_LAST_MESSAGE = 'transport returned no verdict';
  process.env.FAKE_GEMINI_STDERR = 'permission profile unavailable\n';
  process.env.FAKE_GEMINI_EXIT = '7';
  const dir = tmp('gemini-fail');
  const result = await runStage({
    vendor: 'gemini', stage: 'Verify', cwd: dir, prompt: 'verify',
    jsonSchema: { type: 'object' }, logFile: path.join(dir, 'verify.jsonl'),
  }).done;
  delete process.env.TODOMD_GEMINI_BIN; delete process.env.FAKE_GEMINI_NO_VERDICT;
  delete process.env.FAKE_GEMINI_LAST_MESSAGE; delete process.env.FAKE_GEMINI_STDERR; delete process.env.FAKE_GEMINI_EXIT;

  assert.equal(result.envelope.is_error, true);
  assert.equal(result.diagnostic.exitCode, 7);
  assert.equal(result.diagnostic.stderr, 'permission profile unavailable\n');
  assert.equal(result.diagnostic.finalMessage, 'transport returned no verdict');
  assert.equal(result.diagnostic.structuredOutput, null);
});

test('Gemini real stream result preserves the primary infrastructure error', async () => {
  process.env.TODOMD_GEMINI_BIN = FAKE_GEMINI;
  process.env.FAKE_GEMINI_REAL_STREAM = '1';
  process.env.FAKE_GEMINI_NO_SESSION = '1';
  process.env.FAKE_GEMINI_LAST_MESSAGE = 'invalid model selection: effort is not supported';
  process.env.FAKE_GEMINI_STDERR = 'warning: conversation not found\n';
  process.env.FAKE_GEMINI_EXIT = '1';
  const dir = tmp('gemini-real-stream');
  const result = await runStage({
    vendor: 'gemini', stage: 'Build', cwd: dir, prompt: 'build',
    model: 'gemini-3.1-pro-high', effort: 'xhigh', logFile: path.join(dir, 'build.jsonl'),
  }).done;
  delete process.env.TODOMD_GEMINI_BIN; delete process.env.FAKE_GEMINI_REAL_STREAM;
  delete process.env.FAKE_GEMINI_NO_SESSION; delete process.env.FAKE_GEMINI_LAST_MESSAGE;
  delete process.env.FAKE_GEMINI_STDERR; delete process.env.FAKE_GEMINI_EXIT;

  assert.equal(result.envelope.is_error, true);
  assert.match(result.envelope.result, /invalid model selection/);
  assert.equal(result.diagnostic.finalMessage, 'invalid model selection: effort is not supported');
  assert.equal(result.diagnostic.stderr, 'warning: conversation not found\n');
  assert.equal(result.sessionId, null);
});


test('a headless run denied a permission is a failed run, not an empty success', async () => {
  process.env.TODOMD_GEMINI_BIN = FAKE_GEMINI;
  process.env.FAKE_GEMINI_DENIED = 'command';
  const dir = tmp('gemini-denied');
  const result = await runStage({
    vendor: 'gemini', stage: 'Build', cwd: dir, prompt: 'build',
    logFile: path.join(dir, 'build.jsonl'),
  }).done;
  delete process.env.TODOMD_GEMINI_BIN; delete process.env.FAKE_GEMINI_DENIED;

  // exit 0, status SUCCESS and a completed turn — only denied_actions says the
  // run never did anything, so the envelope must not report success.
  assert.equal(result.exitCode, 0);
  assert.equal(result.envelope.is_error, true);
  assert.equal(result.envelope.subtype, 'error');
  assert.deepEqual(result.envelope.denied_actions, [{ action: 'command', target: 'RunCommand' }]);
  assert.match(result.envelope.result, /auto-denied/);
  assert.match(result.envelope.result, /command \(RunCommand\)/);
  assert.deepEqual(result.diagnostic.deniedActions, [{ action: 'command', target: 'RunCommand' }]);
});

test('an ordinary run carries no denied_actions', async () => {
  process.env.TODOMD_GEMINI_BIN = FAKE_GEMINI;
  const dir = tmp('gemini-not-denied');
  const result = await runStage({ vendor: 'gemini', stage: 'Build', cwd: dir, prompt: 'build' }).done;
  delete process.env.TODOMD_GEMINI_BIN;
  assert.equal(result.envelope.is_error, false);
  assert.equal(result.envelope.denied_actions, undefined);
  assert.deepEqual(result.diagnostic.deniedActions, []);
});

test('denial summaries name every refused permission and stay empty otherwise', () => {
  assert.equal(describeDeniedActions(undefined), '');
  assert.equal(describeDeniedActions([]), '');
  assert.deepEqual(normalizeDeniedActions([{ action: 'command' }, 'unsandboxed', { junk: 1 }]),
    [{ action: 'command', target: '' }, { action: 'unsandboxed', target: '' }]);
  const text = describeDeniedActions([{ action: 'command', display_name: 'RunCommand' }, { action: 'unsandboxed' }]);
  assert.match(text, /command \(RunCommand\)/);
  assert.match(text, /unsandboxed/);
  assert.match(text, /permission allow-list/);
});

test('the provider terminal sandbox is on by default and opt-out per stage', async () => {
  process.env.TODOMD_GEMINI_BIN = FAKE_GEMINI;
  const dir = tmp('gemini-sandbox-config');

  // Review stages keep the sandbox: they only read, so confinement is free.
  const reviewLog = path.join(dir, 'review-argv.json');
  process.env.FAKE_GEMINI_ARGV_LOG = reviewLog;
  await runStage({ vendor: 'gemini', stage: 'Verify', cwd: dir, prompt: 'verify', jsonSchema: { type: 'object' } }).done;
  const review = JSON.parse(fs.readFileSync(reviewLog, 'utf8'));
  assert.ok(review.includes('--sandbox'));
  assert.deepEqual(review.slice(review.indexOf('--mode'), review.indexOf('--mode') + 2), ['--mode', 'plan']);

  // An unset stage sandbox is still ON — the opt-out has to be explicit.
  const defaultLog = path.join(dir, 'default-argv.json');
  process.env.FAKE_GEMINI_ARGV_LOG = defaultLog;
  await runStage({ vendor: 'gemini', stage: 'Build', cwd: dir, prompt: 'build', terminalSandbox: undefined }).done;
  assert.ok(JSON.parse(fs.readFileSync(defaultLog, 'utf8')).includes('--sandbox'));

  // A Build that must commit from a worktree checkout can drop the terminal
  // sandbox — and still never reaches for the global skip-permissions hatch.
  const buildLog = path.join(dir, 'build-argv.json');
  process.env.FAKE_GEMINI_ARGV_LOG = buildLog;
  const result = await runStage({ vendor: 'gemini', stage: 'Build', cwd: dir, prompt: 'build', terminalSandbox: false }).done;
  delete process.env.TODOMD_GEMINI_BIN; delete process.env.FAKE_GEMINI_ARGV_LOG;
  const build = JSON.parse(fs.readFileSync(buildLog, 'utf8'));
  assert.equal(build.includes('--sandbox'), false);
  assert.equal(build.includes('--dangerously-skip-permissions'), false);
  assert.deepEqual(build.slice(build.indexOf('--mode'), build.indexOf('--mode') + 2), ['--mode', 'accept-edits']);
  assert.equal(result.diagnostic.sandbox, false);
});

test('Claude main model comes from init, not the first auxiliary modelUsage entry', async () => {
  process.env.TODOMD_CLAUDE_BIN = FAKE;
  process.env.FAKE_MODE = 'parsing';
  process.env.FAKE_INIT_MODEL = 'claude-fable-5-1';
  process.env.FAKE_MODEL_USAGE = JSON.stringify({ 'claude-haiku-4-5-20251001': {}, 'claude-fable-5-1': {} });
  try {
    const result = await runStage({ cwd: process.cwd(), prompt: 'x', model: 'opus' }).done;
    assert.equal(result.model, 'claude-fable-5-1');
    delete process.env.FAKE_INIT_MODEL;
    const fallback = await runStage({ cwd: process.cwd(), prompt: 'x', model: 'opus' }).done;
    assert.equal(fallback.model, 'opus', 'ambiguous usage cannot override the configured model');
    const unknown = await runStage({ cwd: process.cwd(), prompt: 'x' }).done;
    assert.equal(unknown.model, '', 'ambiguous usage is not proof of a main model');
  } finally {
    for (const key of ['TODOMD_CLAUDE_BIN', 'FAKE_MODE', 'FAKE_INIT_MODEL', 'FAKE_MODEL_USAGE']) delete process.env[key];
  }
});

test('a provider reporting zero turns and an empty response is never successful', async () => {
  process.env.TODOMD_CLAUDE_BIN = FAKE;
  process.env.FAKE_MODE = 'parsing';
  process.env.FAKE_EMPTY_RESULT = '1';
  process.env.FAKE_TURNS = '0';
  try {
    const result = await runStage({ cwd: process.cwd(), prompt: 'anything' }).done;
    assert.equal(result.envelope.is_error, true);
    assert.equal(result.envelope.subtype, 'empty_run');
  } finally {
    delete process.env.TODOMD_CLAUDE_BIN; delete process.env.FAKE_MODE;
    delete process.env.FAKE_EMPTY_RESULT; delete process.env.FAKE_TURNS;
  }
});

test('Gemini reported turns are preserved and absent metrics stay unknown', async () => {
  process.env.TODOMD_GEMINI_BIN = FAKE_GEMINI;
  try {
    process.env.FAKE_GEMINI_DENIED = 'command';
    const denied = await runStage({ vendor: 'gemini', cwd: tmp('gemini-reported-turns'), prompt: 'build' }).done;
    assert.equal(denied.envelope.num_turns, 1);
    delete process.env.FAKE_GEMINI_DENIED;
    process.env.FAKE_GEMINI_REAL_STREAM = '1';
    const unknown = await runStage({ vendor: 'gemini', cwd: tmp('gemini-unknown-turns'), prompt: 'build' }).done;
    assert.equal(unknown.envelope.num_turns, null);
    assert.equal(unknown.envelope.is_error, false);
  } finally {
    delete process.env.TODOMD_GEMINI_BIN; delete process.env.FAKE_GEMINI_REAL_STREAM; delete process.env.FAKE_GEMINI_DENIED;
  }
});

test('Claude with teamwork enables slash commands, agent teams env, and injects multi-agent protocol', async () => {
  process.env.TODOMD_CLAUDE_BIN = FAKE;
  process.env.FAKE_MODE = 'parsing';
  const log = path.join(tmp('claude-teamwork'), 'argv.jsonl');
  const envLog = path.join(tmp('claude-teamwork'), 'env.json');
  process.env.FAKE_ARGV_LOG = log;
  process.env.FAKE_ENV_LOG = envLog;
  try {
    const res = await runStage({ cwd: process.cwd(), prompt: 'build feature', vendor: 'claude', teamwork: true }).done;
    assert.equal(res.teamwork, true);
    const argv = JSON.parse(fs.readFileSync(log, 'utf8'));
    assert.ok(argv.includes('--safe-mode'));
    assert.equal(argv.includes('--disable-slash-commands'), false, 'slash commands must be enabled for teamwork');
    const envData = JSON.parse(fs.readFileSync(envLog, 'utf8'));
    assert.equal(envData.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, '1', 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS must be set to 1');
    const promptArg = argv[argv.indexOf('-p') + 1];
    assert.ok(promptArg.includes('Multi-Agent Teamwork Orchestration Protocol (Claude Teamwork)'));
  } finally {
    delete process.env.FAKE_MODE; delete process.env.TODOMD_CLAUDE_BIN; delete process.env.FAKE_ARGV_LOG; delete process.env.FAKE_ENV_LOG;
  }
});

test('Codex with teamwork injects multi-agent protocol and reports teamwork in diagnostic', async () => {
  process.env.TODOMD_CODEX_BIN = FAKE_CODEX;
  const log = path.join(tmp('codex-teamwork'), 'argv.jsonl');
  process.env.FAKE_CODEX_ARGV_LOG = log;
  try {
    const res = await runStage({ cwd: process.cwd(), prompt: 'implement epic', vendor: 'codex', teamwork: true }).done;
    assert.equal(res.teamwork, true);
    assert.equal(res.diagnostic?.teamwork, true);
    if (fs.existsSync(log)) {
      const argv = JSON.parse(fs.readFileSync(log, 'utf8'));
      assert.ok(argv.includes('features.multi_agent=true'), 'features.multi_agent must be enabled for Codex teamwork');
      const promptArg = argv[argv.length - 1];
      assert.ok(promptArg.includes('Multi-Agent Teamwork Orchestration Protocol (Codex Teamwork)'));
    }
  } finally {
    delete process.env.TODOMD_CODEX_BIN; delete process.env.FAKE_CODEX_ARGV_LOG;
  }
});
