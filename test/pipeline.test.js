import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, writeCard, isolateHome, useFakeAgent, clearFakeAgent, until, tmp } from './helpers.js';
import { readCard } from '../src/board.js';
import { addProject } from '../src/registry.js';
import * as pipeline from '../src/pipeline.js';

const noop = () => {};
// unique project name per repo — the pipeline module keys queue/run state by name
function project(repo) { return { name: path.basename(repo), path: repo }; }
const status = (repo, id) => readCard(repo, id).data.status;

test('happy path: Review → Plan → Planned → Queue → Build → Verify → Done, merged + worktree pruned', async () => {
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
  r = await pipeline.humanMove(p, 'task-0001', 'Queue');
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
  await pipeline.humanMove(p, 'task-0002', 'Queue');

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
  await pipeline.humanMove(p, 'task-0003', 'Queue');
  await until(() => status(repo, 'task-0003') === 'Needs Human', { timeout: 25000 });

  const card = readCard(repo, 'task-0003');
  assert.equal(card.data.needs_human_reason, 'attempts_exhausted');
  assert.ok((card.data.verification.attempts || 0) <= 3);
  clearFakeAgent();
});

test('worktree env: a verify setup_error → Needs Human (worktree_env) on attempt 1, no wasted retries', async () => {
  isolateHome();
  // the verify command "can't even run" — should escalate distinctly and at once,
  // not burn all attempts ending in a generic attempts_exhausted
  useFakeAgent({ verdict: 'fail', build: 'good', setup_error: 'Cannot find module "dotenv"' });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0003');

  await pipeline.humanMove(p, 'task-0003', 'Plan');
  await until(() => status(repo, 'task-0003') === 'Planned');
  await pipeline.humanMove(p, 'task-0003', 'Queue');
  await until(() => status(repo, 'task-0003') === 'Needs Human', { timeout: 25000 });

  const card = readCard(repo, 'task-0003');
  assert.equal(card.data.needs_human_reason, 'worktree_env');
  assert.equal(card.data.verification.attempts, 1, 'escalates on the first verify, not after the attempt cap');
  clearFakeAgent();
});

test('cancel mid-build cleans the worktree and clears the worktree frontmatter', async () => {
  isolateHome();
  const marker = path.join(tmp('hang'), 'started');
  useFakeAgent({ build: 'good', hang: '1', hang_marker: marker }); // build hangs until SIGTERM
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Planned' });

  await pipeline.humanMove(p, 'task-0001', 'Queue'); // launcher drives → Build (then hangs)
  await until(() => status(repo, 'task-0001') === 'Build' && fs.existsSync(marker), { timeout: 15000 });
  const wt = path.join(repo, '.todomd/worktrees/task-0001');
  assert.ok(fs.existsSync(wt), 'worktree was created for the build');

  await pipeline.humanMove(p, 'task-0001', 'Review'); // cancels the live run
  await until(() => status(repo, 'task-0001') === 'Review', { timeout: 15000 });
  assert.ok(!fs.existsSync(wt), 'worktree removed on cancel (no leak)');
  assert.equal(readCard(repo, 'task-0001').data.worktree || '', '', 'worktree frontmatter cleared');
  clearFakeAgent();
});

test('agent question → Needs Human (needs_answer); answering re-drives the build → Done', async () => {
  isolateHome();
  const marker = path.join(tmp('q'), 'asked');
  useFakeAgent({ build: 'good', verdict: 'pass', question: 'default the widget on or off?', question_marker: marker });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Planned' });

  await pipeline.humanMove(p, 'task-0001', 'Queue'); // build → verify asks a question
  await until(() => status(repo, 'task-0001') === 'Needs Human', { timeout: 20000 });
  let card = readCard(repo, 'task-0001');
  assert.equal(card.data.needs_human_reason, 'needs_answer');
  assert.match(card.data.question || '', /on or off/);

  // answer → threads the decision into the next build → verify passes → Done
  assert.equal((await pipeline.answerCard(p, 'task-0001', 'default to ON')).ok, true);
  await until(() => status(repo, 'task-0001') === 'Done', { timeout: 20000 });
  card = readCard(repo, 'task-0001');
  assert.equal(card.data.question || '', '', 'question cleared after answering');
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
  const blocked = await pipeline.humanMove(p, 'task-0012', 'Queue');
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /blocked/);
});

test('quota: build hits a usage limit → card parks in Queue + project paused; resume completes it', async () => {
  isolateHome();
  const repo = makeRepo();
  const p = project(repo);
  const marker = path.join(repo, '.quota-marker'); // build quotas once, then succeeds
  useFakeAgent({ verdict: 'pass', build: 'good', quota_marker: marker });
  pipeline.init({ broadcast: noop });
  writeCard(repo, 'task-0001', { status: 'Planned' });

  // approve → build hits quota → parked back in Queue, project paused
  await pipeline.humanMove(p, 'task-0001', 'Queue');
  await until(() => pipeline.usage(p.name).quota_paused === true, { timeout: 10000 });
  assert.equal(status(repo, 'task-0001'), 'Queue'); // parked, not Needs Human
  const ver = readCard(repo, 'task-0001').data.verification;
  assert.ok((ver.attempts || 0) <= 1, 'quota must not burn an attempt'); // rolled back

  // resume → build now succeeds → full chain to Done
  pipeline.resumeQueues([p]);
  await until(() => status(repo, 'task-0001') === 'Done', { timeout: 20000 });
  assert.equal(pipeline.usage(p.name).quota_paused, false);
  clearFakeAgent();
});

