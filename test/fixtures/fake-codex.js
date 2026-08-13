#!/usr/bin/env node
import fs from 'node:fs';

const args = process.argv.slice(2);
if (process.env.FAKE_CODEX_ARGV_LOG) fs.writeFileSync(process.env.FAKE_CODEX_ARGV_LOG, JSON.stringify(args));
const outputIndex = args.indexOf('--output-last-message');
const outputFile = outputIndex >= 0 ? args[outputIndex + 1] : '';
const schemaIndex = args.indexOf('--output-schema');
const schemaFile = schemaIndex >= 0 ? args[schemaIndex + 1] : '';
const defaultVerdict = JSON.stringify({
  verdict: 'pass',
  criteria: [{ criterion: 'works', met: true }],
  findings: 'all good',
  setup_error: null,
  question: null,
});
const defaultPlan = JSON.stringify({ plan: '1. Do the thing.', chunks: [] });
const finalMessage = process.env.FAKE_CODEX_LAST_MESSAGE ??
  (args.join(' ').includes('implementation plan') ? defaultPlan : defaultVerdict);
const stderr = process.env.FAKE_CODEX_STDERR || '';
const exitCode = Number(process.env.FAKE_CODEX_EXIT || 0);

if (process.env.FAKE_CODEX_REQUIRE_STRICT_SCHEMA && schemaFile) {
  const strict = (node) => {
    if (!node || typeof node !== 'object') return true;
    if (node.type === 'object') {
      if (node.additionalProperties !== false) return false;
      const keys = Object.keys(node.properties || {}).sort();
      if (JSON.stringify([...(node.required || [])].sort()) !== JSON.stringify(keys)) return false;
    }
    return Object.values(node.properties || {}).every(strict) && (!node.items || strict(node.items));
  };
  if (!strict(JSON.parse(fs.readFileSync(schemaFile, 'utf8')))) {
    process.stderr.write('invalid strict output schema\n');
    process.exit(2);
  }
}

process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'fake-codex-session' }) + '\n');
process.stdout.write(JSON.stringify(exitCode
  ? { type: 'turn.failed', error: { message: 'fake Codex failure' } }
  : { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10, reasoning_output_tokens: 4 } }) + '\n');
if (outputFile) fs.writeFileSync(outputFile, finalMessage);
if (stderr) process.stderr.write(stderr);
process.exit(exitCode);
