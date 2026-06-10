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

export async function addWorktree(repoPath, worktreePath, branch) {
  const res = await git(repoPath, ['worktree', 'add', worktreePath, '-b', branch]);
  return res.ok ? { ok: true } : { ok: false, reason: res.stderr };
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
export async function commitCard(repoPath, relFile, message) {
  if (!(await isGitRepo(repoPath))) return { committed: false, reason: 'not a git repo' };
  if (midOperation(repoPath)) return { committed: false, reason: 'repo is mid merge/rebase' };
  const add = await git(repoPath, ['add', '--', relFile]);
  if (!add.ok) return { committed: false, reason: add.stderr };
  const commit = await git(repoPath, ['commit', '--no-verify', '-m', message, '--only', '--', relFile]);
  if (!commit.ok) return { committed: false, reason: commit.stderr || 'nothing to commit' };
  return { committed: true };
}