test('triage commits the card so the working tree stays clean (with triage enabled)', async () => {
  isolateHome();
  useFakeAgent({ verdict: 'pass', build: 'good' });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo({ triage: true });
  const p = project(repo);
  // create via the board path so triage auto-fires (like the API does)
  const { createCard } = await import('../src/board.js');
  const card = await createCard(repo, { title: 'Triage commit test', description: 'x', criteria: ['y'] });
  await pipeline.maybeTriage(p, card.id);
  await until(() => readCard(repo, card.id).data.triaged && readCard(repo, card.id).data.triaged !== 'running', { timeout: 12000 });
  // after triage, the working tree must have no uncommitted .todomd changes
  const { execFileSync } = await import('node:child_process');
  const dirty = execFileSync('git', ['status', '--porcelain', '--', '.todomd'], { cwd: repo, encoding: 'utf8' }).trim();
  assert.equal(dirty, '', `triage left uncommitted board changes:\n${dirty}`);
});

test('forgetProject + projectHasLiveRun', async () => {
  pipeline.init({ broadcast: noop });
  assert.equal(pipeline.projectHasLiveRun('nope'), false);
  pipeline.forgetProject('nope'); // no-op, must not throw
});

test('coordination: a card claims ACTIVE.md while building and releases it on Done', async () => {
  isolateHome();
  useFakeAgent({ verdict: 'pass', build: 'good' });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  // enable coordination in this repo's config
  const cfgPath = path.join(repo, '.todomd/config.yml');
  fs.writeFileSync(cfgPath, fs.readFileSync(cfgPath, 'utf8') + '\ncoordination:\n  enabled: true\n');
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Planned' });

  let claimedDuringBuild = false;
  // poll the manifest while the card runs
  const watch = setInterval(() => {
    try {
      const md = fs.readFileSync(path.join(repo, '.todomd/ACTIVE.md'), 'utf8');
      if (/task-0001/.test(md)) claimedDuringBuild = true;
    } catch {}
  }, 50);

  await pipeline.humanMove(p, 'task-0001', 'Queue');
  await until(() => status(repo, 'task-0001') === 'Done', { timeout: 20000 });
  clearInterval(watch);

  assert.ok(claimedDuringBuild, 'card should appear in ACTIVE.md while building');
  // released on Done — manifest no longer lists it
  const final = fs.readFileSync(path.join(repo, '.todomd/ACTIVE.md'), 'utf8');
  assert.doesNotMatch(final, /task-0001/, 'claim must be released on Done');
  clearFakeAgent();
});

test('coordination: claim is released when a card is pulled back to Review', async () => {
  isolateHome();
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const cfgPath = path.join(repo, '.todomd/config.yml');
  fs.writeFileSync(cfgPath, fs.readFileSync(cfgPath, 'utf8') + '\ncoordination:\n  enabled: true\n');
  const p = project(repo);
  // a quota-parked-style card: Queue with an active claim, no live run
  writeCard(repo, 'task-0001', { status: 'Queue' });
  const { claim, readAllClaims } = await import('../src/coordination.js');
  await claim(repo, { card: 'task-0001', title: 'x', branch: 'todomd/task-0001', worker: 'me@h', files: ['src/a.js'] }, {});
  assert.equal((await readAllClaims(repo, {})).length, 1);
  // human drags it back to Review → claim must be released
  await pipeline.humanMove(p, 'task-0001', 'Review');
  assert.equal((await readAllClaims(repo, {})).length, 0, 'claim released on retriage');
});

test('coordination: reconcileOnBoot prunes a stale claim for a card no longer building', async () => {
  isolateHome();
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const cfgPath = path.join(repo, '.todomd/config.yml');
  fs.writeFileSync(cfgPath, fs.readFileSync(cfgPath, 'utf8') + '\ncoordination:\n  enabled: true\n');
  (await import('../src/registry.js')).addProject(repo);
  // card is in Done, but a stale claim lingers (server died before release)
  writeCard(repo, 'task-0001', { status: 'Done' });
  const { claim, readAllClaims } = await import('../src/coordination.js');
  await claim(repo, { card: 'task-0001', title: 'x', branch: 'b', worker: 'me@h', files: ['src/a.js'] }, {});
  await pipeline.reconcileOnBoot();
  assert.equal((await readAllClaims(repo, {})).length, 0, 'stale claim pruned on boot');
});

test('reconcileOnBoot retries a transient-failure triage (cli_missing) once the CLI is back', async () => {
  isolateHome();
  useFakeAgent(); // triage now succeeds
  pipeline.init({ broadcast: noop });
  const repo = makeRepo({ triage: true });
  addProject(repo); // reconcileOnBoot iterates registered projects
  // a Review card whose triage failed earlier because claude wasn't on PATH
  writeCard(repo, 'task-0001', { extra: 'triaged: failed (cli_missing)\n' });

  await pipeline.reconcileOnBoot(); // resets the transient stamp + re-sweeps
  await until(() => {
    const t = readCard(repo, 'task-0001').data.triaged;
    return t && !String(t).startsWith('failed') && t !== 'running';
  }, { timeout: 12000 });
  const t = readCard(repo, 'task-0001').data.triaged; // a date (success), not a failure marker
  assert.ok(t && !String(t).startsWith('failed') && t !== 'running', 're-triaged after the transient failure');
  clearFakeAgent();
});
