import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolateHome, makeRepo, writeCard, tmp, useFakeAgent, clearFakeAgent, git } from './helpers.js';
import { seedDelivery } from './delivery-fixture.js';
import { deliveryRuntimeStatus, deliveryStoreDirectory } from '../src/delivery-runtime.js';
import * as board from '../src/board.js';
import * as pipeline from '../src/pipeline.js';
import * as scheduler from '../src/scheduler.js';
import { addProject } from '../src/registry.js';

afterEach(async () => { scheduler.resetState(); await pipeline.killAllChildren({ graceMs: 100 }); clearFakeAgent(); });
function fixture() {
  const home = isolateHome(), repo = makeRepo({ automaticMaintenance: false });
  writeCard(repo, 'task-0001', { status: 'Needs Human', extra: 'needs_human_reason: ci_failed\nworktree: todomd/task-0001\n' });
  return { home, repo, project: { name: path.basename(repo), path: repo }, id: 'task-0001' };
}

test('ordinary boards stay outside delivery management and reads create no private files', () => {
  const { repo, home } = fixture();
  assert.deepEqual(deliveryRuntimeStatus(repo, 'task-0001'), { managed: false, legacy_execution_allowed: true });
  assert.deepEqual(fs.readdirSync(home), []);
});

test('canonical aliases share ownership, expired leases stay held, and status excludes private evidence', () => {
  const { repo, id } = fixture(); seedDelivery(repo, id, { leased: true });
  const alias = path.join(tmp('delivery-alias'), 'project'); fs.symlinkSync(repo, alias);
  assert.equal(deliveryStoreDirectory(repo), deliveryStoreDirectory(alias));
  const status = deliveryRuntimeStatus(alias, id);
  assert.equal(status.code, 'delivery_execution_owned');
  assert.equal(status.lease.expired, true);
  assert.equal(status.ownership.implementation, 'agent-role:builder');
  assert.equal(status.legacy_execution_allowed, false);
  assert.doesNotMatch(JSON.stringify(status), /private-evidence|private-run|receipts|source_revision|\.todomd/);
});

test('transaction remnants, corrupt records and nonregular files never look like idle tasks', () => {
  const { repo, id } = fixture(), directory = deliveryStoreDirectory(repo);
  fs.mkdirSync(directory, { recursive: true });
  const lock = path.join(directory, `${id}.lock`), file = path.join(directory, `${id}.json`);
  fs.mkdirSync(lock);
  assert.equal(deliveryRuntimeStatus(repo, id).code, 'delivery_transaction_pending');
  fs.rmdirSync(lock); fs.writeFileSync(file, '{bad');
  assert.equal(deliveryRuntimeStatus(repo, id).code, 'delivery_state_unavailable');
  fs.unlinkSync(file); fs.mkdirSync(file);
  assert.equal(deliveryRuntimeStatus(repo, id).code, 'delivery_state_unavailable');
  fs.rmdirSync(file); fs.symlinkSync(path.join(directory, 'missing'), file);
  assert.equal(deliveryRuntimeStatus(repo, id).code, 'delivery_state_unavailable');
});

test('all scheduler columns defer managed tasks without claiming capacity or running callbacks', async () => {
  const { repo, id, project } = fixture(); seedDelivery(repo, id, { leased: true });
  let started = 0;
  const pending = ['Plan', 'Build', 'CI', 'Verify', 'Chat', 'Recovery', 'Triage'].map(column =>
    scheduler.schedule(project, id, column, () => { started++; }));
  assert.equal(started, 0);
  assert.ok(scheduler.queuedEntries(project.name).every(e => /delivery ownership/i.test(e.deferredReason)));
  await scheduler.schedule(project, 'task-0002', 'Build', () => { started++; });
  assert.equal(started, 1, 'unmanaged work can use the free slot');
  scheduler.forgetProject(project.name); await Promise.all(pending);
});

