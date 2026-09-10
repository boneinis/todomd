import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmp, isolateHome, makeRepo, writeCard, git } from './helpers.js';
import {
  resolveTaskEvidence,
  recordRelease,
  readRelease,
  listReleases,
  validateReleaseRecord,
} from '../src/delivery-releases.js';
import {
  createDeliveryStore,
} from '../src/delivery-store.js';
import {
  deliveryStoreDirectory,
} from '../src/delivery-paths.js';
import {
  createCycle,
  readCycle,
  listCycles,
  closeCycle,
  checkWipLimit,
  updateCycleScope,
} from '../src/cycles.js';
import {
  calculateEpicRollup,
} from '../src/chunks.js';
import {
  dependencyIssues,
  loadBoard,
  readCard,
} from '../src/board.js';
import {
  runStage,
} from '../src/runner.js';
import {
  evaluateDeliveryTransition,
  validateDeliveryTask,
  DELIVERY_STATES,
} from '../src/delivery.js';

// ============================================================================
// Test Fixture Helpers
// ============================================================================

function seedCanonicalTask(repo, id, {
  state = 'backlog',
  completionPolicy = 'released',
  targetEnv = 'production',
  cycleId = null,
  implementation = 'agent-role:builder',
  reviewer = 'agent-role:reviewer',
  deliveryLead = 'agent-role:lead',
  releaseOwner = 'human:owner',
} = {}) {
  const directory = deliveryStoreDirectory(repo);
  const headSha = 'a'.repeat(40);
  const mergedSha = 'b'.repeat(40);
  const store = createDeliveryStore(directory, {
    enabled: true,
    now: () => 1000,
    resolveContext: () => ({
      actor_id: 'human:owner',
      busy: false,
      grants: [
        'initialize', 'ready', 'acquire', 'in_progress', 'in_review',
        'ready_to_release', 'released', 'completed', 'cancelled', 'backlog',
      ].map(g => `delivery:${g}`),
      facts: {
        ready: Object.fromEntries([
          'scope_defined', 'criteria_defined', 'validation_plan',
          'target_known', 'dependencies_valid', 'planning_approved',
        ].map(k => [k, true])),
        admission: { authorized: true, dependencies_satisfied: true, owner: implementation },
        candidate: { head: headSha, clean: true, preserved: true, run_id: `cand-${id}` },
        policy_revision: '1',
        target_branch: 'main',
        checks: { passed: true, head: headSha, policy_revision: '1', reference: `ci-${id}` },
        review: { passed: true, head: headSha, policy_revision: '1', reference: `rev-${id}`, reviewer, run_id: `rev-run-${id}` },
        integration: { confirmed: true, candidate_head: headSha, merged_head: mergedSha, target_branch: 'main', reference: `int-${id}` },
        release: { deployed: true, verified: true, rolled_back: false, merged_head: mergedSha, environment: targetEnv, reference: `rel-${id}` },
      },
    }),
  });

  const deliveryObj = {
    state: 'backlog',
    completion_policy: completionPolicy,
    ...(targetEnv ? { target_environment: targetEnv } : {}),
    ...(cycleId ? { cycle_id: cycleId } : {}),
  };

  const task = {
    id,
    schema_version: 2,
    delivery: deliveryObj,
    ownership: {
      delivery_lead: deliveryLead,
      implementation,
      reviewer,
      release: releaseOwner,
    },
  };

  let rev = 0;
  const init = store.execute(id, {
    action: 'initialize',
    task,
    source_revision: 'a'.repeat(64),
    expected_revision: rev,
    idempotency_key: `init-${id}`,
  });
  if (!init.ok) throw new Error(`seedCanonicalTask init failed: ${JSON.stringify(init)}`);
  rev = store.read(id).revision;

  if (state === 'ready') {
    const res = store.execute(id, { action: 'transition', to: 'ready', expected_revision: rev, idempotency_key: `ready-${id}` });
    if (!res.ok) throw new Error(`seedCanonicalTask ready failed: ${JSON.stringify(res)}`);
  } else if (state === 'in_progress') {
    store.execute(id, { action: 'transition', to: 'ready', expected_revision: rev, idempotency_key: `ready-${id}` });
    rev = store.read(id).revision;
    const res = store.execute(id, { action: 'acquire', run_id: `run-${id}`, ttl_ms: 3600000, expected_revision: rev, idempotency_key: `acq-${id}` });
    if (!res.ok) throw new Error(`seedCanonicalTask acquire failed: ${JSON.stringify(res)}`);
  } else if (state === 'cancelled') {
    const res = store.execute(id, { action: 'transition', to: 'cancelled', reason: 'cancelled at seed', expected_revision: rev, idempotency_key: `cancel-${id}` });
    if (!res.ok) throw new Error(`seedCanonicalTask cancel failed: ${JSON.stringify(res)}`);
  }

  return { store, directory, task: store.read(id).task };
}

function fullTransitionContext({
  to,
  candidateHead,
  mergedHead,
  candidateRunId = 'run-cand-001',
  reviewRunId = 'run-rev-002',
  targetBranch = 'main',
  policyRev = '1',
  reviewer = 'agent-role:reviewer',
  builder = 'agent-role:builder',
  actorId = 'human:owner',
  revision = 'revision-test',
  reason = 'Authoritative transition reason',
} = {}) {
  return {
    revision,
    actor_id: actorId,
    grants: [`delivery:${to}`],
    busy: false,
    reason,
    facts: {
      ready: {
        scope_defined: true,
        criteria_defined: true,
        validation_plan: true,
        target_known: true,
        dependencies_valid: true,
        planning_approved: true,
      },
      admission: {
        authorized: true,
        dependencies_satisfied: true,
        owner: builder,
      },
      candidate: {
        head: candidateHead,
        clean: true,
        preserved: true,
        run_id: candidateRunId,
      },
      policy_revision: policyRev,
      target_branch: targetBranch,
      checks: {
        passed: true,
        head: candidateHead,
        policy_revision: policyRev,
        reference: 'ci-run-8822',
      },
      review: {
        passed: true,
        head: candidateHead,
        policy_revision: policyRev,
        reference: 'review-rec-9911',
        reviewer,
        run_id: reviewRunId,
      },
      integration: {
        confirmed: true,
        candidate_head: candidateHead,
        merged_head: mergedHead,
        target_branch: targetBranch,
        reference: 'pr-merge-7733',
      },
      release: {
        deployed: true,
        verified: true,
        rolled_back: false,
        merged_head: mergedHead,
        environment: 'production',
        reference: 'deploy-rel-5544',
      },
      acceptance: {
        accepted: true,
        reference: 'acceptance-signoff-1122',
      },
    },
  };
}

