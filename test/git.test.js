import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, git, tmp } from './helpers.js';
import { commitCard, addWorktree, removeWorktree, mergeBranch, branchTouchesBoard, baseBranch, currentBranch } from '../src/git.js';

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

test('linkIntoWorktree symlinks gitignored deps into the worktree', async () => {
  const { linkIntoWorktree } = await import('../src/git.js');
  const repo = makeRepo();
  fs.mkdirSync(path.join(repo, 'node_modules/dep'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'node_modules/dep/index.js'), 'export default 1;\n');
  fs.writeFileSync(path.join(repo, '.env'), 'SECRET=x\n');
  const wt = path.join(repo, '.todomd/worktrees/task-0001');
  await addWorktree(repo, wt, 'todomd/task-0001');
  assert.ok(!fs.existsSync(path.join(wt, 'node_modules')));
  linkIntoWorktree(repo, wt, ['node_modules', '.env']);
  assert.ok(fs.existsSync(path.join(wt, 'node_modules/dep/index.js')), 'node_modules reachable via link');
  assert.equal(fs.readFileSync(path.join(wt, '.env'), 'utf8'), 'SECRET=x\n');
});

test('linkIntoWorktree makes the symlink un-stageable (git add -A skips it)', async () => {
  const { linkIntoWorktree } = await import('../src/git.js');
  const repo = makeRepo();
  fs.mkdirSync(path.join(repo, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'node_modules/x.js'), '1\n');
  const wt = path.join(repo, '.todomd/worktrees/task-0001');
  await addWorktree(repo, wt, 'todomd/task-0001');
  linkIntoWorktree(repo, wt, ['node_modules']);
  fs.writeFileSync(path.join(wt, 'real.js'), 'code\n');
  git(wt, ['add', '-A']);
  const staged = git(wt, ['diff', '--cached', '--name-only']);
  assert.match(staged, /real\.js/);
  assert.doesNotMatch(staged, /node_modules/); // the symlink must NOT be staged
});

test('baseBranch falls back to the checked-out branch when the repo has no origin', async () => {
  const repo = makeRepo();
  const head = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  assert.equal(await currentBranch(repo), head);
  assert.equal(await baseBranch(repo), head);
  git(repo, ['checkout', '-qb', 'feature']);
  assert.equal(await baseBranch(repo), 'feature', 'no origin → follow the current branch');
});

test('baseBranch prefers the checked-out branch; origin/HEAD is only the detached-HEAD fallback', async () => {
  const origin = makeRepo();
  const base = git(origin, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const repo = tmp('clone'); // empty dir — clone into it
  git(repo, ['clone', '-q', origin, '.']);
  git(repo, ['checkout', '-qb', 'switched']);
  assert.equal(await currentBranch(repo), 'switched');
  // worktrees fork from HEAD, so HEAD-at-fork is the truth — NOT origin/HEAD
  assert.equal(await baseBranch(repo), 'switched', 'the checked-out branch wins over origin/HEAD');

  // detached HEAD → fall back to origin/HEAD
  git(repo, ['checkout', '-q', '--detach', 'HEAD']);
  assert.equal(await currentBranch(repo), null);
  assert.equal(await baseBranch(repo), base, 'detached HEAD falls back to origin/HEAD');

  // detached HEAD with no origin at all → null (the pipeline stamps 'unknown')
  const local = makeRepo();
  git(local, ['checkout', '-q', '--detach', 'HEAD']);
  assert.equal(await baseBranch(local), null);
});

test('branchAddedForbidden catches a committed node_modules, passes a clean branch', async () => {
  const { branchAddedForbidden } = await import('../src/git.js');
  const repo = makeRepo();
  fs.mkdirSync(path.join(repo, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'node_modules/x.js'), '1\n');

  const wtA = path.join(repo, '.todomd/worktrees/task-0001');
  await addWorktree(repo, wtA, 'todomd/task-0001');
  fs.writeFileSync(path.join(wtA, 'real.js'), 'code\n');
  git(wtA, ['add', '-A']); git(wtA, ['commit', '-qm', 'clean']);
  assert.equal(await branchAddedForbidden(repo, 'todomd/task-0001'), null);

  const wtB = path.join(repo, '.todomd/worktrees/task-0002');
  await addWorktree(repo, wtB, 'todomd/task-0002');
  fs.symlinkSync(path.join(repo, 'node_modules'), path.join(wtB, 'node_modules'));
  git(wtB, ['add', '-f', '--', 'node_modules']); git(wtB, ['commit', '-qm', 'oops']);
  assert.equal(await branchAddedForbidden(repo, 'todomd/task-0002'), 'node_modules');
});
