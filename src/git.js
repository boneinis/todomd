import { agentPublicationPolicy } from './board-agent-policy.js';
import { execFile, execFileSync } from 'node:child_process';
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

// The branch currently checked out in the main working tree, or null on a
// detached HEAD (rev-parse prints literal "HEAD" there).
export async function currentBranch(repoPath) {
  const res = await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return res.ok && res.stdout && res.stdout !== 'HEAD' ? res.stdout : null;
}

// The repo's base branch: the branch checked out right now. Worktrees fork
// from HEAD, so HEAD-at-fork is the truth about where a task branch must merge
// back — preferring origin/HEAD false-fires on repos where the user works on a
// non-default branch. origin/HEAD is only the fallback for a detached HEAD
// (e.g. a CI checkout); null when neither resolves (detached, no origin).
export async function baseBranch(repoPath) {
  const cur = await currentBranch(repoPath);
  if (cur) return cur;
  const res = await git(repoPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (res.ok && res.stdout) return res.stdout.replace(/^origin\//, '');
  return null;
}

export async function addWorktree(repoPath, worktreePath, branch) {
  const res = await git(repoPath, ['worktree', 'add', worktreePath, '-b', branch]);
  return res.ok ? { ok: true } : { ok: false, reason: res.stderr };
}

// Refresh only a clean, correctly checked-out candidate. Never stash, reset or
// resolve conflicts on behalf of a stage agent; a failed refresh costs no Build.
export async function refreshWorktreeBase(worktreePath, branch, base) {
  if (!base || base === 'unknown' || base === branch) return { ok: false, reason: 'base_branch_unknown' };
  if (await currentBranch(worktreePath) !== branch) return { ok: false, reason: 'worktree_failed' };
  const target = await git(worktreePath, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`]);
  if (!target.ok) return { ok: false, reason: 'base_branch_unknown' };
  if ((await git(worktreePath, ['merge-base', '--is-ancestor', target.stdout, 'HEAD'])).ok) return { ok: true, changed: false };
  // Board bookkeeping advances the base during every stage. It is not a
  // source refresh and must not dirty a resumed candidate's source identity.
  const ancestor = await git(worktreePath, ['merge-base', target.stdout, 'HEAD']);
  if (!ancestor.ok) return { ok: false, reason: 'base_sync_conflict' };
  const changed = await git(worktreePath, ['diff', '--name-only', ancestor.stdout, target.stdout, '--', '.', ':(exclude).todomd']);
  if (!changed.ok) return { ok: false, reason: 'base_sync_conflict' };
  if (!changed.stdout) return { ok: true, changed: false };
  const dirty = await git(worktreePath, ['status', '--porcelain']);
  if (!dirty.ok || dirty.stdout) return { ok: false, reason: 'base_sync_dirty' };
  for (const name of ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD']) {
    if ((await git(worktreePath, ['rev-parse', '--verify', name])).ok) return { ok: false, reason: 'base_sync_dirty' };
  }
  const merged = await git(worktreePath, ['merge', '--no-verify', '--no-edit', '--no-gpg-sign', target.stdout]);
  if (!merged.ok) {
    await git(worktreePath, ['merge', '--abort']);
    return { ok: false, reason: 'base_sync_conflict' };
  }
  return { ok: true, changed: true };
}

// A fresh Restart Build must fork from the current base branch, but an older
// orphan can have lost only its worktree while its task branch still survives.
// Preserve that branch under a deterministic backup ref before freeing the
// canonical task branch name. Nothing is deleted, and a branch checked out in
// some other live worktree fails closed instead of being disturbed.
export async function archiveBranchForRestart(repoPath, branch) {
  const exists = await git(repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
  if (!exists.ok) return { ok: true, archived: null };

  const tip = await git(repoPath, ['rev-parse', '--short=8', branch]);
  const stem = `${branch}-preserved-${tip.ok && tip.stdout ? tip.stdout : 'orphan'}`;
  let archived = stem;
  for (let i = 2; i < 100; i++) {
    const taken = await git(repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${archived}`]);
    if (!taken.ok) break;
    archived = `${stem}-${i}`;
  }
  const moved = await git(repoPath, ['branch', '-m', branch, archived]);
  return moved.ok
    ? { ok: true, archived }
    : { ok: false, reason: moved.stderr || `could not preserve existing branch ${branch}` };
}

