import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Spawn one headless claude run for a pipeline stage.
//
// Two modes (both spike-validated):
//  - streaming (plan/build): --output-format stream-json --verbose; events are
//    tee'd to a jsonl file and forwarded via onEvent; final `result` event is
//    the envelope.
//  - buffered (verify): --output-format json [--json-schema]; structured
//    verdict arrives in envelope.structured_output.
export function runStage({
  cwd,
  prompt,
  model,
  maxTurns,
  allowedTools = [],
  permissionMode = 'acceptEdits',
  settings,            // object → written to a temp settings file (Stop hook)
  jsonSchema,          // object → buffered mode with structured output
  resume,              // session id
  logFile,             // jsonl tee target (streaming mode)
  onEvent = () => {},
}) {
  const streaming = !jsonSchema;
  const args = ['-p'];
  if (resume) args.push('--resume', resume);
  args.push(prompt);
  args.push('--output-format', streaming ? 'stream-json' : 'json');
  if (streaming) args.push('--verbose');
  if (jsonSchema) args.push('--json-schema', JSON.stringify(jsonSchema));
  args.push('--permission-mode', permissionMode);
  if (allowedTools.length) args.push('--allowedTools', allowedTools.join(','));
  if (maxTurns) args.push('--max-turns', String(maxTurns));
  if (model) args.push('--model', model);

  let settingsFile;
  if (settings) {
    settingsFile = path.join(os.tmpdir(), `todomd-settings-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(settingsFile, JSON.stringify(settings));
    args.push('--settings', settingsFile);
  }

  const child = spawn('claude', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });

  let log;
  if (streaming && logFile) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    log = fs.createWriteStream(logFile);
  }

  const done = new Promise((resolve) => {
    let envelope = null;
    let sessionId = null;
    let stdoutBuf = '';
    let lineBuf = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      if (!streaming) { stdoutBuf += chunk; return; }
      lineBuf += chunk;
      let nl;
      while ((nl = lineBuf.indexOf('\n')) >= 0) {
        const line = lineBuf.slice(0, nl);
        lineBuf = lineBuf.slice(nl + 1);
        if (!line.trim()) continue;
        log?.write(line + '\n');
        try {
          const event = JSON.parse(line);
          if (event.type === 'system' && event.subtype === 'init') sessionId = event.session_id;
          if (event.type === 'result') envelope = event;
          onEvent(event);
        } catch { /* partial/garbled line — skip */ }
      }
    });
    child.stderr.on('data', (c) => { stderr += c; });

    child.on('error', (err) => {
      cleanup();
      resolve({ envelope: null, sessionId, exitCode: -1, spawnError: err.code || String(err), stderr });
    });
    child.on('close', (code) => {
      if (!streaming) {
        try { envelope = JSON.parse(stdoutBuf); } catch { /* leave null */ }
      }
      cleanup();
      resolve({
        envelope,
        sessionId: envelope?.session_id || sessionId,
        exitCode: code,
        stderr: stderr.slice(0, 2000),
      });
    });

    function cleanup() {
      log?.end();
      if (settingsFile) fs.rm(settingsFile, { force: true }, () => {});
    }
  });

  return { child, done };
}

// Stop-hook settings generated from the repo's verify_command at spawn time —
// the single source of truth lives in config.yml, never in a stale file.
export function stopHookSettings(verifyCommand) {
  return {
    hooks: {
      Stop: [{
        hooks: [{
          type: 'command',
          command: `${verifyCommand} >/dev/null 2>&1 || { echo 'Stop blocked by todomd quality gate: the verify command is failing. Fix it before finishing.' >&2; exit 2; }`,
          timeout: 300,
        }],
      }],
    },
  };
}
