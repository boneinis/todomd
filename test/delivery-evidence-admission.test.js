import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isolateHome, makeRepo, writeCard, tmp } from './helpers.js';
import { resolveTaskEvidence, recordRelease, listReleases } from '../src/delivery-releases.js';
import { makeServerDeliveryResolvers, makeApprovedJobs } from '../src/server.js';
import { createDeliveryStore } from '../src/delivery-store.js';
import { createDeliverySession } from '../src/delivery-session.js';
import { createDeliveryAccess } from '../src/delivery-access.js';
import { deliveryStoreDirectory } from '../src/delivery-paths.js';
import { readCard, patchFrontmatter } from '../src/board.js';

function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function getBaseBranch(repo) {
  try {
    return git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  } catch {
    return 'main';
  }
}

test('candidate evidence: resolves worktree HEAD and detects clean vs dirty status', () => {
  isolateHome();
  const repo = makeRepo();
  const base = getBaseBranch(repo);
  const wtDir = path.join(repo, '.todomd/worktrees/task-wt-01');
  git(repo, ['worktree', 'add', '-b', 'task-wt-01-branch', wtDir]);

  // Make a commit in the worktree
  fs.writeFileSync(path.join(wtDir, 'feature.txt'), 'feature code\n');
  git(wtDir, ['add', '-A']);
  git(wtDir, ['commit', '-m', 'feat: initial worktree commit']);
  const headCommit = git(wtDir, ['rev-parse', 'HEAD']);

  // When worktree is clean
  const cleanFacts = resolveTaskEvidence(repo, 'task-wt-01');
  assert.equal(cleanFacts.candidate.head, headCommit);
  assert.equal(cleanFacts.candidate.clean, true);
  assert.equal(cleanFacts.candidate.preserved, true);

  // When worktree has uncommitted changes
  fs.writeFileSync(path.join(wtDir, 'feature.txt'), 'dirty uncommitted change\n');
  const dirtyFacts = resolveTaskEvidence(repo, 'task-wt-01');
  assert.equal(dirtyFacts.candidate.head, headCommit);
  assert.equal(dirtyFacts.candidate.clean, false);
});

test('candidate evidence: rejects non-existent commits and accepts existing git commits', () => {
  isolateHome();
  const repo = makeRepo();
  const baseHead = git(repo, ['rev-parse', 'HEAD']);
  const nonExistentCommit = '00112233445566778899aabbccddeeff00112233';

  // Non-existent commit should be rejected
  const rejectedFacts = resolveTaskEvidence(repo, 'task-none', {
    candidate_head: nonExistentCommit,
  });
  assert.equal(rejectedFacts.candidate.head, null);
  assert.equal(rejectedFacts.candidate.clean, false);

  // Existing git commit should be accepted
  const acceptedFacts = resolveTaskEvidence(repo, 'task-real', {
    candidate_head: baseHead,
  });
  assert.equal(acceptedFacts.candidate.head, baseHead);
  assert.equal(acceptedFacts.candidate.clean, true);
});

