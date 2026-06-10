import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function git(repoPath, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: repoPath }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout?.trim(), stderr: stderr?.trim() });
    });
  });
}

async function isGitRepo(repoPath) {
  const res = await git(repoPath, ['rev-parse', '--is-inside-work-tree']);
  return res.ok && res.stdout === 'true';
}

function midOperation(repoPath) {
  const g = path.join(repoPath, '.git');
  return ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD'].some((f) =>
    fs.existsSync(path.join(g, f))
  );
}

export { git, isGitRepo };

export async function addWorktree(repoPath, worktreePath, branch) {
  const res = await git(repoPath, ['worktree', 'add', worktreePath, '-b', branch]);
  return res.ok ? { ok: true } : { ok: false, reason: res.stderr };
}

export async function removeWorktree(repoPath, worktreePath, branch) {
  await git(repoPath, ['worktree', 'remove', '--force', worktreePath]);
  if (branch) await git(repoPath, ['branch', '-D', branch]);
  await git(repoPath, ['worktree', 'prune']);
}

// Guard: a task branch must never carry .todomd/ changes (board tampering).
// Three-dot diff: merge-base → branch, i.e. only what the BRANCH changed —
// main legitimately commits board transitions during the run.
export async function branchTouchesBoard(repoPath, branch) {
  const res = await git(repoPath, ['diff', '--name-only', `HEAD...${branch}`, '--', '.todomd']);
  return res.ok && res.stdout.length > 0;
}

export async function mergeBranch(repoPath, branch, message) {
  if (midOperation(repoPath)) return { ok: false, reason: 'repo is mid merge/rebase' };
  const res = await git(repoPath, ['merge', '--no-ff', branch, '-m', message]);
  if (!res.ok) {
    await git(repoPath, ['merge', '--abort']);
    return { ok: false, reason: res.stderr || 'merge conflict' };
  }
  return { ok: true };
}

// Path-scoped commit: stages and commits ONLY the given file, never the
// user's other changes or whatever they have staged.
export async function commitCard(repoPath, relFile, message) {
  if (!(await isGitRepo(repoPath))) return { committed: false, reason: 'not a git repo' };
  if (midOperation(repoPath)) return { committed: false, reason: 'repo is mid merge/rebase' };
  const add = await git(repoPath, ['add', '--', relFile]);
  if (!add.ok) return { committed: false, reason: add.stderr };
  const commit = await git(repoPath, ['commit', '-m', message, '--only', '--', relFile]);
  if (!commit.ok) return { committed: false, reason: commit.stderr || 'nothing to commit' };
  return { committed: true };
}
