import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Read only the coordinator's private, user-controlled policy registry. Task
// worktrees inherit the policy through their canonical parent repository path.
export function agentPublicationPolicy(repoPath) {
  const directory = path.join(process.env.TODOMD_HOME || os.homedir(), '.todomd', 'board-agent');
  let policies;
  try {
    let saved;
    try { saved = JSON.parse(fs.readFileSync(path.join(directory, 'state.json'), 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (saved?.version === 2) {
      if (!saved.boards || typeof saved.boards !== 'object' || Array.isArray(saved.boards)) throw new Error('invalid board policies');
      policies = Object.fromEntries([...(saved.retiredPolicies || []), ...Object.values(saved.boards)].map((b) => [b.path, {
        publication: b.policy.publication, protectedBranches: b.policy.protectedBranches, worktreeRoot: b.worktreeRoot,
      }]));
    } else {
      if (saved?.version) throw new Error('unsupported board state version');
      // Standalone/legacy policy registry, also used by pipeline fixtures. V2
      // always reads its authoritative atomic state instead of this fallback.
      try { policies = JSON.parse(fs.readFileSync(path.join(directory, 'publication.json'), 'utf8')); }
      catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    }
  } catch { return { publication: 'review_required', error: 'publication policy is unreadable' }; }
  if (!policies || typeof policies !== 'object' || Array.isArray(policies) || Object.values(policies).some((p) =>
    !p || !['review_required', 'legacy_auto_merge'].includes(p.publication) || !Array.isArray(p.protectedBranches) ||
    p.protectedBranches.some((b) => typeof b !== 'string') || typeof p.worktreeRoot !== 'string')) return { publication: 'review_required', error: 'publication policy is invalid' };
  const abs = fs.realpathSync(repoPath);
  const direct = policies[abs];
  if (direct) return direct;
  // Only registered task worktree directories inherit the parent restriction.
  const entry = Object.entries(policies).find(([root, p]) => p.worktreeRoot && (abs === p.worktreeRoot || abs.startsWith(p.worktreeRoot + path.sep)));
  return entry?.[1] || null;
}
export function savePublicationPolicies(directory, boards) {
  const file = path.join(directory, 'publication.json');
  const policies = Object.fromEntries(boards.map((b) => [b.path, {
    publication: b.policy.publication, protectedBranches: b.policy.protectedBranches,
    worktreeRoot: b.worktreeRoot,
  }]));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file + '.tmp', JSON.stringify(policies, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}
