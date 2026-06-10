#!/usr/bin/env node
// Deterministic stand-in for `claude -p`. Reads the same argv the runner passes,
// performs the file ops a real stage agent would, and emits the same JSON shapes
// (stream-json events or a buffered envelope with structured_output).
//
// Behavior is steered by FAKE_* env vars set by the test:
//   FAKE_MODE=stream-json (parsing tests echo a fixed sequence)
//   FAKE_VERDICT=pass|fail   — what the verify stage returns
//   FAKE_BUILD=good|bad|noop — whether build writes passing/failing/no code
//   FAKE_FAIL=1              — exit non-zero (agent error)
//   FAKE_MAXTURNS=1         — emit an error_max_turns envelope
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const prompt = argv.find((a) => !a.startsWith('-') && a !== '-p') || '';
const has = (f) => argv.includes(f);
const cwd = process.cwd();
const session = 'fake-session-0001';

const emitStream = (events) => {
  for (const e of events) process.stdout.write(JSON.stringify({ session_id: session, ...e }) + '\n');
};
const resultEnvelope = (extra = {}) => ({
  type: 'result', subtype: 'success', is_error: false,
  total_cost_usd: 0.001, num_turns: 1, session_id: session, result: 'ok', ...extra,
});

function findCard(id) {
  const dir = path.join(cwd, '.todomd/tasks');
  const f = fs.readdirSync(dir).find((x) => x.startsWith(`${id}-`) || x === `${id}.md`);
  return f ? path.join(dir, f) : null;
}
const taskId = (prompt.match(/task-\d+/) || [])[0];

// ── forced-failure modes ──
if (process.env.FAKE_FAIL === '1') { process.stderr.write('forced failure\n'); process.exit(1); }
if (process.env.FAKE_MAXTURNS === '1') {
  emitStream([{ type: 'system', subtype: 'init' }, resultEnvelope({ subtype: 'error_max_turns', is_error: true })]);
  process.exit(0);
}

// ── raw parsing-test mode: emit a canned sequence incl. a trailing newline-less line ──
if (process.env.FAKE_MODE === 'parsing') {
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: session }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'héllo 日本語' }] }, session_id: session }) + '\n');
  // final result with NO trailing newline — exercises the flush path
  process.stdout.write(JSON.stringify(resultEnvelope()));
  process.exit(0);
}

const stage = prompt.includes('plan') ? 'plan'
  : prompt.includes('build') ? 'build'
  : prompt.includes('verify') ? 'verify' : 'other';

if (stage === 'plan') {
  const file = findCard(taskId);
  if (file) {
    const raw = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, raw.replace('## Implementation Plan\n', '## Implementation Plan\n\n1. Do the thing.\n'));
  }
  emitStream([{ type: 'system', subtype: 'init' }, { type: 'assistant', message: { content: [{ type: 'text', text: 'planned' }] } }, resultEnvelope()]);
  process.exit(0);
}

if (stage === 'build') {
  // cwd is the worktree; write code + test, commit on the branch
  const mode = process.env.FAKE_BUILD || 'good';
  if (mode !== 'noop') {
    const fn = mode === 'bad' ? 'export function prod(a, b) { return a + b; }\n'  // wrong: returns sum
                              : 'export function prod(a, b) { return a * b; }\n';
    fs.appendFileSync(path.join(cwd, 'src/calc.js'), fn);
    fs.writeFileSync(path.join(cwd, 'src/prod.test.js'),
      `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { prod } from './calc.js';\n` +
      `test('prod', () => { assert.equal(prod(3, 4), 12); });\n`);
    execFileSync('git', ['add', '-A'], { cwd });
    execFileSync('git', ['commit', '-qm', `${taskId}: add prod`], { cwd });
  }
  emitStream([{ type: 'system', subtype: 'init' }, resultEnvelope()]);
  process.exit(0);
}

if (stage === 'verify') {
  // buffered mode (--json-schema): emit one envelope with structured_output
  const verdict = process.env.FAKE_VERDICT || 'pass';
  const env = resultEnvelope({
    structured_output: {
      verdict,
      criteria: [{ criterion: 'works', met: verdict === 'pass' }],
      findings: verdict === 'pass' ? 'all good' : 'prod returns the wrong value',
    },
  });
  process.stdout.write(JSON.stringify(env));
  process.exit(0);
}

emitStream([{ type: 'system', subtype: 'init' }, resultEnvelope()]);