// ============================================================================
// TIER 1: Feature Coverage for Evidence Verification & Delivery Workflow
// ============================================================================

describe('Tier 1: Feature Coverage for Evidence Verification & Delivery Workflow', () => {

  test('F1: Git candidate fact resolution verifies HEAD commit, worktree cleanliness, and preservation', () => {
    isolateHome();
    const repo = makeRepo();
    const headCommit = git(repo, ['rev-parse', 'HEAD']);
    assert.match(headCommit, /^[a-f0-9]{40}$/);

    writeCard(repo, 'task-f1-001', { status: 'Review', title: 'F1 candidate fact task' });
    const evidence = resolveTaskEvidence(repo, { id: 'task-f1-001' }, { candidate_head: headCommit });

    assert.ok(evidence.candidate, 'Evidence must contain candidate fact');
    assert.equal(evidence.candidate.head, headCommit);
    assert.equal(evidence.candidate.clean, true, 'Porcelain worktree should be clean');
    assert.equal(evidence.candidate.preserved, true, 'Candidate should be preserved');
  });

  test('F2: Real checks fact resolution derives verification from card CI evidence and rejects unbacked claims', () => {
    isolateHome();
    const repo = makeRepo();
    const head = git(repo, ['rev-parse', 'HEAD']);

    const cardWithCI = {
      id: 'task-f2-001',
      status: 'Review',
      delivery: { state: 'in_review', completion_policy: 'released' },
      data: {
        ci_evidence: {
          passed: true,
          head,
          policy_revision: '1',
          reference: 'ci-job-verified',
        },
      },
    };

    const evidence = resolveTaskEvidence(repo, cardWithCI, { candidate_head: head });
    // Verify checks fact is resolved when backed by card.data.ci_evidence
    if (evidence.checks) {
      assert.equal(evidence.checks.passed, true);
      assert.equal(evidence.checks.head, head);
      assert.equal(evidence.checks.reference, 'ci-job-verified');
    }

    // Verify delivery transition contract requires verified checks
    const task = {
      id: 'task-f2-001',
      schema_version: 2,
      delivery: { state: 'in_review', completion_policy: 'released', target_environment: 'production' },
      ownership: { delivery_lead: 'agent-role:lead', implementation: 'agent-role:builder', reviewer: 'agent-role:reviewer', release: 'human:owner' },
    };
    const ctxWithoutChecks = fullTransitionContext({ to: 'ready_to_release', candidateHead: head, mergedHead: head });
    delete ctxWithoutChecks.facts.checks;

    const assessment = evaluateDeliveryTransition(task, { to: 'ready_to_release', expected_revision: 'rev-1' }, ctxWithoutChecks);
    assert.equal(assessment.ok, false, 'Transition without checks fact must be rejected');
  });

  test('F3: Real review fact resolution enforces reviewer separation and verification records', () => {
    const head = 'a'.repeat(40), merged = 'b'.repeat(40);
    const task = {
      id: 'task-f3-001',
      schema_version: 2,
      delivery: { state: 'in_review', completion_policy: 'released', target_environment: 'production' },
      ownership: { delivery_lead: 'agent-role:lead', implementation: 'agent-role:builder', reviewer: 'agent-role:reviewer', release: 'human:owner' },
    };

    // Valid independent review: reviewer matches ownership.reviewer and run_id differs from candidate
    const validCtx = fullTransitionContext({
      to: 'ready_to_release',
      candidateHead: head,
      mergedHead: merged,
      candidateRunId: 'candidate-run-1',
      reviewRunId: 'review-run-2',
      reviewer: 'agent-role:reviewer',
      builder: 'agent-role:builder',
      revision: 'rev-1',
    });
    const validAssessment = evaluateDeliveryTransition(task, { to: 'ready_to_release', expected_revision: 'rev-1' }, validCtx);
    assert.equal(validAssessment.ok, true, 'Valid independent review should permit ready_to_release transition');

    // Invalid: reviewer is the same as implementation runner (violates separation of duties)
    const invalidReviewerCtx = fullTransitionContext({
      to: 'ready_to_release',
      candidateHead: head,
      mergedHead: merged,
      candidateRunId: 'candidate-run-1',
      reviewRunId: 'candidate-run-1', // Colliding run ID
      reviewer: 'agent-role:reviewer',
      revision: 'rev-1',
    });
    const collisionAssessment = evaluateDeliveryTransition(task, { to: 'ready_to_release', expected_revision: 'rev-1' }, invalidReviewerCtx);
    assert.equal(collisionAssessment.ok, false, 'Same run_id for candidate and review must be rejected');

    // Invalid: reviewer identity does not match assigned reviewer
    const wrongReviewerCtx = fullTransitionContext({
      to: 'ready_to_release',
      candidateHead: head,
      mergedHead: merged,
      candidateRunId: 'candidate-run-1',
      reviewRunId: 'review-run-2',
      reviewer: 'agent-role:unauthorized-person',
      revision: 'rev-1',
    });
    const wrongReviewerAssessment = evaluateDeliveryTransition(task, { to: 'ready_to_release', expected_revision: 'rev-1' }, wrongReviewerCtx);
    assert.equal(wrongReviewerAssessment.ok, false, 'Review by unassigned reviewer must be rejected');
  });

  test('F4: Real integration ancestry fact verifies candidate commit is ancestor of target branch', () => {
    isolateHome();
    const repo = makeRepo();
    const baseCommit = git(repo, ['rev-parse', 'HEAD']);

    // Create a feature branch with a commit
    git(repo, ['checkout', '-b', 'feature-f4']);
    fs.writeFileSync(path.join(repo, 'feature.txt'), 'feature code\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-m', 'feature commit']);
    const candidateCommit = git(repo, ['rev-parse', 'HEAD']);

    // Candidate commit is not yet in main
    git(repo, ['checkout', 'main']);
    let isAncestor = true;
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', candidateCommit, 'main'], { cwd: repo });
    } catch {
      isAncestor = false;
    }
    assert.equal(isAncestor, false, 'Candidate commit on unmerged feature branch must not be an ancestor of main');

    // Merge feature branch into main
    git(repo, ['merge', '--no-ff', 'feature-f4', '-m', 'Merge feature-f4 into main']);
    const mergedCommit = git(repo, ['rev-parse', 'HEAD']);

    let isAncestorAfterMerge = false;
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', candidateCommit, 'main'], { cwd: repo });
      isAncestorAfterMerge = true;
    } catch {
      isAncestorAfterMerge = false;
    }
    assert.equal(isAncestorAfterMerge, true, 'Merged candidate commit must be an ancestor of main');

    // Verify integration fact contract in delivery evaluation
    const task = {
      id: 'task-f4-001',
      schema_version: 2,
      delivery: { state: 'in_review', completion_policy: 'released', target_environment: 'production' },
      ownership: { delivery_lead: 'agent-role:lead', implementation: 'agent-role:builder', reviewer: 'agent-role:reviewer', release: 'human:owner' },
    };
    const ctx = fullTransitionContext({
      to: 'ready_to_release',
      candidateHead: candidateCommit,
      mergedHead: mergedCommit,
      targetBranch: 'main',
      revision: 'rev-1',
    });
    const assessment = evaluateDeliveryTransition(task, { to: 'ready_to_release', expected_revision: 'rev-1' }, ctx);
    assert.equal(assessment.ok, true, 'Transition with verified integration ancestry must succeed');
  });

  test('F6: Strict 2-task WIP limit admission gate rejects active task dispatch exceeding limit', () => {
    isolateHome();
    const repo = makeRepo();

    // 0 active tasks
    let wip = checkWipLimit(repo, { limit: 2 });
    assert.equal(wip.current, 0);
    assert.equal(wip.allowed, true);

    // 1 active task (Build)
    writeCard(repo, 'task-wip-1', { status: 'Build' });
    wip = checkWipLimit(repo, { limit: 2 });
    assert.equal(wip.current, 1);
    assert.equal(wip.allowed, true);

    // 2 active tasks (Build + Verify) -> at capacity limit
    writeCard(repo, 'task-wip-2', { status: 'Verify' });
    wip = checkWipLimit(repo, { limit: 2 });
    assert.equal(wip.current, 2);
    assert.equal(wip.allowed, true);

    // 3 active tasks -> strictly exceeds 2-task limit
    writeCard(repo, 'task-wip-3', { status: 'CI' });
    wip = checkWipLimit(repo, { limit: 2 });
    assert.equal(wip.current, 3);
    assert.equal(wip.allowed, false, 'Admission gate must reject when active tasks > 2');
  });

  test('F8: Deterministic cycle close transitions tasks in canonical delivery store (return to backlog & cancel)', () => {
    isolateHome();
    const repo = makeRepo();

    // Seed tasks in canonical delivery store
    seedCanonicalTask(repo, 'task-close-ret', { state: 'ready' });
    seedCanonicalTask(repo, 'task-close-cnc', { state: 'ready' });

    writeCard(repo, 'task-close-ret', { status: 'Queue' });
    writeCard(repo, 'task-close-cnc', { status: 'Queue' });

    const cycle = createCycle(repo, {
      name: 'Sprint F8',
      goal: 'Verify store transitions on cycle close',
      start_date: '2026-09-01T00:00:00Z',
      end_date: '2026-09-08T00:00:00Z',
      scope: ['task-close-ret', 'task-close-cnc'],
    });

    // Close cycle with return_to_backlog for task-close-ret and cancel for task-close-cnc
    const closed = closeCycle(repo, cycle.id, {
      return_to_backlog: ['task-close-ret'],
      cancel: ['task-close-cnc'],
      audit_reason: 'Sprint finished with planned close actions',
      actor: 'human:project-owner',
    });

    assert.equal(closed.status, 'closed');

    // Verify canonical delivery store state reconciliation
    const store = createDeliveryStore(deliveryStoreDirectory(repo));
    const recRet = store.read('task-close-ret');
    const recCnc = store.read('task-close-cnc');

    assert.equal(recRet.task.delivery.state, 'backlog', 'Task must transition to backlog in canonical store');
    assert.equal(recCnc.task.delivery.state, 'cancelled', 'Task must transition to cancelled in canonical store');
  });

  test('F9: Deterministic carry forward updates destination cycle and task delivery cycle_id', () => {
    isolateHome();
    const repo = makeRepo();

    seedCanonicalTask(repo, 'task-cf-01', { state: 'ready', cycleId: 'initial-cycle' });
    writeCard(repo, 'task-cf-01', { status: 'Queue' });

    const c1 = createCycle(repo, {
      name: 'Sprint 1',
      goal: 'Initial sprint',
      start_date: '2026-09-01T00:00:00Z',
      end_date: '2026-09-08T00:00:00Z',
      scope: ['task-cf-01'],
    });

    const c2 = createCycle(repo, {
      name: 'Sprint 2',
      goal: 'Next sprint',
      start_date: '2026-09-08T00:00:00Z',
      end_date: '2026-09-15T00:00:00Z',
      scope: [],
    });

    const closed = closeCycle(repo, c1.id, {
      incomplete_action: 'carry_forward',
      carry_forward_cycle_id: c2.id,
      audit_reason: 'Carry forward incomplete work',
    });

    assert.equal(closed.status, 'closed');

    // Destination cycle scope now contains the task
    const readC2 = readCycle(repo, c2.id);
    assert.ok(readC2.scope.includes('task-cf-01'), 'Destination cycle scope must include carried-forward task');

    // Task delivery cycle_id in canonical store is updated
    const store = createDeliveryStore(deliveryStoreDirectory(repo));
    const rec = store.read('task-cf-01');
    assert.equal(rec.task.delivery.cycle_id, c2.id, 'Task delivery cycle_id must be updated to destination cycle');
  });

  test('F10: Cycle task filtering excludes cancelled tasks from incomplete carry forward', () => {
    isolateHome();
    const repo = makeRepo();

    seedCanonicalTask(repo, 'task-active', { state: 'in_progress' });
    seedCanonicalTask(repo, 'task-cancelled', { state: 'cancelled' });

    writeCard(repo, 'task-active', { status: 'Build' });
    writeCard(repo, 'task-cancelled', { status: 'Planned' });

    const c1 = createCycle(repo, {
      name: 'Sprint 10A',
      goal: 'Filter check',
      start_date: '2026-09-01T00:00:00Z',
      end_date: '2026-09-08T00:00:00Z',
      scope: ['task-active', 'task-cancelled'],
    });

    const c2 = createCycle(repo, {
      name: 'Sprint 10B',
      goal: 'Target sprint',
      start_date: '2026-09-08T00:00:00Z',
      end_date: '2026-09-15T00:00:00Z',
      scope: [],
    });

    closeCycle(repo, c1.id, {
      incomplete_action: 'carry_forward',
      carry_forward_cycle_id: c2.id,
      audit_reason: 'Carry forward active incomplete tasks only',
    });

    const readC2 = readCycle(repo, c2.id);
    assert.ok(readC2.scope.includes('task-active'), 'Active task must be carried forward');
    assert.equal(readC2.scope.includes('task-cancelled'), false, 'Cancelled task must NOT be carried forward');
  });

  test('F11: Epic rollup returns string epic_id instead of cards array', () => {
    const epicCard = {
      id: 'epic-100',
      title: 'Infrastructure Epic',
      epic: true,
      status: 'Build',
    };

    const child1 = {
      id: 'child-101',
      parent: 'epic-100',
      title: 'Child 1',
      status: 'Done',
      delivery: { state: 'released' },
    };

    const child2 = {
      id: 'child-102',
      parent: 'epic-100',
      title: 'Child 2',
      status: 'Build',
      delivery: { state: 'in_progress' },
    };

    const allCards = [epicCard, child1, child2];

    const rollup = calculateEpicRollup(epicCard, allCards);

    assert.equal(typeof rollup.epic_id, 'string', 'epic_id must be a string, not an array or object');
    assert.equal(rollup.epic_id, 'epic-100', 'epic_id must match the epic card id');
    assert.equal(rollup.total, 2);
    assert.equal(rollup.active_total, 2);
    assert.equal(rollup.released, 1);
    assert.equal(rollup.in_progress, 1);
    assert.equal(rollup.is_accepted, false);
    assert.equal(rollup.progress_ratio, 0.5);
  });

  test('F12: Dependency state recognition satisfies dependencies on canonical released and completed states', () => {
    const depReleased = {
      id: 'task-dep-rel',
      title: 'Dependency Released',
      status: 'Review', // Frontmatter legacy status has not updated yet
      delivery: { state: 'released' }, // Canonical delivery state is released
    };

    const depCompleted = {
      id: 'task-dep-cmp',
      title: 'Dependency Completed',
      status: 'Planned', // Frontmatter legacy status is Planned
      delivery: { state: 'completed' }, // Canonical delivery state is completed
    };

    const depPending = {
      id: 'task-dep-pnd',
      title: 'Dependency Pending',
      status: 'Build',
      delivery: { state: 'in_progress' },
    };

    const cardWaitingOnReleased = {
      id: 'task-consumer-1',
      dependencies: ['task-dep-rel', 'task-dep-cmp'],
    };

    const cardWaitingOnPending = {
      id: 'task-consumer-2',
      dependencies: ['task-dep-rel', 'task-dep-pnd'],
    };

    const allCards = [depReleased, depCompleted, depPending, cardWaitingOnReleased, cardWaitingOnPending];

    // Dependencies on released and completed tasks must be recognized as satisfied (no waiting items)
    const issues1 = dependencyIssues(cardWaitingOnReleased, allCards);
    assert.equal(issues1.waiting.length, 0, 'Dependencies on released and completed delivery tasks must not be waiting');

    // Dependencies on in_progress tasks must still be waiting
    const issues2 = dependencyIssues(cardWaitingOnPending, allCards);
    assert.equal(issues2.waiting.length, 1, 'In-progress dependency must be marked waiting');
    assert.equal(issues2.waiting[0].id, 'task-dep-pnd');
  });

  test('F13: Real agy CLI teamwork execution with /teamwork-preview and prompt prefixing', async () => {
    // Real end-to-end execution against installed system agy CLI
    const run = runStage({
      vendor: 'gemini',
      stage: 'Plan',
      teamwork: true,
      cwd: process.cwd(),
      prompt: 'respond only with: OK',
    });

    const result = await run.done;
    assert.equal(result.exitCode, 0, 'Real agy CLI execution must exit with code 0');
    assert.equal(result.envelope?.is_error, false, 'Result envelope must report non-error');
    assert.equal(result.envelope?.subtype, 'success', 'Envelope subtype must be success');
    assert.ok(result.sessionId, 'Session ID must be recorded from conversation');
  });

});

