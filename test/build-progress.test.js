import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, git } from './helpers.js';
import { git as runGit } from '../src/git.js';
import { progressSnapshot, retryStagedCommit, isIndexLockFailure } from '../src/build-progress.js';

test('permission failures and hook errors are not treated as transient index locks', () => {
  assert.equal(isIndexLockFailure("Unable to create '/repo/index.lock': Permission denied"), false);
  assert.equal(isIndexLockFailure('pre-commit hook exited 1'), false);
  assert.equal(isIndexLockFailure("Unable to create '/repo/index.lock': File exists."), true);
});

function stagedRepo() {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'src/change.js'), 'export const change = true;\n');
  git(repo, ['add', 'src/change.js']);
  return repo;
}

test('progress snapshots leave the index untouched and do not contend with a commit', async () => {
  const repo = stagedRepo();
  const index = path.join(repo, '.git/index');
  const before = fs.readFileSync(index);
  const stamp = fs.statSync(index).mtimeMs;
  const snapshot = await progressSnapshot(repo);
  assert.equal(snapshot.changed, 1);
  assert.deepEqual(fs.readFileSync(index), before);
  assert.equal(fs.statSync(index).mtimeMs, stamp);
  const [commit, ...snapshots] = await Promise.all([
    runGit(repo, ['commit', '-qm', 'candidate']),
    ...Array.from({ length: 8 }, () => progressSnapshot(repo)),
  ]);
  assert.equal(commit.ok, true, commit.stderr);
  assert.ok(snapshots.every((s) => s.head));
  assert.equal((await progressSnapshot(repo)).changed, 0);
});

test('commit retries a transient lock without removing it or staging extra files', async () => {
  const repo = stagedRepo();
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'leave this alone');
  const lock = path.join(repo, '.git/index.lock');
  fs.writeFileSync(lock, 'fixture-owned lock');
  const timer = setTimeout(() => fs.unlinkSync(lock), 100);
  try {
    const committed = await retryStagedCommit(repo, 'recover candidate', { attempts: 20, delayMs: 25 });
    assert.equal(committed.ok, true, committed.error);
    assert.deepEqual(committed.paths, ['src/change.js']);
    assert.match(git(repo, ['status', '--porcelain']), /untracked.txt/);
  } finally { clearTimeout(timer); }
});

test('persistent lock preserves staged paths and can be resumed after its owner releases it', async () => {
  const repo = stagedRepo();
  const lock = path.join(repo, '.git/index.lock');
  fs.writeFileSync(lock, 'fixture-owned lock');
  const result = await retryStagedCommit(repo, 'candidate', { attempts: 2, delayMs: 1 });
  assert.equal(result.ok, false);
  assert.deepEqual(result.paths, ['src/change.js']);
  assert.equal(fs.readFileSync(lock, 'utf8'), 'fixture-owned lock');
  fs.unlinkSync(lock);
  assert.equal((await retryStagedCommit(repo, 'candidate')).ok, true);
});
