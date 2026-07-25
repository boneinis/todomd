import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeRepo, writeCard, isolateHome } from './helpers.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin/todomd.js');

function runCli(args, { cwd } = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    env: { ...process.env },
    encoding: 'utf8',
  });
}

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
