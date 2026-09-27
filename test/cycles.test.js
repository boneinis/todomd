import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isolateHome, makeRepo, writeCard } from './helpers.js';
import {
  createCycle,
  readCycle,
  listCycles,
  getActiveCycle,
  updateCycleScope,
  closeCycle,
  checkWipLimit,
} from '../src/cycles.js';
import { deliveryStoreDirectory } from '../src/delivery-paths.js';
import { createDeliveryStore } from '../src/delivery-store.js';
import { dependencyIssues } from '../src/board.js';

test('cycles: creation, validation, reading, and listing', () => {
  isolateHome();
  const repo = makeRepo();

  // Create valid cycle
  const cycle = createCycle(repo, {
    name: 'Sprint 1',
    goal: 'Complete delivery foundation',
    start_date: '2026-09-01T00:00:00Z',
    end_date: '2026-09-08T00:00:00Z',
    scope: ['task-001', 'task-002'],
  });

  assert.ok(cycle.id);
  assert.equal(cycle.name, 'Sprint 1');
  assert.equal(cycle.status, 'active');
  assert.deepEqual(cycle.scope, ['task-001', 'task-002']);

  // Read created cycle
  const read = readCycle(repo, cycle.id);
  assert.deepEqual(read, cycle);

  // List cycles
  const list = listCycles(repo);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, cycle.id);

  // Active cycle
  const active = getActiveCycle(repo);
  assert.ok(active);
  assert.equal(active.id, cycle.id);

  // Validation: Missing goal throws error
  assert.throws(() => {
    createCycle(repo, { name: 'Sprint 2', start_date: '2026-09-08T00:00:00Z', end_date: '2026-09-15T00:00:00Z' });
  }, /Goal is required/i);
});

test('cycles: scope modification tracks audit history', () => {
  isolateHome();
  const repo = makeRepo();

  const cycle = createCycle(repo, {
    name: 'Cycle 1',
    goal: 'Implement Phase 4',
    start_date: '2026-09-01T00:00:00Z',
    end_date: '2026-09-08T00:00:00Z',
    scope: ['task-001'],
  });

  // Add a task and remove another
  const updated = updateCycleScope(repo, cycle.id, {
    add: ['task-002', 'task-003'],
    remove: ['task-001'],
    reason: 'Scope rebalancing after refinement',
    actor: 'human:project-owner',
  });

  assert.deepEqual(updated.scope.sort(), ['task-002', 'task-003']);
  assert.ok(updated.scope_history.length >= 2);
  const lastChange = updated.scope_history.find(h => h.action === 'scope_updated');
  assert.ok(lastChange);
  assert.equal(lastChange.reason, 'Scope rebalancing after refinement');
  assert.deepEqual(lastChange.added, ['task-002', 'task-003']);
  assert.deepEqual(lastChange.removed, ['task-001']);
});

test('cycles: close cycle handles carry forward, backlog, and cancellation', () => {
  isolateHome();
  const repo = makeRepo();

  // Create card task-001 as Done, task-002 as In Progress
  writeCard(repo, 'task-001', { status: 'Done' });
  writeCard(repo, 'task-002', { status: 'Build' });

  const c1 = createCycle(repo, {
    name: 'Cycle A',
    goal: 'MVP',
    start_date: '2026-09-01T00:00:00Z',
    end_date: '2026-09-08T00:00:00Z',
    scope: ['task-001', 'task-002'],
  });

  const c2 = createCycle(repo, {
    name: 'Cycle B',
    goal: 'Next phase',
    start_date: '2026-09-08T00:00:00Z',
    end_date: '2026-09-15T00:00:00Z',
    scope: [],
  });

  // Close cycle with carry_forward to c2
  const closed = closeCycle(repo, c1.id, {
    incomplete_action: 'carry_forward',
    carry_forward_cycle_id: c2.id,
    audit_reason: 'Carry forward incomplete tasks to Cycle B',
  });

  assert.equal(closed.status, 'closed');
  assert.ok(closed.closed_at);

  // Check c2 now contains task-002
  const updatedC2 = readCycle(repo, c2.id);
  assert.ok(updatedC2.scope.includes('task-002'));
});

