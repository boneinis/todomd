import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { git } from './git.js';

export function isIndexLockFailure(text) {
  return /index\.lock[^\n]*(?:File exists|already exists)/i.test(String(text || ''));
}

// Only retry a completed agent's existing index. Never stage more files,
// delete someone else's lock, or repeat non-lock failures such as a hook error.
export async function retryStagedCommit(cwd, message, { attempts = 5, delayMs = 250, cancelled = () => false } = {}) {
  const staged = await git(cwd, ['--no-optional-locks', 'diff', '--cached', '--name-only', '-z']);
  const paths = staged.ok ? staged.stdout.split('\0').filter(Boolean) : [];
  if (!staged.ok || !paths.length) return { ok: false, paths, error: staged.stderr || 'No staged changes to commit.' };
  let result;
  for (let i = 0; i < attempts; i++) {
    if (cancelled()) return { ok: false, paths, cancelled: true, error: 'Commit recovery cancelled; staged work preserved.' };
    result = await git(cwd, ['commit', '-m', message]);
    if (result.ok) return { ok: true, paths };
    if (!isIndexLockFailure(result.stderr)) break;
    if (i + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return { ok: false, paths, error: result?.stderr || 'Commit did not complete.' };
}

export async function progressSnapshot(worktreeAbs) {
  const head = await git(worktreeAbs, ['--no-optional-locks', 'rev-parse', 'HEAD']);
  const changed = await git(worktreeAbs, ['--no-optional-locks', 'status', '--porcelain=v1']);
  // diff's stat-only refresh can still acquire index.lock even with optional
  // locks disabled. Progress sampling runs beside the agent's git add/commit.
  const tracked = await git(worktreeAbs, ['--no-optional-locks', '-c', 'diff.autoRefreshIndex=false', 'diff', '--name-only', '-z', 'HEAD', '--']);
  const untracked = await git(worktreeAbs, ['--no-optional-locks', 'ls-files', '--others', '--exclude-standard', '-z']);
  const digest = createHash('sha256');
  const paths = new Set();
  for (const output of [tracked, untracked]) {
    if (!output.ok) continue;
    for (const file of output.stdout.split('\0').filter(Boolean)) paths.add(file);
  }
  for (const file of [...paths].sort()) {
    digest.update(`\0${file}\0`);
    try {
      const absolute = path.join(worktreeAbs, file);
      const stat = fs.statSync(absolute);
      digest.update(`${stat.size}:${stat.mtimeMs}:`);
      // Source files are normally small. Hash their contents exactly; for a
      // large generated artifact, size+mtime still detects continued writes
      // without reading an unbounded file into the board process.
      if (stat.isFile() && stat.size <= 1024 * 1024) digest.update(fs.readFileSync(absolute));
    }
    catch { digest.update('unreadable'); }
  }
  return {
    head: head.ok ? head.stdout : '',
    fingerprint: digest.digest('hex'),
    changed: changed.ok ? changed.stdout.split('\n').filter(Boolean).length : 0,
  };
}
