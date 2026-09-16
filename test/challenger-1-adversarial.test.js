import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isolateHome, makeRepo, writeCard } from './helpers.js';
import { seedDelivery } from './delivery-fixture.js';
import { resolveTaskEvidence, recordRelease } from '../src/delivery-releases.js';
import { makeServerDeliveryResolvers, makeApprovedJobs } from '../src/server.js';
import { createDeliverySession } from '../src/delivery-session.js';
import { createDeliveryAccess } from '../src/delivery-access.js';
import { checkWipLimit } from '../src/cycles.js';

function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// ============================================================================
// OBJECTIVE 1: Adversarially stress-test resolveTaskEvidence
// ============================================================================

test('CHALLENGE 1.1: Fabricated / non-existent candidate commit SHA is rejected', () => {
  isolateHome();
  const repo = makeRepo();
  const fakeSha = '0123456789abcdef0123456789abcdef01234567';

  const facts = resolveTaskEvidence(repo, 'T-fake-1', {
    candidate_head: fakeSha,
    candidate: { head: fakeSha, clean: true },
  });

  assert.equal(facts.candidate.head, null, 'Non-existent commit SHA must never be accepted as candidate.head');
  assert.equal(facts.candidate.clean, false);
});

test('CHALLENGE 1.2: Git tree / blob object SHA passed as candidate commit is rejected', () => {
  isolateHome();
  const repo = makeRepo();
  const treeSha = git(repo, ['rev-parse', 'HEAD^{tree}']);
  assert.ok(treeSha);

  const facts = resolveTaskEvidence(repo, 'T-tree-1', {
    candidate_head: treeSha,
  });

  assert.equal(facts.candidate.head, null, 'Git tree object must not be accepted as candidate commit');
});

test('CHALLENGE 1.3: Unbacked checks options are rejected (options.checks ignored)', () => {
  isolateHome();
  const repo = makeRepo();
  const headSha = git(repo, ['rev-parse', 'HEAD']);

  writeCard(repo, 'T-checks-1', { status: 'Build' });
  const facts = resolveTaskEvidence(repo, 'T-checks-1', {
    candidate_head: headSha,
    checks: { passed: true, head: headSha, reference: 'spoofed-ci' },
  });

  assert.equal(facts.checks, null, 'options.checks must be ignored without backing card.data.ci_evidence');
});

test('CHALLENGE 1.4: Card with ci_evidence where clean is false must NOT pass checks', () => {
  isolateHome();
  const repo = makeRepo();
  const headSha = git(repo, ['rev-parse', 'HEAD']);

  const card = {
    id: 'T-dirty-1',
    data: {
      ci_evidence: { head: headSha, clean: false, command: 'npm test' }
    }
  };

  const facts = resolveTaskEvidence(repo, card, { candidate_head: headSha });
  assert.equal(facts.checks, null, 'Checks must NOT pass when ci_evidence.clean is false');
});

test('CHALLENGE 1.5: Unbacked review options are rejected (options.review ignored)', () => {
  isolateHome();
  const repo = makeRepo();
  const headSha = git(repo, ['rev-parse', 'HEAD']);

  writeCard(repo, 'T-rev-1', { status: 'Verify' });
  const facts = resolveTaskEvidence(repo, 'T-rev-1', {
    candidate_head: headSha,
    review: { passed: true, reviewer: 'human:spoofed', run_id: 'run-99' },
  });

  assert.equal(facts.review, null, 'options.review must be ignored without backing verification in card');
});