test('checks evidence: resolves real card ci_evidence and rejects unverified caller claims', () => {
  isolateHome();
  const repo = makeRepo();
  const baseHead = git(repo, ['rev-parse', 'HEAD']);

  // 1. Card with real clean CI evidence matching commit
  writeCard(repo, 'task-ci-pass', {
    status: 'Verify',
    extra: `ci_evidence:\n  head: ${baseHead}\n  clean: true\n  command: npm test\n`,
  });
  const cardWithCi = readCard(repo, 'task-ci-pass');
  const passedFacts = resolveTaskEvidence(repo, cardWithCi, { candidate_head: baseHead });
  assert.ok(passedFacts.checks);
  assert.equal(passedFacts.checks.passed, true);
  assert.equal(passedFacts.checks.head, baseHead);
  assert.equal(passedFacts.checks.reference, 'npm test');

  // 2. Card with dirty CI evidence
  writeCard(repo, 'task-ci-dirty', {
    status: 'Verify',
    extra: `ci_evidence:\n  head: ${baseHead}\n  clean: false\n  command: npm test\n`,
  });
  const cardWithDirtyCi = readCard(repo, 'task-ci-dirty');
  const dirtyFacts = resolveTaskEvidence(repo, cardWithDirtyCi, { candidate_head: baseHead });
  assert.equal(dirtyFacts.checks, null);

  // 3. Fabricated caller claim without card CI evidence
  writeCard(repo, 'task-ci-none', { status: 'Build' });
  const cardNoCi = readCard(repo, 'task-ci-none');
  const fakeFacts = resolveTaskEvidence(repo, cardNoCi, {
    candidate_head: baseHead,
    checks: { passed: true, head: baseHead, reference: 'fabricated-proof' },
  });
  assert.equal(fakeFacts.checks, null);
});

test('review evidence: resolves real card verification pass and rejects unverified caller claims', async () => {
  isolateHome();
  const repo = makeRepo();
  const baseHead = git(repo, ['rev-parse', 'HEAD']);

  // 1. Card with real passed verification
  writeCard(repo, 'task-rev-pass', { status: 'Verify' });
  await patchFrontmatter(repo, 'task-rev-pass', {
    verification: { attempts: 1, max_attempts: 3, last_verdict: 'pass', reviewer: 'agent-role:todomd-reviewer' },
  });
  const cardPassed = readCard(repo, 'task-rev-pass');
  const factsPassed = resolveTaskEvidence(repo, cardPassed, {
    candidate_head: baseHead,
    candidate_run_id: 'run-impl-1',
  });
  assert.ok(factsPassed.review);
  assert.equal(factsPassed.review.passed, true);
  assert.equal(factsPassed.review.head, baseHead);
  assert.notEqual(factsPassed.review.run_id, 'run-impl-1');

  // 2. Fabricated claim: card has no pass verdict, caller claims review: { passed: true }
  writeCard(repo, 'task-rev-fail', { status: 'Verify' });
  await patchFrontmatter(repo, 'task-rev-fail', {
    verification: { attempts: 1, max_attempts: 3, last_verdict: 'fail' },
  });
  const cardFailed = readCard(repo, 'task-rev-fail');
  const fakeReviewFacts = resolveTaskEvidence(repo, cardFailed, {
    candidate_head: baseHead,
    review: { passed: true, head: baseHead, reference: 'trust-me-bro' },
  });
  assert.equal(fakeReviewFacts.review, null);
});

test('integration evidence: checks git merge-base --is-ancestor ancestry and rejects unmerged commits', () => {
  isolateHome();
  const repo = makeRepo();
  const base = getBaseBranch(repo);
  const baseHead = git(repo, ['rev-parse', 'HEAD']);

  // 1. Base commit IS an ancestor of base branch
  const mergedFacts = resolveTaskEvidence(repo, 'task-anc', {
    candidate_head: baseHead,
    target_branch: base,
  });
  assert.ok(mergedFacts.integration);
  assert.equal(mergedFacts.integration.confirmed, true);
  assert.equal(mergedFacts.integration.candidate_head, baseHead);
  assert.equal(mergedFacts.integration.merged_head, baseHead);

  // 2. Unmerged branch commit is NOT an ancestor of target branch
  git(repo, ['checkout', '-b', 'unmerged-branch']);
  fs.writeFileSync(path.join(repo, 'unmerged.txt'), 'not on main\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', 'feat: unmerged commit']);
  const unmergedHead = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['checkout', base]);

  const unmergedFacts = resolveTaskEvidence(repo, 'task-anc', {
    candidate_head: unmergedHead,
    target_branch: base,
  });
  assert.equal(unmergedFacts.integration, null);

  // 3. Fabricated claim with fake commit SHA is rejected
  const fakeIntegrationFacts = resolveTaskEvidence(repo, 'task-anc', {
    candidate_head: baseHead,
    target_branch: base,
    integration: {
      confirmed: true,
      merged_head: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      target_branch: base,
    },
  });
  assert.equal(fakeIntegrationFacts.integration, null);
});

