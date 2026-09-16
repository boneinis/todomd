import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isolateHome, makeRepo, writeCard, git } from './helpers.js';
import { resolveTaskEvidence } from '../src/delivery-releases.js';
import { createCycle, closeCycle, readCycle } from '../src/cycles.js';
import { deliveryStoreDirectory } from '../src/delivery-paths.js';
import { createDeliveryStore } from '../src/delivery-store.js';
import { validateDeliveryTask } from '../src/delivery.js';

function setupDeliveryTask(repo, taskId, { state = 'ready', cycle_id = null, owner = 'agent-role:dev' } = {}) {
  const dir = deliveryStoreDirectory(repo);
  fs.mkdirSync(dir, { recursive: true });
  const store = createDeliveryStore(dir, {
    enabled: true,
    resolveContext: () => ({
      actor_id: 'human:project-owner',
      grants: ['delivery:initialize', 'delivery:ready', 'delivery:backlog', 'delivery:cancelled', 'delivery:in_progress', 'delivery:acquire'],
      busy: false,
      facts: {
        ready: { scope_defined: true, criteria_defined: true, validation_plan: true, target_known: true, dependencies_valid: true, planning_approved: true },
        admission: { authorized: true, dependencies_satisfied: true, owner },
      },
    }),
  });

  const cardPath = path.join(repo, '.todomd/tasks', `${taskId}-card.md`);
  if (!fs.existsSync(cardPath)) {
    writeCard(repo, taskId, { status: state === 'ready' ? 'Planned' : state === 'in_progress' ? 'Build' : 'Review' });
  }
  const raw = fs.readFileSync(cardPath);
  const source_revision = createHash('sha256').update(raw).digest('hex');

  const task = {
    id: taskId,
    schema_version: 2,
    delivery: {
      state: 'backlog',
      completion_policy: 'released',
      target_environment: 'production',
      ...(cycle_id ? { cycle_id } : {}),
    },
    ownership: {
      delivery_lead: 'human:project-owner',
      implementation: owner,
      reviewer: 'agent-role:rev',
      release: 'human:project-owner',
    },
  };

  store.execute(taskId, {
    action: 'initialize',
    task,
    source_revision,
    expected_revision: 0,
    idempotency_key: `init-${taskId}`,
  });

  if (state === 'ready') {
    store.execute(taskId, {
      action: 'transition',
      to: 'ready',
      reason: 'Ready for sprint',
      expected_revision: 1,
      idempotency_key: `ready-${taskId}`,
    });
  }

  return store;
}

