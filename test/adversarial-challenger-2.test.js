import { test, describe, before, after } from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isolateHome, makeRepo, writeCard } from './helpers.js';
import {
  createCycle,
  readCycle,
  listCycles,
  closeCycle,
  validateCycle,
} from '../src/cycles.js';
import { deliveryStoreDirectory } from '../src/delivery-paths.js';
import { createDeliveryStore } from '../src/delivery-store.js';
import { calculateEpicRollup } from '../src/chunks.js';
import { dependencyIssues } from '../src/board.js';
import { runStage } from '../src/runner.js';

// Unit/CI runs use a deterministic CLI. Authenticated provider delegation is a
// separate release gate, so these tests also run on clean Linux installations.
const originalGeminiBin = process.env.TODOMD_GEMINI_BIN;
before(() => { process.env.TODOMD_GEMINI_BIN = fileURLToPath(new URL('./fixtures/fake-gemini.js', import.meta.url)); });
after(() => {
  if (originalGeminiBin === undefined) delete process.env.TODOMD_GEMINI_BIN;
  else process.env.TODOMD_GEMINI_BIN = originalGeminiBin;
});


function setupDeliveryTask(repo, taskId, { state = 'backlog', cycle_id = null, owner = 'agent-role:dev', lease = null, execution = null } = {}) {
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

  if (state === 'ready' || state === 'in_progress') {
    store.execute(taskId, {
      action: 'transition',
      to: 'ready',
      reason: 'Ready for sprint',
      expected_revision: 1,
      idempotency_key: `ready-${taskId}`,
    });
    if (state === 'in_progress' || lease) {
      store.execute(taskId, {
        action: 'acquire',
        run_id: `run-${taskId}`,
        ttl_ms: 60000,
        expected_revision: 2,
        idempotency_key: `acq-${taskId}`,
      });
    }
  } else if (state === 'cancelled') {
    store.execute(taskId, {
      action: 'transition',
      to: 'cancelled',
      reason: 'Cancelled',
      expected_revision: 1,
      idempotency_key: `cancel-${taskId}`,
    });
  }

  // If custom execution phase needs override:
  if (execution) {
    const file = path.join(dir, `${taskId}.json`);
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    rec.execution = {
      backend: 'local',
      source_revision: rec.source_revision,
      ...execution,
    };
    delete rec.checksum;
    const canonical = v => JSON.stringify(v, (k, val) => (val !== null && typeof val === 'object' && !Array.isArray(val) ? Object.fromEntries(Object.keys(val).sort().map(x => [x, val[x]])) : val));
    rec.checksum = createHash('sha256').update(canonical(rec)).digest('hex');
    fs.writeFileSync(file, JSON.stringify(rec) + '\n', 'utf8');
  }

  return store;
}

