import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// A stage's jsonl tee is best-effort telemetry: an unwritable runs dir (full
// disk, read-only mount, a path the user chmod'd) must never take the board
// server down. Without the 'error' listener a stream error is an UNCAUGHT
// exception — this whole process dies mid-run.
function openLog(logFile) {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const s = fs.createWriteStream(logFile);
    s.on('error', () => {}); // the run keeps going; only the transcript is lost
    return s;
  } catch { return null; }
}

// A CLI that never emits a newline (or floods stdout) would otherwise buffer
// without bound and OOM the server. Past the cap the run keeps going, but the
// oversized chunk is dropped — the stage then fails its normal "no envelope"
// path instead of taking the process with it.
const MAX_BUF = 32 * 1024 * 1024;

// Vendor dispatch: every stage run returns the same shape —
// { envelope: {subtype, is_error, total_cost_usd, num_turns, structured_output?},
//   sessionId, exitCode, stderr } — regardless of which CLI did the work.
export function runStage(opts) {
  if (opts.vendor === 'codex') return runCodex(opts);
  if (opts.vendor === 'gemini') return runGemini(opts);
  if (opts.vendor === 'kimi') return runKimi(opts);
  return runClaude(opts);
}

// Spawn one headless claude run for a pipeline stage.
//
// Two modes (both spike-validated):
//  - streaming (plan/build): --output-format stream-json --verbose; events are
//    tee'd to a jsonl file and forwarded via onEvent; final `result` event is
//    the envelope.
//  - buffered (verify): --output-format json [--json-schema]; structured
//    verdict arrives in envelope.structured_output.
function runClaude({
  cwd,
  prompt,
  model,
  effort,
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
  if (['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) args.push('--effort', effort);

  let settingsFile;
  if (settings) {
    settingsFile = path.join(os.tmpdir(), `todomd-settings-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    // 0600: this file carries the repo's verify_command as a Stop hook — on a
    // shared machine /tmp is world-readable, and another user must not be able
    // to read (or, on a lax umask, rewrite) a command this process runs
    fs.writeFileSync(settingsFile, JSON.stringify(settings), { mode: 0o600 });
    args.push('--settings', settingsFile);
  }

  const child = spawn(process.env.TODOMD_CLAUDE_BIN || 'claude', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });

  const log = streaming && logFile ? openLog(logFile) : null;

  child.stdout.setEncoding('utf8'); // decode multibyte chars across chunk boundaries
  const done = new Promise((resolve) => {
    let envelope = null;
    let sessionId = null;
    let stdoutBuf = '';
    let lineBuf = '';
    let stderr = '';

    const handleLine = (line) => {
      if (!line.trim()) return;
      log?.write(line + '\n');
      try {
        const event = JSON.parse(line);
        if (event.type === 'system' && event.subtype === 'init') sessionId = event.session_id;
        if (event.type === 'result') envelope = event;
        onEvent(event);
      } catch { /* partial/garbled line — skip */ }
    };

    child.stdout.on('data', (chunk) => {
      if (!streaming) {
        if (stdoutBuf.length < MAX_BUF) stdoutBuf += chunk;
        return;
      }
      lineBuf += chunk;
      let nl;
      while ((nl = lineBuf.indexOf('\n')) >= 0) {
        handleLine(lineBuf.slice(0, nl));
        lineBuf = lineBuf.slice(nl + 1);
      }
      if (lineBuf.length > MAX_BUF) lineBuf = ''; // newline-less flood — drop it
    });
    child.stderr.on('data', (c) => { if (stderr.length < MAX_BUF) stderr += c; });

    child.on('error', (err) => {
      cleanup();
      resolve({ envelope: null, sessionId, exitCode: -1, spawnError: err.code || String(err), stderr });
    });
    child.on('close', (code) => {
      if (streaming) {
        if (lineBuf.trim()) handleLine(lineBuf); // flush a final newline-less event
      } else {
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

// OpenAI Codex CLI profile (ChatGPT-plan auth, no API key).
// codex exec --json emits JSONL events (thread.started carries the session id,
// turn.failed signals errors); resume via `codex exec resume <id>`; structured
// output via --output-schema <file> + --output-last-message <file>.
// No per-run hook injection → the independent Verify stage is the quality
// gate (the Stop hook is a claude-only extra layer). Codex reports no $ cost
// on subscription; the ledger records 0 for codex runs.
const CLAUDE_MODEL_NAMES = /^(sonnet|haiku|opus|claude)/i;

function runCodex({
  cwd,
  prompt,
  model,
  effort,
  jsonSchema,
  resume,
  logFile,
  onEvent = () => {},
}) {
  const tmp = (name) =>
    path.join(os.tmpdir(), `todomd-codex-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const executable = process.env.TODOMD_CODEX_BIN || 'codex';
  // codex exec is non-interactive by design — no approval flag exists (v0.139)
  const args = ['exec'];
  if (resume) args.push('resume', resume);
  args.push('--json');
  // `codex exec resume` inherits the original session sandbox and does not
  // accept --sandbox itself. Supplying it makes every verifier-repair resume
  // exit at argument parsing before the agent can act.
  if (!resume) args.push('--sandbox', 'workspace-write');
  args.push('--skip-git-repo-check');
  if (model && !CLAUDE_MODEL_NAMES.test(model)) args.push('-m', model);
  if (['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) args.push('-c', `model_reasoning_effort="${effort}"`);
  let schemaFile, outFile;
  if (jsonSchema) {
    schemaFile = tmp('schema.json');
    outFile = tmp('out.json');
    fs.writeFileSync(schemaFile, JSON.stringify(jsonSchema));
    args.push('--output-schema', schemaFile, '--output-last-message', outFile);
  }
  args.push(prompt);

  const log = logFile ? openLog(logFile) : null;
  // Keep the invocation even when spawn itself fails. This deliberately omits
  // argv/prompt (which can contain card text or secrets) while retaining the
  // two facts needed to diagnose PATH and worktree problems.
  log?.write(JSON.stringify({ type: 'runner-invocation', executable, cwd }) + '\n');

  const child = spawn(executable, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });

  const done = new Promise((resolve) => {
    let sessionId = null;
    let failed = null;
    let turns = 0;
    let lineBuf = '';
    let stderr = '';
    let settled = false;

    const finish = ({ exitCode, signal = null, spawnError = null, lastMessage = '', structuredOutput }) => {
      if (settled) return;
      settled = true;
      const diagnostic = {
        executable,
        cwd,
        exitCode,
        signal,
        spawnError,
        stderr,
        finalMessage: lastMessage,
        structuredOutput: structuredOutput ?? null,
      };
      const ok = exitCode === 0 && !signal && !spawnError && !failed;
      const result = {
        envelope: spawnError ? null : {
          subtype: ok ? 'success' : 'error',
          is_error: !ok,
          total_cost_usd: 0,
          num_turns: turns,
          result: failed ? JSON.stringify(failed).slice(0, 500) : '',
          structured_output: structuredOutput,
        },
        sessionId,
        exitCode,
        ...(spawnError ? { spawnError } : {}),
        stderr: stderr.slice(0, 2000),
        diagnostic,
      };
      const complete = () => {
        for (const f of [schemaFile, outFile]) if (f) fs.rm(f, { force: true }, () => {});
        resolve(result);
      };
      if (log) {
        // The full bounded stderr/final message lives in the private raw run log;
        // the card history receives only a concise infrastructure summary.
        log.write(JSON.stringify({ type: 'runner-diagnostic', ...diagnostic }) + '\n');
        log.end(complete);
      } else {
        complete();
      }
    };

    const handleLine = (line) => {
      if (!line.trim()) return;
      log?.write(line + '\n');
      try {
        const event = JSON.parse(line);
        sessionId ||= event.thread_id || event.session_id || event?.thread?.id || null;
        if (event.type === 'turn.completed') turns++;
        if (event.type === 'turn.failed' || event.type === 'error') failed = event;
        onEvent({ vendor: 'codex', ...event });
      } catch { /* non-JSON line — skip */ }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      lineBuf += chunk;
      let nl;
      while ((nl = lineBuf.indexOf('\n')) >= 0) {
        handleLine(lineBuf.slice(0, nl));
        lineBuf = lineBuf.slice(nl + 1);
      }
      if (lineBuf.length > MAX_BUF) lineBuf = ''; // newline-less flood — drop it
    });
    child.stderr.on('data', (c) => { if (stderr.length < MAX_BUF) stderr += c; });

    child.on('error', (err) => {
      finish({ exitCode: -1, spawnError: err.code || String(err) });
    });
    child.on('close', (code, signal) => {
      if (lineBuf.trim()) handleLine(lineBuf); // flush trailing newline-less event
      let structured;
      let lastMessage = '';
      if (outFile) {
        try {
          lastMessage = fs.readFileSync(outFile, 'utf8');
          structured = JSON.parse(lastMessage);
        } catch {}
      }
      finish({ exitCode: code, signal, lastMessage, structuredOutput: structured });
    });
  });

  return { child, done };
}

function runGemini({
  cwd,
  prompt,
  model,
  effort,
  stage,
  jsonSchema,
  resume,
  logFile,
  onEvent = () => {},
}) {
  const tmp = (name) =>
    path.join(os.tmpdir(), `todomd-gemini-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const executable = process.env.TODOMD_GEMINI_BIN || 'agy';
  const streaming = !jsonSchema;
  // agy print mode is headless, but it still needs an explicit execution mode
  // to avoid permission dialogs. Sandbox is always on. Build may edit only its
  // cwd; every read/review stage uses plan mode. Never use agy's global
  // --dangerously-skip-permissions escape hatch.
  const mode = stage === 'Build' ? 'accept-edits' : 'plan';
  const args = ['-p', prompt, '--output-format', streaming ? 'stream-json' : 'json',
    '--sandbox', '--mode', mode, '--disable-slash-commands'];
  if (resume) args.push('--conversation', resume);
  if (model && !CLAUDE_MODEL_NAMES.test(model)) args.push('--model', model);
  // agy 1.1 supports low|medium|high. Preserve the board's stronger intent by
  // clamping xhigh/max to the highest enforceable value instead of silently
  // dropping effort altogether.
  const effectiveEffort = ['xhigh', 'max'].includes(effort) ? 'high' : effort;
  if (['low', 'medium', 'high'].includes(effectiveEffort)) args.push('--effort', effectiveEffort);

  let schemaFile;
  if (jsonSchema) {
    schemaFile = tmp('schema.json');
    fs.writeFileSync(schemaFile, JSON.stringify(jsonSchema), { mode: 0o600 });
    args.push('--json-schema', schemaFile);
  }

  const log = logFile ? openLog(logFile) : null;
  log?.write(JSON.stringify({ type: 'runner-invocation', executable, cwd }) + '\n');

  const child = spawn(executable, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });

  const done = new Promise((resolve) => {
    let sessionId = null;
    let failed = null;
    let turns = 0;
    let lineBuf = '';
    let stderr = '';
    let settled = false;

    const finish = ({ exitCode, signal = null, spawnError = null, lastMessage = '', structuredOutput }) => {
      if (settled) return;
      settled = true;
      const diagnostic = {
        executable,
        cwd,
        exitCode,
        signal,
        spawnError,
        stderr,
        finalMessage: lastMessage,
        structuredOutput: structuredOutput ?? null,
        requestedEffort: effort || null,
        effectiveEffort: effectiveEffort || null,
        mode,
        sandbox: true,
      };
      const ok = exitCode === 0 && !signal && !spawnError && !failed;
      const result = {
        envelope: spawnError ? null : {
          subtype: ok ? 'success' : 'error',
          is_error: !ok,
          total_cost_usd: 0,
          num_turns: turns,
          result: failed ? JSON.stringify(failed).slice(0, 500) : '',
          structured_output: structuredOutput,
        },
        sessionId,
        exitCode,
        ...(spawnError ? { spawnError } : {}),
        stderr: stderr.slice(0, 2000),
        diagnostic,
      };
      const complete = () => {
        if (schemaFile) fs.rm(schemaFile, { force: true }, () => {});
        resolve(result);
      };
      if (log) {
        log.write(JSON.stringify({ type: 'runner-diagnostic', ...diagnostic }) + '\n');
        log.end(complete);
      } else {
        complete();
      }
    };

    let finalEvent = null;
    const handleLine = (line) => {
      if (!line.trim()) return;
      log?.write(line + '\n');
      try {
        const event = JSON.parse(line);
        sessionId ||= event.thread_id || event.session_id || event?.thread?.id || null;
        if (event.type === 'turn.completed') turns++;
        if (event.type === 'turn.failed' || event.type === 'error') failed = event;
        if (event.type === 'result') finalEvent = event;
        onEvent({ vendor: 'gemini', ...event });
      } catch { /* non-JSON line — skip */ }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      lineBuf += chunk;
      if (!streaming) {
        if (lineBuf.length > MAX_BUF) lineBuf = '';
        return;
      }
      let nl;
      while ((nl = lineBuf.indexOf('\n')) >= 0) {
        handleLine(lineBuf.slice(0, nl));
        lineBuf = lineBuf.slice(nl + 1);
      }
      if (lineBuf.length > MAX_BUF) lineBuf = '';
    });
    child.stderr.on('data', (c) => { if (stderr.length < MAX_BUF) stderr += c; });

    child.on('error', (err) => {
      finish({ exitCode: -1, spawnError: err.code || String(err) });
    });
    child.on('close', (code, signal) => {
      let payload = null;
      if (streaming) {
        if (lineBuf.trim()) handleLine(lineBuf);
        payload = finalEvent;
      } else {
        try { payload = JSON.parse(lineBuf); } catch { /* retained as final message below */ }
      }
      let structured;
      let lastMessage = lineBuf.trim();
      if (payload) {
        sessionId ||= payload.thread_id || payload.session_id || payload.conversation_id || payload?.thread?.id || null;
        structured = payload.structured_output ?? payload.structuredOutput ?? null;
        const candidate = payload.result ?? payload.response ?? payload.message;
        if (!structured && candidate && typeof candidate === 'object') structured = candidate;
        if (!structured && typeof candidate === 'string') {
          try { structured = JSON.parse(candidate); } catch {}
        }
        if (typeof candidate === 'string') lastMessage = candidate;
        else if (candidate !== undefined) lastMessage = JSON.stringify(candidate);
        else lastMessage = JSON.stringify(payload);
      }
      finish({ exitCode: code, signal, lastMessage, structuredOutput: structured });
    });
  });

  return { child, done };
}

function runKimi({
  cwd,
  prompt,
  model,
  effort,
  jsonSchema,
  resume,
  logFile,
  onEvent = () => {},
}) {
  const tmp = (name) =>
    path.join(os.tmpdir(), `todomd-kimi-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const executable = process.env.TODOMD_KIMI_BIN || 'kimi';
  const args = [];
  if (resume) args.push('--resume', resume);
  args.push('--json');
  if (model && !CLAUDE_MODEL_NAMES.test(model)) args.push('-m', model);
  if (['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) args.push('-c', `model_reasoning_effort="${effort}"`);
  let schemaFile, outFile;
  if (jsonSchema) {
    schemaFile = tmp('schema.json');
    outFile = tmp('out.json');
    fs.writeFileSync(schemaFile, JSON.stringify(jsonSchema));
    args.push('--output-schema', schemaFile, '--output-last-message', outFile);
  }
  args.push(prompt);

  const log = logFile ? openLog(logFile) : null;
  log?.write(JSON.stringify({ type: 'runner-invocation', executable, cwd }) + '\n');

  const child = spawn(executable, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });

  const done = new Promise((resolve) => {
    let sessionId = null;
    let failed = null;
    let turns = 0;
    let lineBuf = '';
    let stderr = '';
    let settled = false;

    const finish = ({ exitCode, signal = null, spawnError = null, lastMessage = '', structuredOutput }) => {
      if (settled) return;
      settled = true;
      const diagnostic = {
        executable,
        cwd,
        exitCode,
        signal,
        spawnError,
        stderr,
        finalMessage: lastMessage,
        structuredOutput: structuredOutput ?? null,
      };
      const ok = exitCode === 0 && !signal && !spawnError && !failed;
      const result = {
        envelope: spawnError ? null : {
          subtype: ok ? 'success' : 'error',
          is_error: !ok,
          total_cost_usd: 0,
          num_turns: turns,
          result: failed ? JSON.stringify(failed).slice(0, 500) : '',
          structured_output: structuredOutput,
        },
        sessionId,
        exitCode,
        ...(spawnError ? { spawnError } : {}),
        stderr: stderr.slice(0, 2000),
        diagnostic,
      };
      const complete = () => {
        for (const f of [schemaFile, outFile]) if (f) fs.rm(f, { force: true }, () => {});
        resolve(result);
      };
      if (log) {
        log.write(JSON.stringify({ type: 'runner-diagnostic', ...diagnostic }) + '\n');
        log.end(complete);
      } else {
        complete();
      }
    };

    const handleLine = (line) => {
      if (!line.trim()) return;
      log?.write(line + '\n');
      try {
        const event = JSON.parse(line);
        sessionId ||= event.thread_id || event.session_id || event?.thread?.id || null;
        if (event.type === 'turn.completed') turns++;
        if (event.type === 'turn.failed' || event.type === 'error') failed = event;
        onEvent({ vendor: 'kimi', ...event });
      } catch { /* non-JSON line — skip */ }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      lineBuf += chunk;
      let nl;
      while ((nl = lineBuf.indexOf('\n')) >= 0) {
        handleLine(lineBuf.slice(0, nl));
        lineBuf = lineBuf.slice(nl + 1);
      }
      if (lineBuf.length > MAX_BUF) lineBuf = '';
    });
    child.stderr.on('data', (c) => { if (stderr.length < MAX_BUF) stderr += c; });

    child.on('error', (err) => {
      finish({ exitCode: -1, spawnError: err.code || String(err) });
    });
    child.on('close', (code, signal) => {
      if (lineBuf.trim()) handleLine(lineBuf);
      let structured;
      let lastMessage = '';
      if (outFile) {
        try {
          lastMessage = fs.readFileSync(outFile, 'utf8');
          structured = JSON.parse(lastMessage);
        } catch {}
      }
      finish({ exitCode: code, signal, lastMessage, structuredOutput: structured });
    });
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
