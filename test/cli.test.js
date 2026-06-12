import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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