test('cycles: WIP capacity limit enforcement', () => {
  isolateHome();
  const repo = makeRepo();

  // Initially 0 tasks in progress
  let wip = checkWipLimit(repo, { limit: 2 });
  assert.equal(wip.current, 0);
  assert.equal(wip.limit, 2);
  assert.equal(wip.exceeded, false);

  // Create 2 tasks in progress (e.g. Build and CI)
  writeCard(repo, 'task-001', { status: 'Build' });
  writeCard(repo, 'task-002', { status: 'CI' });

  wip = checkWipLimit(repo, { limit: 2 });
  assert.equal(wip.current, 2);
  assert.equal(wip.exceeded, false);

  // Add a 3rd task in progress
  writeCard(repo, 'task-003', { status: 'Build' });

  wip = checkWipLimit(repo, { limit: 2 });
  assert.equal(wip.current, 3);
  assert.equal(wip.exceeded, true);
});

function setupDeliveryTask(repo, taskId, { state = 'backlog', cycle_id = null, owner = 'agent-role:dev' } = {}) {
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
    if (state === 'in_progress') {
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

  return store;
}

test('cycles: closeCycle returns incomplete tasks to backlog in canonical delivery store and clears cycle_id', () => {
  isolateHome();
  const repo = makeRepo();

  setupDeliveryTask(repo, 'task-b1', { state: 'ready', cycle_id: 'cycle-old' });
  setupDeliveryTask(repo, 'task-b2', { state: 'ready', cycle_id: 'cycle-old' });

  const c = createCycle(repo, {
    id: 'cycle-old',
    name: 'Sprint Old',
    goal: 'Return testing',
    start_date: '2026-09-01T00:00:00Z',
    end_date: '2026-09-08T00:00:00Z',
    scope: ['task-b1', 'task-b2'],
  });

  closeCycle(repo, c.id, {
    incomplete_action: 'return_to_backlog',
    audit_reason: 'Cycle closing - return remaining to backlog',
  });

  const store = createDeliveryStore(deliveryStoreDirectory(repo));
  const r1 = store.read('task-b1');
  const r2 = store.read('task-b2');

  assert.equal(r1.task.delivery.state, 'backlog');
  assert.equal(r2.task.delivery.state, 'backlog');
  assert.equal(r1.task.delivery.cycle_id, undefined);
  assert.equal(r2.task.delivery.cycle_id, undefined);

  const closed = readCycle(repo, c.id);
  assert.equal(closed.status, 'closed');
  const returnedActions = closed.scope_history.filter(h => h.action === 'returned_to_backlog');
  assert.equal(returnedActions.length, 2);
});

test('cycles: closeCycle cancels incomplete tasks in canonical delivery store and clears cycle_id', () => {
  isolateHome();
  const repo = makeRepo();

  setupDeliveryTask(repo, 'task-c1', { state: 'ready', cycle_id: 'cycle-can' });
  setupDeliveryTask(repo, 'task-c2', { state: 'ready', cycle_id: 'cycle-can' });

  const c = createCycle(repo, {
    id: 'cycle-can',
    name: 'Sprint Cancel',
    goal: 'Cancel testing',
    start_date: '2026-09-01T00:00:00Z',
    end_date: '2026-09-08T00:00:00Z',
    scope: ['task-c1', 'task-c2'],
  });

  closeCycle(repo, c.id, {
    incomplete_action: 'cancel',
    audit_reason: 'Abandoning sprint tasks',
  });

  const store = createDeliveryStore(deliveryStoreDirectory(repo));
  const r1 = store.read('task-c1');
  const r2 = store.read('task-c2');

  assert.equal(r1.task.delivery.state, 'cancelled');
  assert.equal(r2.task.delivery.state, 'cancelled');
  assert.equal(r1.task.delivery.cycle_id, undefined);
  assert.equal(r2.task.delivery.cycle_id, undefined);

  const closed = readCycle(repo, c.id);
  const cancelActions = closed.scope_history.filter(h => h.action === 'cancelled');
  assert.equal(cancelActions.length, 2);
});

test('cycles: closeCycle carry forward updates task delivery cycle_id and excludes cancelled tasks', () => {
  isolateHome();
  const repo = makeRepo();

  setupDeliveryTask(repo, 'task-cf-active', { state: 'ready', cycle_id: 'cycle-src' });
  setupDeliveryTask(repo, 'task-cf-cancelled', { state: 'cancelled', cycle_id: 'cycle-src' });

  const c1 = createCycle(repo, {
    id: 'cycle-src',
    name: 'Cycle Source',
    goal: 'Carry forward source',
    start_date: '2026-09-01T00:00:00Z',
    end_date: '2026-09-08T00:00:00Z',
    scope: ['task-cf-active', 'task-cf-cancelled'],
  });

  const c2 = createCycle(repo, {
    id: 'cycle-dst',
    name: 'Cycle Dest',
    goal: 'Carry forward dest',
    start_date: '2026-09-08T00:00:00Z',
    end_date: '2026-09-15T00:00:00Z',
    scope: [],
  });

  closeCycle(repo, c1.id, {
    incomplete_action: 'carry_forward',
    carry_forward_cycle_id: c2.id,
    audit_reason: 'Carrying forward active work',
  });

  const updatedC2 = readCycle(repo, c2.id);
  // task-cf-active carried forward
  assert.ok(updatedC2.scope.includes('task-cf-active'));
  // task-cf-cancelled MUST NOT be carried forward
  assert.ok(!updatedC2.scope.includes('task-cf-cancelled'));

  const store = createDeliveryStore(deliveryStoreDirectory(repo));
  const rActive = store.read('task-cf-active');
  assert.equal(rActive.task.delivery.cycle_id, c2.id);
  const rCancelled = store.read('task-cf-cancelled');
  assert.equal(rCancelled.task.delivery.state, 'cancelled');
});

test('cycles: closeCycle handles tasks with active execution leases gracefully', () => {
  isolateHome();
  const repo = makeRepo();

  setupDeliveryTask(repo, 'task-leased', { state: 'in_progress', cycle_id: 'cycle-lease' });

  const store = createDeliveryStore(deliveryStoreDirectory(repo));
  const recordBefore = store.read('task-leased');
  assert.ok(recordBefore.lease, 'Task should have an active lease');
  const revisionBefore = recordBefore.revision;

  const c = createCycle(repo, {
    id: 'cycle-lease',
    name: 'Sprint Lease',
    goal: 'Active lease safety',
    start_date: '2026-09-01T00:00:00Z',
    end_date: '2026-09-08T00:00:00Z',
    scope: ['task-leased'],
  });

  // Closing cycle with return_to_backlog must not crash or corrupt store
  assert.doesNotThrow(() => {
    closeCycle(repo, c.id, {
      incomplete_action: 'return_to_backlog',
      audit_reason: 'Attempt close while lease active',
    });
  });

  const recordAfter = store.read('task-leased');
  // Lease remains intact and revision unchanged
  assert.ok(recordAfter.lease, 'Active lease must remain intact');
  assert.equal(recordAfter.revision, revisionBefore);
  assert.equal(recordAfter.task.delivery.state, 'in_progress');
});

test('board: dependencyIssues recognizes released and completed canonical delivery states as satisfied', () => {
  const cardA = { id: 'task-main', dependencies: ['task-dep-done', 'task-dep-rel', 'task-dep-comp', 'task-dep-wait'] };
  const cardDone = { id: 'task-dep-done', status: 'Done' };
  const cardReleased = { id: 'task-dep-rel', status: 'Review', delivery: { state: 'released' } };
  const cardCompleted = { id: 'task-dep-comp', status: 'Planned', delivery: { state: 'completed' } };
  const cardWaiting = { id: 'task-dep-wait', status: 'Build' };

  const issues = dependencyIssues(cardA, [cardA, cardDone, cardReleased, cardCompleted, cardWaiting]);

  assert.equal(issues.missing.length, 0);
  assert.equal(issues.unparseable.length, 0);
  assert.equal(issues.waiting.length, 1);
  assert.equal(issues.waiting[0].id, 'task-dep-wait');
});
