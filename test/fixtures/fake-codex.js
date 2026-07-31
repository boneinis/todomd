#!/usr/bin/env node
import fs from 'node:fs';

const args = process.argv.slice(2);
const outputIndex = args.indexOf('--output-last-message');
const outputFile = outputIndex >= 0 ? args[outputIndex + 1] : '';
const defaultVerdict = JSON.stringify({
  verdict: 'pass',
  criteria: [{ criterion: 'works', met: true }],
  findings: 'all good',
});
const finalMessage = process.env.FAKE_CODEX_LAST_MESSAGE ?? defaultVerdict;
const stderr = process.env.FAKE_CODEX_STDERR || '';
const exitCode = Number(process.env.FAKE_CODEX_EXIT || 0);

process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'fake-codex-session' }) + '\n');
process.stdout.write(JSON.stringify(exitCode
  ? { type: 'turn.failed', error: { message: 'fake Codex failure' } }
  : { type: 'turn.completed' }) + '\n');
if (outputFile) fs.writeFileSync(outputFile, finalMessage);
if (stderr) process.stderr.write(stderr);
process.exit(exitCode);
