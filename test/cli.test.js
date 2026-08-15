import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeRepo, writeCard, isolateHome, until, BUDGET } from './helpers.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin/todomd.js');

function runCli(args, { cwd } = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    env: { ...process.env },
    encoding: 'utf8',
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

test('control approval lifecycle is short-lived, explicit, and independently revocable', () => {
  const home = isolateHome();
  const dir = path.join(home, '.todomd');

  const enabled = runCli(['control-enable', '--minutes', '2']);
  assert.equal(enabled.status, 0, enabled.stderr);
  assert.match(enabled.stdout, /enabled for 2 minute/);
  for (const name of ['token-control', 'control-approval.json']) {
    const file = path.join(dir, name);
    assert.ok(fs.existsSync(file));
    assert.equal(fs.statSync(file).mode & 0o077, 0, `${name} must not be group/world accessible`);
  }
  const approval = JSON.parse(fs.readFileSync(path.join(dir, 'control-approval.json'), 'utf8'));
  assert.ok(approval.expiresAt > Date.now());
  assert.ok(approval.expiresAt <= Date.now() + 2 * 60_000);

  const status = runCli(['control-status']);
  assert.equal(status.status, 0);
  assert.match(status.stdout, /enabled until/);

  fs.chmodSync(path.join(dir, 'control-approval.json'), 0o644);
  assert.equal(runCli(['control-status']).status, 1, 'a permission-broad approval must fail closed');
  assert.equal(runCli(['control-enable', '--minutes', '2']).status, 0);

  const disabled = runCli(['control-disable']);
  assert.equal(disabled.status, 0);
  assert.equal(fs.existsSync(path.join(dir, 'control-approval.json')), false);
  assert.equal(runCli(['control-status']).status, 1);

  fs.writeFileSync(path.join(dir, 'token'), `${'a'.repeat(32)}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'token-control'), `${'b'.repeat(32)}\n`, { mode: 0o600 });
  assert.equal(runCli(['revoke']).status, 0);
  assert.ok(fs.existsSync(path.join(dir, 'token')), 'default revoke preserves the primary browser credential');
  assert.equal(fs.existsSync(path.join(dir, 'token-control')), false);
  assert.equal(runCli(['revoke', '--full']).status, 0);
  assert.equal(fs.existsSync(path.join(dir, 'token')), false, '--full rotates the primary credential too');
});

test('serve --safe-output writes a protected server identity without printing the primary token', async () => {
  const home = isolateHome();
  const repo = makeRepo();
  const port = await freePort();
  const child = spawn(process.execPath, [BIN, 'serve', '--port', String(port), '--no-open', '--safe-output'], {
    cwd: repo,
    env: { ...process.env, TODOMD_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    await until(() => stdout.includes('todomd board:'), { timeout: BUDGET.stage, label: 'safe todomd startup output' });
    const token = fs.readFileSync(path.join(home, '.todomd', 'token'), 'utf8').trim();
    assert.match(stdout, new RegExp(`http://127\\.0\\.0\\.1:${port}`));
    assert.doesNotMatch(stdout, /[?&]token=/);
    assert.ok(!stdout.includes(token), 'safe startup output must not contain the primary credential');

    const identity = path.join(home, '.todomd', 'server.pid');
    const parts = fs.readFileSync(identity, 'utf8').trim().split(/\s+/);
    assert.deepEqual(parts.slice(0, 2), [String(child.pid), String(port)]);
    assert.match(parts[2], /^[a-f0-9]{32}$/);
    assert.equal(fs.statSync(identity).mode & 0o077, 0);
    assert.equal(stderr, '');
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }
});

test('fanout: bails with exit 1 when card already has epic: true', () => {
  isolateHome();
  const repo = makeRepo();
  writeCard(repo, 'task-0001', { extra: 'epic: true\n' });

  const result = runCli(['fanout', 'task-0001'], { cwd: repo });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /already fanned out/);
});

test('fanout: bails with exit 1 when card already has children', () => {
  isolateHome();
  const repo = makeRepo();
  writeCard(repo, 'task-0001', { extra: 'epic: true\nchildren: [task-0002]\n' });

  const result = runCli(['fanout', 'task-0001'], { cwd: repo });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /already fanned out/);
});

test('advance: exits 1 with "not an epic" when card has no epic flag', () => {
  isolateHome();
  const repo = makeRepo();
  writeCard(repo, 'task-0001');

  const result = runCli(['advance', 'task-0001'], { cwd: repo });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not an epic/);
});

test('advance: exits 1 with "not an epic" when card does not exist', () => {
  isolateHome();
  const repo = makeRepo();

  const result = runCli(['advance', 'task-9999'], { cwd: repo });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not an epic/);
});

test('stop: refuses a live pid that is not a todomd server (stale pid file / pid reuse)', () => {
  const home = isolateHome();
  // a live process whose command line clearly isn't todomd — the pid a recycled
  // server.pid could point at
  const decoy = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: 'ignore' });
  try {
    fs.mkdirSync(path.join(home, '.todomd'), { recursive: true });
    fs.writeFileSync(path.join(home, '.todomd', 'server.pid'), `${decoy.pid} 7337`);
    const result = runCli(['stop']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not a todomd server/);
    // the refusal happened BEFORE any signal — the decoy is still alive and the
    // pid file is left in place for the user to inspect
    assert.doesNotThrow(() => process.kill(decoy.pid, 0));
    assert.ok(fs.existsSync(path.join(home, '.todomd', 'server.pid')), 'pid file kept on refusal');
  } finally {
    decoy.kill();
  }
});