test('CHALLENGE 1.6: Passing unmerged / non-ancestor commit via options.integration is rejected', () => {
  isolateHome();
  const repo = makeRepo();
  const base = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']) || 'main';

  // Create an unmerged feature branch with a commit not reachable from base
  git(repo, ['checkout', '-b', 'unmerged-feature']);
  fs.writeFileSync(path.join(repo, 'unmerged.txt'), 'secret unmerged code\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', 'feat: unmerged commit']);
  const unmergedSha = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['checkout', base]);

  // Verify that unmergedSha is NOT an ancestor of base
  let isAncestor = true;
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', unmergedSha, base], { cwd: repo, stdio: 'ignore' });
  } catch {
    isAncestor = false;
  }
  assert.equal(isAncestor, false, 'Precondition: unmerged commit must not be reachable from target branch');

  // Attack: Supply options.integration with merged_head set to unmergedSha
  const facts = resolveTaskEvidence(repo, 'T-unmerged-1', {
    candidate_head: unmergedSha,
    target_branch: base,
    integration: {
      candidate_head: unmergedSha,
      merged_head: unmergedSha,
      reference: 'exploit:self-ancestor',
    },
  });

  // REMEDIATED:
  // facts.integration must be null because unmergedSha is NOT an ancestor of target_branch!
  assert.equal(facts.integration, null, 'Unmerged commit must not be confirmed as integrated');

  // Also verify that when candidateSha and mergedHead ARE valid ancestors of targetBranch, integration succeeds:
  const baseHead = git(repo, ['rev-parse', 'HEAD']);
  const validFacts = resolveTaskEvidence(repo, 'T-valid-1', {
    candidate_head: baseHead,
    target_branch: base,
    integration: {
      candidate_head: baseHead,
      merged_head: baseHead,
      reference: 'git:ancestor:valid',
    },
  });
  assert.ok(validFacts.integration);
  assert.equal(validFacts.integration.confirmed, true);
  assert.equal(validFacts.integration.candidate_head, baseHead);
  assert.equal(validFacts.integration.merged_head, baseHead);
});

test('CHALLENGE 1.7: Release fact ignores options.release backdoor', () => {
  isolateHome();
  const repo = makeRepo();
  const headSha = git(repo, ['rev-parse', 'HEAD']);

  const facts = resolveTaskEvidence(repo, 'T-unrel-1', {
    candidate_head: headSha,
    release: { deployed: true, verified: true, merged_head: headSha },
  });

  assert.equal(facts.release, null, 'Backdoor options.release must be ignored');
});

test('CHALLENGE 1.8: Unbacked options.acceptance is rejected (acceptance comes only from card)', () => {
  isolateHome();
  const repo = makeRepo();
  const facts = resolveTaskEvidence(repo, 'T-acc-1', {
    acceptance: { accepted: true, reference: 'spoofed-acceptance' }
  });
  assert.equal(facts.acceptance, null, 'Unbacked options.acceptance must be rejected');

  // Backing card acceptance works
  const cardWithAcceptance = {
    id: 'T-acc-card',
    data: {
      acceptance: { accepted: true, reference: 'card-acceptance-ref' },
    },
  };
  const cardFacts = resolveTaskEvidence(repo, cardWithAcceptance);
  assert.deepEqual(cardFacts.acceptance, { accepted: true, reference: 'card-acceptance-ref' });
});

// ============================================================================
// OBJECTIVE 2: Adversarially stress-test 2-task WIP limit admission gate
// ============================================================================

test('CHALLENGE 2.1: Boundary condition 0 active tasks allows admission', () => {
  isolateHome();
  const repo = makeRepo();
  writeCard(repo, 'T-new-1', { status: 'Planned' });

  const resolvers = makeServerDeliveryResolvers(repo);
  const admission = resolvers.resolveAdmission('T-new-1');

  assert.equal(admission.admitted, true);
  assert.equal(admission.currentWip, 0);
  assert.equal(admission.maxWip, 2);
  assert.equal(admission.job_approved, true);
});

test('CHALLENGE 2.2: Boundary condition 1 active task allows admission of 2nd task', () => {
  isolateHome();
  const repo = makeRepo();
  writeCard(repo, 'T-active-1', { status: 'Build' });
  writeCard(repo, 'T-new-2', { status: 'Planned' });

  const resolvers = makeServerDeliveryResolvers(repo);
  const admission = resolvers.resolveAdmission('T-new-2');

  assert.equal(admission.admitted, true);
  assert.equal(admission.currentWip, 1);
  assert.equal(admission.maxWip, 2);
  assert.equal(admission.job_approved, true);
});

test('CHALLENGE 2.3a: Boundary condition 2 active tasks (both in Build) REJECTS 3rd task', () => {
  isolateHome();
  const repo = makeRepo();
  writeCard(repo, 'T-active-1', { status: 'Build' });
  writeCard(repo, 'T-active-2', { status: 'Build' });
  writeCard(repo, 'T-candidate-3', { status: 'Planned' });

  const resolvers = makeServerDeliveryResolvers(repo);
  const admission = resolvers.resolveAdmission('T-candidate-3');

  assert.equal(admission.admitted, false);
  assert.equal(admission.currentWip, 2);
  assert.equal(admission.maxWip, 2);
  assert.equal(admission.job_approved, false);
  assert.match(admission.reason, /WIP/i);
});