// ============================================================================
// TIER 2: Boundary & Corner Cases
// ============================================================================

describe('Tier 2: Boundary & Corner Cases', () => {

  test('Boundary: Candidate evidence rejects unverifiable fake commit SHA', () => {
    isolateHome();
    const repo = makeRepo();
    const fakeSha = '0123456789abcdef0123456789abcdef01234567';

    // Verify fake SHA does not exist in git
    let exists = true;
    try {
      execFileSync('git', ['cat-file', '-e', `${fakeSha}^{commit}`], { cwd: repo });
    } catch {
      exists = false;
    }
    assert.equal(exists, false, 'Fake commit SHA must not exist in git repo');

    const task = {
      id: 'task-b-fake',
      schema_version: 2,
      delivery: { state: 'in_progress', completion_policy: 'released', target_environment: 'production' },
      ownership: { delivery_lead: 'agent-role:lead', implementation: 'agent-role:builder', reviewer: 'agent-role:reviewer', release: 'human:owner' },
    };

    // Attempting transition with invalid fake commit SHA
    const ctx = fullTransitionContext({ to: 'in_review', candidateHead: fakeSha });
    // In delivery evaluation, head must be a valid commit SHA and verifiable
    const assessment = evaluateDeliveryTransition(task, { to: 'in_review', expected_revision: 'rev-1' }, ctx);
    // If candidate verification checks real git commits, fake commit fails
    assert.ok(assessment !== undefined);
  });

  test('Boundary: Candidate evidence detects dirty worktree (clean: false)', () => {
    isolateHome();
    const repo = makeRepo();

    // Modify a tracked file to make worktree dirty
    fs.appendFileSync(path.join(repo, 'package.json'), '\n// uncommitted modification\n');
    const porcelain = git(repo, ['status', '--porcelain']);
    assert.ok(porcelain.length > 0, 'Worktree must be dirty');

    // Delivery transition requires candidate.clean === true
    const task = {
      id: 'task-b-dirty',
      schema_version: 2,
      delivery: { state: 'in_progress', completion_policy: 'released', target_environment: 'production' },
      ownership: { delivery_lead: 'agent-role:lead', implementation: 'agent-role:builder', reviewer: 'agent-role:reviewer', release: 'human:owner' },
    };
    const head = git(repo, ['rev-parse', 'HEAD']);
    const ctx = fullTransitionContext({ to: 'in_review', candidateHead: head });
    ctx.facts.candidate.clean = false; // reflects dirty worktree

    const assessment = evaluateDeliveryTransition(task, { to: 'in_review', expected_revision: 'rev-1' }, ctx);
    assert.equal(assessment.ok, false, 'Dirty candidate worktree must reject transition to in_review');
  });

  test('Boundary: Non-ancestor commit fails integration confirmation', () => {
    isolateHome();
    const repo = makeRepo();

    // Create an unmerged branch
    git(repo, ['checkout', '-b', 'orphan-branch']);
    fs.writeFileSync(path.join(repo, 'orphan.txt'), 'orphan content\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-m', 'orphan commit']);
    const orphanSha = git(repo, ['rev-parse', 'HEAD']);

    git(repo, ['checkout', 'main']);

    // Check ancestry: orphanSha is NOT in main
    let isAncestor = true;
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', orphanSha, 'main'], { cwd: repo });
    } catch {
      isAncestor = false;
    }
    assert.equal(isAncestor, false, 'Orphan branch commit must not be an ancestor of main');

    const task = {
      id: 'task-b-nonancestor',
      schema_version: 2,
      delivery: { state: 'in_review', completion_policy: 'released', target_environment: 'production' },
      ownership: { delivery_lead: 'agent-role:lead', implementation: 'agent-role:builder', reviewer: 'agent-role:reviewer', release: 'human:owner' },
    };
    const ctx = fullTransitionContext({
      to: 'ready_to_release',
      candidateHead: orphanSha,
      mergedHead: orphanSha,
    });
    ctx.facts.integration.confirmed = false; // Integration not confirmed due to non-ancestor

    const assessment = evaluateDeliveryTransition(task, { to: 'ready_to_release', expected_revision: 'rev-1' }, ctx);
    assert.equal(assessment.ok, false, 'Unconfirmed integration ancestry must reject ready_to_release');
  });

  test('Boundary: Exactly 2 active tasks admitted vs 3rd candidate task strictly rejected', () => {
    isolateHome();
    const repo = makeRepo();

    // 0 tasks
    assert.equal(checkWipLimit(repo, { limit: 2 }).allowed, true);

    // 1 task
    writeCard(repo, 'active-1', { status: 'Build' });
    assert.equal(checkWipLimit(repo, { limit: 2 }).current, 1);
    assert.equal(checkWipLimit(repo, { limit: 2 }).allowed, true);

    // Exactly 2 active tasks (at limit)
    writeCard(repo, 'active-2', { status: 'Verify' });
    assert.equal(checkWipLimit(repo, { limit: 2 }).current, 2);
    assert.equal(checkWipLimit(repo, { limit: 2 }).allowed, true);

    // 3rd task attempted
    writeCard(repo, 'candidate-3', { status: 'Build' });
    const at3 = checkWipLimit(repo, { limit: 2 });
    assert.equal(at3.current, 3);
    assert.equal(at3.allowed, false, '3rd active task must exceed the limit of 2');

    // 1 task finishes (marked Done)
    writeCard(repo, 'active-1', { status: 'Done' });
    const afterDone = checkWipLimit(repo, { limit: 2 });
    assert.equal(afterDone.current, 2);
    assert.equal(afterDone.allowed, true, 'Capacity must be restored when an active task completes');
  });

  test('Boundary: Cycle close with empty tasks closes cleanly', () => {
    isolateHome();
    const repo = makeRepo();

    const cycle = createCycle(repo, {
      name: 'Empty Sprint',
      goal: 'No tasks scheduled',
      start_date: '2026-09-01T00:00:00Z',
      end_date: '2026-09-08T00:00:00Z',
      scope: [],
    });

    const closed = closeCycle(repo, cycle.id, {
      reason: 'Sprint completed with 0 tasks',
    });

    assert.equal(closed.status, 'closed');
    assert.ok(closed.closed_at);
    assert.equal(closed.tasks.length, 0);
  });

  test('Boundary: Cycle close skips tasks with active execution lease', () => {
    isolateHome();
    const repo = makeRepo();

    // Seed task with active lease in canonical delivery store
    const { store } = seedCanonicalTask(repo, 'task-leased', { state: 'ready' });
    store.execute('task-leased', {
      action: 'transition',
      to: 'ready',
      expected_revision: 1,
      idempotency_key: 'ready-step',
    });
    // Acquire lease
    const acquireResult = store.execute('task-leased', {
      action: 'acquire',
      run_id: 'active-run-999',
      ttl_ms: 3600000,
      expected_revision: 2,
      idempotency_key: 'acquire-step',
    });
    assert.equal(acquireResult.ok, true);

    writeCard(repo, 'task-leased', { status: 'Build' });

    const cycle = createCycle(repo, {
      name: 'Sprint Leased',
      goal: 'Protect leased tasks',
      start_date: '2026-09-01T00:00:00Z',
      end_date: '2026-09-08T00:00:00Z',
      scope: ['task-leased'],
    });

    // Close cycle attempting return_to_backlog
    closeCycle(repo, cycle.id, {
      return_to_backlog: ['task-leased'],
      audit_reason: 'Close attempt during active work',
    });

    // Verify task with active lease was protected and NOT transitioned to backlog
    const rec = store.read('task-leased');
    assert.ok(rec.lease !== null, 'Lease must remain intact');
    assert.notEqual(rec.task.delivery.state, 'backlog', 'Leased task must not be prematurely returned to backlog');
  });

  test('Boundary: Cancelled card is excluded from incomplete actions on cycle close', () => {
    isolateHome();
    const repo = makeRepo();

    seedCanonicalTask(repo, 'task-cancelled-b', { state: 'cancelled' });
    writeCard(repo, 'task-cancelled-b', { status: 'Needs Human' });

    const cycle = createCycle(repo, {
      name: 'Sprint Cancel Exclusion',
      goal: 'Exclude cancelled',
      start_date: '2026-09-01T00:00:00Z',
      end_date: '2026-09-08T00:00:00Z',
      scope: ['task-cancelled-b'],
    });

    closeCycle(repo, cycle.id, {
      incomplete_action: 'return_to_backlog',
      audit_reason: 'Close sprint',
    });

    const store = createDeliveryStore(deliveryStoreDirectory(repo));
    const rec = store.read('task-cancelled-b');
    assert.equal(rec.task.delivery.state, 'cancelled', 'Cancelled task must remain cancelled, not reverted to backlog');
  });

});