describe('Empirical Adversarial Challenge: Integration Fact Ancestry (R1)', () => {
  test('R1.1: Unmerged branch commit cannot be certified as integrated into targetBranch', () => {
    isolateHome();
    const repo = makeRepo();
    const targetBranch = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']) || 'main';

    git(repo, ['checkout', '-b', 'unmerged-feature']);
    fs.writeFileSync(path.join(repo, 'unmerged.txt'), 'unmerged feature code\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-m', 'feat: unmerged']);
    const unmergedSha = git(repo, ['rev-parse', 'HEAD']);
    git(repo, ['checkout', targetBranch]);

    // Attack 1: Self-ancestor spoofing (merged_head = candidate_head = unmergedSha)
    const result1 = resolveTaskEvidence(repo, 'T1', {
      candidate_head: unmergedSha,
      target_branch: targetBranch,
      integration: {
        candidate_head: unmergedSha,
        merged_head: unmergedSha,
      },
    });
    assert.equal(result1.integration, null, 'Unmerged commit must not pass integration even when merged_head equals candidate_head');

    // Attack 2: Omitting merged_head (default targetBranch ancestry)
    const result2 = resolveTaskEvidence(repo, 'T1', {
      candidate_head: unmergedSha,
      target_branch: targetBranch,
    });
    assert.equal(result2.integration, null, 'Unmerged commit must not pass integration when merged_head is omitted');
  });

  test('R1.2: Candidate commit merged to intermediate feature branch, but feature branch not merged to targetBranch', () => {
    isolateHome();
    const repo = makeRepo();
    const targetBranch = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']) || 'main';

    git(repo, ['checkout', '-b', 'feature-sub']);
    fs.writeFileSync(path.join(repo, 'sub.txt'), 'sub feature\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-m', 'feat: candidate commit']);
    const candidateSha = git(repo, ['rev-parse', 'HEAD']);

    // Another commit on the feature branch
    fs.writeFileSync(path.join(repo, 'sub2.txt'), 'sub feature follow-up\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-m', 'feat: follow-up commit']);
    const featureHead = git(repo, ['rev-parse', 'HEAD']);

    git(repo, ['checkout', targetBranch]);

    // candidateSha IS an ancestor of featureHead, but featureHead is NOT an ancestor of targetBranch
    const result = resolveTaskEvidence(repo, 'T2', {
      candidate_head: candidateSha,
      target_branch: targetBranch,
      integration: {
        candidate_head: candidateSha,
        merged_head: featureHead,
      },
    });
    assert.equal(result.integration, null, 'Intermediate feature head not merged to targetBranch must fail');
  });

  test('R1.3: Merged_head is ancestor of targetBranch, but candidate commit is NOT an ancestor of merged_head', () => {
    isolateHome();
    const repo = makeRepo();
    const targetBranch = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']) || 'main';
    const mainHead = git(repo, ['rev-parse', 'HEAD']);

    // Create an unmerged feature commit
    git(repo, ['checkout', '-b', 'orphan-feature']);
    fs.writeFileSync(path.join(repo, 'orphan.txt'), 'orphan\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-m', 'feat: orphan commit']);
    const orphanSha = git(repo, ['rev-parse', 'HEAD']);
    git(repo, ['checkout', targetBranch]);

    // Attack: caller points merged_head to mainHead (which IS an ancestor of targetBranch),
    // but candidate_head is orphanSha (which is NOT an ancestor of mainHead)
    const result = resolveTaskEvidence(repo, 'T3', {
      candidate_head: orphanSha,
      target_branch: targetBranch,
      integration: {
        candidate_head: orphanSha,
        merged_head: mainHead,
      },
    });
    assert.equal(result.integration, null, 'Candidate commit not reachable from merged_head must fail');
  });

  test('R1.4: Inverted ancestry attack: merged_head is an ancestor of candidate instead of descendant', () => {
    isolateHome();
    const repo = makeRepo();
    const targetBranch = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']) || 'main';
    const oldMainHead = git(repo, ['rev-parse', 'HEAD']);

    // Advance main with a new commit
    fs.writeFileSync(path.join(repo, 'advance.txt'), 'advanced\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-m', 'chore: advance main']);
    const newMainHead = git(repo, ['rev-parse', 'HEAD']);

    // Attack: candidate is newMainHead, but caller specifies merged_head as oldMainHead
    // gitIsAncestor(candidate, merged_head) checks if newMainHead is an ancestor of oldMainHead (which is false!)
    const result = resolveTaskEvidence(repo, 'T4', {
      candidate_head: newMainHead,
      target_branch: targetBranch,
      integration: {
        candidate_head: newMainHead,
        merged_head: oldMainHead,
      },
    });
    assert.equal(result.integration, null, 'Inverted ancestry must fail');
  });

  test('R1.5: Divergent branches: branch A merged to main, branch B NOT merged', () => {
    isolateHome();
    const repo = makeRepo();
    const targetBranch = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']) || 'main';

    // Branch A
    git(repo, ['checkout', '-b', 'branch-a']);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'content a\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-m', 'feat: branch a']);
    const shaA = git(repo, ['rev-parse', 'HEAD']);

    // Branch B
    git(repo, ['checkout', targetBranch]);
    git(repo, ['checkout', '-b', 'branch-b']);
    fs.writeFileSync(path.join(repo, 'b.txt'), 'content b\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-m', 'feat: branch b']);
    const shaB = git(repo, ['rev-parse', 'HEAD']);

    // Merge Branch A into targetBranch
    git(repo, ['checkout', targetBranch]);
    git(repo, ['merge', '--no-ff', 'branch-a', '-m', 'Merge branch-a']);
    const mergeShaA = git(repo, ['rev-parse', 'HEAD']);

    // Attack 1: Task on Branch B uses Branch A merge commit as merged_head
    const resultB = resolveTaskEvidence(repo, 'TB', {
      candidate_head: shaB,
      target_branch: targetBranch,
      integration: {
        candidate_head: shaB,
        merged_head: mergeShaA,
      },
    });
    assert.equal(resultB.integration, null, 'Branch B candidate cannot use Branch A merge commit');

    // Attack 2: Task on Branch A uses Branch B unmerged commit as merged_head
    const resultA = resolveTaskEvidence(repo, 'TA', {
      candidate_head: shaA,
      target_branch: targetBranch,
      integration: {
        candidate_head: shaA,
        merged_head: shaB,
      },
    });
    assert.equal(resultA.integration, null, 'Branch A candidate cannot use Branch B unmerged commit');

    // Legitimate integration: Branch A candidate with merge commit or targetBranch HEAD
    const legitResult = resolveTaskEvidence(repo, 'TA-legit', {
      candidate_head: shaA,
      target_branch: targetBranch,
      integration: {
        candidate_head: shaA,
        merged_head: mergeShaA,
      },
    });
    assert.ok(legitResult.integration);
    assert.equal(legitResult.integration.confirmed, true);
    assert.equal(legitResult.integration.merged_head, mergeShaA);
  });

  test('R1.6: Non-existent branch, non-commit objects, or invalid SHA in integration options', () => {
    isolateHome();
    const repo = makeRepo();
    const mainHead = git(repo, ['rev-parse', 'HEAD']);

    // Non-existent target branch does not crash and returns null integration
    const noBranch = resolveTaskEvidence(repo, 'T-nobranch', {
      candidate_head: mainHead,
      target_branch: 'non-existent-branch-404',
    });
    assert.equal(noBranch.integration, null, 'Non-existent target branch must return null integration');

    // Blob object SHA passed as merged_head
    fs.writeFileSync(path.join(repo, 'blob.txt'), 'some blob text\n');
    const blobSha = git(repo, ['hash-object', '-w', path.join(repo, 'blob.txt')]);
    const blobResult = resolveTaskEvidence(repo, 'T-blob', {
      candidate_head: mainHead,
      target_branch: 'main',
      integration: {
        candidate_head: mainHead,
        merged_head: blobSha,
      },
    });
    assert.equal(blobResult.integration, null, 'Blob object SHA passed as merged_head must return null');

    // Fake 40-char SHA that does not exist in git repo
    const fakeSha = 'a'.repeat(40);
    const fakeResult = resolveTaskEvidence(repo, 'T-fake', {
      candidate_head: mainHead,
      target_branch: 'main',
      integration: {
        candidate_head: mainHead,
        merged_head: fakeSha,
      },
    });
    assert.equal(fakeResult.integration, null, 'Fake non-existent SHA must return null');
  });
});

