import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, git } from './helpers.js';
import { commitCard, addWorktree, removeWorktree, mergeBranch, branchTouchesBoard } from '../src/git.js';

test('commitCard is path-scoped: leaves the user\'s other changes untouched', async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, '.todomd/tasks/task-0001-card.md'), '---\nid: task-0001\nstatus: Plan\n---\n');
  fs.writeFileSync(path.join(repo, 'src/calc.js'), 'export const dirty = 1;\n'); // unrelated edit
  git(repo, ['add', 'src/calc.js']); // even staged

  const r = await commitCard(repo, '.todomd/tasks/task-0001-card.md', 'chore(todomd): create');
  assert.equal(r.committed, true);
  // the dirty file is still uncommitted/modified, not swept into the commit
  const status = git(repo, ['status', '--porcelain']);
  assert.match(status, /src\/calc\.js/);
  const lastFiles = git(repo, ['show', '--name-only', '--format=', 'HEAD']);
  assert.doesNotMatch(lastFiles, /src\/calc\.js/);
});

test('commitCard refuses outside a git repo', async () => {
  const r = await commitCard('/tmp', 'x.md', 'm'); // /tmp is not a repo
  assert.equal(r.committed, false);
});

test('worktree add/remove lifecycle', async () => {
  const repo = makeRepo();
  const wt = path.join(repo, '.todomd/worktrees/task-0001');
  const add = await addWorktree(repo, wt, 'todomd/task-0001');
  assert.equal(add.ok, true);
  assert.ok(fs.existsSync(wt));
  await removeWorktree(repo, wt, 'todomd/task-0001');
  assert.ok(!fs.existsSync(wt));
  assert.doesNotMatch(git(repo, ['branch']), /todomd\/task-0001/);
});

test('branchTouchesBoard uses merge-base (three-dot): main\'s own board commits do NOT false-positive', async () => {
  const repo = makeRepo();
  const wt = path.join(repo, '.todomd/worktrees/task-0001');
  await addWorktree(repo, wt, 'todomd/task-0001');
  // branch changes only source — clean
  fs.appendFileSync(path.join(wt, 'src/calc.js'), 'export const x = 1;\n');
  git(wt, ['add', '-A']); git(wt, ['commit', '-qm', 'work']);
  // meanwhile main commits a board change (as the orchestrator does)
  fs.writeFileSync(path.join(repo, '.todomd/tasks/task-0001-card.md'), '---\nid: task-0001\nstatus: Build\n---\n');
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'board move']);
  assert.equal(await branchTouchesBoard(repo, 'todomd/task-0001'), false);

  // now the branch itself touches the board → flagged
  fs.mkdirSync(path.join(wt, '.todomd/tasks'), { recursive: true });
  fs.writeFileSync(path.join(wt, '.todomd/tasks/task-0001-card.md'), '---\nid: task-0001\nstatus: Done\n---\n');
  git(wt, ['add', '-A']); git(wt, ['commit', '-qm', 'tamper']);
  assert.equal(await branchTouchesBoard(repo, 'todomd/task-0001'), true);
});

test('mergeBranch merges, and aborts cleanly on conflict', async () => {
  const repo = makeRepo();
  const wt = path.join(repo, '.todomd/worktrees/task-0001');
  await addWorktree(repo, wt, 'todomd/task-0001');
  fs.writeFileSync(path.join(wt, 'src/calc.js'), 'export const v = "branch";\n');
  git(wt, ['add', '-A']); git(wt, ['commit', '-qm', 'branch change']);
  // conflicting change on main
  fs.writeFileSync(path.join(repo, 'src/calc.js'), 'export const v = "main";\n');
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'main change']);

  const r = await mergeBranch(repo, 'todomd/task-0001', 'merge');
  assert.equal(r.ok, false); // conflict
  // repo is not left mid-merge
  assert.ok(!fs.existsSync(path.join(repo, '.git/MERGE_HEAD')));
});
