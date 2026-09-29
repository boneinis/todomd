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

test('mergeMetadata pulls a remote assignee change on a card that predates either clone\'s first sync', async () => {
  // Regression: with no stored last-synced ref (this clone's very first
  // sync), the naive base for a path is null — which used to make an
  // UNCHANGED existing card look identical to an independently-created one,
  // and any remote edit to it was wrongly treated as a same-path conflict
  // instead of a clean fast-forward. The fix walks the remote branch's own
  // history for the path: the card's original (unassigned) content is a real
  // point in that history, since worker's local history — which subtree
  // split walked — includes the very commit both clones were made from.
  const origin = makeRepo();
  const originCard = path.join(origin, '.todomd/tasks/task-0001-card.md');
  fs.mkdirSync(path.dirname(originCard), { recursive: true });
  fs.writeFileSync(originCard, '---\nid: task-0001\ntitle: Test\nstatus: Queue\nassignee:\n---\n\nbody\n');
  git(origin, ['add', '.todomd/tasks/task-0001-card.md']);
  git(origin, ['commit', '-qm', 'add unassigned task-0001']);

  const dir = tmp('sync');
  const worker = clone(origin, path.join(dir, 'worker'));
  const viewer = clone(origin, path.join(dir, 'viewer'));
  enableSync(worker, 'origin');
  enableSync(viewer, 'origin');

  const workerCard = path.join(worker, '.todomd/tasks/task-0001-card.md');
  fs.writeFileSync(workerCard, '---\nid: task-0001\ntitle: Test\nstatus: Queue\nassignee: alice\n---\n\nbody\n');
  git(worker, ['add', '.todomd/tasks/task-0001-card.md']);
  git(worker, ['commit', '-qm', 'assign task-0001 to alice']);
  const push = await pushMetadata({ path: worker, name: 'worker' });
  assert.equal(push.ok, true, push.error);

  // viewer's copy is untouched since the clone — this is its first-ever sync
  const result = await mergeMetadata({ path: viewer, name: 'viewer' });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.conflicts, [], JSON.stringify(result));
  assert.ok(result.applied.some((f) => f.endsWith('tasks/task-0001-card.md')), JSON.stringify(result));
  assert.match(fs.readFileSync(path.join(viewer, '.todomd/tasks/task-0001-card.md'), 'utf8'), /assignee: alice/);
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
  assert.deepEqual(result.deferred, []);
  // the local (bob) assignment survives — a conflict never silently loses local intent
  assert.match(fs.readFileSync(viewerCard, 'utf8'), /assignee: bob/);
});