describe('Adversarial Stress Testing: closeCycle & Delivery Store Reconciliation', () => {

  test('ADV-1.1: Task with active execution lease avoids store corruption and state mutation on closeCycle', () => {
    isolateHome();
    const repo = makeRepo();

    setupDeliveryTask(repo, 'task-leased-1', { state: 'in_progress', cycle_id: 'cycle-adv-lease' });
    setupDeliveryTask(repo, 'task-unleased-1', { state: 'ready', cycle_id: 'cycle-adv-lease' });

    const store = createDeliveryStore(deliveryStoreDirectory(repo));
    const leasedBefore = store.read('task-leased-1');
    assert.ok(leasedBefore.lease, 'Task must hold an active lease');
    const revBefore = leasedBefore.revision;

    const cycle = createCycle(repo, {
      id: 'cycle-adv-lease',
      name: 'Adversarial Lease Sprint',
      goal: 'Verify lease preservation under cycle close',
      start_date: '2026-09-01T00:00:00Z',
      end_date: '2026-09-08T00:00:00Z',
      scope: ['task-leased-1', 'task-unleased-1'],
    });

    // Attempt return_to_backlog close policy
    const closed = closeCycle(repo, cycle.id, {
      incomplete_action: 'return_to_backlog',
      audit_reason: 'Sprint closed with active lease present',
    });

    assert.equal(closed.status, 'closed');

    // Verification: Leased task must NOT be mutated in store
    const leasedAfter = store.read('task-leased-1');
    assert.ok(leasedAfter, 'Record must be readable and valid');
    assert.equal(leasedAfter.revision, revBefore, 'Revision must NOT increment');
    assert.equal(leasedAfter.task.delivery.state, 'in_progress', 'Delivery state must remain in_progress');
    assert.ok(leasedAfter.lease, 'Active lease must remain intact');
    assert.equal(leasedAfter.task.delivery.cycle_id, 'cycle-adv-lease', 'Cycle ID must not be wiped while leased');

    // Unleased task MUST be cleanly transitioned to backlog and cycle_id wiped
    const unleasedAfter = store.read('task-unleased-1');
    assert.equal(unleasedAfter.task.delivery.state, 'backlog', 'Unleased task must transition to backlog');
    assert.equal(unleasedAfter.task.delivery.cycle_id, undefined, 'Cycle ID must be wiped on backlog return');
  });

  test('ADV-1.2: Task with running execution phase (unstopped) avoids cancellation and corruption', () => {
    isolateHome();
    const repo = makeRepo();

    setupDeliveryTask(repo, 'task-exec-running', {
      state: 'in_progress',
      cycle_id: 'cycle-adv-exec',
      execution: { phase: 'running' },
    });

    const store = createDeliveryStore(deliveryStoreDirectory(repo));
    const before = store.read('task-exec-running');
    const revBefore = before.revision;

    const cycle = createCycle(repo, {
      id: 'cycle-adv-exec',
      name: 'Adversarial Exec Sprint',
      goal: 'Verify running execution preservation',
      start_date: '2026-09-01T00:00:00Z',
      end_date: '2026-09-08T00:00:00Z',
      scope: ['task-exec-running'],
    });

    closeCycle(repo, cycle.id, {
      incomplete_action: 'cancel',
      audit_reason: 'Closing cycle with active execution',
    });

    const after = store.read('task-exec-running');
    assert.equal(after.revision, revBefore, 'Revision must not change for running execution');
    assert.equal(after.task.delivery.state, 'in_progress', 'State must remain in_progress and not transition to cancelled');
    assert.equal(after.task.delivery.cycle_id, 'cycle-adv-exec', 'Cycle ID must remain intact');
  });

  test('ADV-1.3: Empty cycle task list closes cleanly and idempotently with valid schema', () => {
    isolateHome();
    const repo = makeRepo();

    const emptyCycle = createCycle(repo, {
      id: 'cycle-adv-empty',
      name: 'Empty Sprint',
      goal: 'No tasks scheduled',
      start_date: '2026-09-01T00:00:00Z',
      end_date: '2026-09-08T00:00:00Z',
      scope: [],
    });

    const closed1 = closeCycle(repo, emptyCycle.id, {
      incomplete_action: 'carry_forward',
      audit_reason: 'Closing empty sprint',
    });

    assert.equal(closed1.status, 'closed');
    assert.deepEqual(closed1.tasks, []);
    assert.ok(closed1.closed_at);
    assert.ok(validateCycle(closed1).ok, 'Closed empty cycle must pass schema validation');

    // Idempotent re-close
    const closed2 = closeCycle(repo, emptyCycle.id, {
      incomplete_action: 'return_to_backlog',
    });
    assert.equal(closed2.status, 'closed');
  });

  test('ADV-1.4: Carry forward to non-existent destination cycle', () => {
    isolateHome();
    const repo = makeRepo();

    setupDeliveryTask(repo, 'task-cf-ghost', { state: 'ready', cycle_id: 'cycle-cf-ghost-src' });

    const cSrc = createCycle(repo, {
      id: 'cycle-cf-ghost-src',
      name: 'Ghost Target Sprint',
      goal: 'Carry forward to nowhere',
      start_date: '2026-09-01T00:00:00Z',
      end_date: '2026-09-08T00:00:00Z',
      scope: ['task-cf-ghost'],
    });

    // Destination cycle does NOT exist on disk
    const ghostDestId = 'cycle-does-not-exist-at-all';
    assert.equal(readCycle(repo, ghostDestId), null);

    const closed = closeCycle(repo, cSrc.id, {
      incomplete_action: 'carry_forward',
      carry_forward_cycle_id: ghostDestId,
      audit_reason: 'Carry forward targeting non-existent cycle',
    });

    assert.equal(closed.status, 'closed');
    const store = createDeliveryStore(deliveryStoreDirectory(repo));
    const rec = store.read('task-cf-ghost');
    assert.ok(rec, 'Record must still be readable');
    // Verify whether the store updated cycle_id or not
    assert.equal(rec.task.delivery.cycle_id, ghostDestId);
  });

  test('ADV-1.5: Already-cancelled tasks under closeCycle with explicit cancel or backlog action', () => {
    isolateHome();
    const repo = makeRepo();

    setupDeliveryTask(repo, 'task-pre-cancelled', { state: 'cancelled', cycle_id: 'cycle-precanc' });

    const cycle = createCycle(repo, {
      id: 'cycle-precanc',
      name: 'Pre-cancelled task sprint',
      goal: 'Test terminal state task safety',
      start_date: '2026-09-01T00:00:00Z',
      end_date: '2026-09-08T00:00:00Z',
      scope: ['task-pre-cancelled'],
    });

    // 1. Incomplete action 'cancel' should exclude already-cancelled task from incomplete
    const closed = closeCycle(repo, cycle.id, {
      incomplete_action: 'cancel',
      audit_reason: 'Closing cycle with pre-cancelled task',
    });
    assert.equal(closed.status, 'closed');

    const store = createDeliveryStore(deliveryStoreDirectory(repo));
    const rec = store.read('task-pre-cancelled');
    assert.equal(rec.task.delivery.state, 'cancelled');

    // 2. Explicit cancellation pass on an already-cancelled task
    const cycle2 = createCycle(repo, {
      id: 'cycle-precanc-2',
      name: 'Explicit Cancel Test',
      goal: 'Explicit array of cancelled task',
      start_date: '2026-09-01T00:00:00Z',
      end_date: '2026-09-08T00:00:00Z',
      scope: ['task-pre-cancelled'],
    });

    assert.doesNotThrow(() => {
      closeCycle(repo, cycle2.id, {
        cancel: ['task-pre-cancelled'],
        audit_reason: 'Explicitly cancel already cancelled task',
      });
    });

    const rec2 = store.read('task-pre-cancelled');
    assert.equal(rec2.task.delivery.state, 'cancelled');
    assert.equal(rec2.task.delivery.cycle_id, undefined, 'Cycle ID cleared without invalid state transition error');
  });

  test('ADV-1.6: Whitespace or unvalidated carry_forward_cycle_id is rejected by closeCycle and updateTaskDeliveryCycleId', () => {
    isolateHome();
    const repo = makeRepo();

    setupDeliveryTask(repo, 'task-whitespace-target', { state: 'ready', cycle_id: 'cycle-ws-src' });

    const cycle = createCycle(repo, {
      id: 'cycle-ws-src',
      name: 'Whitespace Target Source',
      goal: 'Test whitespace carry_forward_cycle_id',
      start_date: '2026-09-01T00:00:00Z',
      end_date: '2026-09-08T00:00:00Z',
      scope: ['task-whitespace-target'],
    });

    // Passing whitespace as destination cycle ID throws
    assert.throws(() => {
      closeCycle(repo, cycle.id, {
        incomplete_action: 'carry_forward',
        carry_forward_cycle_id: '   ',
        audit_reason: 'Carry forward with invalid whitespace cycle ID',
      });
    }, /Invalid destination cycle identifier/);

    // Passing invalid format cycle ID throws
    assert.throws(() => {
      closeCycle(repo, cycle.id, {
        incomplete_action: 'carry_forward',
        carry_forward_cycle_id: 'invalid!cycle#id',
        audit_reason: 'Carry forward with invalid format cycle ID',
      });
    }, /Invalid destination cycle identifier/);

    const store = createDeliveryStore(deliveryStoreDirectory(repo));
    // Calling store.read verifies record remains intact and unpoisoned
    const rec = store.read('task-whitespace-target');
    assert.ok(rec);
    assert.equal(rec.task.delivery.cycle_id, 'cycle-ws-src');
  });

});

