#!/usr/bin/env node
// Deterministic stand-in for `claude -p`. Reads the same argv the runner passes,
// performs the file ops a real stage agent would, and emits the same JSON shapes
// (stream-json events or a buffered envelope with structured_output).
//
// Behavior is steered by FAKE_* env vars set by the test:
//   FAKE_MODE=stream-json (parsing tests echo a fixed sequence)
//   FAKE_VERDICT=pass|fail   — what the verify stage returns
//   FAKE_BUILD=good|bad|noop — whether build writes passing/failing/no code
//   FAKE_EMPTY_RESULT=1      — report success with an empty final response
//   FAKE_FAIL=1              — exit non-zero (agent error)
//   FAKE_MAXTURNS=1         — emit an error_max_turns envelope
//   FAKE_MAXTURNS_ONCE_MARKER=<path> — emit it once, then complete normally
//   FAKE_HANG=1|<stage>     — hang a stage until SIGTERM (1 = build; once per
//                             FAKE_HANG_MARKER so a re-driven run proceeds)
//   FAKE_HANG_ON=N + FAKE_HANG_COUNTER=<path> — hang only the Nth matching
//                             stage run (counted via the counter file), e.g. a
//                             retry build; takes precedence over the marker
//   FAKE_IGNORE_TERM=1      — while hanging, ignore SIGTERM (forces a SIGKILL)
//   FAKE_RM_WORKTREE=1      — build deletes its own worktree cwd before
//                             exiting, so the NEXT stage's spawn hits ENOENT
//                             on the cwd (not on the binary)
//   FAKE_SWITCH_REPO/FAKE_SWITCH_BRANCH — on verify, checkout -b this branch in
//                             the given repo (simulates the user switching
//                             branches mid-run before the merge)
//   FAKE_ARGV_LOG=<path>   — append each invocation's full argv (JSON lines),
//                             so a test can assert what the runner passed
//   FAKE_REQUIRE_FILE=<relpath> — a build fails unless this existing worktree
//                             file survived (used by orphan recovery tests)
//   FAKE_LEAVE_DIRTY=1      — leave an untracked candidate file after commit
//   FAKE_FINDINGS=<text>    — override verifier findings (empty is allowed)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

const argv = process.argv.slice(2);
if (process.env.FAKE_ARGV_LOG) {
  fs.appendFileSync(process.env.FAKE_ARGV_LOG, JSON.stringify(argv) + '\n');
}
if (process.env.FAKE_ENV_LOG) {
  fs.writeFileSync(process.env.FAKE_ENV_LOG, JSON.stringify({ CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS }));
}
// record the permission bits of the --settings file (the runner deletes it as
// soon as the run ends, so only the child can see them)
if (process.env.FAKE_STAT_SETTINGS) {
  const i = argv.indexOf('--settings');
  let mode = 'none';
  try { if (i >= 0) mode = (fs.statSync(argv[i + 1]).mode & 0o777).toString(8); } catch { mode = 'unreadable'; }
  fs.writeFileSync(process.env.FAKE_STAT_SETTINGS, mode);
}
// copy out the --settings CONTENT — same reason: the runner deletes the file
// when the run ends
if (process.env.FAKE_DUMP_SETTINGS) {
  const i = argv.indexOf('--settings');
  try { fs.writeFileSync(process.env.FAKE_DUMP_SETTINGS, i >= 0 ? fs.readFileSync(argv[i + 1], 'utf8') : '(no --settings)'); } catch {}
}
const prompt = argv.find((a) => !a.startsWith('-') && a !== '-p') || '';
const has = (f) => argv.includes(f);
const cwd = process.cwd();
const session = 'fake-session-0001';