test('mergeMetadata re-reports an unresolved conflict on every poll and only advances after real resolution', async () => {
  // Regression: the last-synced ref used to be recorded even when conflicts
  // remained, so the NEXT poll short-circuited as a clean no-op and the
  // client cleared its conflict banner with nothing actually resolved.
  const origin = makeRepo();
  const dir = tmp('sync');
  const worker = clone(origin, path.join(dir, 'worker'));
  const viewer = clone(origin, path.join(dir, 'viewer'));
  enableSync(worker, 'origin');
  enableSync(viewer, 'origin');

  const alice = '---\nid: task-0001\ntitle: Test\nstatus: Queue\nassignee: alice\n---\n\nbody\n';
  const workerCard = path.join(worker, '.todomd/tasks/task-0001-card.md');
  fs.mkdirSync(path.dirname(workerCard), { recursive: true });
  fs.writeFileSync(workerCard, alice);
  git(worker, ['add', '.todomd/tasks/task-0001-card.md']);
  git(worker, ['commit', '-qm', 'assign task-0001 to alice']);
  assert.equal((await pushMetadata({ path: worker, name: 'worker' })).ok, true);

  const viewerCard = path.join(viewer, '.todomd/tasks/task-0001-card.md');
  fs.mkdirSync(path.dirname(viewerCard), { recursive: true });
  fs.writeFileSync(viewerCard, '---\nid: task-0001\ntitle: Test\nstatus: Queue\nassignee: bob\n---\n\nbody\n');
  git(viewer, ['add', '.todomd/tasks/task-0001-card.md']);
  git(viewer, ['commit', '-qm', 'assign task-0001 to bob']);

  const first = await mergeMetadata({ path: viewer, name: 'viewer' });
  assert.equal(first.ok, true, first.error);
  assert.ok(first.conflicts.some((f) => f.endsWith('tasks/task-0001-card.md')), JSON.stringify(first));

  // same remote ref, nothing resolved — the conflict must be re-derived and
  // re-reported, not swallowed by prematurely advanced sync state
  const second = await mergeMetadata({ path: viewer, name: 'viewer' });
  assert.equal(second.ok, true, second.error);
  assert.ok(second.conflicts.some((f) => f.endsWith('tasks/task-0001-card.md')), JSON.stringify(second));

  // resolve locally by taking the remote version — only now does a poll come
  // back clean (which is what lets the client clear its banner)
  fs.writeFileSync(viewerCard, alice);
  git(viewer, ['add', '.todomd/tasks/task-0001-card.md']);
  git(viewer, ['commit', '-qm', 'take remote assignment']);
  const third = await mergeMetadata({ path: viewer, name: 'viewer' });
  assert.deepEqual(third, { ok: true, applied: [], deferred: [], conflicts: [] });
  // and the state advanced: the next poll is a clean short-circuit too
  const fourth = await mergeMetadata({ path: viewer, name: 'viewer' });
  assert.deepEqual(fourth, { ok: true, applied: [], deferred: [], conflicts: [] });
});

test('mergeMetadata applies a remote deletion on a clone\'s first sync', async () => {
  // Regression: the first-sync reconciliation set covered only remote and
  // base paths — a card still present locally but deleted remotely was never
  // even examined, so the deletion never applied.
  const origin = makeRepo();
  const originCard = path.join(origin, '.todomd/tasks/task-0001-card.md');
  fs.mkdirSync(path.dirname(originCard), { recursive: true });
  fs.writeFileSync(originCard, '---\nid: task-0001\ntitle: Test\nstatus: Queue\nassignee:\n---\n\nbody\n');
  git(origin, ['add', '.todomd/tasks/task-0001-card.md']);
  git(origin, ['commit', '-qm', 'add task-0001']);

  const dir = tmp('sync');
  const worker = clone(origin, path.join(dir, 'worker'));
  const viewer = clone(origin, path.join(dir, 'viewer'));
  enableSync(worker, 'origin');
  enableSync(viewer, 'origin');

  git(worker, ['rm', '-q', '.todomd/tasks/task-0001-card.md']);
  git(worker, ['commit', '-qm', 'drop task-0001']);
  assert.equal((await pushMetadata({ path: worker, name: 'worker' })).ok, true);

  // viewer's copy is untouched since the clone — remote's deletion is a safe
  // fast-forward (viewer's content is a real point in the remote history)
  const result = await mergeMetadata({ path: viewer, name: 'viewer' });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.conflicts, [], JSON.stringify(result));
  assert.ok(result.applied.some((f) => f.endsWith('tasks/task-0001-card.md')), JSON.stringify(result));
  assert.equal(fs.existsSync(path.join(viewer, '.todomd/tasks/task-0001-card.md')), false);
});