// Symlink gitignored runtime deps (node_modules, .env, …) from the main repo
// into a fresh worktree so the verify command can actually run. Symlinks are
// instant and share one install; never overwrites anything already present.
// Critically: a `node_modules/` gitignore pattern (directory-only) does NOT
// match a *symlink* named node_modules, so a build agent's `git add -A` would
// commit a machine-specific absolute symlink. We add bare-name patterns to the
// worktree's own exclude so git ignores the links in this worktree.
export function linkIntoWorktree(repoPath, worktreePath, names) {
  const linked = [];
  for (const name of names || []) {
    const src = path.join(repoPath, name);
    const dest = path.join(worktreePath, name);
    if (!fs.existsSync(src) || fs.existsSync(dest)) continue;
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.symlinkSync(src, dest);
      linked.push(name.replace(/\/+$/, ''));
    } catch { /* best effort — a missing link just means tests may fail loudly */ }
  }
  if (linked.length) {
    try {
      const excludePath = execFileSync('git', ['-C', worktreePath, 'rev-parse', '--git-path', 'info/exclude'],
        { encoding: 'utf8' }).trim();
      const abs = path.isAbsolute(excludePath) ? excludePath : path.join(worktreePath, excludePath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const cur = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
      const add = linked.filter((n) => !cur.split('\n').includes(n));
      if (add.length) fs.appendFileSync(abs, (cur && !cur.endsWith('\n') ? '\n' : '') + add.join('\n') + '\n');
    } catch { /* exclude is a safety net; the merge guard below is the backstop */ }
  }
}

// Pre-merge safety net: a task branch must never introduce these (e.g. a
// committed node_modules/.env symlink). Returns the offending path or null.
export async function branchAddedForbidden(repoPath, branch) {
  const res = await git(repoPath, ['diff', '--name-only', '--diff-filter=A', `HEAD...${branch}`]);
  if (!res.ok) return null;
  const base = (f) => f.split('/').pop();
  const bad = res.stdout.split('\n').map((s) => s.trim()).find((f) => {
    if (f === 'node_modules' || f.startsWith('node_modules/')) return true;
    // real secret/runtime env files, but not committed templates (.env.example, …)
    return /^\.env(\.local|\.development|\.production)?$/.test(base(f));
  });
  return bad || null;
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
  if (agentPublicationPolicy(repoPath)?.publication === 'review_required') return { ok: false, reviewRequired: true, reason: 'Verified work requires publication review; branch and worktree are preserved.' };
  if (midOperation(repoPath)) return { ok: false, reason: 'repo is mid merge/rebase' };
  // --no-verify: this is a tool-generated merge commit; don't let the repo's
  // commit-msg/pre-commit hooks (commitlint, etc.) block board automation
  const res = await git(repoPath, ['merge', '--no-ff', '--no-verify', branch, '-m', message]);
  if (!res.ok) {
    await git(repoPath, ['merge', '--abort']);
    return { ok: false, reason: res.stderr || 'merge conflict' };
  }
  return { ok: true };
}

// Path-scoped commit: stages and commits ONLY the given file, never the
// user's other changes or whatever they have staged.
// --no-verify: board commits are tool-generated metadata touching only
// .todomd/; the repo's commit hooks (commitlint subject-case, lint-staged,
// secret-scan) are for human code commits and must not block board automation.
export async function commitPaths(repoPath, relPaths, message) {
  if (!(await isGitRepo(repoPath))) return { committed: false, reason: 'not a git repo' };
  if (midOperation(repoPath)) return { committed: false, reason: 'repo is mid merge/rebase' };
  const policy = agentPublicationPolicy(repoPath);
  if (policy?.publication === 'review_required' && (policy.error || policy.protectedBranches?.includes(await currentBranch(repoPath)))) {
    return { committed: false, reviewRequired: true, reason: 'Board metadata saved locally; protected-branch commits require review.' };
  }
  const add = await git(repoPath, ['add', '--', ...relPaths]);
  if (!add.ok) return { committed: false, reason: add.stderr };
  const commit = await git(repoPath, ['commit', '--no-verify', '-m', message, '--only', '--', ...relPaths]);
  if (!commit.ok) return { committed: false, reason: commit.stderr || 'nothing to commit' };
  return { committed: true };
}

export async function commitCard(repoPath, relFile, message) {
  return commitPaths(repoPath, [relFile], message);
}
