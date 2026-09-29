import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createMetadataScheduler, pushMetadata, fetchMetadata, mergeMetadata } from '../src/github-sync.js';
import { makeRepo, git, tmp } from './helpers.js';

test('metadata scheduler is inert when GitHub sync is disabled', async () => {
  const scheduler = createMetadataScheduler();
  // An absent config is equivalent to disabled; this must not create a timer
  // or attempt to access a repository.
  scheduler.schedule({ path: '/definitely/not/a/repo', name: 'none' });
  scheduler.close();
  assert.ok(true);
});

function enableSync(repo, remote, branch = 'todomd-state') {
  const file = path.join(repo, '.todomd/config.yml');
  fs.appendFileSync(file, `\ngithub_sync:\n  enabled: true\n  remote: ${remote}\n  branch: ${branch}\n`);
  git(repo, ['add', '.todomd/config.yml']);
  git(repo, ['commit', '-qm', 'enable github_sync']);
}

function clone(from, into) {
  git(path.dirname(into), ['clone', '-q', from, into]);
  git(into, ['config', 'user.email', 'test@todomd.local']);
  git(into, ['config', 'user.name', 'todomd-test']);
  return into;
}

test('fetchMetadata is a no-op when github_sync is disabled', async () => {
  const repo = makeRepo();
  const result = await fetchMetadata({ path: repo });
  assert.deepEqual(result, { ok: true, skipped: 'disabled' });
});

test('mergeMetadata is a no-op when nothing has ever been published', async () => {
  const origin = makeRepo();
  const repo = clone(origin, path.join(tmp('sync'), 'repo'));
  enableSync(repo, origin);
  const result = await mergeMetadata({ path: repo });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, 'no-remote-branch');
  assert.deepEqual(result.applied, []);
});

test('mergeMetadata pulls a remote assignee change into a clean local clone', async () => {
  const origin = makeRepo();
  const dir = tmp('sync');
  const worker = clone(origin, path.join(dir, 'worker'));
  const viewer = clone(origin, path.join(dir, 'viewer'));
  enableSync(worker, 'origin');
  enableSync(viewer, 'origin');

  // worker assigns a card and publishes just the board metadata — never
  // pushes main, so this must not touch the shared origin's main branch.
  const card = path.join(worker, '.todomd/tasks/task-0001-card.md');
  fs.mkdirSync(path.dirname(card), { recursive: true });
  fs.writeFileSync(card, '---\nid: task-0001\ntitle: Test\nstatus: Queue\nassignee: alice\n---\n\nbody\n');
  git(worker, ['add', '.todomd/tasks/task-0001-card.md']);
  git(worker, ['commit', '-qm', 'assign task-0001 to alice']);
  const originMainBefore = git(origin, ['rev-parse', 'main']);
  const push = await pushMetadata({ path: worker, name: 'worker' });
  assert.equal(push.ok, true, push.error);
  assert.equal(git(origin, ['rev-parse', 'main']), originMainBefore, 'metadata push must never move main');

  // viewer never saw that commit locally — merging in the published branch
  // should apply it cleanly (its own tree is byte-identical to the ancestor).
  const result = await mergeMetadata({ path: viewer, name: 'viewer' });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.conflicts, []);
  assert.ok(result.applied.some((f) => f.endsWith('tasks/task-0001-card.md')), JSON.stringify(result));
  assert.match(fs.readFileSync(path.join(viewer, '.todomd/tasks/task-0001-card.md'), 'utf8'), /assignee: alice/);

  // a second merge with nothing new published is a clean no-op
  const again = await mergeMetadata({ path: viewer, name: 'viewer' });
  assert.deepEqual(again, { ok: true, applied: [], deferred: [], conflicts: [] });
});

test('mergeMetadata defers a real conflict and keeps the local version', async () => {
  const origin = makeRepo();
  const dir = tmp('sync');
  const worker = clone(origin, path.join(dir, 'worker'));
  const viewer = clone(origin, path.join(dir, 'viewer'));
  enableSync(worker, 'origin');
  enableSync(viewer, 'origin');

  const workerCard = path.join(worker, '.todomd/tasks/task-0001-card.md');
  fs.mkdirSync(path.dirname(workerCard), { recursive: true });
  fs.writeFileSync(workerCard, '---\nid: task-0001\ntitle: Test\nstatus: Queue\nassignee: alice\n---\n\nbody\n');
  git(worker, ['add', '.todomd/tasks/task-0001-card.md']);
  git(worker, ['commit', '-qm', 'assign task-0001 to alice']);
  const push = await pushMetadata({ path: worker, name: 'worker' });
  assert.equal(push.ok, true, push.error);

  // viewer independently assigned the same card to someone else before syncing
  const viewerCard = path.join(viewer, '.todomd/tasks/task-0001-card.md');
  fs.mkdirSync(path.dirname(viewerCard), { recursive: true });
  fs.writeFileSync(viewerCard, '---\nid: task-0001\ntitle: Test\nstatus: Queue\nassignee: bob\n---\n\nbody\n');
  git(viewer, ['add', '.todomd/tasks/task-0001-card.md']);
  git(viewer, ['commit', '-qm', 'assign task-0001 to bob']);

  const result = await mergeMetadata({ path: viewer, name: 'viewer' });
  assert.equal(result.ok, true, result.error);
  assert.ok(result.conflicts.some((f) => f.endsWith('tasks/task-0001-card.md')), JSON.stringify(result));
  assert.deepEqual(result.deferred, result.conflicts);
  // the local (bob) assignment survives — a conflict never silently loses local intent
  assert.match(fs.readFileSync(viewerCard, 'utf8'), /assignee: bob/);
});

test('mergeMetadata refuses to run over uncommitted local board changes', async () => {
  const origin = makeRepo();
  const dir = tmp('sync');
  const worker = clone(origin, path.join(dir, 'worker'));
  const viewer = clone(origin, path.join(dir, 'viewer'));
  enableSync(worker, 'origin');
  enableSync(viewer, 'origin');

  fs.mkdirSync(path.join(worker, '.todomd/tasks'), { recursive: true });
  fs.writeFileSync(path.join(worker, '.todomd/tasks/task-0001-card.md'), '---\nid: task-0001\nassignee: alice\n---\n');
  git(worker, ['add', '.todomd/tasks/task-0001-card.md']);
  git(worker, ['commit', '-qm', 'assign to alice']);
  await pushMetadata({ path: worker, name: 'worker' });

  // uncommitted, unstaged edit under .todomd on the viewer's side
  fs.appendFileSync(path.join(viewer, '.todomd/config.yml'), '\n# local scratch note\n');
  const result = await mergeMetadata({ path: viewer, name: 'viewer' });
  assert.equal(result.ok, false);
  assert.match(result.error, /uncommitted/);
});