test('mergeMetadata never resurrects a deliberately committed local deletion', async () => {
  // Regression: local absence used to be treated as "predates the remote
  // file" and the remote copy was re-applied — silently undoing a local
  // deletion. Local history shows the path existed, so this is a conflict.
  const origin = makeRepo();
  const originCard = path.join(origin, '.todomd/tasks/task-0001-card.md');
  fs.mkdirSync(path.dirname(originCard), { recursive: true });
  fs.writeFileSync(originCard, '---\nid: task-0001\ntitle: Test\nstatus: Queue\nassignee:\n---\n\nbody\n');
  git(origin, ['add', '.todomd/tasks/task-0001-card.md']);
  git(origin, ['commit', '-qm', 'add task-0001']);

  const dir = tmp('sync');
  const worker = clone(origin, path.join(dir, 'worker'));
  const viewer = clone(origin, path.join(dir, 'viewer'));
  enableSync(worker, 'origin');
  enableSync(viewer, 'origin');
  assert.equal((await pushMetadata({ path: worker, name: 'worker' })).ok, true);

  git(viewer, ['rm', '-q', '.todomd/tasks/task-0001-card.md']);
  git(viewer, ['commit', '-qm', 'deliberately drop task-0001']);

  const result = await mergeMetadata({ path: viewer, name: 'viewer' });
  assert.equal(result.ok, true, result.error);
  assert.ok(result.conflicts.some((f) => f.endsWith('tasks/task-0001-card.md')), JSON.stringify(result));
  assert.equal(fs.existsSync(path.join(viewer, '.todomd/tasks/task-0001-card.md')), false,
    'a committed local deletion must never be silently resurrected');
});