describe('Empirical Adversarial Challenge: Acceptance Fact Authority (R1)', () => {
  test('R1.7: Unbacked caller options.acceptance cannot spoof acceptance fact', () => {
    isolateHome();
    const repo = makeRepo();

    // 1. No card acceptance, options.acceptance provided
    const res1 = resolveTaskEvidence(repo, 'T-acc-spoof1', {
      acceptance: { accepted: true, reference: 'spoofed-reference' },
    });
    assert.equal(res1.acceptance, null, 'Options acceptance without card acceptance must be null');

    // 2. Card has accepted: false, options claims accepted: true
    const cardRejected = {
      id: 'T-acc-spoof2',
      data: {
        acceptance: { accepted: false, reference: 'rejected-by-qa' },
      },
    };
    const res2 = resolveTaskEvidence(repo, cardRejected, {
      acceptance: { accepted: true, reference: 'spoofed-override' },
    });
    assert.equal(res2.acceptance, null, 'Card accepted: false cannot be overridden by options');
  });

  test('R1.8: Card acceptance requires strict boolean true and nonempty string reference', () => {
    isolateHome();
    const repo = makeRepo();

    const invalidAcceptances = [
      { accepted: 'true', reference: 'valid-ref' }, // string 'true'
      { accepted: 1, reference: 'valid-ref' }, // truthy number
      { accepted: true, reference: '' }, // empty string ref
      { accepted: true, reference: '   ' }, // whitespace only ref
      { accepted: true, reference: null }, // null ref
      { accepted: true, reference: undefined }, // undefined ref
      { accepted: true, reference: 12345 }, // number ref
      { accepted: true }, // missing ref
    ];

    for (const acc of invalidAcceptances) {
      const card = { id: 'T-acc-invalid', data: { acceptance: acc } };
      const res = resolveTaskEvidence(repo, card);
      assert.equal(res.acceptance, null, `Acceptance with ${JSON.stringify(acc)} must be null`);
    }

    // Valid acceptance
    const validCard = {
      id: 'T-acc-valid',
      data: {
        acceptance: { accepted: true, reference: 'qa-signoff-verdict:pass' },
      },
    };
    const validRes = resolveTaskEvidence(repo, validCard);
    assert.deepEqual(validRes.acceptance, {
      accepted: true,
      reference: 'qa-signoff-verdict:pass',
    });
  });
});