test('CHALLENGE 2.3b: 2 active tasks (1 Build, 1 CI/Verify) REJECTS 3rd task', () => {
  isolateHome();
  const repo = makeRepo();
  writeCard(repo, 'T-active-1', { status: 'Build' });
  writeCard(repo, 'T-active-2', { status: 'Verify' });
  writeCard(repo, 'T-candidate-3', { status: 'Planned' });

  const resolvers = makeServerDeliveryResolvers(repo);
  const admission = resolvers.resolveAdmission('T-candidate-3');

  assert.equal(admission.admitted, false);
  assert.equal(admission.currentWip, 2);
  assert.equal(admission.job_approved, false);
});

test('CHALLENGE 2.3c: 2 active tasks in private delivery store (in_progress) REJECTS 3rd task even if card frontmatter says Planned', () => {
  isolateHome();
  const repo = makeRepo();
  writeCard(repo, 'T-store-1', { status: 'Planned' });
  writeCard(repo, 'T-store-2', { status: 'Planned' });
  writeCard(repo, 'T-candidate-3', { status: 'Planned' });

  // Seed T-store-1 and T-store-2 as leased (in_progress) in delivery store
  seedDelivery(repo, 'T-store-1', { leased: true });
  seedDelivery(repo, 'T-store-2', { leased: true });

  // Now test admission of T-candidate-3:
  const resolvers = makeServerDeliveryResolvers(repo);
  const admission = resolvers.resolveAdmission('T-candidate-3');

  assert.equal(admission.admitted, false, 'Delivery store active records must be counted by getEnrichedCardsForWip');
  assert.equal(admission.currentWip, 2);
  assert.equal(admission.job_approved, false);
  assert.match(admission.reason, /WIP capacity limit reached/);
});

test('CHALLENGE 2.4: Exactly 2 tasks active, candidate task IS one of the 2 -> renewal / re-admission succeeds', () => {
  isolateHome();
  const repo = makeRepo();
  writeCard(repo, 'T-active-1', { status: 'Build' });
  writeCard(repo, 'T-active-2', { status: 'Build' });

  const resolvers = makeServerDeliveryResolvers(repo);
  // Candidate is T-active-1 itself
  const admission = resolvers.resolveAdmission('T-active-1');

  assert.equal(admission.admitted, true, 'Active task re-evaluating itself must not count itself toward WIP');
  assert.equal(admission.currentWip, 1, 'Only the other active task counts toward WIP');
  assert.equal(admission.job_approved, true);
});

test('CHALLENGE 2.5: Blocked task counts toward WIP capacity (Build + Ready-Blocked rejects 3rd task)', () => {
  isolateHome();
  const repo = makeRepo();
  writeCard(repo, 'T-wip-1', { status: 'Build' });
  writeCard(repo, 'T-wip-2', {
    status: 'Planned',
    extra: 'delivery:\n  state: ready\n  completion_policy: completed\nblocker:\n  category: dependency\n  owner: human:lead\n  since: "2026-09-10T10:00:00Z"\n  evidence: test\n  next_action: test\n',
  });
  writeCard(repo, 'T-cand-3', { status: 'Planned' });

  const resolvers = makeServerDeliveryResolvers(repo);
  const admission = resolvers.resolveAdmission('T-cand-3');

  assert.equal(admission.admitted, false, 'Blocked work must count toward 2-task WIP limit');
  assert.equal(admission.currentWip, 2);
  assert.equal(admission.job_approved, false);
});

test('CHALLENGE 2.6: Caller passing spoofed ref / options cannot override maxWip limit in resolveAdmission', () => {
  isolateHome();
  const repo = makeRepo();
  writeCard(repo, 'T-act-1', { status: 'Build' });
  writeCard(repo, 'T-act-2', { status: 'Build' });
  writeCard(repo, 'T-cand-3', { status: 'Planned' });

  const resolvers = makeServerDeliveryResolvers(repo);
  // Try to spoof options / limit in ref
  const admission = resolvers.resolveAdmission('T-cand-3', {
    limit: 100,
    maxWip: 100,
    override: true,
  });

  assert.equal(admission.admitted, false, 'Spoofed ref must not override strict limit of 2');
  assert.equal(admission.maxWip, 2);
});