test('mergeMetadata persists sync state inside a linked git worktree', async () => {
  // Regression: state was written to <repo>/.git/todomd-metadata-sync.json,
  // but in a linked worktree `.git` is a file — the write failed silently,
  // every sync ran as a "first sync", and any local board edit afterwards
  // was misreported as a conflict.
  const origin = makeRepo();
  const dir = tmp('sync');
  const worker = clone(origin, path.join(dir, 'worker'));
  const viewer = clone(origin, path.join(dir, 'viewer'));
  enableSync(worker, 'origin');
  enableSync(viewer, 'origin');
  const wt = path.join(dir, 'viewer-wt');
  git(viewer, ['worktree', 'add', '-q', wt]);

  const workerCard = path.join(worker, '.todomd/tasks/task-0001-card.md');
  fs.mkdirSync(path.dirname(workerCard), { recursive: true });
  fs.writeFileSync(workerCard, '---\nid: task-0001\ntitle: Test\nstatus: Queue\nassignee: alice\n---\n\nbody\n');
  git(worker, ['add', '.todomd/tasks/task-0001-card.md']);
  git(worker, ['commit', '-qm', 'assign task-0001 to alice']);
  assert.equal((await pushMetadata({ path: worker, name: 'worker' })).ok, true);

  const result = await mergeMetadata({ path: wt, name: 'viewer-wt' });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.warning, undefined, result.warning);
  assert.ok(result.applied.some((f) => f.endsWith('tasks/task-0001-card.md')), JSON.stringify(result));

  // the state file lands under the worktree's OWN git dir, not <repo>/.git
  const gitDir = git(wt, ['rev-parse', '--absolute-git-dir']);
  assert.ok(gitDir.includes(`${path.sep}worktrees${path.sep}`), gitDir);
  assert.equal(fs.existsSync(path.join(gitDir, 'todomd-metadata-sync.json')), true);

  // a local board edit after a successful sync must NOT read as a conflict:
  // with the last-synced ref persisted, an unchanged remote is a clean no-op
  // regardless of local-only commits
  const card = path.join(wt, '.todomd/tasks/task-0001-card.md');
  fs.writeFileSync(card, '---\nid: task-0001\ntitle: Test\nstatus: Queue\nassignee: bob\n---\n\nbody\n');
  git(wt, ['add', '.todomd/tasks/task-0001-card.md']);
  git(wt, ['commit', '-qm', 'reassign locally']);
  const after = await mergeMetadata({ path: wt, name: 'viewer-wt' });
  assert.deepEqual(after, { ok: true, applied: [], deferred: [], conflicts: [] });
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

test('mergeMetadata restores the worktree when the merge commit is refused', async () => {
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

  // a mid-merge viewer makes commitPaths refuse AFTER applyRemote has already
  // written the remote files — the writes must be rolled back, not left dirty
  const gitDir = git(viewer, ['rev-parse', '--absolute-git-dir']);
  fs.writeFileSync(path.join(gitDir, 'MERGE_HEAD'), 'f'.repeat(40) + '\n');
  const result = await mergeMetadata({ path: viewer, name: 'viewer' });
  assert.equal(result.ok, false);
  assert.match(result.error, /mid merge\/rebase/i);
  assert.equal(git(viewer, ['status', '--porcelain', '--', '.todomd']), '',
    'a refused merge commit must leave no applied writes behind');
  fs.rmSync(path.join(gitDir, 'MERGE_HEAD'));

  // and once the merge state clears, the same remote change still applies —
  // the refusal did not advance the stored ref or wedge the board
  const retry = await mergeMetadata({ path: viewer, name: 'viewer' });
  assert.equal(retry.ok, true, retry.error);
  assert.ok(retry.applied.some((f) => f.endsWith('tasks/task-0001-card.md')), JSON.stringify(retry));
  assert.match(fs.readFileSync(path.join(viewer, '.todomd/tasks/task-0001-card.md'), 'utf8'), /assignee: alice/);
});

test('mergeMetadata conflicts when local diverged from the remote base on first sync', async () => {
  const origin = makeRepo();
  const dir = tmp('sync');
  const worker = clone(origin, path.join(dir, 'worker'));
  const viewer = clone(origin, path.join(dir, 'viewer'));
  enableSync(worker, 'origin');
  enableSync(viewer, 'origin');

  // worker creates the card, then edits it — remote history is A -> B
  const wcard = path.join(worker, '.todomd/tasks/task-0001-card.md');
  fs.mkdirSync(path.dirname(wcard), { recursive: true });
  fs.writeFileSync(wcard, '---\nid: task-0001\nassignee: alice\n---\n');
  git(worker, ['add', '.todomd/tasks/task-0001-card.md']);
  git(worker, ['commit', '-qm', 'assign to alice']);

  // viewer independently creates the same card with different content — it
  // never held the remote's base state, so the remote edit must NOT
  // fast-forward over the local version
  const vcard = path.join(viewer, '.todomd/tasks/task-0001-card.md');
  fs.mkdirSync(path.dirname(vcard), { recursive: true });
  fs.writeFileSync(vcard, '---\nid: task-0001\nassignee: carol\n---\n');
  git(viewer, ['add', '.todomd/tasks/task-0001-card.md']);
  git(viewer, ['commit', '-qm', 'independently assign to carol']);

  await pushMetadata({ path: worker, name: 'worker' });
  const result = await mergeMetadata({ path: viewer, name: 'viewer' });
  assert.equal(result.ok, true, result.error);
  assert.ok(result.conflicts.some((f) => f.endsWith('tasks/task-0001-card.md')), JSON.stringify(result));
  assert.match(fs.readFileSync(vcard, 'utf8'), /assignee: carol/, 'local edit must be preserved');
});

test('mergeMetadata defers paths for cards with in-flight runs', async () => {
  const origin = makeRepo();
  const dir = tmp('sync');
  const worker = clone(origin, path.join(dir, 'worker'));
  const viewer = clone(origin, path.join(dir, 'viewer'));
  enableSync(worker, 'origin');
  enableSync(viewer, 'origin');

  const wcard = path.join(worker, '.todomd/tasks/task-0001-card.md');
  fs.mkdirSync(path.dirname(wcard), { recursive: true });
  fs.writeFileSync(wcard, '---\nid: task-0001\nassignee: alice\n---\n');
  git(worker, ['add', '.todomd/tasks/task-0001-card.md']);
  git(worker, ['commit', '-qm', 'assign to alice']);
  await pushMetadata({ path: worker, name: 'worker' });

  // task-0001 has a live run on this clone — its file must not be written
  const result = await mergeMetadata({ path: viewer, name: 'viewer' }, { deferCardIds: new Set(['task-0001']) });
  assert.equal(result.ok, true, result.error);
  assert.ok(result.deferred.some((f) => f.endsWith('tasks/task-0001-card.md')), JSON.stringify(result));
  assert.equal(fs.existsSync(path.join(viewer, '.todomd/tasks/task-0001-card.md')), false, 'deferred card file must not be written');

  // once the run finishes the same remote change applies normally
  const after = await mergeMetadata({ path: viewer, name: 'viewer' });
  assert.equal(after.ok, true, after.error);
  assert.match(fs.readFileSync(path.join(viewer, '.todomd/tasks/task-0001-card.md'), 'utf8'), /assignee: alice/);
});

test('a clone that pulled remote metadata can still publish its own edits', async () => {
  const origin = makeRepo();
  const dir = tmp('sync');
  const worker = clone(origin, path.join(dir, 'worker'));
  const viewer = clone(origin, path.join(dir, 'viewer'));
  enableSync(worker, 'origin');
  enableSync(viewer, 'origin');

  // worker publishes; viewer merges it in
  const wcard = path.join(worker, '.todomd/tasks/task-0001-card.md');
  fs.mkdirSync(path.dirname(wcard), { recursive: true });
  fs.writeFileSync(wcard, '---\nid: task-0001\nassignee: alice\n---\n');
  git(worker, ['add', '.todomd/tasks/task-0001-card.md']);
  git(worker, ['commit', '-qm', 'assign to alice']);
  await pushMetadata({ path: worker, name: 'worker' });
  const merged = await mergeMetadata({ path: viewer, name: 'viewer' });
  assert.equal(merged.ok, true, merged.error);

  // viewer now makes its own board edit and publishes — a subtree-split
  // publish would be a non-fast-forward sibling of the ref it just merged;
  // parenting the publish on the remote tip keeps the branch linear
  const vcard = path.join(viewer, '.todomd/tasks/task-0002-card.md');
  fs.writeFileSync(vcard, '---\nid: task-0002\nassignee: bob\n---\n');
  git(viewer, ['add', '.todomd/tasks/task-0002-card.md']);
  git(viewer, ['commit', '-qm', 'assign task-0002 to bob']);
  const pushed = await pushMetadata({ path: viewer, name: 'viewer' });
  assert.equal(pushed.ok, true, pushed.error);

  // and the worker sees the viewer's edit on its next merge
  const back = await mergeMetadata({ path: worker, name: 'worker' });
  assert.equal(back.ok, true, back.error);
  assert.ok(back.applied.some((f) => f.endsWith('tasks/task-0002-card.md')), JSON.stringify(back));
  assert.match(fs.readFileSync(path.join(worker, '.todomd/tasks/task-0002-card.md'), 'utf8'), /assignee: bob/);
});

test('pushMetadata is suppressed while a merge has unresolved paths', async () => {
  const origin = makeRepo();
  const dir = tmp('sync');
  const worker = clone(origin, path.join(dir, 'worker'));
  const viewer = clone(origin, path.join(dir, 'viewer'));
  enableSync(worker, 'origin');
  enableSync(viewer, 'origin');

  // worker publishes a card change
  const wcard = path.join(worker, '.todomd/tasks/task-0001-card.md');
  fs.mkdirSync(path.dirname(wcard), { recursive: true });
  fs.writeFileSync(wcard, '---\nid: task-0001\nassignee: alice\n---\n');
  git(worker, ['add', '.todomd/tasks/task-0001-card.md']);
  git(worker, ['commit', '-qm', 'assign alice']);
  await pushMetadata({ path: worker, name: 'worker' });

  // viewer has a conflicting local edit — merge leaves it unresolved
  const vcard = path.join(viewer, '.todomd/tasks/task-0001-card.md');
  fs.mkdirSync(path.dirname(vcard), { recursive: true });
  fs.writeFileSync(vcard, '---\nid: task-0001\nassignee: bob\n---\n');
  git(viewer, ['add', '.todomd/tasks/task-0001-card.md']);
  git(viewer, ['commit', '-qm', 'local assign bob']);
  const merged = await mergeMetadata({ path: viewer, name: 'viewer' });
  assert.ok(merged.conflicts.length > 0, JSON.stringify(merged));

  // publishing now would overwrite the remote version with the unresolved
  // local copy — the guard must refuse
  const suppressed = await pushMetadata({ path: viewer, name: 'viewer' });
  assert.equal(suppressed.ok, true);
  assert.equal(suppressed.skipped, 'unresolved-sync');

  // the human resolves by editing the card — the guard releases
  fs.writeFileSync(vcard, '---\nid: task-0001\nassignee: alice\n---\n');
  git(viewer, ['add', '.todomd/tasks/task-0001-card.md']);
  git(viewer, ['commit', '-qm', 'resolve: accept alice']);
  const released = await pushMetadata({ path: viewer, name: 'viewer' });
  assert.equal(released.ok, true, released.error);
  assert.notEqual(released.skipped, 'unresolved-sync');
});

test('pushMetadata refuses to publish onto a code branch', async () => {
  const repo = makeRepo();
  const cfg = path.join(repo, '.todomd/config.yml');
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  fs.writeFileSync(cfg, 'columns: [Queue, Done]\ngithub_sync:\n  enabled: true\n  remote: origin\n  branch: main\n');
  git(repo, ['add', '.todomd/config.yml']);
  git(repo, ['commit', '-qm', 'sync misconfigured to main']);
  const result = await pushMetadata({ path: repo, name: 'repo' });
  assert.equal(result.ok, false);
  assert.match(result.error, /dedicated metadata branch/);
});

test('pushMetadata refuses a non-default code branch as the sync target', async () => {
  const origin = makeRepo();
  // a second code branch exists on the remote alongside main
  git(origin, ['branch', 'develop']);
  const dir = tmp('sync');
  const worker = clone(origin, path.join(dir, 'worker'));
  const cfg = path.join(worker, '.todomd/config.yml');
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  fs.writeFileSync(cfg, 'columns: [Queue, Done]\ngithub_sync:\n  enabled: true\n  remote: origin\n  branch: develop\n');
  git(worker, ['add', '.todomd/config.yml']);
  git(worker, ['commit', '-qm', 'sync misconfigured to develop']);
  const result = await pushMetadata({ path: worker, name: 'worker' });
  assert.equal(result.ok, false);
  assert.match(result.error, /metadata branch/);
  // and the remote branch must be untouched
  const tip = git(origin, ['rev-parse', 'develop']);
  assert.match(git(origin, ['ls-tree', '--name-only', tip]), /package\.json/);
});

test('mergeMetadata refuses to merge a branch that is not metadata-shaped', async () => {
  const origin = makeRepo();
  git(origin, ['branch', 'develop']);
  const dir = tmp('sync');
  const viewer = clone(origin, path.join(dir, 'viewer'));
  const cfg = path.join(viewer, '.todomd/config.yml');
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  fs.writeFileSync(cfg, 'columns: [Queue, Done]\ngithub_sync:\n  enabled: true\n  remote: origin\n  branch: develop\n');
  git(viewer, ['add', '.todomd/config.yml']);
  git(viewer, ['commit', '-qm', 'sync misconfigured']);
  const out = await mergeMetadata({ path: viewer, name: 'viewer' });
  assert.equal(out.ok, false);
  assert.match(out.error, /dedicated metadata branch|metadata branch/);
});

test('pushMetadata refuses a foreign branch even with a metadata-looking root', async () => {
  const origin = makeRepo();
  // a hand-made branch whose root carries config.yml + source files but no
  // .todomd/ — passes a shape check, must still fail provenance
  git(origin, ['checkout', '-qb', 'docs-site']);
  fs.writeFileSync(path.join(origin, 'config.yml'), 'columns: [Queue, Done]\n');
  fs.mkdirSync(path.join(origin, 'src'), { recursive: true });
  fs.writeFileSync(path.join(origin, 'src/app.js'), 'console.log(1)\n');
  git(origin, ['rm', '-rq', '.todomd']);
  git(origin, ['add', 'config.yml', 'src/app.js']);
  git(origin, ['commit', '-qm', 'docs branch']);
  git(origin, ['checkout', '-q', 'main']);
  const dir = tmp('sync');
  const worker = clone(origin, path.join(dir, 'worker'));
  const cfg = path.join(worker, '.todomd/config.yml');
  fs.writeFileSync(cfg, 'columns: [Queue, Done]\ngithub_sync:\n  enabled: true\n  remote: origin\n  branch: docs-site\n');
  git(worker, ['add', '.todomd/config.yml']);
  git(worker, ['commit', '-qm', 'sync misconfigured to docs-site']);
  const result = await pushMetadata({ path: worker, name: 'worker' });
  assert.equal(result.ok, false);
  assert.match(result.error, /metadata branch/);
  const tip = git(origin, ['rev-parse', 'docs-site']);
  assert.match(git(origin, ['ls-tree', '--name-only', tip]), /src/);
});

test('a completed in-flight commit does not release a deferred-path publish guard', async () => {
  const origin = makeRepo();
  // card pre-exists on both sides
  const originCard = path.join(origin, '.todomd/tasks/task-0001-card.md');
  fs.mkdirSync(path.dirname(originCard), { recursive: true });
  fs.writeFileSync(originCard, '---\nid: task-0001\nstatus: Build\nassignee:\n---\n\nbody\n');
  git(origin, ['add', '.todomd/tasks/task-0001-card.md']);
  git(origin, ['commit', '-qm', 'add task-0001']);

  const dir = tmp('sync');
  const worker = clone(origin, path.join(dir, 'worker'));
  const viewer = clone(origin, path.join(dir, 'viewer'));
  enableSync(worker, 'origin');
  enableSync(viewer, 'origin');

  // remote side changes the assignee and publishes
  const wcard = path.join(worker, '.todomd/tasks/task-0001-card.md');
  fs.writeFileSync(wcard, '---\nid: task-0001\nstatus: Build\nassignee: alice\n---\n\nbody\n');
  git(worker, ['add', '.todomd/tasks/task-0001-card.md']);
  git(worker, ['commit', '-qm', 'assign alice']);
  await pushMetadata({ path: worker, name: 'worker' });

  // viewer merges while task-0001 is in flight — the remote change defers
  const merged = await mergeMetadata({ path: viewer, name: 'viewer' }, { deferCardIds: new Set(['task-0001']) });
  assert.equal(merged.ok, true, merged.error);
  assert.deepEqual(merged.deferred, ['.todomd/tasks/task-0001-card.md'], JSON.stringify(merged));

  // the run completes and commits its own change — the blob differs now, but
  // this is NOT a resolution: the remote assignee update was never seen
  const vcard = path.join(viewer, '.todomd/tasks/task-0001-card.md');
  fs.writeFileSync(vcard, '---\nid: task-0001\nstatus: Done\nassignee:\n---\n\nbody\n');
  git(viewer, ['add', '.todomd/tasks/task-0001-card.md']);
  git(viewer, ['commit', '-qm', 'run completes']);

  const suppressed = await pushMetadata({ path: viewer, name: 'viewer' });
  assert.equal(suppressed.skipped, 'unresolved-sync',
    'a completed run committing to the card must not publish over the unseen remote update');

  // the next merge (card no longer in flight) reconciles — both sides moved,
  // so it surfaces as a conflict a human can resolve
  const merged2 = await mergeMetadata({ path: viewer, name: 'viewer' });
  assert.equal(merged2.ok, true, merged2.error);
  assert.ok(merged2.conflicts.includes('.todomd/tasks/task-0001-card.md'), JSON.stringify(merged2));
});

test('first sync conflicts when a local card edit was pushed to the code branch', async () => {
  const origin = makeRepo();
  const originCard = path.join(origin, '.todomd/tasks/task-0001-card.md');
  fs.mkdirSync(path.dirname(originCard), { recursive: true });
  fs.writeFileSync(originCard, '---\nid: task-0001\nassignee:\n---\n\nbody\n');
  git(origin, ['add', '.todomd/tasks/task-0001-card.md']);
  git(origin, ['commit', '-qm', 'add task-0001']);

  const dir = tmp('sync');
  const worker = clone(origin, path.join(dir, 'worker'));
  const viewer = clone(origin, path.join(dir, 'viewer'));
  enableSync(worker, 'origin');
  enableSync(viewer, 'origin');

  // viewer edits the card AND pushes it to the code branch — reachable from
  // origin/HEAD, but the metadata publisher never saw it
  const vcard = path.join(viewer, '.todomd/tasks/task-0001-card.md');
  fs.writeFileSync(vcard, '---\nid: task-0001\nassignee: bob\n---\n\nbody\n');
  git(viewer, ['add', '.todomd/tasks/task-0001-card.md']);
  git(viewer, ['commit', '-qm', 'viewer assigns bob']);
  // "push" the edit to the code branch — the test origin has main checked
  // out, so move the ref directly (reachable from origin/HEAD either way)
  git(origin, ['fetch', '-q', viewer, 'HEAD']);
  git(origin, ['update-ref', 'refs/heads/main', 'FETCH_HEAD']);

  // worker (never saw bob) publishes its own change
  const wcard = path.join(worker, '.todomd/tasks/task-0001-card.md');
  fs.writeFileSync(wcard, '---\nid: task-0001\nassignee: alice\n---\n\nbody\n');
  git(worker, ['add', '.todomd/tasks/task-0001-card.md']);
  git(worker, ['commit', '-qm', 'worker assigns alice']);
  await pushMetadata({ path: worker, name: 'worker' });

  const result = await mergeMetadata({ path: viewer, name: 'viewer' });
  assert.equal(result.ok, true, result.error);
  assert.ok(result.conflicts.includes('.todomd/tasks/task-0001-card.md'),
    `pushed-but-unseen local edit must conflict, got ${JSON.stringify(result)}`);
  assert.match(fs.readFileSync(vcard, 'utf8'), /assignee: bob/, 'local version must be kept');
});

test('pushMetadata refuses a metadata branch that gained a source-bearing commit', async () => {
  const origin = makeRepo();
  const dir = tmp('sync');
  const worker = clone(origin, path.join(dir, 'worker'));
  enableSync(worker, 'origin');
  assert.equal((await pushMetadata({ path: worker, name: 'worker' })).ok, true);

  // someone lands a normal commit on the metadata branch (valid publish root,
  // then a source file on top with a foreign message)
  const abuse = clone(origin, path.join(dir, 'abuse'));
  git(abuse, ['checkout', '-q', 'todomd-state']);
  fs.mkdirSync(path.join(abuse, 'src'), { recursive: true });
  fs.writeFileSync(path.join(abuse, 'src/app.js'), 'console.log(1)\n');
  git(abuse, ['add', 'src/app.js']);
  git(abuse, ['commit', '-qm', 'add source to metadata branch']);
  git(abuse, ['push', '-q', 'origin', 'todomd-state']);

  const result = await pushMetadata({ path: worker, name: 'worker' });
  assert.equal(result.ok, false);
  assert.match(result.error, /metadata branch/);
});

test('the metadata scheduler runs pushes through the exclusive hook', async () => {
  const calls = [];
  const scheduler = createMetadataScheduler({
    exclusive: async (project, fn) => { calls.push(project.name); return fn(); },
  });
  const repo = makeRepo();
  // remote 'origin' does not exist — the publish fails, but the exclusive
  // wrapper must still have been invoked around it
  const cfg = path.join(repo, '.todomd/config.yml');
  fs.appendFileSync(cfg, '\ngithub_sync:\n  enabled: true\n  remote: origin\n  debounce_seconds: 1\n  done_delay_seconds: 1\n  max_delay_seconds: 1\n');
  git(repo, ['add', '.todomd/config.yml']);
  git(repo, ['commit', '-qm', 'enable github_sync']);
  scheduler.schedule({ path: repo, name: 'spy' }, { done: true });
  await new Promise((r) => setTimeout(r, 1600));
  scheduler.close();
  assert.deepEqual(calls, ['spy']);
});
