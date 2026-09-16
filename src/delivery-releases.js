import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isOwnerId } from './delivery.js';
import { readCard, loadConfig } from './board.js';
import { createDeliveryStore } from './delivery-store.js';
import { deliveryStoreDirectory } from './delivery-paths.js';

const sha = v => typeof v === 'string' && /^[a-f0-9]{40}([a-f0-9]{24})?$/.test(v);
const nonempty = v => typeof v === 'string' && v.trim().length > 0;
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const releaseId = v => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(v);

export function releasesDirectory(repoPath) {
  return path.join(fs.realpathSync(repoPath), '.todomd', 'releases');
}

function safeDirectory(repoPath, create = false) {
  const dir = releasesDirectory(repoPath);
  for (const part of [path.dirname(dir), dir]) {
    if (create) {
      try { fs.mkdirSync(part); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    try { if (!fs.lstatSync(part).isDirectory()) throw new Error('Release directories must not be symlinks.'); }
    catch (error) { if (!create && error.code === 'ENOENT') return null; throw error; }
  }
  return dir;
}

function releaseFile(repoPath, id, create = false) {
  if (!releaseId(id)) throw new Error('Invalid release ID. Use an alphanumeric identifier up to 64 characters.');
  const dir = safeDirectory(repoPath, create);
  if (!dir) return null;
  const file = path.resolve(dir, `${id}.json`);
  if (path.dirname(file) !== dir) throw new Error('Release path is outside the releases directory.');
  return file;
}

export function validateReleaseRecord(record) {
  const issues = [];
  const issue = (path, code, message) => issues.push({ path, code, message });
  if (!object(record)) return { ok: false, issues: [{ path: '', code: 'invalid_record', message: 'Record must be an object.' }] };
  if (record.schema_version !== 2) issue('schema_version', 'unsupported_version', 'schema_version must be 2.');
  if (!releaseId(record.release_id)) issue('release_id', 'invalid_id', 'release_id must be an alphanumeric identifier up to 64 characters.');
  if (!nonempty(record.environment)) issue('environment', 'required', 'environment must be a nonempty string.');
  if (!Array.isArray(record.tasks) || record.tasks.length === 0 || record.tasks.some(t => !nonempty(t))) {
    issue('tasks', 'required', 'tasks must be a nonempty array of task IDs.');
  }
  if (!sha(record.deployed_commit)) issue('deployed_commit', 'invalid_sha', 'deployed_commit must be a valid Git commit SHA.');
  if (!nonempty(record.target_branch)) issue('target_branch', 'required', 'target_branch must be a nonempty string.');

  if (!object(record.approval) || !isOwnerId(record.approval.approver) || !nonempty(record.approval.approved_at)) {
    issue('approval', 'required', 'Valid approval object with approver and approved_at timestamp is required.');
  }
  if (!object(record.deployment) || typeof record.deployment.deployed !== 'boolean' || !nonempty(record.deployment.reference)) {
    issue('deployment', 'required', 'deployment object with deployed boolean and reference is required.');
  }
  if (!object(record.verification) || typeof record.verification.verified !== 'boolean' || !nonempty(record.verification.reference)) {
    issue('verification', 'required', 'verification object with verified boolean and reference is required.');
  }
  if (record.rollback !== undefined) {
    if (!object(record.rollback) || typeof record.rollback.rolled_back !== 'boolean') {
      issue('rollback', 'invalid_rollback', 'rollback must be an object with rolled_back boolean.');
    }
  }

  return { ok: issues.length === 0, issues };
}

export function listReleases(repoPath) {
  const dir = safeDirectory(repoPath);
  if (!dir) return [];
  const entries = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
  const results = [];
  for (const file of entries) {
    try {
      const content = readRelease(repoPath, file.slice(0, -5));
      if (content) results.push(content);
    } catch {}
  }
  return results;
}

export function readRelease(repoPath, releaseId) {
  let fd;
  try {
    const file = releaseFile(repoPath, releaseId);
    if (!file) return null;
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    if (!fs.fstatSync(fd).isFile()) return null;
    const content = JSON.parse(fs.readFileSync(fd, 'utf8'));
    return content.release_id === releaseId && validateReleaseRecord(content).ok ? content : null;
  } catch {
    return null;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function recordRelease(repoPath, releaseRecord) {
  const validation = validateReleaseRecord(releaseRecord);
  if (!validation.ok) {
    const error = new Error(`Invalid release record: ${validation.issues.map(i => i.message).join('; ')}`);
    error.issues = validation.issues;
    throw error;
  }
  const file = releaseFile(repoPath, releaseRecord.release_id, true);
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(releaseRecord, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    try { fs.unlinkSync(tmp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return releaseRecord;
}

export function recordRollback(repoPath, releaseId, { reason, actor, affectedReleaseId } = {}) {
  const existing = readRelease(repoPath, releaseId);
  if (!existing) throw new Error(`Release not found: ${releaseId}`);
  if (!nonempty(reason)) throw new Error('Rollback reason is required.');
  const updated = {
    ...existing,
    rollback: {
      rolled_back: true,
      at: new Date().toISOString(),
      actor: actor || null,
      reason,
      affected_release_id: affectedReleaseId || releaseId,
    },
  };
  return recordRelease(repoPath, updated);
}

function gitExec(repoPath, args, options = {}) {
  try {
    return execFileSync('git', args, {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
      ...options,
    }).trim();
  } catch {
    return null;
  }
}

function gitCommitExists(repoPath, commitSha) {
  if (!sha(commitSha)) return false;
  try {
    execFileSync('git', ['cat-file', '-e', `${commitSha}^{commit}`], {
      cwd: repoPath,
      stdio: 'ignore',
      timeout: 3000,
    });
    return true;
  } catch {
    return false;
  }
}

function gitIsAncestor(repoPath, commitSha, targetBranch) {
  if (!sha(commitSha) || !nonempty(targetBranch)) return false;
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', commitSha, targetBranch], {
      cwd: repoPath,
      stdio: 'ignore',
      timeout: 3000,
    });
    return true;
  } catch {
    return false;
  }
}

// Resolves candidate, CI checks, independent review, PR integration, and release facts for a task
export function resolveTaskEvidence(repoPath, task, options = {}) {
  const taskId = typeof task === 'string' ? task : task?.id;
  const targetEnv = task?.delivery?.target_environment || options.target_environment || 'production';
  const targetBranch = options.target_branch || task?.delivery?.target_branch || 'main';
  const policyRev = options.policy_revision || '1';

  let card = null;
  if (task && object(task.data)) {
    card = task;
  } else if (nonempty(taskId) && typeof repoPath === 'string') {
    try { card = readCard(repoPath, taskId); } catch {}
  }

  // 1. Candidate fact resolution:
  // Check task worktree if present
  let wtHead = null;
  let wtClean = false;
  let wtPreserved = false;
  try {
    const config = loadConfig(repoPath);
    const wtDir = config?.worktree_dir || '.todomd/worktrees';
    const candidatePath = path.resolve(repoPath, wtDir, taskId);
    if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isDirectory()) {
      const headOutput = gitExec(candidatePath, ['rev-parse', 'HEAD']);
      if (sha(headOutput)) {
        wtHead = headOutput;
        const statusOutput = gitExec(candidatePath, ['status', '--porcelain']);
        wtClean = statusOutput === '';
        wtPreserved = true;
      }
    }
  } catch {}

  let candidateHead = null;
  let candidateClean = false;
  let candidatePreserved = false;

  if (wtHead) {
    candidateHead = wtHead;
    candidateClean = wtClean;
    candidatePreserved = wtPreserved;
  } else {
    // Check candidate commit from options or card ci_evidence
    const requestedHead = options.candidate?.head || options.candidate_head || card?.data?.ci_evidence?.head || null;
    if (requestedHead && gitCommitExists(repoPath, requestedHead)) {
      candidateHead = requestedHead;
      const callerClaimClean = options.candidate?.clean !== false && options.candidate_clean !== false;
      const cardClean = card?.data?.ci_evidence?.clean === true || card?.data?.ci_evidence?.clean === undefined;
      candidateClean = callerClaimClean && cardClean;
      candidatePreserved = options.candidate?.preserved !== false && options.candidate_preserved !== false;
    }
  }

  let candidateRunId = options.candidate?.run_id || options.candidate_run_id || card?.data?.ci_evidence?.run_id || null;
  if (!candidateRunId && nonempty(taskId) && typeof repoPath === 'string') {
    try {
      const storeDir = deliveryStoreDirectory(repoPath);
      const storeRecord = createDeliveryStore(storeDir).read(taskId);
      candidateRunId = storeRecord?.execution?.run_id || storeRecord?.lease?.run_id ||
        storeRecord?.events?.slice().reverse().find(e => nonempty(e.run_id))?.run_id || null;
    } catch {}
  }

  const candidate = {
    head: candidateHead,
    clean: candidateClean,
    preserved: candidatePreserved,
    run_id: candidateRunId,
  };

  // 2. Checks fact resolution:
  // Must verify from real card.data.ci_evidence or execution supervisor records
  let checks = null;
  const ciEvidence = card?.data?.ci_evidence;
  const ciRemote = card?.data?.ci_remote;
  const ciClean = ciEvidence?.clean === true;
  const ciHead = ciEvidence?.head;
  const ciPassed = ciClean && sha(ciHead) && gitCommitExists(repoPath, ciHead) &&
    (!candidate.head || ciHead === candidate.head);
  const remotePassed = ciRemote?.state === 'passed' || ciRemote?.result === 'success';

  if (ciPassed || remotePassed) {
    const verifiedHead = candidate.head || ciHead;
    const ref = ciEvidence?.command || ciEvidence?.reference || (remotePassed ? (ciRemote.reference || 'ci-remote-pass') : `ci-pass:${verifiedHead.slice(0, 12)}`);
    checks = {
      passed: true,
      head: verifiedHead,
      policy_revision: policyRev,
      reference: ref,
    };
  }

  // 3. Review fact resolution:
  // Must verify from real review records (card.data.verification last_verdict === 'pass')
  let review = null;
  const ver = card?.data?.verification;
  const reviewApproved = ver?.last_verdict === 'pass' || card?.data?.review_approval?.approved === true;
  if (reviewApproved && candidate.head) {
    const reviewer = card?.data?.verification?.reviewer || task?.ownership?.reviewer || card?.ownership?.reviewer || 'agent-role:todomd-reviewer';
    const reviewRunId = ver?.run_id || card?.data?.review_run_id ||
      (candidate.run_id ? `${candidate.run_id}-review` : 'run-review-1');
    const reviewRef = ver?.reference || card?.data?.review_reference || 'verify-verdict:pass';
    review = {
      passed: true,
      head: candidate.head,
      reviewer,
      run_id: reviewRunId,
      policy_revision: policyRev,
      reference: reviewRef,
    };
  }

  // 4. Integration fact resolution:
  // Must verify candidate commit ancestry via git merge-base --is-ancestor
  let integration = null;
  const candidateSha = candidate.head || (options.integration?.candidate_head && gitCommitExists(repoPath, options.integration.candidate_head) ? options.integration.candidate_head : null);
  if (candidateSha) {
    const mergedHead = options.integration?.merged_head;
    if (mergedHead) {
      if (
        sha(mergedHead) &&
        gitCommitExists(repoPath, mergedHead) &&
        gitIsAncestor(repoPath, candidateSha, mergedHead) &&
        gitIsAncestor(repoPath, mergedHead, targetBranch)
      ) {
        integration = {
          confirmed: true,
          candidate_head: candidateSha,
          merged_head: mergedHead,
          target_branch: targetBranch,
          reference: options.integration?.reference || `git:ancestor:${mergedHead.slice(0, 12)}`,
        };
      }
    } else {
      if (gitIsAncestor(repoPath, candidateSha, targetBranch)) {
        const resolvedMergedHead = gitExec(repoPath, ['rev-parse', targetBranch]);
        if (sha(resolvedMergedHead)) {
          integration = {
            confirmed: true,
            candidate_head: candidateSha,
            merged_head: resolvedMergedHead,
            target_branch: targetBranch,
            reference: options.integration?.reference || `git:ancestor:${resolvedMergedHead.slice(0, 12)}`,
          };
        }
      }
    }
  }

  // 5. Release fact resolution:
  // Query authoritative release records for this task and target environment.
  // Backdoors (options.release) are strictly rejected; evidence comes from listReleases.
  const allReleases = listReleases(repoPath);
  const targetMergedHead = integration?.merged_head || options.integration?.merged_head;
  const matchingRelease = allReleases.find(r =>
    r.tasks.includes(taskId) &&
    r.environment === targetEnv &&
    r.deployment?.deployed === true &&
    r.deployment?.result === 'success' &&
    (!targetMergedHead || r.deployed_commit === targetMergedHead)
  );

  let releaseFact = null;
  if (matchingRelease) {
    releaseFact = {
      deployed: matchingRelease.deployment?.deployed === true && matchingRelease.deployment?.result === 'success',
      verified: matchingRelease.verification?.verified === true,
      rolled_back: matchingRelease.rollback?.rolled_back === true,
      merged_head: matchingRelease.deployed_commit,
      environment: matchingRelease.environment,
      reference: matchingRelease.verification?.reference || matchingRelease.deployment?.reference,
    };
  }

  // 6. Acceptance fact resolution
  let acceptanceFact = null;
  if (card?.data?.acceptance?.accepted === true && nonempty(card.data.acceptance.reference)) {
    acceptanceFact = { accepted: true, reference: card.data.acceptance.reference };
  }

  return {
    candidate,
    policy_revision: policyRev,
    target_branch: targetBranch,
    checks,
    review,
    integration,
    release: releaseFact,
    acceptance: acceptanceFact,
  };
}