const emitStream = (events) => {
  for (const e of events) process.stdout.write(JSON.stringify({ session_id: session, ...(e.type === 'system' && e.subtype === 'init' && process.env.FAKE_INIT_MODEL ? { model: process.env.FAKE_INIT_MODEL } : {}), ...e }) + '\n');
};
const resultEnvelope = (extra = {}) => ({
  type: 'result', subtype: 'success', is_error: false,
  total_cost_usd: 0.001, num_turns: Number(process.env.FAKE_TURNS ?? 1), session_id: session,
  // FAKE_EMPTY_RESULT reproduces a provider that reports success with no final
  // text at all — the shape a run blocked before it acted comes back in.
  result: process.env.FAKE_EMPTY_RESULT ? '' : 'ok',
  usage: { input_tokens: 20, cache_read_input_tokens: 10, cache_creation_input_tokens: 2, output_tokens: 5 },
  ...(process.env.FAKE_MODEL_USAGE ? { modelUsage: JSON.parse(process.env.FAKE_MODEL_USAGE) } : {}),
  ...extra,
});

async function safeExit(code = 0) {
  // Empty writes run their callbacks after all preceding output is flushed.
  // Await at each call site so no other fixture branch executes while draining.
  await Promise.all([process.stdout, process.stderr].map(stream =>
    new Promise(resolve => stream.write('', resolve))));
  process.exit(code);
}

async function waitBeforeExit() {
  if (process.env.FAKE_BEFORE_EXIT_MARKER) fs.writeFileSync(process.env.FAKE_BEFORE_EXIT_MARKER, 'ready');
  const exitDelay = Number(process.env.FAKE_EXIT_DELAY_MS) || 0;
  if (exitDelay > 0) await new Promise((resolve) => setTimeout(resolve, exitDelay));
}

function findCard(id) {
  const dir = path.join(cwd, '.todomd/tasks');
  const f = fs.readdirSync(dir).find((x) => x.startsWith(`${id}-`) || x === `${id}.md`);
  return f ? path.join(dir, f) : null;
}
const taskId = (prompt.match(/task-\d+/) || [])[0];

if (process.env.FAKE_CORRUPT_CARD) {
  const file = findCard(taskId);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^title:.*$/m, 'title: Broken: agent title'));
  emitStream([{ type: 'system', subtype: 'init' }, resultEnvelope()]);
  await safeExit(0);
}

// ── quota-once: emit a usage-limit error on the first BUILD run, then behave ──
if (process.env.FAKE_QUOTA_MARKER && prompt.includes('build') && !fs.existsSync(process.env.FAKE_QUOTA_MARKER)) {
  fs.writeFileSync(process.env.FAKE_QUOTA_MARKER, '1');
  emitStream([{ type: 'system', subtype: 'init' },
    resultEnvelope({ subtype: 'error', is_error: true, result: 'usage limit reached — please try again later' })]);
  await safeExit(0);
}

// ── forced-failure modes ──
if (process.env.FAKE_FAIL === '1') { process.stderr.write('forced failure\n'); await safeExit(1); }
if (process.env.FAKE_MAXTURNS_ONCE_MARKER && !fs.existsSync(process.env.FAKE_MAXTURNS_ONCE_MARKER)) {
  fs.writeFileSync(process.env.FAKE_MAXTURNS_ONCE_MARKER, '1');
  emitStream([{ type: 'system', subtype: 'init' }, resultEnvelope({ subtype: 'error_max_turns', is_error: true })]);
  await safeExit(0);
}
if (process.env.FAKE_MAXTURNS === '1') {
  if (process.env.FAKE_MAXTURNS_PROGRESS_FILE) {
    const progressFile = path.join(cwd, process.env.FAKE_MAXTURNS_PROGRESS_FILE);
    fs.mkdirSync(path.dirname(progressFile), { recursive: true });
    fs.appendFileSync(progressFile, `${Date.now()}-${Math.random()}\n`);
  }
  emitStream([{ type: 'system', subtype: 'init' }, resultEnvelope({ subtype: 'error_max_turns', is_error: true })]);
  await safeExit(0);
}

// ── raw parsing-test mode: emit a canned sequence incl. a trailing newline-less line ──
if (process.env.FAKE_MODE === 'parsing') {
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: session, model: process.env.FAKE_INIT_MODEL }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'héllo 日本語' }] }, session_id: session }) + '\n');
  // final result with NO trailing newline — exercises the flush path
  process.stdout.write(JSON.stringify(resultEnvelope()));
  await safeExit(0);
}