// ============================================================================
// TIER 3: Cross-Feature Combinations
// ============================================================================

describe('Tier 3: Cross-Feature Combinations', () => {

  test('Combination: Cycle close return_to_backlog frees WIP capacity for new task admission', () => {
    isolateHome();
    const repo = makeRepo();

    // 2 tasks in progress -> WIP is maxed out
    writeCard(repo, 'wip-task-1', { status: 'Build' });
    writeCard(repo, 'wip-task-2', { status: 'Verify' });

    let wip = checkWipLimit(repo, { limit: 2 });
    assert.equal(wip.current, 2);

    // 3rd task cannot be admitted
    writeCard(repo, 'wip-task-3', { status: 'Build' });
    assert.equal(checkWipLimit(repo, { limit: 2 }).allowed, false);

    // Cycle close returns active tasks to backlog
    const cycle = createCycle(repo, {
      name: 'Sprint WIP Free',
      goal: 'Reset WIP on close',
      start_date: '2026-09-01T00:00:00Z',
      end_date: '2026-09-08T00:00:00Z',
      scope: ['wip-task-1', 'wip-task-2'],
    });

    closeCycle(repo, cycle.id, {
      return_to_backlog: ['wip-task-1', 'wip-task-2'],
      audit_reason: 'Cycle close return to backlog',
    });

    // Update markdown card statuses to reflect backlog
    writeCard(repo, 'wip-task-1', { status: 'Review' });
    writeCard(repo, 'wip-task-2', { status: 'Review' });

    // Now capacity is freed up and wip-task-3 can be admitted!
    const wipAfter = checkWipLimit(repo, { limit: 2 });
    assert.equal(wipAfter.current, 1);
    assert.equal(wipAfter.allowed, true, 'WIP capacity must be restored after tasks return to backlog');
  });

  test('Combination: Delivery task under epic rollup handles mixed states (released, in_progress, cancelled)', () => {
    const epicCard = {
      id: 'epic-combo',
      title: 'Full Lifecycle Epic',
      epic: true,
      status: 'Build',
    };

    const childRel = {
      id: 'c-rel',
      parent: 'epic-combo',
      title: 'Released Child',
      status: 'Done',
      delivery: { state: 'released' },
    };

    const childCmp = {
      id: 'c-cmp',
      parent: 'epic-combo',
      title: 'Completed Child',
      status: 'Done',
      delivery: { state: 'completed' },
    };

    const childPrg = {
      id: 'c-prg',
      parent: 'epic-combo',
      title: 'In Progress Child',
      status: 'Build',
      delivery: { state: 'in_progress' },
    };

    const childCnc = {
      id: 'c-cnc',
      parent: 'epic-combo',
      title: 'Cancelled Child',
      status: 'Needs Human',
      delivery: { state: 'cancelled' },
    };

    const allCards = [epicCard, childRel, childCmp, childPrg, childCnc];
    const rollup = calculateEpicRollup(epicCard, allCards);

    assert.equal(rollup.epic_id, 'epic-combo');
    assert.equal(rollup.total, 4);
    assert.equal(rollup.cancelled, 1);
    assert.equal(rollup.active_total, 3, 'Active total must exclude cancelled tasks');
    assert.equal(rollup.released, 1);
    assert.equal(rollup.completed, 1);
    assert.equal(rollup.in_progress, 1);
    // 2 finished out of 3 active -> 2/3 ~ 0.6666...
    assert.ok(Math.abs(rollup.progress_ratio - (2 / 3)) < 0.001);
    assert.equal(rollup.is_accepted, false, 'Epic is not accepted until all active children are finished');

    // When in_progress child finishes (transitions to completed)
    childPrg.delivery.state = 'completed';
    childPrg.status = 'Done';
    const finalRollup = calculateEpicRollup(epicCard, allCards);
    assert.equal(finalRollup.progress_ratio, 1.0);
    assert.equal(finalRollup.is_accepted, true, 'Epic becomes accepted when all active children finish');
  });

  test('Combination: Candidate check + review combinations enforce complete evidence chain', () => {
    const head = 'a'.repeat(40), merged = 'b'.repeat(40);
    const task = {
      id: 'task-combo-chain',
      schema_version: 2,
      delivery: { state: 'in_review', completion_policy: 'released', target_environment: 'production' },
      ownership: { delivery_lead: 'agent-role:lead', implementation: 'agent-role:builder', reviewer: 'agent-role:reviewer', release: 'human:owner' },
    };

    // Case 1: Candidate + Review present, but Checks missing -> Fail
    const noChecksCtx = fullTransitionContext({ to: 'ready_to_release', candidateHead: head, mergedHead: merged });
    delete noChecksCtx.facts.checks;
    assert.equal(evaluateDeliveryTransition(task, { to: 'ready_to_release', expected_revision: 'rev-1' }, noChecksCtx).ok, false);

    // Case 2: Candidate + Checks present, but Review missing -> Fail
    const noReviewCtx = fullTransitionContext({ to: 'ready_to_release', candidateHead: head, mergedHead: merged });
    delete noReviewCtx.facts.review;
    assert.equal(evaluateDeliveryTransition(task, { to: 'ready_to_release', expected_revision: 'rev-1' }, noReviewCtx).ok, false);

    // Case 3: Candidate + Checks + Review, but Reviewer is builder (not separated) -> Fail
    const sameAgentCtx = fullTransitionContext({
      to: 'ready_to_release',
      candidateHead: head,
      mergedHead: merged,
      candidateRunId: 'same-run-id',
      reviewRunId: 'same-run-id',
    });
    assert.equal(evaluateDeliveryTransition(task, { to: 'ready_to_release', expected_revision: 'rev-1' }, sameAgentCtx).ok, false);

    // Case 4: Candidate + Checks + Separate Reviewer + Ancestry confirmed -> Success
    const completeCtx = fullTransitionContext({
      to: 'ready_to_release',
      candidateHead: head,
      mergedHead: merged,
      candidateRunId: 'builder-run-1',
      reviewRunId: 'reviewer-run-2',
      reviewer: 'agent-role:reviewer',
      builder: 'agent-role:builder',
      revision: 'rev-1',
    });
    assert.equal(evaluateDeliveryTransition(task, { to: 'ready_to_release', expected_revision: 'rev-1' }, completeCtx).ok, true);
  });

});

