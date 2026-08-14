import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

const isTaskPath = (file) => file === '.todomd/tasks' || file.startsWith('.todomd/tasks/');

export function evaluateTaskChanges({ changedPaths = [], authorAssociation = '' } = {}) {
  const taskPaths = changedPaths.filter(isTaskPath);
  if (taskPaths.length === 0) {
    return { allowed: true, taskPaths, reason: 'No tracked TODOMD task files changed.' };
  }

  const association = String(authorAssociation).trim().toUpperCase();
  if (TRUSTED_ASSOCIATIONS.has(association)) {
    return { allowed: true, taskPaths, reason: `Trusted ${association.toLowerCase()} task-file change.` };
  }

  return {
    allowed: false,
    taskPaths,
    reason: 'Tracked TODOMD task files are owner-managed. Remove them from this pull request and open an Issue instead.',
  };
}

function changedTaskPaths(baseSha, headSha) {
  const output = execFileSync('git', [
    'diff', '--name-only', '-z', baseSha, headSha, '--', '.todomd/tasks',
  ], { encoding: 'buffer', maxBuffer: 1024 * 1024 });
  return output.toString('utf8').split('\0').filter(Boolean);
}

export function runGuard(env = process.env) {
  const baseSha = String(env.GITHUB_BASE_SHA || '').trim();
  const headSha = String(env.GITHUB_HEAD_SHA || '').trim();
  if (!baseSha || !headSha) {
    console.error('::error title=TODOMD task protection::Missing pull-request base or head SHA.');
    return 1;
  }

  let changedPaths;
  try {
    changedPaths = changedTaskPaths(baseSha, headSha);
  } catch (error) {
    console.error(`::error title=TODOMD task protection::Could not inspect pull-request changes: ${error.message}`);
    return 1;
  }

  const result = evaluateTaskChanges({
    changedPaths,
    authorAssociation: env.GITHUB_AUTHOR_ASSOCIATION,
  });
  if (result.allowed) {
    console.log(result.reason);
    return 0;
  }

  console.error(`::error title=Owner-managed TODOMD tasks::${result.reason}`);
  for (const file of result.taskPaths) console.error(`  ${file}`);
  return 1;
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exitCode = runGuard();