// The `ps` identity check is a Unix nicety — on a platform without `ps`
// (Windows) it must not turn `stop` into a no-op that only deletes the pid
// file and leaves the server running.
test('stop: with no `ps` on PATH, still stops the recorded (live) pid', async () => {
  const home = isolateHome();
  const emptyDir = path.join(home, 'empty-path');
  fs.mkdirSync(emptyDir, { recursive: true });
  const victim = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  const exited = new Promise((resolve) => victim.on('exit', resolve));
  try {
    fs.mkdirSync(path.join(home, '.todomd'), { recursive: true });
    fs.writeFileSync(path.join(home, '.todomd', 'server.pid'), `${victim.pid} 7337`);
    const result = spawnSync(process.execPath, [BIN, 'stop'], {
      env: { ...process.env, PATH: emptyDir }, // `ps` unresolvable
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /stopped todomd/);
    await exited; // the signal actually landed
    assert.equal(fs.existsSync(path.join(home, '.todomd', 'server.pid')), false, 'pid file cleared');
  } finally {
    victim.kill();
  }
});

test('stop: a present but failing ps command fails closed instead of signalling an unknown pid', () => {
  const home = isolateHome();
  const fakeBin = path.join(home, 'failing-ps');
  fs.mkdirSync(fakeBin, { recursive: true });
  const ps = path.join(fakeBin, 'ps');
  fs.writeFileSync(ps, '#!/bin/sh\nexit 1\n');
  fs.chmodSync(ps, 0o755);
  const decoy = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: 'ignore' });
  try {
    fs.mkdirSync(path.join(home, '.todomd'), { recursive: true });
    fs.writeFileSync(path.join(home, '.todomd', 'server.pid'), `${decoy.pid} 7337`);
    const result = spawnSync(process.execPath, [BIN, 'stop'], {
      env: { ...process.env, PATH: fakeBin },
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not a todomd server/);
    assert.doesNotThrow(() => process.kill(decoy.pid, 0));
  } finally {
    decoy.kill();
  }
});

test('stop: accepts a node-launched npm todomd symlink as the recorded server', async () => {
  const home = isolateHome();
  const fakeBin = path.join(home, 'npm-style-ps');
  fs.mkdirSync(fakeBin, { recursive: true });
  const ps = path.join(fakeBin, 'ps');
  fs.writeFileSync(ps, '#!/bin/sh\nprintf "%s\\n" "node /Users/example/.npm-global/bin/todomd serve --port 7337"\n');
  fs.chmodSync(ps, 0o755);
  const victim = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  const exited = new Promise((resolve) => victim.on('exit', resolve));
  try {
    fs.mkdirSync(path.join(home, '.todomd'), { recursive: true });
    fs.writeFileSync(path.join(home, '.todomd', 'server.pid'), `${victim.pid} 7337`);
    const result = spawnSync(process.execPath, [BIN, 'stop'], {
      env: { ...process.env, PATH: fakeBin }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /stopped todomd/);
    await exited;
  } finally {
    victim.kill();
  }
});

test('stop: accepts the known todomd entrypoint when its project path contains spaces', async () => {
  const home = isolateHome();
  const fakeBin = path.join(home, 'space-path-ps');
  fs.mkdirSync(fakeBin, { recursive: true });
  const ps = path.join(fakeBin, 'ps');
  fs.writeFileSync(ps, `#!/bin/sh\nprintf "%s\\n" "node ${BIN} serve --no-open"\n`);
  fs.chmodSync(ps, 0o755);
  const victim = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  const exited = new Promise((resolve) => victim.on('exit', resolve));
  try {
    fs.mkdirSync(path.join(home, '.todomd'), { recursive: true });
    fs.writeFileSync(path.join(home, '.todomd', 'server.pid'), `${victim.pid} 7337`);
    const result = spawnSync(process.execPath, [BIN, 'stop'], {
      env: { ...process.env, PATH: fakeBin }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    await exited;
  } finally {
    victim.kill();
  }
});

test('stop: rejects a later todomd.js argument owned by an unrelated executable', () => {
  const home = isolateHome();
  const fakeBin = path.join(home, 'editor-style-ps');
  fs.mkdirSync(fakeBin, { recursive: true });
  const ps = path.join(fakeBin, 'ps');
  fs.writeFileSync(ps, '#!/bin/sh\nprintf "%s\\n" "vim /tmp/bin/todomd.js"\n');
  fs.chmodSync(ps, 0o755);
  const victim = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: 'ignore' });
  try {
    fs.mkdirSync(path.join(home, '.todomd'), { recursive: true });
    fs.writeFileSync(path.join(home, '.todomd', 'server.pid'), `${victim.pid} 7337`);
    const result = spawnSync(process.execPath, [BIN, 'stop'], {
      env: { ...process.env, PATH: fakeBin }, encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not a todomd server/);
    assert.doesNotThrow(() => process.kill(victim.pid, 0));
  } finally {
    victim.kill();
  }
});
