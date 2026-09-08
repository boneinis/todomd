import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, writeCard, isolateHome, useFakeAgent, clearFakeAgent, until, tmp, git, BUDGET } from './helpers.js';
import { readCard, normalizeConfig } from '../src/board.js';
import { createGovernor, resourcesConfig } from '../src/resources.js';
import * as pipeline from '../src/pipeline.js';
import * as scheduler from '../src/scheduler.js';

beforeEach(() => { isolateHome(); scheduler.resetState(); pipeline.init({ broadcast: () => {} }); });
afterEach(async () => { await pipeline.killAllChildren({ graceMs: 1000 }); clearFakeAgent(); scheduler.resetState(); });
const project = (repo) => ({ name: path.basename(repo), path: repo });
const status = (repo, id) => readCard(repo, id)?.data.status;

for (const stage of ['Plan', 'Triage']) test(`${stage} burst respects the column cap and queued cancellation needs no capacity`, async () => {
  useFakeAgent({ hang: stage.toLowerCase() });
  const repo = makeRepo({ triage: true });
  const p = project(repo);
  const cfg = path.join(repo, '.todomd/config.yml');
  fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace('concurrency: 1', 'concurrency: 5'));
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'higher project cap']);
  const ids = ['task-0001', 'task-0002', 'task-0003'];
  for (const id of ids) writeCard(repo, id);
  const promises = [];
  for (const id of ids) {
    if (stage === 'Plan') await pipeline.humanMove(p, id, 'Plan');
    else promises.push(pipeline.maybeTriage(p, id));
  }
  await until(() => scheduler.queuedEntries(p.name).length === 2, { timeout: BUDGET.stage });
  assert.equal(normalizeConfig({}).scheduler.columns[stage], 1);
  assert.equal(pipeline.getRunStates(p.name)['task-0002'].stage, stage);
  assert.equal((await pipeline.cancel(p, 'task-0002')).ok, true);
  await until(() => !pipeline.hasLiveRun(p.name, 'task-0002'));
  assert.equal(status(repo, 'task-0002'), 'Review');
  assert.equal(scheduler.queuedEntries(p.name).length, 1);
  await pipeline.killAllChildren({ graceMs: 1000 });
  await Promise.all(promises);
});

for (const stage of ['Plan', 'Triage']) test(`${stage} obeys resource deferral and cancels while pressure remains`, async () => {
  useFakeAgent();
  const repo = makeRepo({ triage: true }); const p = project(repo);
  scheduler.setGovernor(createGovernor({ thresholds: resourcesConfig({}), sample: () => ({ memoryPressure: 0.99, cpuLoad: 0.1, diskFreeGb: 20 }) }));
  writeCard(repo, 'task-0001');
  let pending;
  if (stage === 'Plan') await pipeline.humanMove(p, 'task-0001', 'Plan');
  else pending = pipeline.maybeTriage(p, 'task-0001');
  await until(() => scheduler.queuedEntries(p.name).some((q) => q.deferredReason));
  assert.match(scheduler.queuedEntries(p.name)[0].deferredReason, /memory/);
  await pipeline.cancel(p, 'task-0001');
  await until(() => !pipeline.hasLiveRun(p.name, 'task-0001'));
  await pending;
  assert.equal(status(repo, 'task-0001'), 'Review');
});

for (const mode of ['noop', 'docs', 'good']) test(`CI classifies ${mode} candidate without a false empty pass`, async () => {
  useFakeAgent({ build: mode, verdict: 'pass' });
  const repo = makeRepo(); const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Planned' });
  await pipeline.humanMove(p, 'task-0001', 'Queue');
  await until(() => ['Done', 'Needs Human'].includes(status(repo, 'task-0001')), { timeout: BUDGET.chain });
  const card = readCard(repo, 'task-0001');
  if (mode === 'noop') {
    assert.equal(card.data.needs_human_reason, 'nothing_to_test');
    assert.match(card.raw, /nothing to test/);
    assert.ok(!card.data.ci_evidence?.head);
    assert.doesNotMatch(card.raw, /CI attempt.*passed|Verify attempt/);
  } else assert.equal(card.data.status, 'Done', card.raw);
});

test('zero-turn empty response is rejected even if a provider changed files', async () => {
  useFakeAgent({ build: 'good', turns: 0, empty_result: 1 });
  const repo = makeRepo(); const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Planned' });
  await pipeline.humanMove(p, 'task-0001', 'Queue');
  await until(() => status(repo, 'task-0001') === 'Needs Human', { timeout: BUDGET.chain });
  assert.equal(readCard(repo, 'task-0001').data.needs_human_reason, 'empty_run');
});

