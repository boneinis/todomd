import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, writeCard, isolateHome, useFakeAgent, clearFakeAgent, until } from './helpers.js';
import { readCard } from '../src/board.js';
import * as pipeline from '../src/pipeline.js';

const noop = () => {};
// unique project name per repo — the pipeline module keys queue/run state by name
function project(repo) { return { name: path.basename(repo), path: repo }; }
const status = (repo, id) => readCard(repo, id).data.status;

test('happy path: Review → Plan → Planned → Assigned → Build → Verify → Done, merged + worktree pruned', async () => {
  isolateHome();
  useFakeAgent({ verdict: 'pass', build: 'good' });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0001');

  // human drags to Plan → orchestrator runs plan → Planned
  let r = await pipeline.humanMove(p, 'task-0001', 'Plan');
  assert.equal(r.ok, true);
  await until(() => status(repo, 'task-0001') === 'Planned');

  // approve → the full automatic chain
  r = await pipeline.humanMove(p, 'task-0001', 'Assigned');
  assert.equal(r.ok, true);
  await until(() => status(repo, 'task-0001') === 'Done', { timeout: 15000 });

  // the build's code was merged to main, the worktree was pruned
  assert.match(fs.readFileSync(path.join(repo, 'src/calc.js'), 'utf8'), /export function prod/);
  assert.ok(!fs.existsSync(path.join(repo, '.todomd/worktrees/task-0001')));
  assert.equal(readCard(repo, 'task-0001').data.verification.last_verdict, 'pass');
  clearFakeAgent();
});

test('verification loop: fail then pass on retry → Done', async () => {
  isolateHome();
  // build writes wrong code first; we flip the verdict after the first verify
  useFakeAgent({ verdict: 'fail', build: 'good' });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0002');

  await pipeline.humanMove(p, 'task-0002', 'Plan');
  await until(() => status(repo, 'task-0002') === 'Planned');
  await pipeline.humanMove(p, 'task-0002', 'Assigned');

  // wait until at least one verify failed and a retry incremented attempts
  await until(() => (readCard(repo, 'task-0002').data.verification?.attempts || 0) >= 2, { timeout: 15000 });
  process.env.FAKE_VERDICT = 'pass'; // next verify passes
  await until(() => status(repo, 'task-0002') === 'Done', { timeout: 20000 });
  clearFakeAgent();
});

test('attempt cap: persistent fail → Needs Human with a reason, attempts not exceeded', async () => {
  isolateHome();
  useFakeAgent({ verdict: 'fail', build: 'good' });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0003');

  await pipeline.humanMove(p, 'task-0003', 'Plan');
  await until(() => status(repo, 'task-0003') === 'Planned');
  await pipeline.humanMove(p, 'task-0003', 'Assigned');
  await until(() => status(repo, 'task-0003') === 'Needs Human', { timeout: 25000 });

  const card = readCard(repo, 'task-0003');
  assert.equal(card.data.needs_human_reason, 'attempts_exhausted');
  assert.ok((card.data.verification.attempts || 0) <= 3);
  clearFakeAgent();
});

test('agent error → Needs Human (agent_error)', async () => {
  isolateHome();
  useFakeAgent({ fail: 1 });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0004');

  await pipeline.humanMove(p, 'task-0004', 'Plan');
  await until(() => status(repo, 'task-0004') === 'Needs Human', { timeout: 12000 });
  clearFakeAgent();
});

test('transition table: humans cannot drop into orchestrator-only columns', async () => {
  isolateHome();
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0005');

  for (const col of ['Done', 'Build', 'Verify', 'Planned']) {
    const r = await pipeline.humanMove(p, 'task-0005', col);
    assert.equal(r.ok, false, `${col} should be rejected for a human`);
  }
  assert.equal(status(repo, 'task-0005'), 'Review');
});

test('dependency gate: approval blocked until deps are Done', async () => {
  isolateHome();
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0010', { status: 'Done' });          // dependency, done
  writeCard(repo, 'task-0011', { status: 'Done' });          // dependency, done
  writeCard(repo, 'task-0012', { status: 'Planned', deps: ['task-0010', 'task-0099'] });
  // task-0099 doesn't exist → not Done → blocked
  const blocked = await pipeline.humanMove(p, 'task-0012', 'Assigned');
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /blocked/);
});

test('quota: build hits a usage limit → card parks in Assigned + project paused; resume completes it', async () => {
  isolateHome();
  const repo = makeRepo();
  const p = project(repo);
  const marker = path.join(repo, '.quota-marker'); // build quotas once, then succeeds
  useFakeAgent({ verdict: 'pass', build: 'good', quota_marker: marker });
  pipeline.init({ broadcast: noop });
  writeCard(repo, 'task-0001', { status: 'Planned' });

  // approve → build hits quota → parked back in Assigned, project paused
  await pipeline.humanMove(p, 'task-0001', 'Assigned');
  await until(() => pipeline.usage(p.name).quota_paused === true, { timeout: 10000 });
  assert.equal(status(repo, 'task-0001'), 'Assigned'); // parked, not Needs Human
  const ver = readCard(repo, 'task-0001').data.verification;
  assert.ok((ver.attempts || 0) <= 1, 'quota must not burn an attempt'); // rolled back

  // resume → build now succeeds → full chain to Done
  pipeline.resumeQueues([p]);
  await until(() => status(repo, 'task-0001') === 'Done', { timeout: 20000 });
  assert.equal(pipeline.usage(p.name).quota_paused, false);
  clearFakeAgent();
});