const promptLower = prompt.toLowerCase();
const stage = (promptLower.includes('read-only agent attached') || promptLower.includes('advisory agent attached')) ? 'other'
  : has('--resume') ? 'build' // only retry builds resume a session
  : promptLower.includes('todomd-verify') ? 'verify'
  : promptLower.includes('todomd-build') ? 'build'
  : promptLower.includes('todomd-plan') ? 'plan'
  : has('--json-schema') ? 'verify'
  : promptLower.includes('plan') ? 'plan'
  : promptLower.includes('build') ? 'build'
  : promptLower.includes('verify') ? 'verify' : 'other';

if (process.env.FAKE_RESUME_MISSING && has('--resume')) {
  emitStream([resultEnvelope({
    subtype: 'error_during_execution',
    is_error: true,
    num_turns: 0,
    result: '',
    errors: process.env.FAKE_RESUME_MISSING === 'empty' ? [] : ['No conversation found with session ID: fake-session'],
  })]);
  await safeExit(0);
}

if (prompt.startsWith('TODOMD BOARD AGENT\n')) {
  process.stdout.write(JSON.stringify(resultEnvelope({ structured_output: JSON.parse(process.env.FAKE_BOARD_AGENT_OUTPUT || '{"reply":"Your selected boards are ready for review.","actions":[]}') })));
  await safeExit(0);
}

if (prompt.includes('TODOMD CARD SUMMARY REQUEST')) {
  emitStream([resultEnvelope({ structured_output: {
    description_tldr: process.env.FAKE_DESCRIPTION_TLDR || 'The card needs a concise semantic description summary.',
    last_run_tldr: process.env.FAKE_LAST_RUN_TLDR || 'The latest run completed and left a concrete next action.',
  } })]);
  await safeExit(0);
}

if (prompt.includes('TODOMD RECOVERY REVIEW')) {
  process.stdout.write(JSON.stringify(resultEnvelope({ structured_output: {
    action: process.env.FAKE_RECOVERY_ACTION || 'hold_for_human',
    confidence: process.env.FAKE_RECOVERY_CONFIDENCE || 'high',
    diagnosis: process.env.FAKE_RECOVERY_DIAGNOSIS || 'The evidence requires an explicit human decision.',
    handoff: process.env.FAKE_RECOVERY_HANDOFF || '',
  } })));
  await safeExit(0);
}

