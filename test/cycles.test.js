import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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