test('release evidence: strictly reads from recorded releases and rejects options.release backdoor', () => {
  isolateHome();
  const repo = makeRepo();
  const base = getBaseBranch(repo);
  const baseHead = git(repo, ['rev-parse', 'HEAD']);

  const releaseRecord = {
    schema_version: 2,
    release_id: 'rel-real-001',
    environment: 'production',
    tasks: ['task-release-target'],
    deployed_commit: baseHead,
    target_branch: base,
    approval: { approver: 'human:project-owner', approved_at: new Date().toISOString() },
    deployment: { deployed: true, result: 'success', reference: 'dep-ref-1' },
    verification: { verified: true, reference: 'ver-ref-1' },
  };
  recordRelease(repo, releaseRecord);

  // Matching task gets authoritative release fact
  const facts = resolveTaskEvidence(repo, 'task-release-target', {
    candidate_head: baseHead,
    target_environment: 'production',
  });
  assert.ok(facts.release);
  assert.equal(facts.release.deployed, true);
  assert.equal(facts.release.verified, true);
  assert.equal(facts.release.merged_head, baseHead);

  // Task without release cannot use options.release backdoor
  const backdoorFacts = resolveTaskEvidence(repo, 'task-unreleased', {
    candidate_head: baseHead,
    release: { deployed: true, verified: true, merged_head: baseHead },
  });
  assert.equal(backdoorFacts.release, null);
});

test('makeServerDeliveryResolvers & WIP limit: strictly rejects admission when 2 tasks are active', () => {
  isolateHome();
  const repo = makeRepo();

  // Create 2 active implementation tasks (e.g. Build and CI)
  writeCard(repo, 'task-wip-1', { status: 'Build' });
  writeCard(repo, 'task-wip-2', { status: 'CI' });
  writeCard(repo, 'task-wip-new', { status: 'Planned' });

  const resolvers = makeServerDeliveryResolvers(repo);
  assert.equal(typeof resolvers.resolveWorkflow, 'function');
  assert.equal(typeof resolvers.resolveAdmission, 'function');

  // Admitting a new task when 2 tasks are active must be rejected
  const rejectedAdmission = resolvers.resolveAdmission('task-wip-new');
  assert.equal(rejectedAdmission.admitted, false);
  assert.equal(rejectedAdmission.currentWip >= 2, true);
  assert.equal(rejectedAdmission.job_approved, false);
  assert.match(rejectedAdmission.reason, /WIP/i);

  // Resolve one task by moving to Done
  writeCard(repo, 'task-wip-2', { status: 'Done' });
  const admittedAdmission = resolvers.resolveAdmission('task-wip-new');
  assert.equal(admittedAdmission.admitted, true);
  assert.equal(admittedAdmission.currentWip, 1);
  assert.equal(admittedAdmission.maxWip, 2);
  assert.equal(admittedAdmission.job_approved, true);
  assert.equal(admittedAdmission.writers_fenced, true);
  assert.equal(admittedAdmission.busy, false);
});

test('makeApprovedJobs: provides valid local_process_group job definitions pointing to real binaries', () => {
  isolateHome();
  const repo = makeRepo();
  const jobs = makeApprovedJobs(repo);

  assert.ok(jobs.build);
  assert.ok(jobs.verify);
  assert.equal(jobs.build.containment, 'local_process_group');
  assert.equal(jobs.verify.containment, 'local_process_group');
  assert.equal(jobs.build.command, process.execPath);
  assert.ok(fs.existsSync(jobs.build.command));
  assert.ok(fs.existsSync(jobs.build.args[0])); // bin/todomd.js
});
