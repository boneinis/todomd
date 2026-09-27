#!/usr/bin/env node
// Stand-in for the `devin` CLI in print mode: records argv, writes the ATIF
// transcript that `--export` produces, and prints the final answer to stdout.
import fs from 'node:fs';

const args = process.argv.slice(2);
if (process.env.FAKE_DEVIN_ARGV_LOG) fs.writeFileSync(process.env.FAKE_DEVIN_ARGV_LOG, JSON.stringify(args));

const prompt = args[args.indexOf('-p') + 1] || '';
const exportFile = args[args.indexOf('--export') + 1];
const exitCode = Number(process.env.FAKE_DEVIN_EXIT || 0);
const wantsJson = prompt.includes('JSON Schema');
const answer = process.env.FAKE_DEVIN_ANSWER
  ?? (wantsJson
    ? '```json\n' + JSON.stringify({ verdict: 'pass', criteria: [{ criterion: 'works', met: true }], findings: '', setup_error: null, question: null }) + '\n```'
    : 'candidate committed');

if (exportFile && !process.env.FAKE_DEVIN_NO_EXPORT) {
  fs.writeFileSync(exportFile, JSON.stringify({
    schema_version: 'ATIF-v1.7',
    session_id: 'fake-devin-session',
    agent: { name: 'devin', version: '0.0.0', model_name: 'SWE-2 High' },
    steps: [
      { step_id: '1', source: 'system', message: 'You are Devin' },
      { step_id: '2', source: 'user', message: prompt },
      { step_id: '3', source: 'agent', message: 'looking', tool_calls: [{ function_name: 'run_command' }] },
      { step_id: '4', source: 'tool', message: 'ok' },
      { step_id: '5', source: 'agent', message: answer, tool_calls: [] },
    ],
    final_metrics: { total_prompt_tokens: 40, total_completion_tokens: 9, total_cached_tokens: 15, total_steps: 5 },
  }));
}
if (process.env.FAKE_DEVIN_STDERR) process.stderr.write(process.env.FAKE_DEVIN_STDERR);
process.stdout.write(answer + '\n');
process.exit(exitCode);