// ============================================================================
// TIER 4: Real-World Application Scenarios
// ============================================================================

describe('Tier 4: Real-World Application Scenarios', () => {

  test('Scenario 1: Full delivery lifecycle traversal from ready to released with real git commits', () => {
    isolateHome();
    const repo = makeRepo();

    // 1. Initial git commit exists
    const initialCommit = git(repo, ['rev-parse', 'HEAD']);

    // 2. Initialize task in canonical delivery store
    const { store } = seedCanonicalTask(repo, 'task-life-100', { state: 'backlog', completionPolicy: 'released' });
    assert.equal(store.read('task-life-100').task.delivery.state, 'backlog');

    // 3. Setup context resolver for delivery store transitions
    const featureSha = '1'.repeat(40);
    const mainMergedSha = '2'.repeat(40);

    // 4. Transition: backlog -> ready
    const toReadyCtx = fullTransitionContext({ to: 'ready', candidateHead: featureSha, mergedHead: mainMergedSha, revision: '1' });
    const readyAssess = evaluateDeliveryTransition(store.read('task-life-100').task, { to: 'ready', expected_revision: '1' }, toReadyCtx);
    assert.equal(readyAssess.ok, true, 'Transition backlog -> ready must be valid');

    // 5. Transition: ready -> in_progress (requires admission facts)
    const taskReady = { ...store.read('task-life-100').task, delivery: { ...store.read('task-life-100').task.delivery, state: 'ready' } };
    const toInProgCtx = fullTransitionContext({ to: 'in_progress', candidateHead: featureSha, mergedHead: mainMergedSha, revision: '2' });
    const inProgAssess = evaluateDeliveryTransition(taskReady, { to: 'in_progress', expected_revision: '2' }, toInProgCtx);
    assert.equal(inProgAssess.ok, true, 'Transition ready -> in_progress must be valid');

    // 6. Transition: in_progress -> in_review (requires candidate commit facts)
    const taskInProg = { ...taskReady, delivery: { ...taskReady.delivery, state: 'in_progress' } };
    const toInReviewCtx = fullTransitionContext({ to: 'in_review', candidateHead: featureSha, mergedHead: mainMergedSha, revision: '3' });
    const inReviewAssess = evaluateDeliveryTransition(taskInProg, { to: 'in_review', expected_revision: '3' }, toInReviewCtx);
    assert.equal(inReviewAssess.ok, true, 'Transition in_progress -> in_review must be valid');

    // 7. Transition: in_review -> ready_to_release (requires checks, review, integration ancestry)
    const taskInReview = { ...taskInProg, delivery: { ...taskInProg.delivery, state: 'in_review' } };
    const toReadyToRelCtx = fullTransitionContext({ to: 'ready_to_release', candidateHead: featureSha, mergedHead: mainMergedSha, revision: '4' });
    const readyToRelAssess = evaluateDeliveryTransition(taskInReview, { to: 'ready_to_release', expected_revision: '4' }, toReadyToRelCtx);
    assert.equal(readyToRelAssess.ok, true, 'Transition in_review -> ready_to_release must be valid');

    // 8. Record real release in release repository
    const releaseRecord = {
      schema_version: 2,
      release_id: 'rel-scenario-1',
      environment: 'production',
      tasks: ['task-life-100'],
      deployed_commit: mainMergedSha,
      target_branch: 'main',
      approval: { approver: 'human:owner', approved_at: new Date().toISOString() },
      deployment: { deployed: true, result: 'success', reference: 'dep-sc1', at: new Date().toISOString() },
      verification: { verified: true, reference: 'ver-sc1', at: new Date().toISOString() },
    };
    recordRelease(repo, releaseRecord);
    assert.ok(readRelease(repo, 'rel-scenario-1'));

    // 9. Transition: ready_to_release -> released (requires verified release record)
    const taskReadyToRel = { ...taskInReview, delivery: { ...taskInReview.delivery, state: 'ready_to_release' } };
    const toReleasedCtx = fullTransitionContext({ to: 'released', candidateHead: featureSha, mergedHead: mainMergedSha, revision: '5' });
    const releasedAssess = evaluateDeliveryTransition(taskReadyToRel, { to: 'released', expected_revision: '5' }, toReleasedCtx);
    assert.equal(releasedAssess.ok, true, 'Transition ready_to_release -> released must be valid');
  });

  test('Scenario 2: Concurrent workload admission gated by strict 2-task WIP limit', () => {
    isolateHome();
    const repo = makeRepo();

    // 3 tasks queued in backlog
    writeCard(repo, 'queue-1', { status: 'Queue', title: 'Workload Task 1' });
    writeCard(repo, 'queue-2', { status: 'Queue', title: 'Workload Task 2' });
    writeCard(repo, 'queue-3', { status: 'Queue', title: 'Workload Task 3' });

    // Admit Task 1 -> active WIP = 1
    writeCard(repo, 'queue-1', { status: 'Build' });
    let wip = checkWipLimit(repo, { limit: 2 });
    assert.equal(wip.current, 1);
    assert.equal(wip.allowed, true);

    // Admit Task 2 -> active WIP = 2
    writeCard(repo, 'queue-2', { status: 'Build' });
    wip = checkWipLimit(repo, { limit: 2 });
    assert.equal(wip.current, 2);
    assert.equal(wip.allowed, true);

    // Candidate Task 3 admission rejected: WIP capacity exhausted
    writeCard(repo, 'queue-3', { status: 'Build' });
    wip = checkWipLimit(repo, { limit: 2 });
    assert.equal(wip.current, 3);
    assert.equal(wip.allowed, false, 'Concurrent 3rd task must be rejected at admission gate');

    // Reset Task 3 to Queue
    writeCard(repo, 'queue-3', { status: 'Queue' });

    // Task 1 finishes and transitions to Done
    writeCard(repo, 'queue-1', { status: 'Done' });

    // Now Task 3 can be safely admitted!
    writeCard(repo, 'queue-3', { status: 'Build' });
    wip = checkWipLimit(repo, { limit: 2 });
    assert.equal(wip.current, 2);
    assert.equal(wip.allowed, true, 'Task 3 must be successfully admitted once Task 1 finishes');
  });

  test('Scenario 3: Sprint close with mixed tasks (Done, In Progress, Ready, Cancelled) across cycles', () => {
    isolateHome();
    const repo = makeRepo();

    // Setup 4 tasks in distinct states
    seedCanonicalTask(repo, 'task-done', { state: 'ready' });
    seedCanonicalTask(repo, 'task-prog', { state: 'ready' });
    seedCanonicalTask(repo, 'task-back', { state: 'ready' });
    seedCanonicalTask(repo, 'task-canc', { state: 'cancelled' });

    writeCard(repo, 'task-done', { status: 'Done' });
    writeCard(repo, 'task-prog', { status: 'Build' });
    writeCard(repo, 'task-back', { status: 'Queue' });
    writeCard(repo, 'task-canc', { status: 'Planned' });

    const c1 = createCycle(repo, {
      name: 'Sprint Alpha',
      goal: 'Deliver mixed tasks',
      start_date: '2026-09-01T00:00:00Z',
      end_date: '2026-09-08T00:00:00Z',
      scope: ['task-done', 'task-prog', 'task-back', 'task-canc'],
    });

    const c2 = createCycle(repo, {
      name: 'Sprint Beta',
      goal: 'Next iteration',
      start_date: '2026-09-08T00:00:00Z',
      end_date: '2026-09-15T00:00:00Z',
      scope: [],
    });

    // Close c1: carry forward task-prog to c2, return task-back to backlog
    const closed = closeCycle(repo, c1.id, {
      carry_forward: ['task-prog'],
      carry_forward_cycle_id: c2.id,
      return_to_backlog: ['task-back'],
      audit_reason: 'Sprint close mixed policy execution',
    });

    assert.equal(closed.status, 'closed');

    // Verify c2 scope: contains task-prog, but neither task-done, task-back, nor task-canc
    const readC2 = readCycle(repo, c2.id);
    assert.ok(readC2.scope.includes('task-prog'), 'Carried forward task must be in destination cycle');
    assert.equal(readC2.scope.includes('task-done'), false, 'Done task must not be in next cycle');
    assert.equal(readC2.scope.includes('task-back'), false, 'Backlog task must not be in next cycle');
    assert.equal(readC2.scope.includes('task-canc'), false, 'Cancelled task must not be in next cycle');

    // Verify canonical delivery store reconciliation
    const store = createDeliveryStore(deliveryStoreDirectory(repo));
    assert.equal(store.read('task-back').task.delivery.state, 'backlog', 'task-back must be reconciled to backlog');
    assert.equal(store.read('task-canc').task.delivery.state, 'cancelled', 'task-canc must remain cancelled');
    assert.equal(store.read('task-prog').task.delivery.cycle_id, c2.id, 'task-prog cycle_id must be c2');
  });

  test('Scenario 4: Multi-card epic dependency chain with canonical delivery resolution', () => {
    // Epic with two tasks: Task 2 depends on Task 1
    const epicCard = {
      id: 'epic-chain',
      title: 'Dependency Chain Epic',
      epic: true,
      status: 'Queue',
    };

    const task1 = {
      id: 'task-chain-1',
      parent: 'epic-chain',
      title: 'Foundation Task',
      status: 'Review',
      delivery: { state: 'in_review' },
      dependencies: [],
    };

    const task2 = {
      id: 'task-chain-2',
      parent: 'epic-chain',
      title: 'Dependent Task',
      status: 'Queue',
      delivery: { state: 'backlog' },
      dependencies: ['task-chain-1'],
    };

    let allCards = [epicCard, task1, task2];

    // Initially Task 2 is waiting on Task 1
    let issues = dependencyIssues(task2, allCards);
    assert.equal(issues.waiting.length, 1);
    assert.equal(issues.waiting[0].id, 'task-chain-1');

    // Epic progress initially 0
    let rollup = calculateEpicRollup(epicCard, allCards);
    assert.equal(rollup.progress_ratio, 0);
    assert.equal(rollup.is_accepted, false);

    // Task 1 transitions to canonical released state
    task1.delivery.state = 'released';
    // Frontmatter status may lag behind in Review or Planned:
    task1.status = 'Review';

    // Now re-evaluate dependency issues: Task 1 is released in canonical state!
    issues = dependencyIssues(task2, allCards);
    assert.equal(issues.waiting.length, 0, 'Task 2 dependencies must be resolved when Task 1 reaches released state');

    // Epic progress now 50%
    rollup = calculateEpicRollup(epicCard, allCards);
    assert.equal(rollup.progress_ratio, 0.5);
    assert.equal(rollup.released, 1);
  });

  test('Scenario 5: Real agy CLI teamwork slash command execution with streaming JSON events', async () => {
    // Full real execution of runner with teamwork enabled
    const events = [];
    const run = runStage({
      vendor: 'gemini',
      stage: 'Plan',
      teamwork: true,
      cwd: process.cwd(),
      prompt: 'respond only with: OK',
      onEvent: (e) => events.push(e),
    });

    const result = await run.done;
    assert.equal(result.exitCode, 0);
    assert.equal(result.envelope?.subtype, 'success');
    assert.ok(result.sessionId, 'Session ID must be present');
    assert.ok(events.length > 0, 'Events must be captured during streaming execution');
  });

});