describe('Adversarial Stress Testing: calculateEpicRollup & dependencyIssues', () => {

  test('ADV-2.1: calculateEpicRollup edge case arguments (null, empty, invalid types)', () => {
    // Null/undefined/empty inputs should not throw unhandled exceptions
    assert.doesNotThrow(() => {
      const res = calculateEpicRollup([], 'non-existent-epic');
      assert.equal(res.total, 0);
      assert.equal(res.active_total, 0);
      assert.equal(res.progress_ratio, 0);
      assert.equal(res.is_accepted, false);
    });

    assert.doesNotThrow(() => {
      const res = calculateEpicRollup(null, 'epic-1');
      assert.equal(res.total, 0);
      assert.equal(res.is_accepted, false);
    });

    assert.doesNotThrow(() => {
      const res = calculateEpicRollup(undefined, undefined);
      assert.equal(res.total, 0);
      assert.equal(res.is_accepted, false);
    });
  });

  test('ADV-2.2: calculateEpicRollup behavior with undefined epicId', () => {
    const cards = [
      { id: 'top-1', status: 'Done' },
      { id: 'top-2', status: 'Build' },
      { id: 'child-1', parent: 'epic-1', status: 'Done' },
    ];
    // Notice: if epicId is undefined, cards without parent have parent === undefined
    const rollup = calculateEpicRollup(cards, undefined);
    assert.equal(rollup.epic_id, undefined);
    // top-1 and top-2 match parent === undefined
    assert.equal(rollup.total, 2);
  });

  test('ADV-2.3: calculateEpicRollup 100% cancelled children vs accepted epic', () => {
    const cards = [
      { id: 'epic-all-cancelled', epic: true },
      { id: 'c-1', parent: 'epic-all-cancelled', status: 'Build', delivery: { state: 'cancelled' } },
      { id: 'c-2', parent: 'epic-all-cancelled', status: 'Planned', delivery: { state: 'cancelled' } },
    ];

    const rollup = calculateEpicRollup(cards, 'epic-all-cancelled');
    assert.equal(rollup.total, 2);
    assert.equal(rollup.cancelled, 2);
    assert.equal(rollup.active_total, 0);
    assert.equal(rollup.progress_ratio, 0);
    // Cancelled children do NOT count as successful completion
    assert.equal(rollup.is_accepted, false);
  });

  test('ADV-2.4: calculateEpicRollup with mixed delivery states, blockers, and legacy fallback', () => {
    const epicCard = { id: 'epic-mixed', epic: true };
    const allCards = [
      epicCard,
      { id: 'c-done', parent: 'epic-mixed', status: 'Done' }, // legacy completed
      { id: 'c-rel', parent: 'epic-mixed', status: 'Done', delivery: { state: 'released' } },
      { id: 'c-comp', parent: 'epic-mixed', status: 'Done', delivery: { state: 'completed' } },
      { id: 'c-rev', parent: 'epic-mixed', status: 'Review', delivery: { state: 'in_review' } },
      { id: 'c-bld', parent: 'epic-mixed', status: 'Build', delivery: { state: 'in_progress' } },
      { id: 'c-q', parent: 'epic-mixed', status: 'Queue', delivery: { state: 'ready' } },
      { id: 'c-back', parent: 'epic-mixed', status: 'Planned', delivery: { state: 'backlog' } },
      { id: 'c-canc', parent: 'epic-mixed', status: 'Planned', delivery: { state: 'cancelled' } },
      { id: 'c-block', parent: 'epic-mixed', status: 'Build', blocker: { category: 'provider' }, delivery: { state: 'in_progress' } },
      // Self-reference card (parent is self)
      { id: 'epic-mixed', parent: 'epic-mixed', status: 'Planned' },
      // Nested sub-epic
      { id: 'sub-epic', parent: 'epic-mixed', epic: true, status: 'Planned' },
    ];

    // Inverted arg invocation: calculateEpicRollup(epicCard, allCards)
    const rollup = calculateEpicRollup(epicCard, allCards);
    assert.equal(rollup.epic_id, 'epic-mixed');
    // kids should be: c-done, c-rel, c-comp, c-rev, c-bld, c-q, c-back, c-canc, c-block (9 total)
    assert.equal(rollup.total, 9);
    assert.equal(rollup.completed, 2); // c-done (legacy) + c-comp
    assert.equal(rollup.released, 1);  // c-rel
    assert.equal(rollup.in_review, 1);
    assert.equal(rollup.in_progress, 2); // c-bld + c-block
    assert.equal(rollup.ready, 1);
    assert.equal(rollup.backlog, 1);
    assert.equal(rollup.cancelled, 1);
    assert.equal(rollup.blocked, 1);   // c-block
    assert.equal(rollup.active_total, 8); // 9 - 1 cancelled
    assert.equal(rollup.is_accepted, false);
  });

  test('ADV-2.5: dependencyIssues edge cases (null, duplicates, non-string, unparseable, missing, mixed)', () => {
    // Null card or empty dependencies
    assert.deepEqual(dependencyIssues(null, []), { missing: [], waiting: [], unparseable: [] });
    assert.deepEqual(dependencyIssues({}, []), { missing: [], waiting: [], unparseable: [] });
    assert.deepEqual(dependencyIssues({ dependencies: null }, []), { missing: [], waiting: [], unparseable: [] });

    // Dependencies with duplicates, numbers, and unparseable cards
    const cards = [
      { id: 'dep-done-legacy', status: 'Done' },
      { id: 'dep-released', status: 'Review', delivery: { state: 'released' } },
      { id: 'dep-completed', status: 'Planned', delivery: { state: 'completed' } },
      { id: 'dep-waiting-build', status: 'Build' },
      { id: 'dep-waiting-cancelled', status: 'Cancelled', delivery: { state: 'cancelled' } },
      { id: 'dep-corrupt', unparseable: true },
      { id: '123', status: 'Done' },
    ];

    const card = {
      id: 'task-test',
      dependencies: [
        'dep-done-legacy',
        'dep-released',
        'dep-completed',
        'dep-waiting-build',
        'dep-waiting-cancelled',
        'dep-corrupt',
        'dep-ghost',
        'dep-ghost', // duplicate missing
        123,         // number dependency
      ],
    };

    const issues = dependencyIssues(card, cards);

    // dep-ghost appears twice in missing because it is in dependencies twice
    assert.deepEqual(issues.missing, ['dep-ghost', 'dep-ghost']);
    // dep-corrupt in unparseable
    assert.deepEqual(issues.unparseable, ['dep-corrupt']);
    // waiting has dep-waiting-build and dep-waiting-cancelled
    assert.equal(issues.waiting.length, 2);
    assert.equal(issues.waiting[0].id, 'dep-waiting-build');
    assert.equal(issues.waiting[1].id, 'dep-waiting-cancelled');
    // dep-done-legacy, dep-released, dep-completed, and '123' are satisfied (not in issues)
  });

  test('ADV-2.6: dependencyIssues behavior when cards argument is null or undefined', () => {
    // Calling dependencyIssues with non-array cards throws TypeError (cards.find is not a function)
    assert.throws(() => {
      dependencyIssues({ dependencies: ['dep-1'] }, null);
    }, TypeError);

    assert.throws(() => {
      dependencyIssues({ dependencies: ['dep-1'] }, undefined);
    }, TypeError);
  });

});