describe('Empirical Adversarial Challenge: Cycle Close & Identifier Validation (R3)', () => {
  test('R3.1: closeCycle rejects whitespace and malformed cycle identifiers across all option aliases', () => {
    isolateHome();
    const repo = makeRepo();

    const cycle = createCycle(repo, {
      id: 'cycle-src-1',
      name: 'Source Cycle',
      goal: 'Test cycle',
      start_date: '2026-09-01T00:00:00Z',
      end_date: '2026-09-08T00:00:00Z',
      scope: [],
    });

    const malformedIds = [
      '   ',
      '\t',
      '\r\n',
      'cycle space',
      'cycle/sub',
      '../cycle',
      '-cycle-leading-dash',
      '_cycle-leading-under',
      '.cycle-leading-dot',
      'cycle$id',
      'cycle#id',
      'cycle!id',
      'x'.repeat(65),
    ];

    const aliases = ['carry_forward_cycle_id', 'destCycleId', 'dest_cycle_id'];

    for (const alias of aliases) {
      for (const badId of malformedIds) {
        assert.throws(() => {
          closeCycle(repo, cycle.id, {
            incomplete_action: 'carry_forward',
            [alias]: badId,
            audit_reason: `Testing bad id "${badId}" via alias ${alias}`,
          });
        }, /Invalid destination cycle identifier/, `Expected badId "${badId}" via ${alias} to throw Invalid destination cycle identifier`);
      }
    }
  });

  test('R3.2: Rejection of invalid cycle identifier leaves delivery store record intact and uncorrupted', () => {
    isolateHome();
    const repo = makeRepo();

    setupDeliveryTask(repo, 'task-preserve-1', { state: 'ready', cycle_id: 'cycle-src-2' });

    const cycle = createCycle(repo, {
      id: 'cycle-src-2',
      name: 'Source Cycle 2',
      goal: 'Test preservation',
      start_date: '2026-09-01T00:00:00Z',
      end_date: '2026-09-08T00:00:00Z',
      scope: ['task-preserve-1'],
    });

    // Attempt carry forward with whitespace cycle ID
    assert.throws(() => {
      closeCycle(repo, cycle.id, {
        incomplete_action: 'carry_forward',
        carry_forward_cycle_id: '   \t  ',
      });
    }, /Invalid destination cycle identifier/);

    // Verify delivery store record was not modified or corrupted
    const store = createDeliveryStore(deliveryStoreDirectory(repo));
    const rec = store.read('task-preserve-1');
    assert.ok(rec, 'Task record must exist in store');
    assert.equal(rec.task.delivery.cycle_id, 'cycle-src-2', 'Original cycle_id must be preserved');
    const validation = validateDeliveryTask(rec.task);
    assert.equal(validation.ok, true, 'Task record must pass validateDeliveryTask');
  });

  test('R3.3: Legitimate destination cycle ID successfully updates delivery store record with valid schema', () => {
    isolateHome();
    const repo = makeRepo();

    setupDeliveryTask(repo, 'task-cf-legit', { state: 'ready', cycle_id: 'cycle-src-3' });

    const cycle = createCycle(repo, {
      id: 'cycle-src-3',
      name: 'Source Cycle 3',
      goal: 'Test legitimate carry forward',
      start_date: '2026-09-01T00:00:00Z',
      end_date: '2026-09-08T00:00:00Z',
      scope: ['task-cf-legit'],
    });

    const validDestIds = ['cycle-dest-next', 'C2', 'sprint_2026.09-v2'];

    for (const destId of validDestIds) {
      // Create destination cycle
      createCycle(repo, {
        id: destId,
        name: `Dest Cycle ${destId}`,
        goal: 'Destination cycle',
        start_date: '2026-09-09T00:00:00Z',
        end_date: '2026-09-16T00:00:00Z',
      });

      // Close source cycle with carry_forward
      const closed = closeCycle(repo, cycle.id, {
        incomplete_action: 'carry_forward',
        carry_forward_cycle_id: destId,
      });
      assert.equal(closed.status, 'closed');

      const store = createDeliveryStore(deliveryStoreDirectory(repo));
      const rec = store.read('task-cf-legit');
      assert.ok(rec);
      assert.equal(rec.task.delivery.cycle_id, destId, `Record must have updated cycle_id ${destId}`);
      const validation = validateDeliveryTask(rec.task);
      assert.equal(validation.ok, true, `Record must pass validateDeliveryTask with cycle_id ${destId}`);
      break; // One cycle close per source cycle
    }
  });

  test('R3.4: return_to_backlog and cancel clear cycle_id in delivery store and maintain schema validity', () => {
    isolateHome();
    const repo = makeRepo();

    // Task 1 for backlog return
    setupDeliveryTask(repo, 'task-ret-1', { state: 'ready', cycle_id: 'cycle-ret-src' });
    // Task 2 for cancel
    setupDeliveryTask(repo, 'task-cnc-1', { state: 'ready', cycle_id: 'cycle-ret-src' });

    const cycle = createCycle(repo, {
      id: 'cycle-ret-src',
      name: 'Return Source Cycle',
      goal: 'Test clearing cycle_id',
      start_date: '2026-09-01T00:00:00Z',
      end_date: '2026-09-08T00:00:00Z',
      scope: ['task-ret-1', 'task-cnc-1'],
    });

    closeCycle(repo, cycle.id, {
      return_to_backlog: ['task-ret-1'],
      cancel: ['task-cnc-1'],
    });

    const store = createDeliveryStore(deliveryStoreDirectory(repo));

    const recRet = store.read('task-ret-1');
    assert.ok(recRet);
    assert.equal(recRet.task.delivery.state, 'backlog');
    assert.equal(recRet.task.delivery.cycle_id, undefined, 'cycle_id must be cleared on return to backlog');
    assert.equal(validateDeliveryTask(recRet.task).ok, true, 'Task returned to backlog must pass schema validation');

    const recCnc = store.read('task-cnc-1');
    assert.ok(recCnc);
    assert.equal(recCnc.task.delivery.state, 'cancelled');
    assert.equal(recCnc.task.delivery.cycle_id, undefined, 'cycle_id must be cleared on cancel');
    assert.equal(validateDeliveryTask(recCnc.task).ok, true, 'Task cancelled must pass schema validation');
  });
});
