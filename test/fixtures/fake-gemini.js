#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
if (process.env.FAKE_GEMINI_ARGV_LOG) {
  fs.writeFileSync(process.env.FAKE_GEMINI_ARGV_LOG, JSON.stringify(args));
}
if (process.env.FAKE_GEMINI_PLAN_COMPLEXITY) {
  const dir = path.join(process.cwd(), '.todomd/tasks');
  const file = path.join(dir, fs.readdirSync(dir).find((f) => f.startsWith('task-0001')));
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^---\n/,
    `---\ncomplexity: ${process.env.FAKE_GEMINI_PLAN_COMPLEXITY}\nbuild_profile: long\n`));
}
const schemaIndex = args.indexOf('--json-schema');
if (process.env.FAKE_GEMINI_SCHEMA_LOG && schemaIndex >= 0) {
  fs.writeFileSync(process.env.FAKE_GEMINI_SCHEMA_LOG, fs.readFileSync(args[schemaIndex + 1], 'utf8'));
}
const verdict = {
  verdict: 'pass',
  criteria: [{ criterion: 'works', met: true }],
  findings: '',
  setup_error: null,
  question: null,
};
const stderr = process.env.FAKE_GEMINI_STDERR || '';
const exitCode = Number(process.env.FAKE_GEMINI_EXIT || 0);
const format = args[args.indexOf('--output-format') + 1];

if (format === 'stream-json') {
  if (process.env.FAKE_GEMINI_REAL_STREAM) {
    process.stdout.write(JSON.stringify({ event: 'result', result: {
      conversation_id: process.env.FAKE_GEMINI_NO_SESSION ? '' : 'fake-gemini-session',
      status: exitCode ? 'ERROR' : 'SUCCESS', response: exitCode ? '' : 'done',
      error: exitCode ? (process.env.FAKE_GEMINI_LAST_MESSAGE || 'model selection failed') : '',
    } }));
  } else {
    process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fake-gemini-session' }) + '\n');
    process.stdout.write(JSON.stringify({ type: 'turn.completed', session_id: 'fake-gemini-session',
      usage: { input_tokens: 30, cached_input_tokens: 12, output_tokens: 7 } }) + '\n');
    process.stdout.write(JSON.stringify({ type: 'result', subtype: exitCode ? 'error' : 'success', is_error: !!exitCode,
      session_id: 'fake-gemini-session', result: process.env.FAKE_GEMINI_LAST_MESSAGE || 'done' }));
  }
} else {
  const body = process.env.FAKE_GEMINI_NO_VERDICT
    ? { session_id: 'fake-gemini-session', response: process.env.FAKE_GEMINI_LAST_MESSAGE || 'no verdict' }
    : { session_id: 'fake-gemini-session', response: JSON.stringify(verdict), structured_output: verdict };
  process.stdout.write(JSON.stringify(body));
}
if (stderr) process.stderr.write(stderr);
process.exit(exitCode);