test('direct recovery, retriage, cancellation and agent entry points share the same hold', async () => {
  const { repo, id, project } = fixture(); useFakeAgent(); seedDelivery(repo, id);
  const before = fs.readFileSync(path.join(repo, '.todomd/tasks/task-0001-card.md'));
  for (const operation of [
    () => pipeline.humanMove(project, id, 'Review'), () => pipeline.humanMove(project, id, 'Planned'),
    () => pipeline.returnToBuild(project, id), () => pipeline.resumeBuild(project, id),
    () => pipeline.restartBuild(project, id), () => pipeline.retryVerification(project, id),
    () => pipeline.cancel(project, id), () => pipeline.promptCard(project, id, 'review'),
    () => pipeline.reviewAndProcessRecovery(project, id), () => pipeline.summarizeCard(project, id),
    () => pipeline.answerCard(project, id, 'yes'), () => pipeline.setCardInstruction(project, id, 'build'),
    () => pipeline.releaseCardResources(project, id),
  ]) {
    const result = await operation(); assert.equal(result.code, 'delivery_managed');
  }
  const actions = await pipeline.recoveryActions(project, id);
  for (const action of ['resume_build', 'restart_build', 'retry_verification', 'return_to_build', 'reset_attempts']) assert.equal(actions[action], false);
  assert.equal(actions.delivery_runtime.code, 'delivery_managed');
  assert.equal(pipeline.hasLiveRun(project.name, id), false);
  assert.equal(scheduler.isQueued(project.name, id), false);
  assert.deepEqual(fs.readFileSync(path.join(repo, '.todomd/tasks/task-0001-card.md')), before);
});

test('low-level card mutations and column rebalance cannot bypass delivery ownership', async () => {
  const { repo, id } = fixture(); seedDelivery(repo, id);
  writeCard(repo, 'task-0002', { status: 'Needs Human' });
  const file = path.join(repo, '.todomd/tasks/task-0001-card.md');
  const before = fs.readFileSync(file), head = git(repo, ['rev-parse', 'HEAD']);
  for (const operation of [
    () => board.moveCard(repo, id, 'Review'), () => board.patchFrontmatter(repo, id, { verification: { attempts: 0 } }),
    () => board.setArchived(repo, id, true), () => board.deleteCard(repo, id),
    () => board.reorderCards(repo, 'task-0002', id), () => board.appendRunLog(repo, id, 'reset'),
    () => board.attachCard(repo, id, 'a.txt', Buffer.from('changed')), () => board.commitCardChanges(repo, id, 'changed'),
  ]) assert.equal((await operation()).code, 'delivery_managed');
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(git(repo, ['rev-parse', 'HEAD']), head);
});

test('restart reconciliation preserves a managed candidate, attempt count and accepted remote journal', async () => {
  const { repo, id, project } = fixture(); useFakeAgent();
  writeCard(repo, id, { status: 'CI', extra: 'worktree: todomd/task-0001\n' });
  const file = path.join(repo, '.todomd/tasks/task-0001-card.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('attempts: 0', 'attempts: 3'));
  const journal = path.join(repo, '.todomd/worktrees/task-0001/fleet-runs/accepted.json');
  fs.mkdirSync(path.dirname(journal), { recursive: true }); fs.writeFileSync(journal, '{"phase":"accepted","run_id":"remote-1"}');
  seedDelivery(repo, id, { leased: true }); addProject(repo);
  const before = fs.readFileSync(file), head = git(repo, ['rev-parse', 'HEAD']);
  await pipeline.reconcileOnBoot();
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.readFileSync(journal, 'utf8'), '{"phase":"accepted","run_id":"remote-1"}');
  assert.equal(git(repo, ['rev-parse', 'HEAD']), head);
  assert.equal(pipeline.hasLiveRun(project.name, id), false);
  assert.equal(scheduler.isQueued(project.name, id), false);
});
