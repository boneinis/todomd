import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolateHome, makeRepo, writeCard } from './helpers.js';
import { readCard, loadConfig } from '../src/board.js';
import { createDeliveryStore } from '../src/delivery-store.js';
import { deliveryStoreDirectory } from '../src/delivery-paths.js';
import { migrateDeliveryBoard, rollbackDeliveryBoard } from '../src/delivery-migration.js';

test('delivery-migration: dry-run inspection produces migration plan without altering files', () => {
  isolateHome();
  const repo = makeRepo();

  writeCard(repo, 'card-001', { status: 'Done', title: 'Old completed work' });
  writeCard(repo, 'card-002', { status: 'Review', title: 'Work in review' });
  writeCard(repo, 'card-003', { status: 'Needs Human', title: 'Blocked work', extra: 'needs_human_reason: Needs API key\n' });

  const result = migrateDeliveryBoard(repo, { dryRun: true });
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.ok(result.plan.length >= 3);

  // Cards still have legacy schema
  const c1 = readCard(repo, 'card-001');
  assert.equal(c1.data.status, 'Done');
  assert.equal(c1.data.schema_version, undefined);
  assert.equal(c1.data.delivery, undefined);
});

test('delivery-migration: active legacy tasks veto migration unless external quiescence is confirmed', () => {
  isolateHome();
  const repo = makeRepo();

  writeCard(repo, 'task-active', { status: 'Build', title: 'Active build task' });

  // Migration should be vetoed by writer preflight
  const blockedResult = migrateDeliveryBoard(repo);
  assert.equal(blockedResult.ok, false);
  assert.equal(blockedResult.code, 'writers_active');
  assert.equal(blockedResult.preflight.blocked, true);

  // With confirmed quiescence, migration proceeds
  const allowedResult = migrateDeliveryBoard(repo, { dryRun: true, confirmExternalQuiescence: true });
  assert.equal(allowedResult.ok, true);
  assert.equal(allowedResult.plan[0].to_state, 'in_progress');
});

test('delivery-migration: full migration and rollback', () => {
  isolateHome();
  const repo = makeRepo();

  writeCard(repo, 'task-done', { status: 'Done', title: 'Historical Done task' });
  writeCard(repo, 'task-build', { status: 'Build', title: 'Active build task' });
  writeCard(repo, 'task-human', { status: 'Needs Human', title: 'Hold task', extra: 'needs_human_reason: Design approval needed\n' });
  writeCard(repo, 'task-review', { status: 'Review', title: 'Review task' });

  const result = migrateDeliveryBoard(repo, { confirmExternalQuiescence: true });
  assert.equal(result.ok, true);
  assert.ok(result.count >= 4);

  // Check config mode
  const cfg = loadConfig(repo);
  assert.equal(cfg.mode, 'delivery');

  // Check task-done mapped to completed (historical Done cards must NEVER be bulk-labeled Released without deployment evidence)
  const doneCard = readCard(repo, 'task-done');
  assert.equal(doneCard.data.schema_version, 2);
  assert.equal(doneCard.data.delivery.state, 'completed');
  assert.equal(doneCard.data.delivery.completion_policy, 'completed');

  // Check task-build mapped to in_progress
  const buildCard = readCard(repo, 'task-build');
  assert.equal(buildCard.data.schema_version, 2);
  assert.equal(buildCard.data.delivery.state, 'in_progress');
  assert.equal(buildCard.data.delivery.completion_policy, 'released');

  // Check task-human mapped to in_review with blocker
  const humanCard = readCard(repo, 'task-human');
  assert.equal(humanCard.data.schema_version, 2);
  assert.equal(humanCard.data.delivery.state, 'in_review');
  assert.ok(humanCard.data.blocker);
  assert.equal(humanCard.data.blocker.evidence, 'Design approval needed');

  // Check delivery store records initialized
  const store = createDeliveryStore(deliveryStoreDirectory(repo), { enabled: true });
  const storeRec = store.read('task-build');
  assert.ok(storeRec);
  assert.equal(storeRec.task.id, 'task-build');
  assert.equal(storeRec.task.delivery.state, 'in_progress');

  // Now perform rollback
  const rollbackResult = rollbackDeliveryBoard(repo);
  assert.equal(rollbackResult.ok, true);

  // Verify rollback restored config and cards
  const rolledCfg = loadConfig(repo);
  assert.equal(rolledCfg.mode, 'launcher');

  const rolledBuild = readCard(repo, 'task-build');
  assert.equal(rolledBuild.data.status, 'Build');
  assert.equal(rolledBuild.data.schema_version, undefined);
  assert.equal(rolledBuild.data.delivery, undefined);
});