// ── hang a stage until SIGTERM, so a test can cancel/timeout a LIVE run ──
// FAKE_HANG=1 hangs the build (legacy); FAKE_HANG=<stage> hangs that stage.
// With FAKE_HANG_MARKER set it hangs only ONCE (the marker records the first
// hang), so a re-driven run proceeds normally. With FAKE_HANG_ON=N it hangs
// only the Nth matching run (counted via FAKE_HANG_COUNTER) — e.g. hang the
// RETRY build while the first build proceeds. The hang is terminal: the stage
// dispatch below is an else-chain so a hanging run never falls through and
// completes on its own.
const hangStage = process.env.FAKE_HANG === '1' ? 'build' : process.env.FAKE_HANG;
let hangNow = hangStage && stage === hangStage;
if (hangNow && process.env.FAKE_HANG_ON) {
  const cf = process.env.FAKE_HANG_COUNTER;
  const n = (cf && fs.existsSync(cf) ? Number(fs.readFileSync(cf, 'utf8')) || 0 : 0) + 1;
  if (cf) fs.writeFileSync(cf, String(n));
  hangNow = n === Number(process.env.FAKE_HANG_ON);
}
if (hangNow &&
    !(process.env.FAKE_HANG_MARKER && fs.existsSync(process.env.FAKE_HANG_MARKER))) {
  if (process.env.FAKE_HANG_MARKER) fs.writeFileSync(process.env.FAKE_HANG_MARKER, '1');
  if (process.env.FAKE_HANG_DESCENDANT) {
    // The leader exits on TERM; its writer ignores TERM and closes inherited
    // pipes. A leader-only close/backstop must not count as cancellation.
    const dir = process.env.FAKE_HANG_DESCENDANT;
    fs.mkdirSync(path.join(cwd, '.todomd/runs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'leader'), String(process.pid));
    spawn(process.execPath, ['-e', `
      const fs = require('node:fs');
      process.on('SIGTERM', () => {});
      fs.writeFileSync(${JSON.stringify(path.join(dir, 'descendant'))}, String(process.pid));
      setInterval(() => fs.appendFileSync(${JSON.stringify(path.join(cwd, '.todomd/runs/writes'))}, 'x'), 15);
    `], { stdio: 'ignore' });
  }
  if (process.env.FAKE_IGNORE_TERM) process.on('SIGTERM', () => {}); // stubborn child — only SIGKILL stops it
  setInterval(() => {}, 1 << 30); // keep alive; the runner SIGTERMs us on cancel/timeout
} else if (stage === 'plan') {
  const file = findCard(taskId);
  if (file) {
    const raw = fs.readFileSync(file, 'utf8');
    const profile = process.env.FAKE_BUILD_PROFILE || (process.env.FAKE_CHUNKS ? 'split_required' : 'standard');
    const planned = /^build_profile:.*$/m.test(raw)
      ? raw.replace(/^build_profile:.*$/m, `build_profile: ${profile}`)
      : raw.replace(/^agent:.*$/m, (line) => `${line}\nbuild_profile: ${profile}`);
    if (process.env.FAKE_CHUNKS) {
      // split into N chunks: write a `## Chunks` yaml block, leave the plan empty
      const n = Math.max(1, Number(process.env.FAKE_CHUNKS) || 2);
      const items = [];
      for (let i = 1; i <= n; i++) {
        items.push(`- title: Chunk ${i}\n  plan: |\n    1. Implement part ${i}.\n  criteria:\n    - Part ${i} works`);
      }
      const block = '## Chunks\n\n```yaml\n' + items.join('\n') + '\n```\n\n';
      fs.writeFileSync(file, planned.replace('## Run Log', block + '## Run Log'));
    } else {
      fs.writeFileSync(file, planned.replace('## Implementation Plan\n', '## Implementation Plan\n\n1. Do the thing.\n'));
    }
  }
  // Let tests park the orchestrator precisely after the agent has finished its
  // work but before the child exits and the stage finalizer starts.
  await waitBeforeExit();
  emitStream([{ type: 'system', subtype: 'init' }, { type: 'assistant', message: { content: [{ type: 'text', text: 'planned' }] } }, resultEnvelope()]);
  await safeExit(0);
} else if (stage === 'build') {
  // cwd is the worktree; write code + test, commit on the branch
  if (process.env.FAKE_REQUIRE_FILE && !fs.existsSync(path.join(cwd, process.env.FAKE_REQUIRE_FILE))) {
    process.stderr.write(`preserved file missing: ${process.env.FAKE_REQUIRE_FILE}\n`);
    await safeExit(1);
  }
  const mode = process.env.FAKE_BUILD || 'good';
  if (mode === 'docs') {
    fs.writeFileSync(path.join(cwd, 'CHANGE.md'), 'Documentation update.\n');
    execFileSync('git', ['add', 'CHANGE.md'], { cwd });
    execFileSync('git', ['commit', '-qm', 'docs update'], { cwd });
  } else if (mode !== 'noop') {
    const fn = mode === 'bad' ? 'export function prod(a, b) { return a + b; }\n'  // wrong: returns sum
                              : 'export function prod(a, b) { return a * b; }\n';
    fs.appendFileSync(path.join(cwd, 'src/calc.js'), fn);
    fs.writeFileSync(path.join(cwd, 'src/prod.test.js'),
      `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { prod } from './calc.js';\n` +
      `test('prod', () => { assert.equal(prod(3, 4), 12); });\n`);
    execFileSync('git', ['add', '-A'], { cwd });
    if (process.env.FAKE_BUILD_INDEX_LOCK) {
      const lock = execFileSync('git', ['rev-parse', '--git-path', 'index.lock'], { cwd, encoding: 'utf8' }).trim();
      fs.writeFileSync(lock, 'fixture-owned lock');
      fs.writeFileSync(process.env.FAKE_BUILD_INDEX_LOCK, lock);
      emitStream([resultEnvelope({ is_error: true, subtype: 'error', result: `fatal: Unable to create '${lock}': File exists.` })]);
      await safeExit(0);
    }
    execFileSync('git', ['commit', '-qm', `${taskId}: add prod`], { cwd });
  }
  if (process.env.FAKE_LEAVE_DIRTY) {
    fs.writeFileSync(path.join(cwd, 'src/uncommitted.js'), 'export const dirty = true;\n');
  }
  // delete the worktree from under the run: the NEXT stage (verify) then fails
  // to spawn with ENOENT on its cwd — distinct from a missing CLI binary
  if (process.env.FAKE_RM_WORKTREE) fs.rmSync(cwd, { recursive: true, force: true });
  emitStream([{ type: 'system', subtype: 'init' }, resultEnvelope()]);
  await safeExit(0);
} else if (stage === 'verify') {
  // A deterministic checkpoint for source changes while Verify is in flight.
  while (process.env.FAKE_VERIFY_RELEASE && !fs.existsSync(process.env.FAKE_VERIFY_RELEASE)) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  // simulate the user switching branches in the main repo mid-run, just before
  // the orchestrator would merge
  if (process.env.FAKE_SWITCH_REPO && process.env.FAKE_SWITCH_BRANCH) {
    execFileSync('git', ['-C', process.env.FAKE_SWITCH_REPO, 'checkout', '-qb', process.env.FAKE_SWITCH_BRANCH], { stdio: 'ignore' });
  }
  // buffered mode (--json-schema): emit one envelope with structured_output
  const verdict = process.env.FAKE_VERDICT || 'pass';
  const structured = {
    verdict,
    criteria: [{ criterion: 'works', met: process.env.FAKE_CRITERIA_MET === '1' || verdict === 'pass' }],
    findings: Object.hasOwn(process.env, 'FAKE_FINDINGS')
      ? process.env.FAKE_FINDINGS
      : verdict === 'pass' ? 'all good' : 'prod returns the wrong value',
    setup_error: null,
    question: null,
    checks_requested: [],
  };
  // simulate "the verify command couldn't even run" (missing gitignored dep/env)
  if (process.env.FAKE_SETUP_ERROR) structured.setup_error = process.env.FAKE_SETUP_ERROR;
  if (process.env.FAKE_CHECKS_REQUESTED &&
      !(process.env.FAKE_CHECKS_MARKER && fs.existsSync(process.env.FAKE_CHECKS_MARKER))) {
    structured.checks_requested = process.env.FAKE_CHECKS_REQUESTED.split('|').filter(Boolean);
    if (process.env.FAKE_CHECKS_MARKER) fs.writeFileSync(process.env.FAKE_CHECKS_MARKER, '1');
  }
  // simulate "the agent needs a human decision" ONCE (marker), then behave
  if (process.env.FAKE_QUESTION && process.env.FAKE_QUESTION_MARKER && !fs.existsSync(process.env.FAKE_QUESTION_MARKER)) {
    fs.writeFileSync(process.env.FAKE_QUESTION_MARKER, '1');
    structured.verdict = 'fail';
    structured.question = process.env.FAKE_QUESTION;
  }
  process.stdout.write(JSON.stringify(resultEnvelope({ structured_output: structured })));
  await safeExit(0);
} else {
  await waitBeforeExit();
  emitStream([
    { type: 'system', subtype: 'init' },
    ...(process.env.FAKE_OTHER_MESSAGE
      ? [{ type: 'assistant', message: { content: [{ type: 'text', text: process.env.FAKE_OTHER_MESSAGE }] } }]
      : []),
    resultEnvelope(),
  ]);
  await safeExit(0);
}