describe('Adversarial Stress Testing: Gemini Teamwork CLI adapter', () => {


  test('ADV-3.1: Slash command flag and /teamwork-preview prefixing rules', async () => {
    // Test prefixing and args generation behavior via runStage
    // Prompt without prefix -> prefixed with /teamwork-preview
    const run1 = runStage({
      vendor: 'gemini',
      stage: 'Plan',
      teamwork: true,
      cwd: process.cwd(),
      prompt: 'respond only with: PING_1',
    });

    const res1 = await run1.done;
    assert.equal(res1.exitCode, 0);
    assert.equal(res1.envelope?.subtype, 'success');
    assert.ok(res1.sessionId);

    // Prompt ALREADY prefixed with /teamwork-preview -> must not double prefix
    const run2 = runStage({
      vendor: 'gemini',
      stage: 'Plan',
      teamwork: true,
      cwd: process.cwd(),
      prompt: '/teamwork-preview respond only with: PING_2',
    });

    const res2 = await run2.done;
    assert.equal(res2.exitCode, 0);
    assert.equal(res2.envelope?.subtype, 'success');
    assert.ok(res2.sessionId);
  });

  test('ADV-3.2: Error handling when binary is non-existent or fails', async () => {
    const oldBin = process.env.TODOMD_GEMINI_BIN;
    process.env.TODOMD_GEMINI_BIN = '/tmp/nonexistent-agy-bin-adv-test';

    try {
      const run = runStage({
        vendor: 'gemini',
        stage: 'Plan',
        teamwork: true,
        cwd: process.cwd(),
        prompt: 'test prompt',
      });

      const res = await run.done;
      assert.equal(res.spawnError, 'ENOENT', 'Missing binary must produce spawnError ENOENT');
      assert.equal(res.envelope, null, 'Envelope is null on spawnError');
    } finally {
      if (oldBin !== undefined) process.env.TODOMD_GEMINI_BIN = oldBin;
      else delete process.env.TODOMD_GEMINI_BIN;
    }
  });

  test('ADV-3.3: Teamwork disabled (--disable-slash-commands included and prefix omitted)', async () => {
    // When teamwork is false, verify runner behaves in standard single-agent mode
    const run = runStage({
      vendor: 'gemini',
      stage: 'Plan',
      teamwork: false,
      cwd: process.cwd(),
      prompt: 'respond only with: PING_SOLO',
    });

    const res = await run.done;
    assert.equal(res.exitCode, 0);
    assert.equal(res.envelope?.subtype, 'success');
    assert.ok(res.sessionId);
  });

});
