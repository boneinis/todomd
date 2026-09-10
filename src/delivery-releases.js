import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isOwnerId } from './delivery.js';

const sha = v => typeof v === 'string' && /^[a-f0-9]{40}([a-f0-9]{24})?$/.test(v);
const nonempty = v => typeof v === 'string' && v.trim().length > 0;
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);

export function releasesDirectory(repoPath) {
  return path.join(path.resolve(repoPath), '.todomd', 'releases');
}

export function validateReleaseRecord(record) {
  const issues = [];
  const issue = (path, code, message) => issues.push({ path, code, message });
  if (!object(record)) return { ok: false, issues: [{ path: '', code: 'invalid_record', message: 'Record must be an object.' }] };
  if (record.schema_version !== 2) issue('schema_version', 'unsupported_version', 'schema_version must be 2.');
  if (!nonempty(record.release_id)) issue('release_id', 'required', 'release_id must be a nonempty string.');
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
  const dir = releasesDirectory(repoPath);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  const entries = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
  const results = [];
  for (const file of entries) {
    try {
      const content = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      const validation = validateReleaseRecord(content);
      if (validation.ok) results.push(content);
    } catch {}
  }
  return results;
}

export function readRelease(repoPath, releaseId) {
  if (!nonempty(releaseId)) return null;
  const file = path.join(releasesDirectory(repoPath), `${releaseId}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    const content = JSON.parse(fs.readFileSync(file, 'utf8'));
    return validateReleaseRecord(content).ok ? content : null;
  } catch {
    return null;
  }
}

export function recordRelease(repoPath, releaseRecord) {
  const validation = validateReleaseRecord(releaseRecord);
  if (!validation.ok) {
    const error = new Error(`Invalid release record: ${validation.issues.map(i => i.message).join('; ')}`);
    error.issues = validation.issues;
    throw error;
  }
  const dir = releasesDirectory(repoPath);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${releaseRecord.release_id}.json`);
  const tmp = `${file}.${createHash('sha256').update(String(Date.now())).digest('hex').slice(0, 8)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(releaseRecord, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
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

// Resolves candidate, CI checks, independent review, PR integration, and release facts for a task
export function resolveTaskEvidence(repoPath, task, options = {}) {
  const taskId = typeof task === 'string' ? task : task.id;
  const targetEnv = task?.delivery?.target_environment || options.target_environment || 'production';
  const targetBranch = options.target_branch || 'main';
  const policyRev = options.policy_revision || '1';

  const candidate = options.candidate || {
    head: options.candidate_head || null,
    clean: options.candidate_clean !== false,
    preserved: options.candidate_preserved !== false,
    run_id: options.candidate_run_id || null,
  };

  const checks = options.checks || null;
  const review = options.review || null;
  const integration = options.integration || null;

  // Find release record for this task and target environment
  const allReleases = listReleases(repoPath);
  const matchingRelease = allReleases.find(r =>
    r.tasks.includes(taskId) &&
    r.environment === targetEnv &&
    r.deployment?.deployed === true &&
    r.deployment?.result === 'success' &&
    (!integration || r.deployed_commit === integration.merged_head)
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
  } else if (options.release) {
    releaseFact = options.release;
  }

  return {
    candidate,
    policy_revision: policyRev,
    target_branch: targetBranch,
    checks,
    review,
    integration,
    release: releaseFact,
    acceptance: options.acceptance || null,
  };
}