test('Verify setup limitation preserves a passing candidate without another Build', async () => {
  const argv = path.join(tmp('verify-argv'), 'args.jsonl');
  useFakeAgent({ build: 'good', verdict: 'fail', setup_error: 'Shell-only inspection is unavailable', argv_log: argv });
  const repo = makeRepo(); const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Planned' });
  await pipeline.humanMove(p, 'task-0001', 'Queue');
  await until(() => status(repo, 'task-0001') === 'Needs Human', { timeout: BUDGET.chain });
  const card = readCard(repo, 'task-0001');
  assert.ok(['worktree_env', 'verification_incomplete'].includes(card.data.needs_human_reason));
  assert.equal((card.raw.match(/Build attempt/g) || []).length, 1);
  assert.ok(card.data.ci_evidence?.head);
  assert.match(fs.readFileSync(argv, 'utf8'), /Read-only inspection.*git diff/);
  assert.doesNotMatch(fs.readFileSync(argv, 'utf8'), /or other local processes/);
});

test('a failed Verify with no defect cannot requeue Build', async () => {
  useFakeAgent({ build: 'good', verdict: 'fail', criteria_met: 1, findings: '' });
  const repo = makeRepo(); const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Planned' });
  await pipeline.humanMove(p, 'task-0001', 'Queue');
  await until(() => status(repo, 'task-0001') === 'Needs Human', { timeout: BUDGET.chain });
  assert.equal(readCard(repo, 'task-0001').data.needs_human_reason, 'bad_verdict');
  assert.equal((readCard(repo, 'task-0001').raw.match(/Build attempt/g) || []).length, 1);
});

test('a Build whose commit hit a transient index lock completes using its staged candidate', async () => {
  const marker = path.join(tmp('commit-lock'), 'path');
  useFakeAgent({ build: 'good', verdict: 'pass', build_index_lock: marker });
  const repo = makeRepo(); const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Planned' });
  await pipeline.humanMove(p, 'task-0001', 'Queue');
  await until(() => fs.existsSync(marker));
  const lock = fs.readFileSync(marker, 'utf8');
  fs.unlinkSync(lock); // the fixture is the owner; production never removes it
  await until(() => ['Done', 'Needs Human'].includes(status(repo, 'task-0001')), { timeout: BUDGET.chain });
  const card = readCard(repo, 'task-0001');
  assert.equal(card.data.status, 'Done', card.raw);
  assert.match(card.raw, /recovered index-lock collision/);
  assert.equal(fs.readFileSync(path.join(repo, 'src/calc.js'), 'utf8').split('export function prod').length, 2);
});

test('persistent commit lock preserves paths and Resume Build commits without repeating implementation', async () => {
  const marker = path.join(tmp('persistent-commit-lock'), 'path');
  useFakeAgent({ build: 'good', verdict: 'pass', build_index_lock: marker });
  const repo = makeRepo(); const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Planned' });
  await pipeline.humanMove(p, 'task-0001', 'Queue');
  await until(() => status(repo, 'task-0001') === 'Needs Human', { timeout: BUDGET.chain });
  let card = readCard(repo, 'task-0001');
  assert.equal(card.data.needs_human_reason, 'uncommitted_build');
  assert.equal(card.data.build_commit_pending, true);
  assert.deepEqual(card.data.build_staged_paths, ['src/calc.js', 'src/prod.test.js']);
  fs.unlinkSync(fs.readFileSync(marker, 'utf8'));
  await until(async () => (await pipeline.recoveryActions(p, 'task-0001')).resume_build);
  assert.equal((await pipeline.resumeBuild(p, 'task-0001')).ok, true);
  await until(() => status(repo, 'task-0001') === 'Done', { timeout: BUDGET.chain });
  card = readCard(repo, 'task-0001');
  assert.match(card.raw, /without restarting the agent/);
  assert.equal(fs.readFileSync(path.join(repo, 'src/calc.js'), 'utf8').split('export function prod').length, 2);
});

test('cancelling a preserved commit retry keeps its candidate and cancellation reason', async () => {
  const marker = path.join(tmp('cancel-commit-lock'), 'path');
  useFakeAgent({ build: 'good', verdict: 'pass', build_index_lock: marker });
  const repo = makeRepo(); const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Planned' });
  await pipeline.humanMove(p, 'task-0001', 'Queue');
  await until(() => status(repo, 'task-0001') === 'Needs Human', { timeout: BUDGET.chain });
  await until(async () => (await pipeline.recoveryActions(p, 'task-0001')).resume_build);
  assert.equal((await pipeline.resumeBuild(p, 'task-0001')).ok, true);
  await until(() => status(repo, 'task-0001') === 'Build');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await pipeline.cancel(p, 'task-0001')).ok, true);
  await until(() => !pipeline.hasLiveRun(p.name, 'task-0001'));
  const card = readCard(repo, 'task-0001');
  assert.equal(card.data.needs_human_reason, 'build_cancelled');
  assert.equal(card.data.build_commit_pending, true);
  assert.ok(fs.existsSync(fs.readFileSync(marker, 'utf8')));
  assert.doesNotMatch(card.raw, /CI attempt.*passed|Verify attempt/);
});
