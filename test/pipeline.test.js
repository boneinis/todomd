import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, writeCard, isolateHome, useFakeAgent, clearFakeAgent, until, tmp, git } from './helpers.js';
import { readCard, setStageRouting, patchFrontmatter } from '../src/board.js';
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

test('stage routing precedence: a column agent gates the queue; a card agent overrides it', async () => {
  isolateHome();
  useFakeAgent({ verdict: 'pass', build: 'good' });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);

  // column-level Build agent is an unsupported vendor — proves the gate reads the
  // column tier (the board default_agent is the supported `claude`, yet it fails)
  await setStageRouting(repo, 'Build', { agent: 'gemini' });
  writeCard(repo, 'task-0001', { status: 'Planned' });
  await patchFrontmatter(repo, 'task-0001', { agent: '' }); // clear card override → column tier applies
  let r = await pipeline.humanMove(p, 'task-0001', 'Queue');
  assert.equal(r.ok, false);
  assert.match(r.error, /gemini.*not supported/);
  assert.equal(status(repo, 'task-0001'), 'Planned'); // didn't move

  // a card-level agent overrides the column → gate passes → chain runs to Done
  await patchFrontmatter(repo, 'task-0001', { agent: 'claude' });
  r = await pipeline.humanMove(p, 'task-0001', 'Queue');
  assert.equal(r.ok, true);
  await until(() => status(repo, 'task-0001') === 'Done', { timeout: 20000 });
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
  // generous timeouts: under full-suite CPU contention the spawn + marker write
  // can lag well past a few seconds, which is what made this test flaky
  await until(() => fs.existsSync(marker), { timeout: 30000 });
  const wt = path.join(repo, '.todomd/worktrees/task-0001');
  await until(() => fs.existsSync(wt), { timeout: 15000 });
  assert.ok(fs.existsSync(wt), 'worktree was created for the build');

  await pipeline.humanMove(p, 'task-0001', 'Review'); // cancels the live run
  // cancel cleanup is async (SIGTERM → child exit → worktree removal → status flip);
  // poll the end state instead of asserting on a single sample so load can't race it
  await until(() => status(repo, 'task-0001') === 'Review', { timeout: 30000 });
  await until(() => !fs.existsSync(wt), { timeout: 15000 });
  assert.ok(!fs.existsSync(wt), 'worktree removed on cancel (no leak)');
  await until(() => (readCard(repo, 'task-0001').data.worktree || '') === '', { timeout: 5000 });
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

test('chunking: a splitting plan fans out sequential child cards; approving the epic cascades them to Done', async () => {
  isolateHome();
  useFakeAgent({ verdict: 'pass', build: 'good', chunks: 2 });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0001', { title: 'big feature' });

  // drag to Plan → the plan agent emits ## Chunks → orchestrator fans out children
  await pipeline.humanMove(p, 'task-0001', 'Plan');
  await until(() => readCard(repo, 'task-0001').data.epic === true && status(repo, 'task-0001') === 'Planned', { timeout: 12000 });

  const epic = readCard(repo, 'task-0001').data;
  assert.equal(epic.children.length, 2);
  const [c1, c2] = epic.children;
  assert.equal(status(repo, c1), 'Planned');
  assert.equal(readCard(repo, c1).data.parent, 'task-0001');
  assert.deepEqual(readCard(repo, c1).data.dependencies, []);     // chunk 1: no deps
  assert.deepEqual(readCard(repo, c2).data.dependencies, [c1]);   // chunk 2 depends on chunk 1
  assert.match(readCard(repo, c1).body, /## Implementation Plan\n\n1\. Implement part 1\./); // pre-planned

  // one approval → the chunks build in order, the epic auto-completes
  const r = await pipeline.humanMove(p, 'task-0001', 'Queue');
  assert.equal(r.ok, true);
  assert.equal(status(repo, 'task-0001'), 'Queue'); // epic parks as a tracker
  await until(() => status(repo, c1) === 'Done', { timeout: 20000 });
  await until(() => status(repo, c2) === 'Done', { timeout: 20000 });
  await until(() => status(repo, 'task-0001') === 'Done', { timeout: 20000 });
  // the epic tracker itself never built — no worktree was ever created for it
  assert.ok(!fs.existsSync(path.join(repo, '.todomd/worktrees/task-0001')));
  clearFakeAgent();
});

test('chunking: a single-chunk plan is folded into Implementation Plan (not fanned out)', async () => {
  isolateHome();
  useFakeAgent({ verdict: 'pass', build: 'good', chunks: 1 });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0001', { title: 'single chunk feature' });

  await pipeline.humanMove(p, 'task-0001', 'Plan');
  await until(() => status(repo, 'task-0001') === 'Planned', { timeout: 12000 });

  const card = readCard(repo, 'task-0001');
  assert.equal(card.data.status, 'Planned');
  assert.equal(card.data.epic, undefined);
  assert.equal(card.data.children, undefined);
  assert.match(card.body, /## Implementation Plan\n\n1\. Implement part 1\./);
  assert.match(card.raw, /single-chunk plan folded into Implementation Plan/);
  clearFakeAgent();
});

test('chunking: approving a split-but-unmaterialized plan is refused (budget-mode safety net)', async () => {
  isolateHome();
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  // a plan that proposed chunks but was never fanned out (no epic flag) — e.g. a
  // budget-mode dispatcher set it Planned without creating child cards
  const chunks = '\n\n## Chunks\n\n```yaml\n- title: A\n  plan: do a\n  criteria:\n    - a works\n- title: B\n  plan: do b\n  criteria:\n    - b works\n```\n';
  writeCard(repo, 'task-0001', { status: 'Planned', body: chunks });

  const r = await pipeline.humanMove(p, 'task-0001', 'Queue');
  assert.equal(r.ok, false);
  assert.match(r.error, /split into chunks/);
  assert.equal(status(repo, 'task-0001'), 'Planned'); // refused, not moved/built
});

test('chunking: reconcileOnBoot re-releases an approved epic\'s ready chunk and never builds the epic', async () => {
  isolateHome();
  useFakeAgent({ verdict: 'pass', build: 'good' });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  addProject(repo);
  const p = project(repo);
  // simulate a crash right after epic approval: epic parked in Queue, chunk ready in Planned
  writeCard(repo, 'task-0001', { status: 'Queue', title: 'epic', extra: 'epic: true\nchildren: [task-0002]\n' });
  writeCard(repo, 'task-0002', { status: 'Planned', title: 'chunk', extra: 'parent: task-0001\n' });

  await pipeline.reconcileOnBoot();
  await until(() => status(repo, 'task-0002') === 'Done', { timeout: 20000 });
  await until(() => status(repo, 'task-0001') === 'Done', { timeout: 20000 });
  assert.ok(!fs.existsSync(path.join(repo, '.todomd/worktrees/task-0001')), 'epic tracker is never built');
  clearFakeAgent();
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

test('chunking cleanup: humanMove Review on an epic archives non-Done chunks, preserves Done chunks', async () => {
  isolateHome();
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'epic-001', { status: 'Queue', extra: 'epic: true\nchildren: [chunk-001, chunk-002]\n' });
  writeCard(repo, 'chunk-001', { status: 'Done', extra: 'parent: epic-001\n' });
  writeCard(repo, 'chunk-002', { status: 'Queue', extra: 'parent: epic-001\n' });

  const r = await pipeline.humanMove(p, 'epic-001', 'Review');
  assert.equal(r.ok, true);

  const c1 = readCard(repo, 'chunk-001');
  const c2 = readCard(repo, 'chunk-002');
  assert.equal(c1.data.status, 'Done', 'Done chunk status unchanged');
  assert.ok(!c1.data.archived, 'Done chunk not archived');
  assert.ok(c2.data.archived, 'non-Done chunk was archived');
});

test('chunking cleanup: cascadeEpicCleanup archives all non-Done children directly', async () => {
  isolateHome();
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'epic-001', { status: 'Queue', extra: 'epic: true\nchildren: [chunk-001, chunk-002, chunk-003]\n' });
  writeCard(repo, 'chunk-001', { status: 'Done', extra: 'parent: epic-001\n' });
  writeCard(repo, 'chunk-002', { status: 'Queue', extra: 'parent: epic-001\n' });
  writeCard(repo, 'chunk-003', { status: 'Build', extra: 'parent: epic-001\n' });

  await pipeline.cascadeEpicCleanup(p, 'epic-001');

  assert.ok(!readCard(repo, 'chunk-001').data.archived, 'Done chunk not archived');
  assert.ok(readCard(repo, 'chunk-002').data.archived, 'Queue chunk archived');
  assert.ok(readCard(repo, 'chunk-003').data.archived, 'Build chunk archived');
});

test('chunking cleanup: Done children preserved when epic is pulled back to Review', async () => {
  isolateHome();
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'epic-001', { status: 'Queue', extra: 'epic: true\nchildren: [chunk-001, chunk-002, chunk-003]\n' });
  writeCard(repo, 'chunk-001', { status: 'Done', extra: 'parent: epic-001\n' });
  writeCard(repo, 'chunk-002', { status: 'Done', extra: 'parent: epic-001\n' });
  writeCard(repo, 'chunk-003', { status: 'Needs Human', extra: 'parent: epic-001\n' });

  const r = await pipeline.humanMove(p, 'epic-001', 'Review');
  assert.equal(r.ok, true);

  assert.ok(!readCard(repo, 'chunk-001').data.archived, 'Done chunk-001 not archived');
  assert.ok(!readCard(repo, 'chunk-002').data.archived, 'Done chunk-002 not archived');
  assert.ok(readCard(repo, 'chunk-003').data.archived, 'Needs Human chunk archived');
});

test('cascadeEpicCleanup: live building child is archived (not Review) after cleanup', async () => {
  isolateHome();
  const marker = path.join(tmp('cascade'), 'started');
  useFakeAgent({ build: 'good', hang: '1', hang_marker: marker });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'epic-001', { status: 'Queue', extra: 'epic: true\nchildren: [chunk-001]\n' });
  writeCard(repo, 'chunk-001', { status: 'Planned', extra: 'parent: epic-001\n' });

  // start the child build — it hangs until SIGTERM
  await pipeline.humanMove(p, 'chunk-001', 'Queue');
  await until(() => status(repo, 'chunk-001') === 'Build' && fs.existsSync(marker), { timeout: 30000 });

  // trigger cascade while the child run is live
  await pipeline.cascadeEpicCleanup(p, 'epic-001');

  // cancel handler archives asynchronously after cleanup
  await until(() => readCard(repo, 'chunk-001').data.archived, { timeout: 15000 });
  const child = readCard(repo, 'chunk-001');
  assert.ok(child.data.archived, 'child is archived');
  assert.notEqual(child.data.status, 'Review', 'child never entered Review');
  clearFakeAgent();
});

test('killAllChildren stops a live agent child and reverts its card', async () => {
  isolateHome();
  const marker = path.join(tmp('killall'), 'started');
  useFakeAgent({ build: 'good', hang: '1', hang_marker: marker }); // build hangs until killed
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Planned' });

  await pipeline.humanMove(p, 'task-0001', 'Queue');
  await until(() => fs.existsSync(marker), { timeout: 30000 });
  assert.ok(pipeline.hasLiveRun(p.name, 'task-0001'), 'build is live');

  await pipeline.killAllChildren();
  assert.equal(pipeline.hasLiveRun(p.name, 'task-0001'), false, 'no live run after killAllChildren');
  // the kill went through the normal cancel path: the card reverts out of Build
  await until(() => status(repo, 'task-0001') === 'Queue', { timeout: 15000 });
  clearFakeAgent();
});

test('killAllChildren SIGKILLs a child that ignores SIGTERM', async () => {
  isolateHome();
  const marker = path.join(tmp('killall-stubborn'), 'started');
  useFakeAgent({ build: 'good', hang: '1', hang_marker: marker, ignore_term: '1' });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Planned' });

  await pipeline.humanMove(p, 'task-0001', 'Queue');
  await until(() => fs.existsSync(marker), { timeout: 30000 });

  const t0 = Date.now();
  await pipeline.killAllChildren({ graceMs: 300 });
  assert.equal(pipeline.hasLiveRun(p.name, 'task-0001'), false, 'stubborn child force-killed');
  assert.ok(Date.now() - t0 < 5000, 'did not hang on the stubborn child');
  clearFakeAgent();
});

test('base-branch guard: switching branches mid-run blocks the merge, work preserved', async () => {
  isolateHome();
  const repo = makeRepo();
  const base = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  // the fake agent checks out a new branch in the main repo during Verify,
  // just before the orchestrator would merge
  useFakeAgent({ verdict: 'pass', build: 'good', switch_repo: repo, switch_branch: 'switched' });
  pipeline.init({ broadcast: noop });
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Planned' });

  await pipeline.humanMove(p, 'task-0001', 'Queue');
  await until(() => status(repo, 'task-0001') === 'Needs Human', { timeout: 20000 });

  const card = readCard(repo, 'task-0001');
  assert.equal(card.data.needs_human_reason, 'base_branch_moved');
  assert.equal(card.data.base_branch, base, 'fork-time base branch recorded');
  // nothing merged anywhere — not on the base, not on the switched-to branch
  assert.doesNotMatch(git(repo, ['log', '--oneline', base]), /merge task-0001/);
  assert.doesNotMatch(git(repo, ['log', '--oneline', 'switched']), /merge task-0001/);
  // the worktree and its branch are preserved — nothing is lost
  assert.ok(fs.existsSync(path.join(repo, '.todomd/worktrees/task-0001')), 'worktree preserved');
  assert.match(git(repo, ['branch', '--list', 'todomd/task-0001']), /todomd\/task-0001/, 'task branch preserved');
  clearFakeAgent();
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

test('stage timeout: a hung build is killed and the card lands in Needs Human (run_timeout)', async () => {
  isolateHome();
  const marker = path.join(tmp('timeout'), 'started');
  useFakeAgent({ build: 'good', hang: '1', hang_marker: marker }); // build hangs forever
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  // a ~3s stage cap so the test doesn't wait out the 45m default (long enough
  // for the fake agent to boot and start its hang — a shorter cap races it)
  fs.appendFileSync(path.join(repo, '.todomd/config.yml'), 'stage_timeout_min: 0.05\n');
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Planned' });

  await pipeline.humanMove(p, 'task-0001', 'Queue');
  await until(() => fs.existsSync(marker), { timeout: 30000 }); // build is live and hung
  await until(() => status(repo, 'task-0001') === 'Needs Human', { timeout: 15000 });

  const card = readCard(repo, 'task-0001');
  assert.equal(card.data.needs_human_reason, 'run_timeout');
  assert.equal(pipeline.hasLiveRun(p.name, 'task-0001'), false, 'hung child was killed, slot freed');
  clearFakeAgent();
});

test('cancel escalates to SIGKILL when the child ignores SIGTERM', async () => {
  isolateHome();
  const marker = path.join(tmp('cancel-stubborn'), 'started');
  useFakeAgent({ build: 'good', hang: '1', hang_marker: marker, ignore_term: '1' });
  process.env.TODOMD_KILL_GRACE_MS = '300'; // shrink the 10s backstop for the test
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Planned' });

  await pipeline.humanMove(p, 'task-0001', 'Queue');
  await until(() => fs.existsSync(marker), { timeout: 30000 });

  await pipeline.humanMove(p, 'task-0001', 'Review'); // cancels the stubborn run
  // without the SIGKILL backstop the close handler never fires and the card
  // never reverts — poll the end state, don't sample once
  await until(() => status(repo, 'task-0001') === 'Review' && !pipeline.hasLiveRun(p.name, 'task-0001'), { timeout: 15000 });
  delete process.env.TODOMD_KILL_GRACE_MS;
  clearFakeAgent();
});

test('cancel during Verify re-enqueues the build — the card resumes to Done on its own', async () => {
  isolateHome();
  const marker = path.join(tmp('verifyhang'), 'started');
  useFakeAgent({ build: 'good', verdict: 'pass', hang: 'verify', hang_marker: marker }); // verify hangs once
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Planned' });

  await pipeline.humanMove(p, 'task-0001', 'Queue');
  await until(() => status(repo, 'task-0001') === 'Verify' && fs.existsSync(marker), { timeout: 30000 });

  assert.equal(pipeline.cancel(p, 'task-0001').ok, true);
  // the cancel reverts to Queue and re-enqueues: build #2 runs (the hang fired
  // once), verify passes, the card lands in Done with no human action
  await until(() => status(repo, 'task-0001') === 'Done', { timeout: 30000 });
  assert.ok((readCard(repo, 'task-0001').data.verification.attempts || 0) >= 2,
    'a second build attempt ran after the cancel');
  clearFakeAgent();
});

test('pipeline error: an unexpected throw in buildChain lands in Needs Human (pipeline_error) with a banner', async () => {
  isolateHome();
  useFakeAgent({ build: 'good', verdict: 'pass' });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Planned' });
  // codex inlines the stage command file — removing it makes stagePrompt throw
  // mid-chain (after the worktree exists), an unexpected buildChain failure
  await patchFrontmatter(repo, 'task-0001', { agent: 'codex' });
  fs.rmSync(path.join(repo, '.claude/commands/todomd-build.md'));

  const r = await pipeline.humanMove(p, 'task-0001', 'Queue'); // codex is a supported vendor → gate passes
  assert.equal(r.ok, true);
  await until(() => status(repo, 'task-0001') === 'Needs Human', { timeout: 15000 });

  const card = readCard(repo, 'task-0001');
  assert.equal(card.data.needs_human_reason, 'pipeline_error');
  assert.equal(pipeline.hasLiveRun(p.name, 'task-0001'), false, 'no phantom live run');
  assert.ok(pipeline.getBanners().some((b) => b.level === 'error' && /pipeline error/.test(b.text)),
    'an error banner is set instead of vanishing silently');
  clearFakeAgent();
});
