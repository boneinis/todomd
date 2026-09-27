import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { makeRepo, writeCard, isolateHome, useFakeAgent, clearFakeAgent, until, tmp, git, sleep, BUDGET } from './helpers.js';
import { readCard, loadBoard, setStageRouting, patchFrontmatter, withRepoLock, readRunLog } from '../src/board.js';
import { addProject } from '../src/registry.js';
import { createGovernor, resourcesConfig } from '../src/resources.js';
import * as pipeline from '../src/pipeline.js';
import * as voice from '../src/voice.js';
import * as scheduler from '../src/scheduler.js';

const noop = () => {};
const FAKE_CODEX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/fake-codex.js');
// unique project name per repo — the pipeline module keys queue/run state by name
function project(repo) { return { name: path.basename(repo), path: repo }; }
const status = (repo, id) => readCard(repo, id).data.status;

// Several tests here spawn an agent that hangs until it's signalled. A live
// child process is a ref'd handle: if any test leaves one behind (a cancel path
// that didn't fire, an early assertion failure), this process never exits and
// the whole suite stalls with no failure to point at. Sweep at the end.
after(async () => { try { await pipeline.killAllChildren({ graceMs: 1000 }); } catch { /* best effort */ } });

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
  assert.equal(r.ok, true, r.error);
  await until(() => status(repo, 'task-0001') === 'Done', { timeout: BUDGET.stage });

  // the build's code was merged to main, the worktree was pruned
  assert.match(fs.readFileSync(path.join(repo, 'src/calc.js'), 'utf8'), /export function prod/);
  assert.ok(!fs.existsSync(path.join(repo, '.todomd/worktrees/task-0001')));
  assert.equal(readCard(repo, 'task-0001').data.verification.last_verdict, 'pass');
  clearFakeAgent();
});

test('reordering Queue cards reprioritizes the live scheduler', async () => {
  isolateHome();
  const marker = path.join(tmp('priority-queue'), 'first-build');
  useFakeAgent({ hang: 'build', hang_marker: marker, verdict: 'pass', build: 'good' });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Planned' });
  writeCard(repo, 'task-0002', { status: 'Planned' });
  writeCard(repo, 'task-0003', { status: 'Planned' });

  try {
    await pipeline.humanMove(p, 'task-0001', 'Queue');
    await until(() => fs.existsSync(marker) && status(repo, 'task-0001') === 'Build', { timeout: BUDGET.stage });
    await pipeline.humanMove(p, 'task-0002', 'Queue');
    await pipeline.humanMove(p, 'task-0003', 'Queue');
    assert.deepEqual(Object.entries(pipeline.getRunStates(p.name))
      .filter(([, state]) => state.state === 'queued').map(([id]) => id), ['task-0002', 'task-0003']);

    const result = await pipeline.reorder(p, 'task-0003', 'task-0002');
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(Object.entries(pipeline.getRunStates(p.name))
      .filter(([, state]) => state.state === 'queued').map(([id]) => id), ['task-0003', 'task-0002']);
  } finally {
    pipeline.forgetProject(p.name); // discard queued followers before stopping the hanging first build
    await pipeline.killAllChildren({ graceMs: 1000 });
    clearFakeAgent();
  }
});

test('manual queue pause lets active work finish, persists, and parks followers until resume', async () => {
  isolateHome();
  useFakeAgent({ verdict: 'pass', build: 'good', exit_delay_ms: 500 });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Planned' });
  writeCard(repo, 'task-0002', { status: 'Planned' });

  try {
    await pipeline.humanMove(p, 'task-0001', 'Queue');
    await until(() => status(repo, 'task-0001') === 'Build', { timeout: BUDGET.quick });
    await pipeline.humanMove(p, 'task-0002', 'Queue');

    assert.deepEqual(pipeline.pauseQueue(p), { ok: true, queue_paused: true });
    assert.equal(pipeline.usage(p).queue_paused, true);
    assert.equal(pipeline.getRunStates(p.name)['task-0002']?.state, 'queued');

    await until(() => status(repo, 'task-0001') === 'Done', { timeout: BUDGET.chain });
    await sleep(100);
    assert.equal(status(repo, 'task-0002'), 'Queue', 'a follower stays parked after the active chain finishes');
    assert.equal(fs.existsSync(path.join(repo, '.todomd/worktrees/task-0002')), false,
      'pausing never creates the follower worktree');

    // Forgetting volatile scheduler state models a board restart. The local
    // marker remains authoritative, and resume rehydrates the parked card.
    pipeline.forgetProject(p.name);
    assert.equal(pipeline.isQueuePaused(p), true, 'the pause survives process state being discarded');
    assert.deepEqual(pipeline.resumeQueue(p), { ok: true, queue_paused: false });
    await until(() => status(repo, 'task-0002') === 'Done', { timeout: BUDGET.chain });
    assert.equal(pipeline.isQueuePaused(p), false);
  } finally {
    pipeline.resumeQueue(p);
    pipeline.forgetProject(p.name);
    await pipeline.killAllChildren({ graceMs: 1000 });
    clearFakeAgent();
  }
});

test('manual queue resume never launches dispatcher-managed budget work', async () => {
  isolateHome();
  const repo = makeRepo();
  const cfg = path.join(repo, '.todomd/config.yml');
  fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace('mode: launcher', 'mode: budget'));
  const p = project(repo);
  const marker = path.join(repo, '.unexpected-build');
  useFakeAgent({ hang: 'build', hang_marker: marker });
  pipeline.init({ broadcast: noop });
  writeCard(repo, 'task-0001', { status: 'Queue' });

  try {
    pipeline.pauseQueue(p);
    assert.deepEqual(pipeline.resumeQueue(p), { ok: true, queue_paused: false });
    await sleep(150);
    assert.equal(status(repo, 'task-0001'), 'Queue');
    assert.equal(fs.existsSync(marker), false, 'resume leaves budget work for the dispatcher');
    assert.deepEqual(pipeline.getRunStates(p.name), {});
  } finally {
    pipeline.forgetProject(p.name);
    await pipeline.killAllChildren({ graceMs: 1000 });
    clearFakeAgent();
  }
});

test('Run Queue is project-scoped and idempotent', async () => {
  isolateHome();
  const marker = path.join(tmp('queue-kick'), 'started');
  useFakeAgent({ build: 'good', verdict: 'pass', hang: 'build', hang_marker: marker });
  pipeline.init({ broadcast: noop });
  const repoA = makeRepo();
  const repoB = makeRepo();
  const a = project(repoA);
  const b = project(repoB);
  writeCard(repoA, 'task-kick-a', { status: 'Queue' });
  writeCard(repoB, 'task-kick-b', { status: 'Queue' });

  try {
    const first = await pipeline.kickQueue(a);
    assert.equal(first.ok, true);
    assert.equal(first.enqueued, 1);
    assert.equal(first.cards[0].code, 'enqueued');
    const repeated = await pipeline.kickQueue(a);
    assert.equal(repeated.enqueued, 0, 'a repeated click cannot enqueue the same card twice');
    assert.ok(['running', 'already_queued'].includes(repeated.cards[0].code));
    await until(() => fs.existsSync(marker), { timeout: BUDGET.stage });
    assert.equal(status(repoB, 'task-kick-b'), 'Queue', 'another registered project is untouched');
    assert.equal(fs.existsSync(path.join(repoB, '.todomd/worktrees/task-kick-b')), false,
      'another project never gets a worktree from this action');
  } finally {
    pipeline.forgetProject(a.name);
    pipeline.forgetProject(b.name);
    await pipeline.killAllChildren({ graceMs: 1000 });
    clearFakeAgent();
  }
});

test('retriaging an initial Build while the queue is paused removes its scheduler entry', async () => {
  isolateHome();
  useFakeAgent({ build: 'good', verdict: 'pass' });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Planned' });
  pipeline.pauseQueue(p);

  try {
    assert.equal((await pipeline.humanMove(p, 'task-0001', 'Queue')).ok, true);
    assert.equal(scheduler.isQueued(p.name, 'task-0001'), true);
    assert.equal((await pipeline.humanMove(p, 'task-0001', 'Review')).ok, true);
    assert.equal(status(repo, 'task-0001'), 'Review');
    assert.equal(scheduler.isQueued(p.name, 'task-0001'), false,
      'the stale Build cannot admit after the human retriage');

    pipeline.resumeQueue(p);
    await sleep(150);
    assert.equal(status(repo, 'task-0001'), 'Review');
    assert.ok(!fs.existsSync(path.join(repo, '.todomd/worktrees/task-0001')));
  } finally {
    pipeline.forgetProject(p.name);
    await pipeline.killAllChildren({ graceMs: 1000 });
    clearFakeAgent();
  }
});

test('scheduler: one authoritative global cap governs two real projects with differing configured globals', async () => {
  isolateHome();
  useFakeAgent({ hang: 'build', verdict: 'pass', build: 'good' });
  pipeline.init({ broadcast: noop });
  const repoA = makeRepo();
  const repoB = makeRepo();
  for (const [repo, global] of [[repoA, 1], [repoB, 5]]) {
    const cfg = path.join(repo, '.todomd/config.yml');
    fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8') + `scheduler:\n  global: ${global}\n`);
  }
  const a = project(repoA);
  const b = project(repoB);
  writeCard(repoA, 'task-a1', { status: 'Planned' });
  writeCard(repoB, 'task-b1', { status: 'Planned' });

  try {
    await pipeline.humanMove(a, 'task-a1', 'Queue');
    await until(() => status(repoA, 'task-a1') === 'Build', { timeout: BUDGET.stage });
    await pipeline.humanMove(b, 'task-b1', 'Queue');
    // project b's OWN configured global (5) would admit this alone — the
    // authoritative cap is min(1, 5) = 1, computed fresh from BOTH known
    // projects, never read off whichever entry happens to be checked.
    await sleep(200);
    assert.equal(status(repoB, 'task-b1'), 'Queue', "b's own looser global must not let it bypass the shared cap of 1");
    // An ordinary capacity wait (global/column/project caps) reports plainly
    // 'queued' — 'deferred' is reserved for governor/resource pressure.
    assert.equal(pipeline.getRunStates(b.name)['task-b1']?.state, 'queued');
  } finally {
    pipeline.forgetProject(a.name);
    pipeline.forgetProject(b.name);
    await pipeline.killAllChildren({ graceMs: 1000 });
    clearFakeAgent();
  }
});

test('scheduler: the Build column slot releases before Verify starts — a full Build column does not hold Verify hostage', async () => {
  isolateHome();
  useFakeAgent({ build: 'good', hang: 'verify' });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const cfg = path.join(repo, '.todomd/config.yml');
  fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8')
    .replace('concurrency: 1', 'concurrency: 2') + 'scheduler:\n  columns:\n    Build: 1\n');
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Planned' });
  writeCard(repo, 'task-0002', { status: 'Planned' });

  try {
    await pipeline.humanMove(p, 'task-0001', 'Queue');
    await until(() => status(repo, 'task-0001') === 'Verify', { timeout: BUDGET.stage });
    // task-0001 is hung IN Verify. If Build's slot were still held for the
    // whole chain (the bug this fixes), the Build column limit of 1 would
    // keep task-0002 queued forever instead of admitting it.
    await pipeline.humanMove(p, 'task-0002', 'Queue');
    await until(() => status(repo, 'task-0002') === 'Build', { timeout: BUDGET.stage });
  } finally {
    pipeline.forgetProject(p.name);
    await pipeline.killAllChildren({ graceMs: 1000 });
    clearFakeAgent();
  }
});

test('scheduler: the governor is constructed from this board\'s OWN configured resource thresholds, not hard-coded defaults', async () => {
  isolateHome();
  // Give any straggling async settlement from an earlier test's killed
  // children a moment to fully drain (they release scheduler counters and
  // can trigger ensureGovernor() asynchronously) before resetState() below —
  // otherwise a belated release() could reconstruct the governor from an
  // empty project set (the real documented defaults) right after this reset,
  // silently overriding the aggressive thresholds this test relies on.
  await sleep(300);
  scheduler.resetState(); // force a fresh governor built from THIS test's project config
  useFakeAgent({ verdict: 'pass', build: 'good' });
  const events = [];
  pipeline.init({ broadcast: (m) => events.push(m) });
  const repo = makeRepo();
  const cfg = path.join(repo, '.todomd/config.yml');
  // An impossible-to-satisfy defer threshold: only deferring proves the
  // scheduler actually read and used THIS board's configured resources block
  // — the documented defaults would never breach on a real test machine.
  fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace('resources:\n  enabled: false\n',
    'resources:\n  enabled: true\n  cpu:\n    defer: 0.001\n    resume: 0.0005\n    critical: 100\n'));
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Planned' });

  try {
    await pipeline.humanMove(p, 'task-0001', 'Queue');
    await until(() => pipeline.getRunStates(p.name)['task-0001']?.state === 'deferred', { timeout: BUDGET.quick });
    const state = pipeline.getRunStates(p.name)['task-0001'];
    assert.match(state.reason, /cpu/, 'the deferral reason names the configured metric that breached');
    assert.equal(status(repo, 'task-0001'), 'Queue', 'no child was ever spawned while deferred');
    const deferredEvent = events.find((e) => e.type === 'run-state' && e.card === 'task-0001' && e.state === 'deferred');
    assert.ok(deferredEvent, 'the deferred state + reason is carried through the live run-state broadcast');
    assert.match(deferredEvent.reason, /cpu/);
  } finally {
    pipeline.forgetProject(p.name);
    await pipeline.killAllChildren({ graceMs: 1000 });
    clearFakeAgent();
    scheduler.resetState(); // this test's aggressive thresholds must not leak into later tests
  }
});

// A committed script the CI stage runs inside the build worktree: it records
// that it started (one line per run, so concurrent runs are countable) and
// then waits for `release` to appear, so a test can hold the CI column open.
function seedCiGate(repo, startedFile, releaseFile) {
  fs.writeFileSync(path.join(repo, 'ci-gate.mjs'),
    `import fs from 'node:fs';\n` +
    `fs.appendFileSync(${JSON.stringify(startedFile)}, process.pid + '\\n');\n` +
    `const t = setInterval(() => {\n` +
    `  if (fs.existsSync(${JSON.stringify(releaseFile)})) { clearInterval(t); process.exit(0); }\n` +
    `}, 50);\n`);
}
const ciStarts = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).length : 0);

test('scheduler: the production Build → CI → Verify chain admits CI as its own column', async () => {
  isolateHome();
  await sleep(300); // let earlier tests' releases drain before resetting (see the governor test above)
  scheduler.resetState();
  useFakeAgent({ build: 'good', verdict: 'pass' });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const gate = tmp('ci-gate');
  const started = path.join(gate, 'started');
  const release = path.join(gate, 'release');
  seedCiGate(repo, started, release);
  const cfg = path.join(repo, '.todomd/config.yml');
  fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8')
    .replace('verify_command: node --version', 'verify_command: node ci-gate.mjs')
    .replace('concurrency: 1', 'concurrency: 2') + 'scheduler:\n  columns:\n    CI: 1\n');
  // verify_command is an EXEC_KEY — the pipeline reads it from HEAD, never the
  // working tree — so both the command and its script must be committed.
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'ci gate']);
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Planned' });
  writeCard(repo, 'task-0002', { status: 'Planned' });

  try {
    await pipeline.humanMove(p, 'task-0001', 'Queue');
    await until(() => pipeline.getRunStates(p.name)['task-0001']?.stage === 'CI', { timeout: BUDGET.chain });
    assert.deepEqual(pipeline.getRunStates(p.name)['task-0001'], { state: 'running', stage: 'CI' });
    assert.equal(status(repo, 'task-0001'), 'Verify',
      "the card's status stays Verify while CI runs — 'CI' is a scheduler column, not a board column");

    // task-0002's Build is unaffected (its own column has room), but its CI
    // must wait for the one CI slot task-0001 is holding.
    await pipeline.humanMove(p, 'task-0002', 'Queue');
    await until(() => {
      const s = pipeline.getRunStates(p.name)['task-0002'];
      return s?.stage === 'CI' && s.state === 'queued';
    }, { timeout: BUDGET.chain, label: "task-0002 waits for the CI column" });
    assert.equal(ciStarts(started), 1, 'a combined CI limit of 1 kept the second card out of the CI column');

    fs.writeFileSync(release, 'go');
    await until(() => status(repo, 'task-0001') === 'Done', { timeout: BUDGET.chain });
    await until(() => ciStarts(started) === 2, { timeout: BUDGET.chain, label: 'the queued CI ran once the slot freed' });
    assert.match(readCard(repo, 'task-0001').raw, /CI attempt 1 · [\d.]+s · `node ci-gate\.mjs` passed/);
  } finally {
    pipeline.forgetProject(p.name);
    await pipeline.killAllChildren({ graceMs: 1000 });
    clearFakeAgent();
    scheduler.resetState();
  }
});

test('a failing CI stage stops the chain before Verify and carries its output to Needs Human', async () => {
  isolateHome();
  useFakeAgent({ build: 'good', verdict: 'pass' });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  // Vendor-independent by construction: this is a plain child process, not a
  // independent CI stage, so a codex build runs the same gate.
  fs.writeFileSync(path.join(repo, 'ci-fail.mjs'),
    `process.stdout.write('verbose progress '.repeat(5000));\n` +
    `console.error('CI_OUTPUT_MARKER: 2 tests failed');\nprocess.exit(1);\n`);
  const cfg = path.join(repo, '.todomd/config.yml');
  fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace('verify_command: node --version', 'verify_command: node ci-fail.mjs'));
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'failing ci']);
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Planned' });

  try {
    await pipeline.humanMove(p, 'task-0001', 'Queue');
    await until(() => status(repo, 'task-0001') === 'Needs Human', { timeout: BUDGET.chain });

    const card = readCard(repo, 'task-0001');
    assert.equal(card.data.needs_human_reason, 'ci_failed');
    assert.match(card.raw, /CI_OUTPUT_MARKER: 2 tests failed/,
      "the command's final failure summary survives output and card-history limits");
    assert.match(card.raw, /`node ci-fail\.mjs` exited 1/,
      'the concise card diagnostic keeps the command and exit result too');
    assert.equal(fs.existsSync(path.join(repo, '.todomd/runs/task-0001/verify-1.jsonl')), false,
      'a failing CI gate is never handed on to Verify');
    assert.doesNotMatch(fs.readFileSync(path.join(repo, 'src/calc.js'), 'utf8'), /export function prod/,
      'nothing was merged');
    assert.ok(fs.existsSync(path.join(repo, '.todomd/worktrees/task-0001')),
      'the worktree is preserved so a human can reproduce the failure');
  } finally {
    pipeline.forgetProject(p.name);
    await pipeline.killAllChildren({ graceMs: 1000 });
    clearFakeAgent();
  }
});

test('retriaging during a hanging CI stage promptly terminates CI and settles in Review', async () => {
  isolateHome();
  useFakeAgent({ build: 'good', verdict: 'pass' });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const marker = path.join(tmp('ci-retriage'), 'started');
  fs.writeFileSync(path.join(repo, 'ci-hang.mjs'),
    `import fs from 'node:fs';\n` +
    `fs.writeFileSync(${JSON.stringify(marker)}, 'started');\n` +
    `setInterval(() => {}, 1000);\n`);
  const cfg = path.join(repo, '.todomd/config.yml');
  fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8')
    .replace('verify_command: node --version', 'verify_command: node ci-hang.mjs'));
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'hanging ci']);
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Planned' });

  try {
    assert.equal((await pipeline.humanMove(p, 'task-0001', 'Queue')).ok, true);
    await until(() => fs.existsSync(marker)
      && pipeline.getRunStates(p.name)['task-0001']?.stage === 'CI', { timeout: BUDGET.chain });

    assert.deepEqual(await pipeline.humanMove(p, 'task-0001', 'Review'),
      { ok: true, cancelled: true });
    await until(() => status(repo, 'task-0001') === 'Review'
      && !pipeline.hasLiveRun(p.name, 'task-0001'), { timeout: BUDGET.stage });
    assert.equal(fs.existsSync(path.join(repo, '.todomd/worktrees/task-0001')), false,
      'the cancelled CI flow performs its normal retriage cleanup');
    assert.match(readCard(repo, 'task-0001').raw, /CI attempt 1 · cancelled/);
  } finally {
    pipeline.cancel(p, 'task-0001');
    await pipeline.killAllChildren({ graceMs: 1000 });
    clearFakeAgent();
    scheduler.resetState();
  }
});

test('a board with no verify_command records the skip and goes straight to Verify', async () => {
  isolateHome();
  useFakeAgent({ build: 'good', verdict: 'pass' });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const cfg = path.join(repo, '.todomd/config.yml');
  fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace(/^verify_command:.*\n/m, ''));
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'no verify command']);
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Planned' });

  try {
    await pipeline.humanMove(p, 'task-0001', 'Queue');
    await until(() => status(repo, 'task-0001') === 'Done', { timeout: BUDGET.chain });
    assert.match(readCard(repo, 'task-0001').raw, /CI: skipped \(no verify_command configured\)/);
  } finally {
    clearFakeAgent();
  }
});

test('a productive Build turn-limit checkpoint resumes automatically and reaches Done', async () => {
  isolateHome();
  const marker = path.join(tmp('checkpoint'), 'first-slice');
  useFakeAgent({ verdict: 'pass', build: 'good', maxturns_once_marker: marker });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-continue', { status: 'Planned' });

  await pipeline.humanMove(p, 'task-continue', 'Queue');
  await until(() => status(repo, 'task-continue') === 'Done', { timeout: BUDGET.chain });

  const card = readCard(repo, 'task-continue');
  assert.ok(fs.existsSync(marker), 'the first slice reached its provider turn limit');
  assert.match(card.body, /checkpoint 1\/3 \(standard\): no worktree progress/, 'the checkpoint was recorded');
  assert.equal(card.data.needs_human_reason || '', '', 'a productive continuation does not need a human');
  clearFakeAgent();
});

test('active long Builds expose safe progress metadata for monitors', async () => {
  isolateHome();
  useFakeAgent({ hang: 'build', verdict: 'pass' });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-progress', { status: 'Planned', extra: 'build_profile: long\n' });

  try {
    await pipeline.humanMove(p, 'task-progress', 'Queue');
    await until(() => pipeline.getRunStates(p.name, { includeProgress: true })['task-progress']?.progress,
      { timeout: BUDGET.stage });
    const state = pipeline.getRunStates(p.name, { includeProgress: true, includeDetails: true })['task-progress'];
    assert.equal(state.state, 'running');
    assert.equal(state.stage, 'Build');
    assert.equal(state.progress.profile, 'long');
    assert.equal(state.progress.slice, 1);
    assert.equal(state.progress.maxSlices, 6);
    assert.equal(state.progress.budgetMinutes, 120);
    assert.equal(typeof state.progress.startedAt, 'string');
    assert.equal(typeof state.progress.lastActivityAt, 'string');
    assert.equal(state.progress.timeoutMinutes, 45);
    assert.equal('worktreeAbs' in state.progress, false, 'internal paths are never exposed in progress state');
  } finally {
    pipeline.forgetProject(p.name);
    await pipeline.killAllChildren({ graceMs: 1000 });
    clearFakeAgent();
  }
});

test('Build slice budget pauses as resumable infrastructure without losing the worktree or attempt', async () => {
  isolateHome();
  const marker = path.join(tmp('build-budget'), 'first-slice');
  useFakeAgent({ verdict: 'pass', build: 'good', maxturns_once_marker: marker });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const cfg = path.join(repo, '.todomd/config.yml');
  fs.appendFileSync(cfg, 'build_continuation:\n  enabled: true\n  max_no_progress_slices: 2\n  max_slices: 1\n  budget_minutes: 60\n');
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'bound build slices']);
  const p = project(repo);
  writeCard(repo, 'task-budget', { status: 'Planned' });

  await pipeline.humanMove(p, 'task-budget', 'Queue');
  await until(() => status(repo, 'task-budget') === 'Needs Human', { timeout: BUDGET.stage });
  const paused = readCard(repo, 'task-budget');
  const worktree = path.join(repo, '.todomd/worktrees/task-budget');
  assert.equal(paused.data.needs_human_reason, 'build_budget');
  assert.equal(paused.data.recovery_stage, 'Build');
  assert.equal(paused.data.verification.attempts, 1);
  assert.equal(paused.data.build_profile, 'standard');
  assert.deepEqual(paused.data.build_limits, { max_slices: 1, budget_minutes: 60 });
  assert.equal(fs.existsSync(worktree), true);
  await until(() => !pipeline.hasLiveRun(p.name, 'task-budget'), { timeout: BUDGET.stage });
  assert.equal((await pipeline.recoveryActions(p, 'task-budget')).resume_build, true);

  clearFakeAgent();
  useFakeAgent({ verdict: 'pass', build: 'good' });
  const resumed = await pipeline.resumeBuild(p, 'task-budget');
  assert.equal(resumed.ok, true);
  assert.equal(resumed.attempt, 1);
  assert.equal(fs.existsSync(worktree), true);
  await until(() => status(repo, 'task-budget') === 'Done', { timeout: BUDGET.chain });
  clearFakeAgent();
});

test('repeated no-progress Build checkpoints pause safely for a human', async () => {
  isolateHome();
  useFakeAgent({ maxturns: 1 });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-stalled', { status: 'Planned' });

  await pipeline.humanMove(p, 'task-stalled', 'Queue');
  await until(() => status(repo, 'task-stalled') === 'Needs Human', { timeout: BUDGET.stage });

  const card = readCard(repo, 'task-stalled');
  assert.equal(card.data.needs_human_reason, 'stalled_build');
  assert.match(card.body, /checkpoint 2\/3 \(standard\): no worktree progress/);
  await until(() => !pipeline.hasLiveRun(p.name, 'task-stalled'), { timeout: BUDGET.stage });
  assert.equal((await pipeline.recoveryActions(p, 'task-stalled')).resume_build, true,
    'a stalled Build preserves the same guarded recovery path');
  clearFakeAgent();
});

test('long Build keeps advancing when the same dirty file changes, then pauses at its frozen absolute cap', async () => {
  isolateHome();
  useFakeAgent({ maxturns: 1, maxturns_progress_file: 'scratch/progress.txt' });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const cfg = path.join(repo, '.todomd/config.yml');
  fs.appendFileSync(cfg,
    'build_continuation:\n  enabled: true\n  max_no_progress_slices: 2\n  max_slices: 2\n  budget_minutes: 30\n' +
    '  profiles:\n    long:\n      max_slices: 4\n      budget_minutes: 90\n');
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'configure build profiles']);
  const p = project(repo);
  writeCard(repo, 'task-long', { status: 'Planned', extra: 'build_profile: long\n' });

  await pipeline.humanMove(p, 'task-long', 'Queue');
  await until(() => status(repo, 'task-long') === 'Needs Human', { timeout: BUDGET.stage });
  const card = readCard(repo, 'task-long');
  assert.equal(card.data.needs_human_reason, 'build_budget', 'content progress avoids a false stalled_build');
  assert.deepEqual(card.data.build_limits, { max_slices: 4, budget_minutes: 90 });
  assert.match(card.body, /checkpoint 3\/4 \(long\): worktree progress detected/);
  assert.equal(fs.existsSync(path.join(repo, '.todomd/worktrees/task-long/scratch/progress.txt')), true);
  await until(() => !pipeline.hasLiveRun(p.name, 'task-long'), { timeout: BUDGET.stage });
  fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace('      max_slices: 4', '      max_slices: 5'));
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'change future long profile']);
  const recovery = await pipeline.recoveryActions(p, 'task-long');
  assert.equal(recovery.resume_build, true);
  assert.deepEqual(recovery.build_limits, { max_slices: 4, budget_minutes: 90 },
    'a later config edit cannot lengthen an already-admitted Build');
  clearFakeAgent();
});

test('split_required profile cannot enter Queue without materialized child cards', async () => {
  isolateHome();
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-split', { status: 'Planned', extra: 'build_profile: split_required\n' });

  const result = await pipeline.humanMove(p, 'task-split', 'Queue');
  assert.equal(result.ok, false);
  assert.match(result.error, /requires splitting before Build/);
  assert.equal(status(repo, 'task-split'), 'Planned');
});

test('stage routing precedence: an unknown column agent is gated; a supported card agent overrides it', async () => {
  isolateHome();
  useFakeAgent({ verdict: 'pass', build: 'good' });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);

  // column-level Build agent is an unknown vendor — proves the gate reads the
  // column tier (the board default_agent is the supported `claude`, yet it fails)
  await setStageRouting(repo, 'Build', { agent: 'unknown-agent' });
  writeCard(repo, 'task-0001', { status: 'Planned' });
  await patchFrontmatter(repo, 'task-0001', { agent: '' }); // clear card override → column tier applies
  let r = await pipeline.humanMove(p, 'task-0001', 'Queue');
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown-agent.*not supported/);
  assert.equal(status(repo, 'task-0001'), 'Planned'); // didn't move

  // a card-level agent overrides the column → gate passes → chain runs to Done
  await patchFrontmatter(repo, 'task-0001', { agent: 'claude' });
  r = await pipeline.humanMove(p, 'task-0001', 'Queue');
  assert.equal(r.ok, true);
  await until(() => status(repo, 'task-0001') === 'Done', { timeout: BUDGET.stage });
  clearFakeAgent();
});

test('Ultra Code enforces xhigh effort even when a card carries a low override', async () => {
  isolateHome();
  const argvLog = path.join(tmp('ultra-code-routing'), 'argv.jsonl');
  useFakeAgent({ verdict: 'pass', build: 'good', argv_log: argvLog });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);

  await setStageRouting(repo, 'Build', { effort: 'high', workflow: 'ultra_code' });
  writeCard(repo, 'task-ultra', { status: 'Planned', extra: 'effort: low\n' });

  try {
    const r = await pipeline.humanMove(p, 'task-ultra', 'Queue');
    assert.equal(r.ok, true, r.error);
    await until(() => status(repo, 'task-ultra') === 'Done', { timeout: BUDGET.chain });

    const invocations = fs.readFileSync(argvLog, 'utf8').trim().split('\n').map(JSON.parse);
    const build = invocations.find((args) => args.some((arg) => String(arg).includes('todomd-build task-ultra')));
    assert.ok(build, 'the Build invocation was captured');
    assert.deepEqual(build.slice(build.indexOf('--effort'), build.indexOf('--effort') + 2),
      ['--effort', 'xhigh']);
    assert.match(build[build.indexOf('-p') + 1], /Ultra Code workflow/);
  } finally {
    clearFakeAgent();
  }
});

test('Verify column routing stays independent from a card Build-agent override', async () => {
  isolateHome();
  useFakeAgent({ verdict: 'pass', build: 'good' });
  process.env.TODOMD_CODEX_BIN = FAKE_CODEX;
  process.env.FAKE_CODEX_REQUIRE_STRICT_SCHEMA = '1';
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);

  await setStageRouting(repo, 'Verify', { agent: 'codex', model: 'gpt-test', effort: 'high' });
  writeCard(repo, 'task-0001', { status: 'Planned' });
  await patchFrontmatter(repo, 'task-0001', { agent: 'claude', model: 'claude-build-model', effort: 'xhigh' });

  try {
    const r = await pipeline.humanMove(p, 'task-0001', 'Queue');
    assert.equal(r.ok, true);
    await until(() => status(repo, 'task-0001') === 'Done', { timeout: BUDGET.chain });
    assert.equal(readCard(repo, 'task-0001').data.session_id, 'fake-session-0001',
      'the independent Codex Verify cannot overwrite the Claude Build session');
    assert.match(readCard(repo, 'task-0001').raw, /Verify.*codex\/gpt-test/);
  } finally {
    clearFakeAgent();
  }
});

test('Codex Plan is read-only and TODOMD writes its structured plan into the card', async () => {
  isolateHome();
  process.env.TODOMD_CODEX_BIN = FAKE_CODEX;
  const argvLog = path.join(tmp('codex-plan'), 'argv.json');
  process.env.FAKE_CODEX_ARGV_LOG = argvLog;
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  await setStageRouting(repo, 'Plan', { agent: 'codex', model: 'gpt-test', effort: 'high' });
  writeCard(repo, 'task-0001');

  try {
    const r = await pipeline.humanMove(p, 'task-0001', 'Plan');
    assert.equal(r.ok, true);
    await until(() => status(repo, 'task-0001') === 'Planned', { timeout: BUDGET.stage });
    assert.match(readCard(repo, 'task-0001').body, /## Implementation Plan\n\n1\. Do the thing\./);
    assert.equal(readCard(repo, 'task-0001').data.build_profile, 'standard');
    assert.equal(readCard(repo, 'task-0001').data.complexity, 'medium');
    assert.equal(loadBoard(repo).cards.find((c) => c.id === 'task-0001').complexity, 'medium');
    const argv = JSON.parse(fs.readFileSync(argvLog, 'utf8'));
    assert.deepEqual(argv.slice(argv.indexOf('--sandbox'), argv.indexOf('--sandbox') + 2), ['--sandbox', 'read-only']);
    assert.ok(argv.includes('--output-schema'));
  } finally {
    delete process.env.TODOMD_CODEX_BIN; delete process.env.FAKE_CODEX_ARGV_LOG;
  }
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
  await until(() => (readCard(repo, 'task-0002').data.verification?.attempts || 0) >= 2, { timeout: BUDGET.stage });
  process.env.FAKE_VERDICT = 'pass'; // next verify passes
  await until(() => status(repo, 'task-0002') === 'Done', { timeout: BUDGET.stage });
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
  await until(() => status(repo, 'task-0003') === 'Needs Human', { timeout: BUDGET.chain });

  const card = readCard(repo, 'task-0003');
  assert.equal(card.data.needs_human_reason, 'attempts_exhausted');
  assert.ok((card.data.verification.attempts || 0) <= 3);
  clearFakeAgent();
});

test('worktree env: a verify setup_error → Needs Human (worktree_env) on attempt 1, no wasted retries', async () => {
  isolateHome();
  // the verify command "can't even run" — should escalate distinctly and at once,
  // not burn all attempts ending in a generic attempts_exhausted
  useFakeAgent({ verdict: 'pass', findings: '', build: 'good', setup_error: 'Cannot inspect linked environment' });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0003');

  await pipeline.humanMove(p, 'task-0003', 'Plan');
  await until(() => status(repo, 'task-0003') === 'Planned');
  await pipeline.humanMove(p, 'task-0003', 'Queue');
  await until(() => status(repo, 'task-0003') === 'Needs Human', { timeout: BUDGET.chain });

  const card = readCard(repo, 'task-0003');
  assert.equal(card.data.needs_human_reason, 'worktree_env');
  assert.equal(card.data.verification.attempts, 1, 'escalates on the first verify, not after the attempt cap');
  await until(async () => (await pipeline.recoveryActions(p, 'task-0003')).retry_verification === true,
    { label: 'a pure review environment failure can retry the same candidate/attempt' });
  assert.doesNotMatch(card.raw, /lacks a gitignored file/,
    'the remediation does not invent a missing worktree link');
  clearFakeAgent();
});

test('verify preserves substantive findings when an environment limitation also occurs', async () => {
  isolateHome();
  useFakeAgent({ verdict: 'fail', findings: 'prod returns the wrong value', build: 'good', setup_error: 'Docker socket access denied' });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0003');

  await pipeline.humanMove(p, 'task-0003', 'Plan');
  await until(() => status(repo, 'task-0003') === 'Planned');
  await pipeline.humanMove(p, 'task-0003', 'Queue');
  await until(() => status(repo, 'task-0003') === 'Needs Human', { timeout: BUDGET.chain });

  const card = readCard(repo, 'task-0003');
  assert.equal(card.data.needs_human_reason, 'verification_incomplete');
  assert.match(card.raw, /prod returns the wrong value/);
  assert.match(card.raw, /Docker socket access denied/);
  await until(async () => (await pipeline.recoveryActions(p, 'task-0003')).return_to_build === true,
    { label: 'mixed code findings route back to a preserved repair Build' });
  clearFakeAgent();
});

test('a Build response cannot advance while candidate changes remain uncommitted', async () => {
  isolateHome();
  useFakeAgent({ verdict: 'pass', build: 'good', leave_dirty: 1 });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0004', { status: 'Planned' });

  await pipeline.humanMove(p, 'task-0004', 'Queue');
  await until(() => status(repo, 'task-0004') === 'Needs Human', { timeout: BUDGET.chain });

  const card = readCard(repo, 'task-0004');
  assert.equal(card.data.needs_human_reason, 'uncommitted_build');
  assert.equal(card.data.recovery_stage, 'Build');
  assert.match(card.raw, /src\/uncommitted\.js/);
  await until(async () => (await pipeline.recoveryActions(p, 'task-0004')).resume_build === true);
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
  await until(() => fs.existsSync(marker), { timeout: BUDGET.chain });
  const wt = path.join(repo, '.todomd/worktrees/task-0001');
  await until(() => fs.existsSync(wt), { timeout: BUDGET.stage });
  assert.ok(fs.existsSync(wt), 'worktree was created for the build');

  await pipeline.humanMove(p, 'task-0001', 'Review'); // cancels the live run
  // cancel cleanup is async (SIGTERM → child exit → worktree removal → status flip);
  // poll the end state instead of asserting on a single sample so load can't race it
  await until(() => status(repo, 'task-0001') === 'Review', { timeout: BUDGET.chain });
  await until(() => !fs.existsSync(wt), { timeout: BUDGET.stage });
  assert.ok(!fs.existsSync(wt), 'worktree removed on cancel (no leak)');
  await until(() => (readCard(repo, 'task-0001').data.worktree || '') === '', { timeout: BUDGET.quick });
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
  await until(() => status(repo, 'task-0001') === 'Needs Human', { timeout: BUDGET.stage });
  let card = readCard(repo, 'task-0001');
  assert.equal(card.data.needs_human_reason, 'needs_answer');
  assert.match(card.data.question || '', /on or off/);

  // answer → threads the decision into the next build → verify passes → Done
  assert.equal((await pipeline.answerCard(p, 'task-0001', 'default to ON')).ok, true);
  await until(() => status(repo, 'task-0001') === 'Done', { timeout: BUDGET.stage });
  card = readCard(repo, 'task-0001');
  assert.equal(card.data.question || '', '', 'question cleared after answering');
  clearFakeAgent();
});

test('card prompt runs an advisory agent turn without moving the card or replacing its Build session', async () => {
  isolateHome();
  useFakeAgent({ other_message: 'The safest next action is a fresh verification pass.' });
  const events = [];
  pipeline.init({ broadcast: (event) => events.push(event) });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0008', {
    status: 'Needs Human',
    body: 'Review the preserved implementation before deciding whether to merge.',
    extra: 'session_id: build-session-must-survive\nneeds_human_reason: attempts_exhausted\n',
  });

  const queued = await pipeline.promptCard(p, 'task-0008', 'What should I do next?');
  assert.deepEqual(queued, { ok: true, queued: true });
  assert.equal((await pipeline.promptCard(p, 'task-0008', 'Duplicate')).ok, false,
    'a second prompt cannot overlap the queued/live turn');
  await until(() => !pipeline.hasLiveRun(p.name, 'task-0008'), { timeout: BUDGET.stage, label: 'card chat completed' });

  const card = readCard(repo, 'task-0008');
  assert.equal(card.data.status, 'Needs Human', 'chat never changes workflow state');
  assert.equal(card.data.session_id, 'build-session-must-survive', 'chat cannot replace the resumable Build session');
  const log = readRunLog(repo, 'task-0008');
  assert.equal(log.stage, 'chat');
  assert.equal(log.events[0].type, 'human_message');
  assert.equal(log.events[0].text, 'What should I do next?');
  assert.ok(log.events.some((event) => JSON.stringify(event).includes('fresh verification pass')));
  assert.ok(events.some((event) => event.type === 'run-event' && event.event?.type === 'human_message'));
  clearFakeAgent();
});

test('an exhausted preserved card can return to Build with a durable human handoff', async () => {
  isolateHome();
  const argvLog = path.join(tmp('return-build-handoff'), 'argv.jsonl');
  useFakeAgent({ build: 'good', verdict: 'pass', argv_log: argvLog });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  seedPreservedVerification(repo, 'task-0009');
  await patchFrontmatter(repo, 'task-0009', {
    needs_human_reason: 'attempts_exhausted',
    verification: { attempts: 3, max_attempts: 3, last_verdict: 'fail' },
  });

  const actions = await pipeline.recoveryActions(p, 'task-0009');
  assert.equal(actions.return_to_build, true);
  const returned = await pipeline.humanMove(p, 'task-0009', 'Build', {
    instruction: 'Fix the authenticated UPDATE grants called out by the verifier, then rerun focused RLS checks.',
  });
  assert.equal(returned.ok, true);
  assert.equal(returned.attempt, 4, 'a human recovery extends the cap by one auditable attempt');
  assert.equal(returned.max_attempts, 4);

  await until(() => status(repo, 'task-0009') === 'Done', { timeout: BUDGET.chain });
  await until(() => !pipeline.hasLiveRun(p.name, 'task-0009'), { timeout: BUDGET.stage });
  const invocations = fs.readFileSync(argvLog, 'utf8').trim().split('\n').map(JSON.parse);
  const repairBuild = invocations.find((argv) => argv.some((arg) =>
    /Human instruction for this Build[\s\S]*authenticated UPDATE grants/.test(arg)));
  assert.ok(repairBuild,
  'the next Build agent receives the saved handoff in its prompt');
  assert.equal(repairBuild.includes('--resume'), false,
    'a verifier-exhausted repair starts a fresh agent instead of trusting a stale provider session');
  const finished = readCard(repo, 'task-0009');
  assert.equal(finished.data.verification.attempts, 4);
  assert.equal(finished.data.verification.max_attempts, 4);
  assert.equal(fs.existsSync(path.join(repo, '.todomd/local/card-instructions/task-0009.md')), false,
    'a successful Build consumes the one-run handoff');
  clearFakeAgent();
});

test('Recovery agent turns substantive exhausted findings into one guarded repair Build', async () => {
  isolateHome();
  const argvLog = path.join(tmp('recovery-agent-build'), 'argv.jsonl');
  useFakeAgent({
    build: 'good',
    verdict: 'pass',
    argv_log: argvLog,
    recovery_action: 'return_to_build',
    recovery_confidence: 'high',
    recovery_diagnosis: 'The verifier found mutable activated rows; unchanged verification would repeat the failure.',
    recovery_handoff: 'Block INSERT into activated metadata, add role-impersonated regressions, and rerun the trusted CI gate.',
  });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  seedPreservedVerification(repo, 'task-0010');
  await patchFrontmatter(repo, 'task-0010', {
    needs_human_reason: 'attempts_exhausted',
    verification: { attempts: 3, max_attempts: 3, last_verdict: 'fail' },
  });

  assert.deepEqual(await pipeline.reviewAndProcessRecovery(p, 'task-0010'), { ok: true, queued: true });
  assert.equal((await pipeline.reviewAndProcessRecovery(p, 'task-0010')).ok, false,
    'one card cannot queue overlapping recovery reviews');
  await until(() => status(repo, 'task-0010') === 'Done', { timeout: BUDGET.chain });
  await until(() => !pipeline.hasLiveRun(p.name, 'task-0010'), { timeout: BUDGET.stage });

  const finished = readCard(repo, 'task-0010');
  assert.equal(finished.data.verification.attempts, 4);
  assert.equal(finished.data.verification.max_attempts, 4,
    'one explicit recovery click creates exactly one auditable repair attempt');
  assert.match(finished.raw, /Recovery.*reviewed: return_to_build \(high\)/);
  const invocations = fs.readFileSync(argvLog, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(invocations.some((argv) => argv.some((arg) =>
    /Human instruction for this Build[\s\S]*Block INSERT into activated metadata/.test(arg))),
  'the structured recovery handoff reaches the fresh Build agent');
  clearFakeAgent();
});

test('Recovery agent refuses to re-verify unchanged substantive failures or act below high confidence', async () => {
  isolateHome();
  useFakeAgent({
    recovery_action: 'retry_verification',
    recovery_confidence: 'high',
    recovery_diagnosis: 'Retry the same candidate.',
  });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  seedPreservedVerification(repo, 'task-0012');
  await patchFrontmatter(repo, 'task-0012', {
    needs_human_reason: 'attempts_exhausted',
    verification: { attempts: 3, max_attempts: 3, last_verdict: 'fail' },
  });

  await pipeline.reviewAndProcessRecovery(p, 'task-0012');
  await until(() => !pipeline.hasLiveRun(p.name, 'task-0012'), { timeout: BUDGET.stage });
  let held = readCard(repo, 'task-0012');
  assert.equal(held.data.status, 'Needs Human');
  assert.deepEqual(held.data.verification, { attempts: 3, max_attempts: 3, last_verdict: 'fail' });
  assert.match(held.raw, /substantive verification failures must return to Build/);

  useFakeAgent({
    recovery_action: 'return_to_build',
    recovery_confidence: 'medium',
    recovery_diagnosis: 'The evidence may be incomplete.',
    recovery_handoff: 'Investigate the incomplete evidence.',
  });
  await pipeline.reviewAndProcessRecovery(p, 'task-0012');
  await until(() => !pipeline.hasLiveRun(p.name, 'task-0012'), { timeout: BUDGET.stage });
  held = readCard(repo, 'task-0012');
  assert.equal(held.data.status, 'Needs Human');
  assert.match(held.raw, /reviewer confidence was medium; no workflow action executed/);
  clearFakeAgent();
});

test('Resume Build falls back to a fresh agent when the provider lost the saved conversation', async () => {
  isolateHome();
  const argvLog = path.join(tmp('resume-missing-fallback'), 'argv.jsonl');
  useFakeAgent({ build: 'good', verdict: 'pass', resume_missing: '1', argv_log: argvLog });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  seedPreservedVerification(repo, 'task-0011');
  await patchFrontmatter(repo, 'task-0011', {
    needs_human_reason: 'agent_error',
    recovery_stage: 'Build',
    verification: { attempts: 4, max_attempts: 4, last_verdict: 'fail' },
  });

  const resumed = await pipeline.resumeBuild(p, 'task-0011');
  assert.equal(resumed.ok, true);
  await until(() => status(repo, 'task-0011') === 'Done', { timeout: BUDGET.chain });
  await until(() => !pipeline.hasLiveRun(p.name, 'task-0011'), { timeout: BUDGET.stage });
  const invocations = fs.readFileSync(argvLog, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(invocations[0].includes('--resume'), true, 'recovery first tries the saved provider session');
  assert.equal(invocations.some((argv) => !argv.includes('--resume') && argv.some((arg) =>
    /Continue from the existing preserved worktree changes/.test(arg))), true,
  'a missing session immediately retries with a fresh agent in the same worktree');
  assert.match(readCard(repo, 'task-0011').raw,
    /resume session unavailable; retrying fresh in preserved worktree/);
  clearFakeAgent();
});

test('card summaries synthesize and cache the full description and latest run instead of extracting excerpts', async () => {
  isolateHome();
  const argvLog = path.join(tmp('summary-agent'), 'argv.jsonl');
  useFakeAgent({
    argv_log: argvLog,
    description_tldr: 'The card consolidates several drawer requirements into one reviewable interaction.',
    last_run_tldr: 'The run validated the focused behavior and left full-flow verification as the next action.',
  });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0010', {
    body: 'First, preserve collapsed sections. Second, summarize all requirements. Third, avoid presenting copied prose as a summary.',
  });
  const runDir = path.join(repo, '.todomd', 'runs', 'task-0010');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'Build-1.jsonl'), [
    { type: 'item.completed', item: { type: 'command_execution', command: 'npm test', status: 'completed', aggregated_output: 'focused checks passed' } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'This final message is evidence, not itself the requested TL;DR.' } },
  ].map((event) => JSON.stringify(event)).join('\n') + '\n');

  const first = await pipeline.summarizeCard(p, 'task-0010');
  assert.equal(first.ok, true);
  assert.equal(first.cached, false);
  assert.equal(first.description_tldr,
    'The card consolidates several drawer requirements into one reviewable interaction.');
  assert.equal(first.last_run_tldr,
    'The run validated the focused behavior and left full-flow verification as the next action.');
  assert.equal(readCard(repo, 'task-0010').tldr, first.description_tldr);
  assert.equal(readRunLog(repo, 'task-0010').tldr, first.last_run_tldr);

  const second = await pipeline.summarizeCard(p, 'task-0010');
  assert.equal(second.cached, true);
  assert.equal(fs.readFileSync(argvLog, 'utf8').trim().split('\n').length, 1,
    'unchanged source material reuses the semantic summary cache');
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
  await until(() => status(repo, 'task-0004') === 'Needs Human', { timeout: BUDGET.quick });
  assert.equal(readCard(repo, 'task-0004').data.needs_human_reason, 'agent_error');
  clearFakeAgent();
});

test('persisted agent process matching recognizes configured agy and interpreter wrappers', () => {
  assert.equal(pipeline.agentCommandMatches('/Users/me/.local/bin/agy -p task', '/Users/me/.local/bin/agy'), true);
  assert.equal(pipeline.agentCommandMatches('/usr/bin/node /Users/me/bin/codex exec', '/Users/me/bin/codex'), true);
  assert.equal(pipeline.agentCommandMatches('/usr/bin/node /tmp/unrelated.js', '/Users/me/bin/codex'), false);
  assert.equal(pipeline.agentCommandMatches('/Applications/agy-helper task'), false,
    'substrings do not qualify as an owned agent process');
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

test('dependency gate preserves a hand-edited scalar dependency', async () => {
  isolateHome();
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0002', { status: 'Review' });
  writeCard(repo, 'task-0001', { status: 'Planned' });
  const file = path.join(repo, '.todomd/tasks/task-0001-card.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('dependencies: []', 'dependencies: task-0002'));

  const blocked = await pipeline.humanMove(p, 'task-0001', 'Queue');
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /blocked by: task-0002/);
  assert.equal(status(repo, 'task-0001'), 'Planned');
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
  await until(() => pipeline.usage(p.name).quota_paused === true, { timeout: BUDGET.quick });
  assert.equal(status(repo, 'task-0001'), 'Queue'); // parked, not Needs Human
  const ver = readCard(repo, 'task-0001').data.verification;
  assert.ok((ver.attempts || 0) <= 1, 'quota must not burn an attempt'); // rolled back

  // resume → build now succeeds → full chain to Done
  pipeline.resumeQueues([p]);
  await until(() => status(repo, 'task-0001') === 'Done', { timeout: BUDGET.stage });
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
  await until(() => readCard(repo, card.id).data.triaged && readCard(repo, card.id).data.triaged !== 'running', { timeout: BUDGET.quick });
  // after triage, the working tree must have no uncommitted .todomd changes
  const { execFileSync } = await import('node:child_process');
  const dirty = execFileSync('git', ['status', '--porcelain', '--', '.todomd'], { cwd: repo, encoding: 'utf8' }).trim();
  assert.equal(dirty, '', `triage left uncommitted board changes:\n${dirty}`);
});

test('Triage stays live from its pre-spawn claim through final writes and blocks voice actions', async () => {
  isolateHome();
  const marker = path.join(tmp('triage-finalizing'), 'agent-done');
  useFakeAgent({ before_exit_marker: marker, exit_delay_ms: 500 });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo({ triage: true });
  const p = project(repo);
  writeCard(repo, 'task-0001');

  let release;
  try {
    const triage = pipeline.maybeTriage(p, 'task-0001');
    assert.equal(pipeline.hasLiveRun(p.name, 'task-0001'), true, 'the synchronous pre-spawn claim is live');
    assert.equal(pipeline.getRunStates(p.name)['task-0001'].stage, 'Triage');
    await until(() => fs.existsSync(marker), { timeout: BUDGET.stage });

    let unlock;
    const held = new Promise((resolve) => { unlock = resolve; });
    const lockDone = withRepoLock(repo, () => held);
    release = async () => { unlock(); await lockDone; };
    await sleep(700);

    assert.equal(pipeline.hasLiveRun(p.name, 'task-0001'), true, 'post-child finalization remains live');
    assert.deepEqual(voice.buildVoiceSummary(p).activeRuns,
      [{ card: 'task-0001', state: 'running', stage: 'Triage', external: false }]);
    const archive = await voice.prepareVoiceAction(p, { cardId: 'task-0001', action: 'archive' });
    assert.equal(archive.status, 400);
    assert.match(archive.error, /live run/);
    assert.deepEqual(await pipeline.cancel(p, 'task-0001'), { ok: true });

    await release();
    release = null;
    await triage;
    assert.equal(pipeline.hasLiveRun(p.name, 'task-0001'), false);
    assert.equal(status(repo, 'task-0001'), 'Review');
    assert.equal(readCard(repo, 'task-0001').data.triaged || '', '');
    const dirty = execFileSync('git', ['status', '--porcelain', '--', '.todomd'], { cwd: repo, encoding: 'utf8' }).trim();
    assert.equal(dirty, '', `cancelled triage left uncommitted board changes:\n${dirty}`);
  } finally {
    if (release) await release();
    clearFakeAgent();
  }
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
  await until(() => readCard(repo, 'task-0001').data.epic === true && status(repo, 'task-0001') === 'Planned', { timeout: BUDGET.quick });

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
  await until(() => status(repo, c1) === 'Done', { timeout: BUDGET.stage });
  await until(() => status(repo, c2) === 'Done', { timeout: BUDGET.stage });
  await until(() => status(repo, 'task-0001') === 'Done', { timeout: BUDGET.stage });
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
  await until(() => status(repo, 'task-0001') === 'Planned', { timeout: BUDGET.quick });

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
  await until(() => status(repo, 'task-0002') === 'Done', { timeout: BUDGET.stage });
  await until(() => status(repo, 'task-0001') === 'Done', { timeout: BUDGET.stage });
  assert.ok(!fs.existsSync(path.join(repo, '.todomd/worktrees/task-0001')), 'epic tracker is never built');
  clearFakeAgent();
});

test('forgetProject + projectHasLiveRun', async () => {
  pipeline.init({ broadcast: noop });
  assert.equal(pipeline.projectHasLiveRun('nope'), false);
  pipeline.forgetProject('nope'); // no-op, must not throw
});

test('projectHasLiveRun includes a live Plan child outside the pending Build chain', async () => {
  isolateHome();
  const marker = path.join(tmp('plan-live-project'), 'started');
  useFakeAgent({ hang: 'plan', hang_marker: marker });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0001');

  try {
    await pipeline.humanMove(p, 'task-0001', 'Plan');
    await until(() => fs.existsSync(marker), { timeout: BUDGET.stage });
    assert.equal(pipeline.getRunStates(p.name)['task-0001'].stage, 'Plan');
    assert.equal(pipeline.projectHasLiveRun(p.name), true);
  } finally {
    await pipeline.humanMove(p, 'task-0001', 'Review');
    await until(() => status(repo, 'task-0001') === 'Review', { timeout: BUDGET.stage });
    clearFakeAgent();
  }
});

test('a scheduled Plan is claimed before the background spawn and refuses an immediate voice move', async () => {
  isolateHome();
  useFakeAgent({ hang: 'plan' });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0001');

  try {
    assert.equal((await pipeline.humanMove(p, 'task-0001', 'Plan')).ok, true);
    // No polling: this is the exact return-from-humanMove handoff where the
    // scheduled async stage used to be invisible until execConfig completed.
    assert.equal(pipeline.hasLiveRun(p.name, 'task-0001'), true);
    assert.deepEqual(pipeline.getRunStates(p.name)['task-0001'], { state: 'running', stage: 'Plan' });
    const retriage = await voice.prepareVoiceAction(p, { cardId: 'task-0001', action: 'retriage' });
    assert.equal(retriage.status, 400);
    assert.match(retriage.error, /live run/);

    assert.deepEqual(await pipeline.humanMove(p, 'task-0001', 'Review'), { ok: true, cancelled: true });
    await until(() => status(repo, 'task-0001') === 'Review' && !pipeline.hasLiveRun(p.name, 'task-0001'),
      { timeout: BUDGET.stage });
    assert.equal(status(repo, 'task-0001'), 'Review', 'the scheduled Plan cannot stomp the cancellation');
  } finally {
    pipeline.cancel(p, 'task-0001');
    await pipeline.killAllChildren({ graceMs: 1000 });
    clearFakeAgent();
  }
});

test('a Plan run remains live through finalization and cancellation wins the final move', async () => {
  isolateHome();
  const marker = path.join(tmp('plan-finalizing'), 'agent-done');
  useFakeAgent({ before_exit_marker: marker, exit_delay_ms: 500 });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0001');

  let release;
  try {
    await pipeline.humanMove(p, 'task-0001', 'Plan');
    await until(() => fs.existsSync(marker), { timeout: BUDGET.stage });

    // Hold the first finalizer write. The child exits during this hold, leaving
    // exactly the post-child/pre-final-move window that used to look idle.
    let unlock;
    const held = new Promise((resolve) => { unlock = resolve; });
    const lockDone = withRepoLock(repo, () => held);
    release = async () => { unlock(); await lockDone; };
    await sleep(700);

    assert.equal(pipeline.hasLiveRun(p.name, 'task-0001'), true);
    assert.equal(pipeline.getRunStates(p.name)['task-0001'].stage, 'Plan');
    assert.deepEqual(voice.buildVoiceSummary(p).activeRuns,
      [{ card: 'task-0001', state: 'running', stage: 'Plan', external: false }]);
    const retriage = await voice.prepareVoiceAction(p, { cardId: 'task-0001', action: 'retriage' });
    assert.equal(retriage.status, 400);
    assert.match(retriage.error, /live run/);
    const cancelled = await pipeline.humanMove(p, 'task-0001', 'Review');
    assert.deepEqual(cancelled, { ok: true, cancelled: true });

    await release();
    release = null;
    await until(() => status(repo, 'task-0001') === 'Review' && !pipeline.hasLiveRun(p.name, 'task-0001'),
      { timeout: BUDGET.stage });
    await sleep(150);
    assert.equal(status(repo, 'task-0001'), 'Review', 'the stage finalizer cannot overwrite the cancellation');
  } finally {
    if (release) await release();
    clearFakeAgent();
  }
});

test('cancelling Plan during chunk fan-out archives every generated non-Done child', async () => {
  isolateHome();
  useFakeAgent({ chunks: 12 });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0001', { title: 'large split' });

  try {
    await pipeline.humanMove(p, 'task-0001', 'Plan');
    await until(() => pipeline.hasLiveRun(p.name, 'task-0001') &&
      readCard(repo, 'task-0001')?.data?.status === 'Plan', { timeout: BUDGET.stage });
    await until(() => {
      const board = loadBoard(repo, { includeArchived: true });
      return board.cards.some((card) => card.parent === 'task-0001');
    }, { timeout: BUDGET.stage, step: 2 });

    assert.deepEqual(await pipeline.humanMove(p, 'task-0001', 'Review'), { ok: true, cancelled: true });
    await until(() => status(repo, 'task-0001') === 'Review' && !pipeline.hasLiveRun(p.name, 'task-0001'),
      { timeout: BUDGET.stage });

    const children = loadBoard(repo, { includeArchived: true }).cards
      .filter((card) => card.parent === 'task-0001');
    assert.equal(children.length, 12, 'fan-out completed before cancellation cleanup');
    assert.ok(children.every((card) => card.status === 'Done' || card.archived),
      'every non-Done child created by the cancelled Plan is archived');
    assert.equal(loadBoard(repo).cards.some((card) => card.parent === 'task-0001'), false,
      'cancelled Plan children are no longer active on the board');
  } finally {
    await pipeline.killAllChildren({ graceMs: 1000 });
    clearFakeAgent();
  }
});

test('forgetProject uses exact ownership and preserves a nested project\'s queued findings', async () => {
  isolateHome();
  const hangMarker = path.join(tmp('nested-project'), 'first-build');
  const argvLog = path.join(tmp('nested-project-argv'), 'argv.jsonl');
  useFakeAgent({ verdict: 'pass', build: 'good', hang: 'build', hang_marker: hangMarker, argv_log: argvLog });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = { name: 'alpha:beta', path: repo };
  writeCard(repo, 'task-0001', { status: 'Planned' });
  writeCard(repo, 'task-0002', {
    status: 'Needs Human',
    extra: 'needs_human_reason: needs_answer\nquestion: Which option?\n',
  });

  try {
    await pipeline.humanMove(p, 'task-0001', 'Queue');
    await until(() => fs.existsSync(hangMarker), { timeout: BUDGET.stage });
    await pipeline.answerCard(p, 'task-0002', 'Keep the blue option');
    assert.equal(status(repo, 'task-0002'), 'Queue', 'the second build is parked behind the live first build');

    pipeline.forgetProject('alpha');
    await pipeline.humanMove(p, 'task-0001', 'Review');
    await until(() => status(repo, 'task-0002') === 'Done', { timeout: BUDGET.chain });

    const invocations = fs.readFileSync(argvLog, 'utf8').trim().split('\n').map(JSON.parse);
    const resumedPrompt = invocations.map((args) => args.join(' '))
      .find((line) => line.includes('task-0002') && line.includes('Keep the blue option'));
    assert.ok(resumedPrompt, 'removing alpha must not delete alpha:beta retry findings');
  } finally {
    if (pipeline.hasLiveRun(p.name, 'task-0001')) pipeline.cancel(p, 'task-0001');
    clearFakeAgent();
  }
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
  await until(() => status(repo, 'task-0001') === 'Done', { timeout: BUDGET.stage });
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

  try {
    // start the child build — it hangs until SIGTERM
    await pipeline.humanMove(p, 'chunk-001', 'Queue');
    await until(() => status(repo, 'chunk-001') === 'Build' && fs.existsSync(marker), { timeout: BUDGET.chain });
    await pipeline.cascadeEpicCleanup(p, 'epic-001');
    await until(() => readCard(repo, 'chunk-001').data.archived, { timeout: BUDGET.stage });
    const child = readCard(repo, 'chunk-001');
    assert.ok(child.data.archived, 'child is archived');
    assert.notEqual(child.data.status, 'Review', 'child never entered Review');
    // Archival precedes final scheduler settlement. Do not let this fixture's
    // late release race the next test's reset or fake-agent configuration.
    await until(() => !pipeline.hasLiveRun(p.name, 'chunk-001'), { timeout: BUDGET.stage });
  } finally {
    await pipeline.killAllChildren({ graceMs: 1000 });
    pipeline.forgetProject(p.name);
    clearFakeAgent();
  }
});

test('cascadeEpicCleanup immediately archives a repair child waiting for Build admission', async () => {
  isolateHome();
  scheduler.resetState();
  useFakeAgent({ verdict: 'fail', build: 'good' });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const cfg = path.join(repo, '.todomd/config.yml');
  fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace('concurrency: 1', 'concurrency: 2')
    + 'scheduler:\n  columns:\n    Build: 1\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'configure occupied Build column']);
  const p = project(repo);
  writeCard(repo, 'epic-001', { status: 'Queue', extra: 'epic: true\nchildren: [chunk-001]\n' });
  const { worktree } = seedPreservedVerification(repo, 'chunk-001');
  await patchFrontmatter(repo, 'chunk-001', { parent: 'epic-001' });
  let releaseBlocker;
  const blocker = scheduler.schedule(p, 'blocker', 'Build', () => new Promise((resolve) => {
    releaseBlocker = resolve;
  }));

  try {
    await until(() => typeof releaseBlocker === 'function', { timeout: BUDGET.stage });
    assert.deepEqual(await pipeline.retryVerification(p, 'chunk-001'), { ok: true });
    await until(() => scheduler.queuedEntries(p.name)
      .some((entry) => entry.card === 'chunk-001' && entry.column === 'Build'),
    { timeout: BUDGET.stage });

    await pipeline.cascadeEpicCleanup(p, 'epic-001');
    const child = readCard(repo, 'chunk-001');
    assert.ok(child.data.archived, 'cleanup does not wait for the occupied Build slot');
    assert.equal(child.data.verification.attempts, 1,
      'the queued repair never opened a second attempt to roll back');
    assert.equal(pipeline.hasLiveRun(p.name, 'chunk-001'), false);
    assert.equal(scheduler.isQueued(p.name, 'chunk-001'), false);
    assert.equal(fs.existsSync(worktree), false, 'the archived child releases its worktree');
  } finally {
    scheduler.dequeue(p.name, 'blocker');
    releaseBlocker?.();
    await blocker;
    pipeline.forgetProject(p.name);
    await pipeline.killAllChildren({ graceMs: 1000 });
    clearFakeAgent();
    scheduler.resetState();
  }
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
  await until(() => fs.existsSync(marker), { timeout: BUDGET.chain });
  assert.ok(pipeline.hasLiveRun(p.name, 'task-0001'), 'build is live');

  await pipeline.killAllChildren();
  // hasLiveRun covers the settling chain too (pending) — poll until it fully reverts
  await until(() => !pipeline.hasLiveRun(p.name, 'task-0001'), { timeout: BUDGET.stage });
  // the kill went through the normal cancel path: the card reverts out of Build
  await until(() => status(repo, 'task-0001') === 'Queue', { timeout: BUDGET.stage });
  clearFakeAgent();
});

test('server shutdown kills billing children but preserves an interrupted Build worktree for Resume Build', async () => {
  isolateHome();
  const marker = path.join(tmp('shutdown-preserve'), 'started');
  useFakeAgent({ build: 'good', hang: '1', hang_marker: marker });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Planned' });

  try {
    await pipeline.humanMove(p, 'task-0001', 'Queue');
    await until(() => fs.existsSync(marker) && status(repo, 'task-0001') === 'Build', { timeout: BUDGET.chain });
    const wt = path.join(repo, '.todomd/worktrees/task-0001');
    fs.writeFileSync(path.join(wt, 'shutdown-sentinel.txt'), 'keep me\n');

    await pipeline.killAllChildren({ graceMs: 1000, preserveWorktrees: true });
    await until(() => !pipeline.hasLiveRun(p.name, 'task-0001'), { timeout: BUDGET.stage });
    await until(() => status(repo, 'task-0001') === 'Needs Human', { timeout: BUDGET.stage });

    const card = readCard(repo, 'task-0001');
    assert.equal(card.data.needs_human_reason, 'orphaned_run');
    assert.equal(card.data.recovery_stage, 'Build');
    assert.equal(fs.readFileSync(path.join(wt, 'shutdown-sentinel.txt'), 'utf8'), 'keep me\n');
    assert.match(git(repo, ['branch', '--list', 'todomd/task-0001']), /todomd\/task-0001/);
    assert.equal((await pipeline.recoveryActions(p, 'task-0001')).resume_build, true);
  } finally {
    clearFakeAgent();
  }
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
  await until(() => fs.existsSync(marker), { timeout: BUDGET.chain });

  const t0 = Date.now();
  await pipeline.killAllChildren({ graceMs: 300 });
  await until(() => !pipeline.hasLiveRun(p.name, 'task-0001'), { timeout: BUDGET.stage });
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
  await until(() => status(repo, 'task-0001') === 'Needs Human', { timeout: BUDGET.stage });

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
  }, { timeout: BUDGET.quick });
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
  await until(() => fs.existsSync(marker), { timeout: BUDGET.chain }); // build is live and hung
  await until(() => status(repo, 'task-0001') === 'Needs Human', { timeout: BUDGET.stage });

  const card = readCard(repo, 'task-0001');
  assert.equal(card.data.needs_human_reason, 'run_timeout');
  assert.equal(card.data.recovery_stage, 'Build');
  const preservedWorktree = path.join(repo, '.todomd/worktrees/task-0001');
  assert.equal(fs.existsSync(preservedWorktree), true, 'the timed-out Build worktree is preserved');
  await until(() => !pipeline.hasLiveRun(p.name, 'task-0001'), { timeout: BUDGET.stage });
  assert.equal((await pipeline.recoveryActions(p, 'task-0001')).resume_build, true,
    'a Build timeout is eligible for the guarded continuation');

  clearFakeAgent();
  useFakeAgent({ build: 'good', verdict: 'pass' });
  const resumed = await pipeline.resumeBuild(p, 'task-0001');
  assert.equal(resumed.ok, true);
  assert.equal(resumed.worktree, card.data.worktree, 'Resume Build keeps the exact task branch');
  assert.equal(fs.existsSync(preservedWorktree), true, 'Resume Build keeps the exact worktree directory');
  await until(() => status(repo, 'task-0001') === 'Done', { timeout: BUDGET.stage });
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
  await until(() => fs.existsSync(marker), { timeout: BUDGET.chain });

  await pipeline.humanMove(p, 'task-0001', 'Review'); // cancels the stubborn run
  // without the SIGKILL backstop the close handler never fires and the card
  // never reverts — poll the end state, don't sample once
  await until(() => status(repo, 'task-0001') === 'Review' && !pipeline.hasLiveRun(p.name, 'task-0001'), { timeout: BUDGET.stage });
  delete process.env.TODOMD_KILL_GRACE_MS;
  clearFakeAgent();
});

// The HEAD: guard must cover keys the committed config OMITS, not just the ones
// it defines. verify_command is optional — if a run inherited it from the
// working tree whenever HEAD's config left it out, an injected edit would arm an
// arbitrary shell command in the independent CI stage. Claude automation is
// isolated and no longer receives a project/user Stop hook at all.
test('an executable key MISSING from the committed config is not taken from the working tree', async () => {
  isolateHome();
  const dump = path.join(tmp('hook'), 'settings.json');
  useFakeAgent({ build: 'good', verdict: 'pass', dump_settings: dump });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const cfgPath = path.join(repo, '.todomd/config.yml');
  // commit a config with NO verify_command at all
  const committed = fs.readFileSync(cfgPath, 'utf8').replace(/^verify_command:.*\n/m, '');
  fs.writeFileSync(cfgPath, committed);
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'config without verify_command']);
  assert.doesNotMatch(git(repo, ['show', 'HEAD:.todomd/config.yml']), /verify_command/, 'committed config has none');
  // …then inject one into the working tree only (a git pull / a poisoned agent edit)
  fs.writeFileSync(cfgPath, `${committed}verify_command: echo POISONED_HOOK\n`);

  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Planned' });
  await pipeline.humanMove(p, 'task-0001', 'Queue');
  await until(() => fs.existsSync(dump), { timeout: BUDGET.chain });

  const armed = fs.readFileSync(dump, 'utf8');
  assert.equal(armed, '(no --settings)', 'isolated Claude automation receives no injected Stop hook');
  clearFakeAgent();
});

// The committed prompt is public (it travels with the repo); .todomd/local/ is
// the private half. It only earns its keep if it actually reaches the agent —
// so assert on the prompt the runner passed, not just on the file.
test('a local prompt layer reaches the agent, appended to the committed prompt', async () => {
  isolateHome();
  const argvLog = path.join(tmp('argv'), 'argv.jsonl');
  useFakeAgent({ argv_log: argvLog });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const { writeLocalPrompt } = await import('../src/board.js');
  await writeLocalPrompt(repo, 'todomd-plan', 'SENTINEL_LOCAL_CONTEXT: the staging host is internal-only.');
  const p = project(repo);
  writeCard(repo, 'task-0001');

  await pipeline.humanMove(p, 'task-0001', 'Plan');
  await until(() => status(repo, 'task-0001') === 'Planned', { timeout: BUDGET.stage });

  const calls = fs.readFileSync(argvLog, 'utf8').trim().split('\n').map(JSON.parse);
  const prompt = calls.flat().find((a) => typeof a === 'string' && a.includes('SENTINEL_LOCAL_CONTEXT'));
  assert.ok(prompt, 'the local layer was passed to the agent');
  // and it rides ON TOP of the committed prompt rather than replacing it —
  // compare against the real file so this holds whatever the template says
  const committed = fs.readFileSync(path.join(repo, '.claude/commands/todomd-plan.md'), 'utf8')
    .replace(/^---[\s\S]*?---\s*/, '').replaceAll('$ARGUMENTS', 'task-0001').trim();
  assert.ok(prompt.includes(committed), 'the committed prompt body is preserved before the local layer');
  assert.ok(prompt.indexOf('SENTINEL_LOCAL_CONTEXT') > committed.length, 'local text comes after the core');
  assert.ok(!calls.flat().some((a) => a === '/todomd-plan task-0001'),
    'with a local layer the body is inlined, so nothing can silently drop the addendum');
  clearFakeAgent();
});

test('no local layer still inlines the repo-owned command under isolated Claude mode', async () => {
  isolateHome();
  const argvLog = path.join(tmp('argv2'), 'argv.jsonl');
  useFakeAgent({ argv_log: argvLog });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0001');

  await pipeline.humanMove(p, 'task-0001', 'Plan');
  await until(() => status(repo, 'task-0001') === 'Planned', { timeout: BUDGET.stage });

  const calls = fs.readFileSync(argvLog, 'utf8').trim().split('\n').map(JSON.parse);
  const prompt = calls.flat().find((a) => typeof a === 'string' && a.includes('TODOMD command: todomd-plan task-0001'));
  assert.ok(prompt && prompt.includes('stub task-0001'), 'repo-owned prompt is explicit and inlined');
  assert.ok(!calls.flat().includes('/todomd-plan task-0001'), 'user/global slash-command expansion is never used');
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
  await until(() => status(repo, 'task-0001') === 'Verify' && fs.existsSync(marker), { timeout: BUDGET.chain });

  assert.equal((await pipeline.cancel(p, 'task-0001')).ok, true);
  // the cancel reverts to Queue and re-enqueues: build #2 runs (the hang fired
  // once), verify passes, the card lands in Done with no human action
  await until(() => status(repo, 'task-0001') === 'Done', { timeout: BUDGET.chain });
  assert.equal(readCard(repo, 'task-0001').data.verification.attempts, 1,
    'the cancelled attempt was rolled back — the resumed build is attempt 1 again');
  clearFakeAgent();
});

test('cancel during Build re-enqueues — the card resumes to Done on its own, no attempt burned', async () => {
  isolateHome();
  const marker = path.join(tmp('buildhang'), 'started');
  useFakeAgent({ build: 'good', verdict: 'pass', hang: '1', hang_marker: marker }); // build hangs once
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Planned' });

  await pipeline.humanMove(p, 'task-0001', 'Queue');
  await until(() => status(repo, 'task-0001') === 'Build' && fs.existsSync(marker), { timeout: BUDGET.chain });

  assert.equal((await pipeline.cancel(p, 'task-0001')).ok, true);
  // the cancel reverts to Queue and re-enqueues (like the Verify cancel): build
  // #2 runs (the hang fired once), verify passes, Done with no human action
  await until(() => status(repo, 'task-0001') === 'Done', { timeout: BUDGET.chain });
  assert.equal(readCard(repo, 'task-0001').data.verification.attempts, 1,
    'the cancelled attempt was rolled back — the resumed build is attempt 1 again');
  clearFakeAgent();
});

test('cancel during a retry Build preserves the candidate for explicit recovery', async () => {
  isolateHome();
  const counter = path.join(tmp('retryhang'), 'builds');
  // the RETRY build (2nd build-stage run) hangs until cancelled
  useFakeAgent({ build: 'good', verdict: 'fail', hang: 'build', hang_on: '2', hang_counter: counter });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Planned' });

  await pipeline.humanMove(p, 'task-0001', 'Queue');
  // build #1 ok → verify fails → the retry build starts and hangs
  await until(() => fs.existsSync(counter) && fs.readFileSync(counter, 'utf8') === '2' &&
    status(repo, 'task-0001') === 'Build', { timeout: BUDGET.chain });

  assert.equal((await pipeline.cancel(p, 'task-0001')).ok, true);
  await until(() => status(repo, 'task-0001') === 'Needs Human' && !pipeline.hasLiveRun(p.name, 'task-0001'), { timeout: BUDGET.chain });
  assert.equal(readCard(repo, 'task-0001').data.needs_human_reason, 'build_cancelled');
  assert.equal(readCard(repo, 'task-0001').data.verification.attempts, 2);
  assert.ok(fs.existsSync(path.join(repo, '.todomd/worktrees/task-0001')));
  assert.equal(fs.readFileSync(counter, 'utf8'), '2', 'no automatic replacement Build');
  clearFakeAgent();
});

test('a retriage in the queue-shift→spawn window reverts safely — the chain never stomps it', async () => {
  isolateHome();
  useFakeAgent({ verdict: 'pass', build: 'good' });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Planned' });

  await pipeline.humanMove(p, 'task-0001', 'Queue');
  // the chain is claimed (pending) but the build hasn't spawned yet: other
  // moves are refused as a live run, and a retriage has no child to SIGTERM —
  // it flags the chain, which must revert at its pre-spawn checkpoint
  const refused = await pipeline.humanMove(p, 'task-0001', 'Plan');
  assert.equal(refused.ok, false);
  assert.match(refused.error, /run in progress/);
  const r = await pipeline.humanMove(p, 'task-0001', 'Review');
  assert.equal(r.ok, true);

  await until(() => status(repo, 'task-0001') === 'Review' && !pipeline.hasLiveRun(p.name, 'task-0001'), { timeout: BUDGET.stage });
  // give the cancelled chain every chance to stomp the card back into the flow
  await sleep(1000);
  assert.equal(status(repo, 'task-0001'), 'Review', 'the chain did not stomp the retriage');
  assert.equal(pipeline.hasLiveRun(p.name, 'task-0001'), false);
  assert.equal(readCard(repo, 'task-0001').data.worktree || '', '', 'no stale worktree frontmatter');
  clearFakeAgent();
});

test('stage_timeout_min: 0 disables the stage timer (a hung agent is never timed out)', async () => {
  isolateHome();
  const marker = path.join(tmp('timeout0'), 'started');
  useFakeAgent({ build: 'good', hang: '1', hang_marker: marker }); // build hangs forever
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  fs.appendFileSync(path.join(repo, '.todomd/config.yml'), 'stage_timeout_min: 0\n');
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Planned' });

  await pipeline.humanMove(p, 'task-0001', 'Queue');
  await until(() => fs.existsSync(marker), { timeout: BUDGET.chain }); // build is live and hung
  const { runs } = await import('../src/runstore.js');
  assert.equal(runs.get(`${p.name}:task-0001`)?.timeoutMin, 0, 'no timer was armed');
  await sleep(1200); // long enough that any small-value timer would have fired
  assert.ok(pipeline.hasLiveRun(p.name, 'task-0001'), 'hung child NOT killed — the timer is disabled');
  assert.equal(status(repo, 'task-0001'), 'Build');

  await pipeline.humanMove(p, 'task-0001', 'Review'); // cleanup: cancel the hung run
  await until(() => status(repo, 'task-0001') === 'Review' && !pipeline.hasLiveRun(p.name, 'task-0001'), { timeout: BUDGET.stage });
  clearFakeAgent();
});

test('stage_timeout_min: a huge value clamps under the setTimeout ceiling instead of overflow-killing the run', async () => {
  isolateHome();
  useFakeAgent({ verdict: 'pass', build: 'good' });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  // 1e12 minutes ≈ 1.9M years; unclamped it overflows setTimeout's 32-bit
  // delay, which Node silently truncates to 1ms — instantly killing every run
  fs.appendFileSync(path.join(repo, '.todomd/config.yml'), 'stage_timeout_min: 1000000000000\n');
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Planned' });

  await pipeline.humanMove(p, 'task-0001', 'Queue');
  await until(() => status(repo, 'task-0001') === 'Done', { timeout: BUDGET.stage });
  clearFakeAgent();
});

test('a verify spawn failing on a deleted worktree cwd is worktree_failed, not cli_missing', async () => {
  isolateHome();
  useFakeAgent({ verdict: 'pass', build: 'good', rm_worktree: '1' }); // build deletes its own worktree
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  // no verify_command → no CI stage, so Verify is the first thing to enter the
  // (now missing) worktree, which is what this test is about
  const cfg = path.join(repo, '.todomd/config.yml');
  fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace(/^verify_command:.*\n/m, ''));
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'no verify command']);
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Planned' });

  await pipeline.humanMove(p, 'task-0001', 'Queue');
  await until(() => status(repo, 'task-0001') === 'Needs Human', { timeout: BUDGET.stage });

  const card = readCard(repo, 'task-0001');
  assert.equal(card.data.needs_human_reason, 'worktree_failed',
    'ENOENT on the spawn cwd is a worktree failure, not a missing CLI');
  clearFakeAgent();
});

test('a CI command failing on a deleted worktree cwd is worktree_failed, not a failing gate', async () => {
  isolateHome();
  useFakeAgent({ verdict: 'pass', build: 'good', rm_worktree: '1' }); // build deletes its own worktree
  pipeline.init({ broadcast: noop });
  const repo = makeRepo(); // keeps the fixture's verify_command → CI runs first
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Planned' });

  await pipeline.humanMove(p, 'task-0001', 'Queue');
  await until(() => status(repo, 'task-0001') === 'Needs Human', { timeout: BUDGET.stage });

  assert.equal(readCard(repo, 'task-0001').data.needs_human_reason, 'worktree_failed',
    'a vanished worktree is an environment failure, not "your tests failed"');
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
  await patchFrontmatter(repo, 'task-0001', { agent: 'codex', model: 'gpt-test' });
  fs.rmSync(path.join(repo, '.claude/commands/todomd-build.md'));

  const r = await pipeline.humanMove(p, 'task-0001', 'Queue'); // codex is a supported vendor → gate passes
  assert.equal(r.ok, true);
  await until(() => status(repo, 'task-0001') === 'Needs Human', { timeout: BUDGET.stage });

  const card = readCard(repo, 'task-0001');
  assert.equal(card.data.needs_human_reason, 'pipeline_error');
  await until(() => !pipeline.hasLiveRun(p.name, 'task-0001'), { timeout: BUDGET.stage });
  assert.ok(pipeline.getBanners().some((b) => b.level === 'error' && /pipeline error/.test(b.text)),
    'an error banner is set instead of vanishing silently');
  clearFakeAgent();
});

test('a card removed externally while Build waits on admission releases its exact pending claim', async () => {
  isolateHome();
  await sleep(300);
  scheduler.resetState();
  useFakeAgent({ build: 'good', verdict: 'pass' });
  const events = [];
  pipeline.init({ broadcast: (event) => events.push(event) });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Planned' });

  let sample = { cpuLoad: 0.99 };
  scheduler.setGovernor(createGovernor({
    thresholds: resourcesConfig({ resources: { cpu: { defer: 0.8, resume: 0.5, critical: 1.5 }, recovery_samples: 1 } }),
    sample: () => sample,
  }));
  scheduler.tick();

  try {
    assert.equal((await pipeline.humanMove(p, 'task-0001', 'Queue')).ok, true);
    await until(() => pipeline.getRunStates(p.name)['task-0001']?.state === 'deferred',
      { timeout: BUDGET.quick });

    const card = readCard(repo, 'task-0001');
    fs.unlinkSync(path.join(repo, '.todomd/tasks', card.file));
    sample = { cpuLoad: 0.05 };
    scheduler.tick();

    await until(() => !pipeline.hasLiveRun(p.name, 'task-0001')
      && !scheduler.isQueued(p.name, 'task-0001'), { timeout: BUDGET.stage });
    assert.equal(fs.existsSync(path.join(repo, '.todomd/worktrees/task-0001')), false,
      'a missing card never creates or recreates a worktree');
    assert.ok(events.some((event) => event.type === 'run-state'
      && event.card === 'task-0001' && event.state === 'idle'),
    'the abandoned admission publishes a terminal idle state');
  } finally {
    pipeline.forgetProject(p.name);
    await pipeline.killAllChildren({ graceMs: 1000 });
    clearFakeAgent();
    scheduler.resetState();
  }
});

for (const column of ['CI', 'Verify']) {
  test(`a card removed externally while ${column} waits on admission never spawns or merges`, async () => {
    isolateHome();
    await sleep(300);
    scheduler.resetState();
    useFakeAgent({ build: 'good', verdict: 'pass' });
    const repo = makeRepo();
    const blockerRepo = makeRepo();
    const marker = path.join(tmp(`deleted-${column.toLowerCase()}`), 'ci-started');
    for (const configuredRepo of [repo, blockerRepo]) {
      const configured = path.join(configuredRepo, '.todomd/config.yml');
      fs.writeFileSync(configured, fs.readFileSync(configured, 'utf8') +
        `scheduler:\n  global: 2\n  columns:\n    ${column}: 1\n`);
      git(configuredRepo, ['add', '-A']);
      git(configuredRepo, ['commit', '-qm', `configure ${column} deletion race`]);
    }
    const cfg = path.join(repo, '.todomd/config.yml');
    if (column === 'CI') {
      fs.writeFileSync(path.join(repo, 'ci-deletion-marker.mjs'),
        `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'started');\n`);
      fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8')
        .replace('verify_command: node --version', 'verify_command: node ci-deletion-marker.mjs'));
      git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'configure CI deletion marker']);
    }
    const p = project(repo);
    const blocker = project(blockerRepo);
    writeCard(repo, 'task-0001', { status: 'Planned' });

    let releaseHolder;
    const holder = scheduler.schedule(blocker, `${column.toLowerCase()}-holder`, column,
      () => new Promise((resolve) => { releaseHolder = resolve; }));

    try {
      assert.equal((await pipeline.humanMove(p, 'task-0001', 'Queue')).ok, true);
      await until(() => {
        const state = pipeline.getRunStates(p.name)['task-0001'];
        return state?.stage === column && state.state === 'queued';
      }, { timeout: BUDGET.chain, label: `${column} waits behind the synthetic holder` });

      const card = readCard(repo, 'task-0001');
      const worktree = path.join(repo, '.todomd/worktrees/task-0001');
      assert.ok(fs.existsSync(worktree), 'Build work is preserved before the queued stage');
      fs.unlinkSync(path.join(repo, '.todomd/tasks', card.file));
      releaseHolder();
      await holder;

      await until(() => !pipeline.hasLiveRun(p.name, 'task-0001')
        && !scheduler.isQueued(p.name, 'task-0001'), { timeout: BUDGET.stage });
      assert.ok(fs.existsSync(worktree), 'external deletion does not discard the candidate worktree');
      assert.equal(fs.existsSync(path.join(repo, '.todomd/runs/task-0001/verify-1.jsonl')), false,
        'the deleted card never spawns Verify');
      assert.equal(fs.existsSync(marker), false, 'the deleted card never starts its CI command');
      assert.doesNotMatch(fs.readFileSync(path.join(repo, 'src/calc.js'), 'utf8'), /export function prod/,
        'the deleted card is never merged');
    } finally {
      releaseHolder?.();
      pipeline.forgetProject(p.name);
      pipeline.forgetProject(blocker.name);
      await pipeline.killAllChildren({ graceMs: 1000 });
      clearFakeAgent();
      scheduler.resetState();
    }
  });
}

test('detached HEAD at fork stamps base_branch "unknown" and refuses the merge (base_branch_unknown)', async () => {
  isolateHome();
  useFakeAgent({ verdict: 'pass', build: 'good' });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  git(repo, ['checkout', '-q', '--detach', 'HEAD']); // fork happens on a detached HEAD
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Planned' });

  await pipeline.humanMove(p, 'task-0001', 'Queue');
  await until(() => status(repo, 'task-0001') === 'Needs Human', { timeout: BUDGET.stage });

  const card = readCard(repo, 'task-0001');
  assert.equal(card.data.base_branch, 'unknown', 'detached fork records the unknown marker');
  assert.equal(card.data.needs_human_reason, 'base_branch_unknown');
  // work preserved: nothing merged, worktree + branch kept
  assert.ok(fs.existsSync(path.join(repo, '.todomd/worktrees/task-0001')), 'worktree preserved');
  assert.match(git(repo, ['branch', '--list', 'todomd/task-0001']), /todomd\/task-0001/, 'task branch preserved');
  clearFakeAgent();
});

test('a stale worktree checked out on the wrong branch is recreated, not reused', async () => {
  isolateHome();
  useFakeAgent({ verdict: 'pass', build: 'good' });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  // a leftover dir at the worktree path, switched to another branch (e.g. by
  // the user) — the build must NOT run inside it
  const wt = path.join(repo, '.todomd/worktrees/task-0001');
  git(repo, ['worktree', 'add', '-q', wt, '-b', 'stale-branch']);
  fs.writeFileSync(path.join(wt, 'SENTINEL'), 'stale\n');
  writeCard(repo, 'task-0001', { status: 'Planned' });

  await pipeline.humanMove(p, 'task-0001', 'Queue');
  await until(() => status(repo, 'task-0001') === 'Done', { timeout: BUDGET.stage });

  // the build ran in a fresh worktree on todomd/task-0001 and merged cleanly
  assert.match(fs.readFileSync(path.join(repo, 'src/calc.js'), 'utf8'), /export function prod/);
  assert.ok(!fs.existsSync(wt), 'worktree pruned after Done');
  assert.match(git(repo, ['branch', '--list', 'stale-branch']), /stale-branch/, 'the unrelated branch is untouched');
  clearFakeAgent();
});

test('a merge that lands nothing ("Already up to date", branch not an ancestor) → Needs Human, never Done', async () => {
  isolateHome();
  useFakeAgent({ verdict: 'pass', build: 'good' });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Planned' });

  // shim `git merge` to fake success without merging (everything else passes
  // through to the real git) — the orchestrator must not mark Done on a noop
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const shimDir = tmp('gitshim');
  fs.writeFileSync(path.join(shimDir, 'git'),
    `#!/bin/sh\nfor a in "$@"; do if [ "$a" = "merge" ]; then echo "Already up to date."; exit 0; fi; done\nexec "${realGit}" "$@"\n`);
  fs.chmodSync(path.join(shimDir, 'git'), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${shimDir}:${oldPath}`;
  try {
    await pipeline.humanMove(p, 'task-0001', 'Queue');
    await until(() => status(repo, 'task-0001') === 'Needs Human', { timeout: BUDGET.stage });
  } finally {
    process.env.PATH = oldPath;
  }

  const card = readCard(repo, 'task-0001');
  assert.equal(card.data.needs_human_reason, 'merge_noop');
  assert.doesNotMatch(fs.readFileSync(path.join(repo, 'src/calc.js'), 'utf8'), /export function prod/,
    'nothing landed on the base branch');
  assert.match(git(repo, ['branch', '--list', 'todomd/task-0001']), /todomd\/task-0001/, 'work preserved on the branch');
  clearFakeAgent();
});

test('orphan sweep: merged branch finishes as Done; unmerged work is preserved as Needs Human', async () => {
  isolateHome();
  useFakeAgent();
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  addProject(repo); // reconcileOnBoot iterates registered projects

  // both cards committed on the base first, so the branch dance below never
  // sweeps an untracked card file into a branch commit
  writeCard(repo, 'task-0001', { status: 'Build' });
  writeCard(repo, 'task-0002', { status: 'Verify' });
  git(repo, ['add', '.todomd/tasks']); git(repo, ['commit', '-qm', 'cards']);

  // card A: left in Build by a crash AFTER its branch was merged into the base
  git(repo, ['checkout', '-qb', 'todomd/task-0001']);
  fs.appendFileSync(path.join(repo, 'src/calc.js'), 'export const a = 1;\n');
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'work A']);
  git(repo, ['checkout', '-q', '-']);
  git(repo, ['merge', '-q', '--no-ff', 'todomd/task-0001', '-m', 'merged A']);

  // card B: left in Verify by a crash with its branch NOT merged
  git(repo, ['checkout', '-qb', 'todomd/task-0002']);
  fs.appendFileSync(path.join(repo, 'src/calc.js'), 'export const b = 1;\n');
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'work B']);
  git(repo, ['checkout', '-q', '-']);

  await pipeline.reconcileOnBoot();

  assert.equal(status(repo, 'task-0001'), 'Done', 'merged work completes instead of being deleted');
  const cardB = readCard(repo, 'task-0002');
  assert.equal(cardB.data.status, 'Needs Human');
  assert.equal(cardB.data.needs_human_reason, 'orphaned_run');
  assert.match(git(repo, ['branch', '--list', 'todomd/task-0002']), /todomd\/task-0002/, 'unmerged branch is KEPT');
  clearFakeAgent();
});

test('restart restores a clean Verify checkpoint through trusted CI instead of orphaning it', async () => {
  isolateHome();
  useFakeAgent({ verdict: 'pass', build: 'good' });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  addProject(repo);
  const branch = 'todomd/task-0003';
  const wt = path.join(repo, '.todomd/worktrees/task-0003');
  const base = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);

  writeCard(repo, 'task-0003', { status: 'Verify' });
  await patchFrontmatter(repo, 'task-0003', {
    worktree: branch,
    base_branch: base,
    verification: { attempts: 1, max_attempts: 3, last_verdict: '' },
  });
  git(repo, ['add', '.todomd/tasks']);
  git(repo, ['commit', '-qm', 'verify checkpoint']);
  git(repo, ['worktree', 'add', '-q', '-b', branch, wt]);
  fs.appendFileSync(path.join(wt, 'src/calc.js'), 'export const restoredCheckpoint = true;\n');
  git(wt, ['add', '-A']);
  git(wt, ['commit', '-qm', 'candidate ready for verification']);

  await pipeline.reconcileOnBoot();
  await until(() => status(repo, 'task-0003') === 'Done', { timeout: BUDGET.chain });

  assert.match(fs.readFileSync(path.join(repo, 'src/calc.js'), 'utf8'), /restoredCheckpoint/);
  const finished = readCard(repo, 'task-0003');
  assert.match(finished.raw, /restart checkpoint restored · Verify attempt 1/);
  assert.doesNotMatch(finished.raw, /orphaned_run/);
  clearFakeAgent();
});

test('Resume Build reuses an orphaned Build worktree, saved attempt, and partial changes', async () => {
  isolateHome();
  useFakeAgent({ verdict: 'pass', build: 'good', require_file: 'resume-sentinel.txt' });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  addProject(repo);
  const base = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = 'todomd/task-0001';
  const wt = path.join(repo, '.todomd/worktrees/task-0001');

  writeCard(repo, 'task-0001', { status: 'Build' });
  await patchFrontmatter(repo, 'task-0001', {
    worktree: branch,
    base_branch: base,
    session_id: 'fake-session-0001',
    verification: { attempts: 1, max_attempts: 3, last_verdict: '' },
  });
  git(repo, ['add', '.todomd/tasks']); git(repo, ['commit', '-qm', 'interrupted build card']);
  git(repo, ['worktree', 'add', '-q', '-b', branch, wt]);
  fs.writeFileSync(path.join(wt, 'resume-sentinel.txt'), 'uncommitted work survives\n');
  fs.appendFileSync(path.join(wt, 'src/calc.js'), 'export const interruptedPartial = true;\n');

  try {
    await pipeline.reconcileOnBoot();
    let card = readCard(repo, 'task-0001');
    assert.equal(card.data.status, 'Needs Human');
    assert.equal(card.data.needs_human_reason, 'orphaned_run');
    assert.equal(card.data.recovery_stage, 'Build');
    assert.equal((await pipeline.recoveryActions(p, 'task-0001')).resume_build, true);
    assert.ok(fs.existsSync(path.join(wt, 'resume-sentinel.txt')), 'orphan sweep kept uncommitted work');

    const resumed = await pipeline.resumeBuild(p, 'task-0001');
    assert.equal(resumed.ok, true);
    assert.equal(resumed.attempt, 1, 'resume does not burn a new attempt');
    await until(() => status(repo, 'task-0001') === 'Done', { timeout: BUDGET.chain });

    card = readCard(repo, 'task-0001');
    assert.equal(card.data.verification.attempts, 1);
    assert.match(fs.readFileSync(path.join(repo, 'src/calc.js'), 'utf8'), /interruptedPartial/,
      'the partial work present before restart was merged');
    assert.equal(fs.readFileSync(path.join(repo, 'resume-sentinel.txt'), 'utf8'), 'uncommitted work survives\n',
      'an uncommitted worktree file survived and was completed by the resumed run');
    assert.ok(!fs.existsSync(wt), 'normal successful cleanup still removes the worktree');
  } finally {
    clearFakeAgent();
  }
});

test('Resume Build eligibility requires the marked Build origin and a live preserved worktree', async () => {
  isolateHome();
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0001', {
    status: 'Needs Human',
    extra: 'needs_human_reason: orphaned_run\nrecovery_stage: Build\nworktree: todomd/task-0001\n',
  });

  const actions = await pipeline.recoveryActions(p, 'task-0001');
  assert.equal(actions.resume_build, false);
  assert.equal(actions.restart_build, true);
  const result = await pipeline.resumeBuild(p, 'task-0001');
  assert.equal(result.ok, false);
  assert.match(result.error, /preserved Build worktree/);
  assert.equal(status(repo, 'task-0001'), 'Needs Human');
});

test('Restart Build re-drives a legacy orphan only when its preserved assets are gone', async () => {
  isolateHome();
  useFakeAgent({ verdict: 'pass', build: 'good' });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0001', {
    status: 'Needs Human',
    extra: 'needs_human_reason: orphaned_run\nsession_id: stale-session\nworktree: todomd/task-0001\nbase_branch: main\n',
  });
  // Exact task-0040 failure mode: the worktree vanished but its branch did not.
  // Restart must preserve that ref, free the canonical name, and fork fresh
  // work from current main rather than failing `git worktree add -b`.
  git(repo, ['branch', 'todomd/task-0001']);

  try {
    const actions = await pipeline.recoveryActions(p, 'task-0001');
    assert.equal(actions.resume_build, false);
    assert.equal(actions.restart_build, true, 'legacy orphan with no worktree offers a fresh retry');

    const restarted = await pipeline.restartBuild(p, 'task-0001');
    assert.equal(restarted.ok, true);
    await until(() => status(repo, 'task-0001') === 'Done', { timeout: BUDGET.chain });

    const card = readCard(repo, 'task-0001');
    assert.equal(card.data.verification.attempts, 1, 'fresh retry starts at attempt one');
    assert.match(card.raw, /Restart Build · preserved worktree unavailable; starting a fresh build/);
    const archived = git(repo, ['branch', '--list', 'todomd/task-0001-preserved-*']);
    assert.match(archived, /todomd\/task-0001-preserved-/,
      'the surviving orphan branch is retained under a backup ref');
    assert.ok(!fs.existsSync(path.join(repo, '.todomd/worktrees/task-0001')),
      'successful Build → Verify → Done cleanup is unchanged');
  } finally {
    clearFakeAgent();
  }
});

test('Retry Verification is claimed before its background spawn and refuses an immediate voice move', async () => {
  isolateHome();
  useFakeAgent({ hang: 'verify' });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  const base = git(repo, ['branch', '--show-current']);
  const branch = 'todomd/task-0001';
  const worktree = path.join(repo, '.todomd/worktrees/task-0001');
  writeCard(repo, 'task-0001', {
    status: 'Needs Human',
    extra: `needs_human_reason: bad_verdict\nsession_id: fake-session\nworktree: ${branch}\nbase_branch: ${base}\n`,
  });
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'seed preserved verification']);
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  git(repo, ['worktree', 'add', '-q', worktree, '-b', branch]);

  try {
    assert.deepEqual(await pipeline.retryVerification(p, 'task-0001'), { ok: true });
    // No polling: the retry has returned but its exact-HEAD CI refresh may
    // still be awaiting admission. Its synchronous claim must already be
    // visible and protective across CI -> Verify.
    assert.equal(pipeline.hasLiveRun(p.name, 'task-0001'), true);
    assert.deepEqual(pipeline.getRunStates(p.name)['task-0001'], { state: 'running', stage: 'CI' });
    assert.deepEqual(voice.buildVoiceSummary(p).activeRuns,
      [{ card: 'task-0001', state: 'running', stage: 'CI', external: false }]);
    const retriage = await voice.prepareVoiceAction(p, { cardId: 'task-0001', action: 'retriage' });
    assert.equal(retriage.status, 400);
    assert.match(retriage.error, /live run/);
    assert.ok(fs.existsSync(worktree), 'the refused voice move preserved the verification worktree');

    assert.deepEqual(await pipeline.humanMove(p, 'task-0001', 'Review'), { ok: true, cancelled: true });
    await until(() => status(repo, 'task-0001') === 'Review' && !pipeline.hasLiveRun(p.name, 'task-0001'),
      { timeout: BUDGET.stage });
  } finally {
    pipeline.cancel(p, 'task-0001');
    await pipeline.killAllChildren({ graceMs: 1000 });
    clearFakeAgent();
  }
});

// A Needs Human card whose preserved worktree/branch make it eligible for the
// direct Retry Verification action (the same seed the test above builds inline).
function seedPreservedVerification(repo, id) {
  const base = git(repo, ['branch', '--show-current']);
  const branch = `todomd/${id}`;
  const worktree = path.join(repo, '.todomd/worktrees', id);
  writeCard(repo, id, {
    status: 'Needs Human',
    extra: `needs_human_reason: bad_verdict\nsession_id: fake-session\nworktree: ${branch}\nbase_branch: ${base}\n`,
  });
  const cardFile = path.join(repo, '.todomd/tasks', `${id}-card.md`);
  fs.writeFileSync(cardFile, fs.readFileSync(cardFile, 'utf8')
    .replace('verification: { attempts: 0,', 'verification: { attempts: 1,'));
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', `seed preserved verification ${id}`]);
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  git(repo, ['worktree', 'add', '-q', worktree, '-b', branch]);
  // Recovery fixtures represent an actual candidate, not an empty branch.
  // Empty candidates are covered by recommended-fixes.test.js and stop at CI.
  fs.writeFileSync(path.join(worktree, 'src/preserved-candidate.js'), 'export const candidate = true;\n');
  git(worktree, ['add', 'src/preserved-candidate.js']);
  git(worktree, ['commit', '-qm', 'seed preserved candidate']);
  return { branch, worktree };
}
const spawnedAnything = (repo, id) => fs.existsSync(path.join(repo, '.todomd/runs', id));

test('Retry Verification performs a tool-less review through CPU pressure when exact-HEAD CI is trusted', async () => {
  isolateHome();
  await sleep(300); // let earlier tests' releases drain before resetting (see the governor test above)
  scheduler.resetState();
  const argvLog = path.join(tmp('light-verify'), 'argv.jsonl');
  useFakeAgent({ verdict: 'pass', argv_log: argvLog });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  const { worktree } = seedPreservedVerification(repo, 'task-0001');
  await patchFrontmatter(repo, 'task-0001', {
    ci_evidence: {
      head: git(worktree, ['rev-parse', 'HEAD']), command: 'node --version',
      passed_at: '2026-01-01T00:00:00.000Z', clean: true,
    },
  });

  let sample = { cpuLoad: 0.99 }; // breach — the governor defers
  scheduler.setGovernor(createGovernor({
    thresholds: resourcesConfig({ resources: { cpu: { defer: 0.8, resume: 0.5, critical: 1.5 }, recovery_samples: 1 } }),
    sample: () => sample,
  }));
  scheduler.tick(); // seed the deferring state

  try {
    assert.deepEqual(await pipeline.retryVerification(p, 'task-0001'), { ok: true });
    await until(() => status(repo, 'task-0001') === 'Done', { timeout: BUDGET.stage });
    await until(() => !pipeline.hasLiveRun(p.name, 'task-0001'), { timeout: BUDGET.quick });
    const argv = fs.readFileSync(argvLog, 'utf8').trim().split('\n').map(JSON.parse).at(-1);
    assert.match(argv.find((arg) => arg.includes('Resource-aware tool-less review')), /CPU pressure/);
    assert.deepEqual(argv.slice(argv.indexOf('--tools'), argv.indexOf('--tools') + 2), ['--tools', '']);
    assert.equal(sample.cpuLoad, 0.99, 'the review completed without waiting for CPU recovery');
  } finally {
    pipeline.forgetProject(p.name);
    await pipeline.killAllChildren({ graceMs: 1000 });
    clearFakeAgent();
    scheduler.resetState();
  }
});

test('a tool-less review that requests checks preserves its findings and queues a heavy continuation', async () => {
  isolateHome();
  await sleep(300);
  scheduler.resetState();
  const marker = path.join(tmp('light-followup'), 'requested');
  const argvLog = path.join(path.dirname(marker), 'argv.jsonl');
  useFakeAgent({
    verdict: 'pass', checks_requested: 'npm test -- focused', checks_marker: marker,
    argv_log: argvLog,
  });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  const { worktree } = seedPreservedVerification(repo, 'task-0001');
  await patchFrontmatter(repo, 'task-0001', {
    ci_evidence: {
      head: git(worktree, ['rev-parse', 'HEAD']), command: 'node --version',
      passed_at: '2026-01-01T00:00:00.000Z', clean: true,
    },
  });

  let sample = { cpuLoad: 0.99 };
  scheduler.setGovernor(createGovernor({
    thresholds: resourcesConfig({ resources: { cpu: { defer: 0.8, resume: 0.5, critical: 1.5 }, recovery_samples: 1 } }),
    sample: () => sample,
  }));
  scheduler.tick();

  try {
    assert.deepEqual(await pipeline.retryVerification(p, 'task-0001'), { ok: true });
    await until(() => pipeline.getRunStates(p.name)['task-0001']?.state === 'deferred',
      { timeout: BUDGET.stage });
    assert.match(readCard(repo, 'task-0001').raw,
      /preliminary review complete; 1 focused check queued/);
    assert.equal(readCard(repo, 'task-0001').data.verification.last_verdict || '', '',
      'a preliminary pass is never persisted as the final verdict');
    assert.equal(fs.readFileSync(argvLog, 'utf8').trim().split('\n').length, 1,
      'only the tool-less review ran while CPU was high');

    sample = { cpuLoad: 0.05 };
    scheduler.tick();
    await until(() => status(repo, 'task-0001') === 'Done', { timeout: BUDGET.stage });
    assert.equal(fs.existsSync(worktree), false, 'the normal successful cleanup still runs after final verification');
  } finally {
    pipeline.forgetProject(p.name);
    await pipeline.killAllChildren({ graceMs: 1000 });
    clearFakeAgent();
    scheduler.resetState();
  }
});

test('manual queue pause parks a direct Retry Verification CI refresh until resume', async () => {
  isolateHome();
  scheduler.resetState();
  useFakeAgent({ verdict: 'pass' });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  const { worktree } = seedPreservedVerification(repo, 'task-0001');

  try {
    pipeline.pauseQueue(p);
    assert.deepEqual(await pipeline.retryVerification(p, 'task-0001'), { ok: true });
    await sleep(150);
    assert.deepEqual(pipeline.getRunStates(p.name)['task-0001'],
      { state: 'queued', stage: 'CI' });
    assert.equal(spawnedAnything(repo, 'task-0001'), false,
      'the paused retry does not start its trusted CI refresh');
    assert.equal(fs.existsSync(worktree), true,
      'the paused retry keeps its preserved worktree');

    assert.deepEqual(pipeline.resumeQueue(p), { ok: true, queue_paused: false });
    await until(() => status(repo, 'task-0001') === 'Done', { timeout: BUDGET.stage });
  } finally {
    pipeline.forgetProject(p.name);
    await pipeline.killAllChildren({ graceMs: 1000 });
    clearFakeAgent();
    scheduler.resetState();
  }
});

test('a failed direct Retry Verification keeps ownership while its repair Build waits for admission', async () => {
  isolateHome();
  await sleep(300);
  scheduler.resetState();
  useFakeAgent({ verdict: 'fail', build: 'good' });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const configPath = path.join(repo, '.todomd/config.yml');
  fs.writeFileSync(configPath,
    fs.readFileSync(configPath, 'utf8').replace('concurrency: 1', 'concurrency: 2')
    + 'scheduler:\n  columns:\n    Build: 1\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'configure occupied Build column']);
  const p = project(repo);
  const { worktree } = seedPreservedVerification(repo, 'task-0001');
  let releaseBlocker;
  const blocker = scheduler.schedule(p, 'blocker', 'Build', () => new Promise((resolve) => {
    releaseBlocker = resolve;
  }));

  try {
    assert.deepEqual(await pipeline.retryVerification(p, 'task-0001'), { ok: true });
    await until(() => scheduler.queuedEntries(p.name)
      .some((entry) => entry.card === 'task-0001' && entry.column === 'Build'),
    { timeout: BUDGET.stage });
    assert.equal(pipeline.hasLiveRun(p.name, 'task-0001'), true,
      'the retry owns the card across Verify -> queued repair Build');
    assert.equal((await pipeline.retryVerification(p, 'task-0001')).ok, false,
      'a second recovery cannot overlap the queued repair');
    assert.deepEqual(await pipeline.humanMove(p, 'task-0001', 'Review'),
      { ok: true, cancelled: true });

    releaseBlocker();
    await blocker;
    await until(() => status(repo, 'task-0001') === 'Review'
      && !pipeline.hasLiveRun(p.name, 'task-0001'), { timeout: BUDGET.stage });
    assert.equal(readCard(repo, 'task-0001').data.verification.attempts, 1,
      'cancelling the queued repair does not erase its completed failed attempt');
    assert.equal(fs.existsSync(worktree), false,
      'cancelling the owned repair flow unwinds its preserved worktree');
  } finally {
    releaseBlocker?.();
    pipeline.forgetProject(p.name);
    await pipeline.killAllChildren({ graceMs: 1000 });
    clearFakeAgent();
  }
});

test('Retry Verification waits its turn when the Verify column is full — plainly queued, not deferred', async () => {
  isolateHome();
  useFakeAgent({ build: 'good', hang: 'verify' });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const cfg = path.join(repo, '.todomd/config.yml');
  // concurrency 2 so the project cap is not what holds the retry back — the
  // combined Verify column limit is.
  fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8')
    .replace('concurrency: 1', 'concurrency: 2') + 'scheduler:\n  columns:\n    Verify: 1\n');
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Planned' });
  seedPreservedVerification(repo, 'task-0002');

  try {
    await pipeline.humanMove(p, 'task-0001', 'Queue');
    await until(() => pipeline.getRunStates(p.name)['task-0001']?.stage === 'Verify'
      && pipeline.getRunStates(p.name)['task-0001']?.state === 'running', { timeout: BUDGET.chain });

    assert.deepEqual(await pipeline.retryVerification(p, 'task-0002'), { ok: true });
    await until(() => pipeline.getRunStates(p.name)['task-0002']?.stage === 'Verify'
      && pipeline.getRunStates(p.name)['task-0002']?.state === 'queued', { timeout: BUDGET.stage });
    // An ordinary capacity wait is 'queued' — 'deferred' stays reserved for
    // resource pressure, so a board never shows a normal turn-wait as load.
    assert.deepEqual(pipeline.getRunStates(p.name)['task-0002'], { state: 'queued', stage: 'Verify' });
    const runDir = path.join(repo, '.todomd/runs/task-0002');
    const files = fs.existsSync(runDir) ? fs.readdirSync(runDir) : [];
    assert.equal(files.some((file) => /^Verify/i.test(file)), false,
      'the retry refreshed CI evidence but never spawned Verify while its column was full');
  } finally {
    pipeline.forgetProject(p.name);
    await pipeline.killAllChildren({ graceMs: 1000 });
    clearFakeAgent();
  }
});

test('cancelling a CPU-deferred Retry Verification CI refresh unwinds through its claim', async () => {
  isolateHome();
  await sleep(300);
  scheduler.resetState();
  const argvLog = path.join(tmp('cancel-light-continuation'), 'argv.jsonl');
  useFakeAgent({ verdict: 'pass', argv_log: argvLog });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  const { worktree } = seedPreservedVerification(repo, 'task-0001');

  let sample = { cpuLoad: 0.99 };
  scheduler.setGovernor(createGovernor({
    thresholds: resourcesConfig({ resources: { cpu: { defer: 0.8, resume: 0.5, critical: 1.5 }, recovery_samples: 1 } }),
    sample: () => sample,
  }));
  scheduler.tick();

  try {
    assert.deepEqual(await pipeline.retryVerification(p, 'task-0001'), { ok: true });
    await until(() => pipeline.getRunStates(p.name)['task-0001']?.state === 'deferred',
      { timeout: BUDGET.stage });
    // pause the queue first, so the cancel's Queue re-drive parks instead of
    // starting a fresh Build we would then have to chase
    pipeline.pauseQueue(p);
    assert.deepEqual(await pipeline.cancel(p, 'task-0001'), { ok: true }, 'a queued retry is cancellable');

    // Cancellation does not wait for resource recovery: the queued admission
    // is removed and its preserved mid-flow state unwinds immediately.
    await until(() => status(repo, 'task-0001') === 'Needs Human' && !pipeline.hasLiveRun(p.name, 'task-0001'),
      { timeout: BUDGET.stage });
    assert.equal(readCard(repo, 'task-0001').data.verification.attempts, 1,
      'a queued re-verification has not opened an attempt to roll back');
    assert.equal(fs.existsSync(argvLog), false,
      'the cancelled CI refresh never spawned either CI or an agent review');
    assert.equal(fs.existsSync(worktree), true, 'cancel preserves the candidate');
    assert.ok(readCard(repo, 'task-0001').data.worktree, 'the candidate branch remains recorded');
  } finally {
    // deliberately NOT resumeQueue(): the pause marker lives in this test's own
    // temp repo, and resuming here would start the very Build this test parked
    pipeline.forgetProject(p.name);
    await pipeline.killAllChildren({ graceMs: 1000 });
    clearFakeAgent();
    scheduler.resetState();
  }
});

test('Codex Verify infrastructure failures retain diagnostics and Retry Verification runs Verify only', async () => {
  isolateHome();
  useFakeAgent({ verdict: 'pass', build: 'good' });
  process.env.TODOMD_CODEX_BIN = FAKE_CODEX;
  process.env.FAKE_CODEX_REQUIRE_STRICT_SCHEMA = '1';
  process.env.FAKE_CODEX_LAST_MESSAGE = 'verification transport returned no verdict';
  process.env.FAKE_CODEX_STDERR = 'codex transport disconnected\n';
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  await setStageRouting(repo, 'Verify', { agent: 'codex', model: 'gpt-test' });
  writeCard(repo, 'task-0001', { status: 'Planned' });
  await patchFrontmatter(repo, 'task-0001', { agent: 'claude' });

  try {
    await pipeline.humanMove(p, 'task-0001', 'Queue');
    await until(() => status(repo, 'task-0001') === 'Needs Human', { timeout: BUDGET.chain });
    await until(() => !pipeline.hasLiveRun(p.name, 'task-0001'), { timeout: BUDGET.stage });

    let card = readCard(repo, 'task-0001');
    assert.equal(card.data.needs_human_reason, 'bad_verdict');
    assert.match(card.raw, /Codex verification infrastructure:/);
    assert.match(card.raw, /codex transport disconnected/);
    assert.match(card.raw, /verification transport returned no verdict/);
    assert.doesNotMatch(card.raw, /failed: bad_verdict/, 'infrastructure was not labeled as a code failure');
    assert.equal((await pipeline.recoveryActions(p, 'task-0001')).retry_verification, true);

    await patchFrontmatter(repo, 'task-0001', {
      needs_human_reason: 'error',
      verification: { attempts: 1, max_attempts: 3, last_verdict: 'fail' },
    });
    assert.equal((await pipeline.recoveryActions(p, 'task-0001')).retry_verification, true,
      'a manually repaired worktree remains directly verifiable after repair infrastructure failed');
    await patchFrontmatter(repo, 'task-0001', {
      needs_human_reason: 'retry_failed',
      verification: { attempts: 2, max_attempts: 3, last_verdict: 'fail' },
    });
    assert.equal((await pipeline.recoveryActions(p, 'task-0001')).retry_verification, true,
      'a manually repaired worktree remains verifiable after escalation infrastructure failed');
    await patchFrontmatter(repo, 'task-0001', {
      needs_human_reason: 'attempts_exhausted',
      verification: { attempts: 3, max_attempts: 3, last_verdict: 'fail' },
    });
    assert.equal((await pipeline.recoveryActions(p, 'task-0001')).retry_verification, true,
      'a human-repaired preserved worktree can receive one more direct verification gate');
    await patchFrontmatter(repo, 'task-0001', {
      needs_human_reason: 'bad_verdict',
      verification: { attempts: 1, max_attempts: 3, last_verdict: '' },
    });

    const runDir = path.join(repo, '.todomd/runs/task-0001');
    const verifyLogs = fs.readdirSync(runDir).filter((f) => f.startsWith('verify-1') && f.endsWith('.jsonl'));
    assert.equal(verifyLogs.length, 2, 'the automatic rerun retained both raw attempts');
    for (const file of verifyLogs) {
      const raw = fs.readFileSync(path.join(runDir, file), 'utf8');
      assert.match(raw, /"type":"runner-diagnostic"/);
      assert.match(raw, /"executable":/);
      assert.match(raw, /"cwd":/);
      assert.match(raw, /"exitCode":0/);
      assert.match(raw, /codex transport disconnected/);
      assert.match(raw, /verification transport returned no verdict/);
    }

    const buildLogsBefore = fs.readdirSync(runDir).filter((f) => f.startsWith('build-')).length;
    process.env.FAKE_CODEX_LAST_MESSAGE = JSON.stringify({
      verdict: 'pass', criteria: [{ criterion: 'works', met: true }], findings: 'all good',
    });
    const retried = await pipeline.retryVerification(p, 'task-0001');
    assert.equal(retried.ok, true);
    await until(() => status(repo, 'task-0001') === 'Done', { timeout: BUDGET.stage });
    const buildLogsAfter = fs.readdirSync(runDir).filter((f) => f.startsWith('build-')).length;
    assert.equal(buildLogsAfter, buildLogsBefore, 'Retry Verification did not run Build again');
    card = readCard(repo, 'task-0001');
    assert.equal(card.data.verification.attempts, 1);
  } finally {
    delete process.env.TODOMD_CODEX_BIN;
    delete process.env.FAKE_CODEX_REQUIRE_STRICT_SCHEMA;
    clearFakeAgent();
  }
});

test('triageSweep skips unparseable cards and banners once per file', async () => {
  isolateHome();
  pipeline.init({ broadcast: noop });
  const repo = makeRepo({ triage: true });
  const p = project(repo);
  // a card whose frontmatter can't be parsed (the billing-loop case)
  fs.writeFileSync(path.join(repo, '.todomd/tasks/task-0009-broken.md'), '---\nbad: [unclosed\n---\n');

  pipeline.triageSweep(p);
  pipeline.triageSweep(p); // a second sweep must not add a second banner

  const banners = pipeline.getBanners().filter((b) => b.text.includes('task-0009-broken.md'));
  assert.equal(banners.length, 1, 'one banner per unparseable file');
  assert.equal(banners[0].level, 'error');
  assert.deepEqual(pipeline.getRunStates(p.name), {}, 'no triage run spawned for the unparseable card');
});

test('stage tools resolve from the committed config (HEAD:), not a working-tree edit', async () => {
  isolateHome();
  const argvLog = path.join(tmp('argv'), 'argv.jsonl');
  useFakeAgent({ argv_log: argvLog });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  // commit a config whose Plan stage carries a sentinel tool, then poison the
  // working-tree copy — the run must see the COMMITTED allowlist
  const cfgPath = path.join(repo, '.todomd/config.yml');
  fs.writeFileSync(cfgPath, fs.readFileSync(cfgPath, 'utf8')
    .replace('  Plan:\n    command: todomd-plan\n    model: sonnet\n',
      '  Plan:\n    command: todomd-plan\n    model: sonnet\n    allowed_tools: [Read, "SentinelCommitted"]\n'));
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'config']);
  fs.writeFileSync(cfgPath, fs.readFileSync(cfgPath, 'utf8').replace('SentinelCommitted', 'SentinelPoisoned'));
  const p = project(repo);
  writeCard(repo, 'task-0001');

  await pipeline.humanMove(p, 'task-0001', 'Plan');
  await until(() => status(repo, 'task-0001') === 'Planned', { timeout: BUDGET.stage });

  const calls = fs.readFileSync(argvLog, 'utf8').trim().split('\n').map(JSON.parse);
  const planCall = calls.find((a) => a.includes('--allowedTools'));
  assert.ok(planCall, 'the plan run received an allowlist');
  const tools = planCall[planCall.indexOf('--allowedTools') + 1];
  assert.match(tools, /SentinelCommitted/, 'the committed config drives the run');
  assert.doesNotMatch(tools, /SentinelPoisoned/, 'a working-tree config edit is not armed mid-run');
  clearFakeAgent();
});


for (const missing of ['empty', '1']) {
  test(`cross-vendor verdict retry recovers a missing Build session (${missing}) with findings`, async () => {
    isolateHome();
    const dir = tmp('cross-vendor-retry');
    const argvLog = path.join(dir, 'argv.jsonl');
    useFakeAgent({ build: 'good', resume_missing: missing, argv_log: argvLog });
    process.env.TODOMD_CODEX_BIN = FAKE_CODEX;
    process.env.FAKE_CODEX_FAIL_ONCE = path.join(dir, 'failed-once');
    pipeline.init({ broadcast: noop });
    const repo = makeRepo();
    const p = project(repo);
    await setStageRouting(repo, 'Verify', { agent: 'codex', model: 'gpt-test' });
    writeCard(repo, 'task-0001', { status: 'Planned' });
    try {
      await pipeline.humanMove(p, 'task-0001', 'Queue');
      await until(() => ['Done', 'Needs Human'].includes(status(repo, 'task-0001')), { timeout: BUDGET.chain });
      const card = readCard(repo, 'task-0001');
      const freshLog = path.join(repo, '.todomd/runs/task-0001/build-2-fresh.jsonl');
      const diagnostics = fs.existsSync(freshLog) ? fs.readFileSync(freshLog, 'utf8') : '';
      assert.equal(card.data.status, 'Done', card.raw + '\nFresh Build diagnostics:\n' + diagnostics);
      assert.equal(card.data.verification.attempts, 2, 'fresh fallback stays on the same retry attempt');
      assert.equal(card.data.session_id, 'fake-session-0001');
      const calls = fs.readFileSync(argvLog, 'utf8').trim().split('\n').map(JSON.parse);
      const resumed = calls.filter((args) => args.includes('--resume'));
      assert.equal(resumed.length, 1, 'only one resume attempt');
      assert.equal(resumed[0][resumed[0].indexOf('--resume') + 1], 'fake-session-0001');
      const fresh = calls.find((args) => args.some((a) => a.includes('Continue from the existing preserved worktree changes')));
      assert.ok(fresh && !fresh.includes('--resume'));
      assert.match(fresh.join(' '), /Repair the edge case/);
      assert.match(card.raw, /resume session unavailable; retrying fresh/);
    } finally {
      delete process.env.TODOMD_CODEX_BIN;
      delete process.env.FAKE_CODEX_FAIL_ONCE;
      clearFakeAgent();
    }
  });
}

test('Build telemetry uses init model despite auxiliary modelUsage entries', async () => {
  const home = isolateHome();
  useFakeAgent({ build: 'good', verdict: 'pass', init_model: 'claude-fable-5-1',
    model_usage: JSON.stringify({ 'claude-haiku-4-5-20251001': {}, 'claude-fable-5-1': {} }) });
  const mirroredModels = [];
  pipeline.init({ broadcast: (event) => {
    if (event.type === 'run-event' && event.event?.subtype === 'init') {
      const runs = JSON.parse(fs.readFileSync(path.join(home, '.todomd/runs.json'), 'utf8'));
      mirroredModels.push(...runs.filter((run) => run.stage === 'Build').map((run) => run.model));
    }
  } });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Planned' });
  try {
    await pipeline.humanMove(p, 'task-0001', 'Queue');
    await until(() => status(repo, 'task-0001') === 'Done', { timeout: BUDGET.chain });
    const card = readCard(repo, 'task-0001');
    assert.match(card.raw, /Build attempt 1.*claude\/claude-fable-5-1/);
    const usage = fs.readFileSync(path.join(home, '.todomd/usage.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(usage.find((r) => r.stage === 'Build').model, 'claude-fable-5-1');
    assert.deepEqual(mirroredModels, ['claude-fable-5-1'], 'runs.json records the actual initialized model');
  } finally { clearFakeAgent(); }
});

for (const complexity of ['trivial', 'low', 'medium', 'high', 'very-high', 'extreme', '', 3, null, undefined]) {
  test(`structured Plan validates complexity ${JSON.stringify(complexity)}`, async () => {
    isolateHome();
    process.env.TODOMD_CODEX_BIN = FAKE_CODEX;
    process.env.FAKE_CODEX_LAST_MESSAGE = JSON.stringify({ plan: '1. Focused plan.', chunks: [], build_profile: 'long', complexity });
    const schemaLog = path.join(tmp('plan-schema'), 'schema.json');
    process.env.FAKE_CODEX_SCHEMA_LOG = schemaLog;
    pipeline.init({ broadcast: noop });
    const repo = makeRepo();
    const p = project(repo);
    await setStageRouting(repo, 'Plan', { agent: 'codex', model: 'gpt-test' });
    writeCard(repo, 'task-0001', { extra: 'session_id: existing-build-session\n' });
    try {
      await pipeline.humanMove(p, 'task-0001', 'Plan');
      await until(() => ['Planned', 'Needs Human'].includes(status(repo, 'task-0001')), { timeout: BUDGET.stage });
      const schema = JSON.parse(fs.readFileSync(schemaLog, 'utf8'));
      assert.deepEqual(schema.properties.complexity, { type: 'string', enum: ['trivial', 'low', 'medium', 'high', 'very-high'] });
      assert.ok(schema.required.includes('complexity'));
      const valid = schema.properties.complexity.enum.includes(complexity);
      const card = readCard(repo, 'task-0001');
      assert.equal(card.data.status, valid ? 'Planned' : 'Needs Human');
      assert.equal(card.data.complexity, valid ? complexity : undefined);
      assert.equal(card.data.session_id, 'existing-build-session');
      if (valid) assert.equal(loadBoard(repo).cards[0].complexity, complexity);
    } finally {
      delete process.env.TODOMD_CODEX_BIN;
      clearFakeAgent();
    }
  });
}

test('Gemini Plan preserves agent-written complexity through parseCard/loadBoard', async () => {
  isolateHome();
  process.env.TODOMD_GEMINI_BIN = path.join(path.dirname(FAKE_CODEX), 'fake-gemini.js');
  process.env.FAKE_GEMINI_PLAN_COMPLEXITY = 'high';
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  await setStageRouting(repo, 'Plan', { agent: 'gemini', model: 'gemini-3.7-flash-high' });
  writeCard(repo, 'task-0001', { extra: 'session_id: existing-build-session\n' });
  try {
    await pipeline.humanMove(p, 'task-0001', 'Plan');
    await until(() => status(repo, 'task-0001') === 'Planned', { timeout: BUDGET.stage });
    assert.equal(readCard(repo, 'task-0001').data.complexity, 'high');
    assert.equal(loadBoard(repo).cards[0].complexity, 'high');
    assert.equal(loadBoard(repo).cards[0].build_profile, 'long');
    assert.equal(readCard(repo, 'task-0001').data.session_id, 'existing-build-session');
  } finally {
    delete process.env.TODOMD_GEMINI_BIN;
    clearFakeAgent();
  }
});


test('a Build denied a tool permission is blocked, names the permission, and stays resumable', async () => {
  isolateHome();
  process.env.TODOMD_GEMINI_BIN = path.join(path.dirname(FAKE_CODEX), 'fake-gemini.js');
  process.env.FAKE_GEMINI_DENIED = 'command';
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  await setStageRouting(repo, 'Build', { agent: 'gemini', model: 'gemini-3.7-flash-high' });
  writeCard(repo, 'task-0001', { status: 'Planned' });
  await patchFrontmatter(repo, 'task-0001', { agent: 'gemini' });
  try {
    await pipeline.humanMove(p, 'task-0001', 'Queue');
    await until(() => status(repo, 'task-0001') === 'Needs Human', { timeout: BUDGET.stage });
    const card = readCard(repo, 'task-0001');
    // never scored ok, and never handed on to CI or the verifier
    assert.equal(card.data.needs_human_reason, 'permission_denied');
    assert.ok(!card.data.verification.last_verdict, 'the empty candidate never reached the verifier');
    // the operator can read which permission to grant straight off the card
    assert.match(card.raw, /failed: permission_denied/);
    assert.match(card.raw, /auto-denied/);
    assert.match(card.raw, /command \(RunCommand\)/);
    // the worktree survives, so granting the permission and resuming is enough
    // (the run's tracking entry is released just after the card moves)
    await until(async () => (await pipeline.recoveryActions(p, 'task-0001')).resume_build,
      { label: 'Resume Build offered for the blocked candidate' });
    // and the offer is honoured: resuming runs Build again in the preserved
    // worktree (still denied here, so it parks a second time with the same reason)
    assert.equal((await pipeline.resumeBuild(p, 'task-0001')).ok, true, 'resume_build accepts a permission_denied card');
    await until(() => (readCard(repo, 'task-0001').raw.match(/failed: permission_denied/g) || []).length >= 2,
      { timeout: BUDGET.stage, label: 'resumed Build ran and parked again' });
  } finally {
    delete process.env.TODOMD_GEMINI_BIN; delete process.env.FAKE_GEMINI_DENIED;
    await pipeline.killAllChildren({ graceMs: 1000 });
    clearFakeAgent();
  }
});

test('a Build that answers nothing and changes nothing is blocked, not passed to CI', async () => {
  isolateHome();
  // envelope reports success, response is empty, and the worktree is untouched
  useFakeAgent({ verdict: 'pass', build: 'noop', empty_result: '1' });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Planned' });
  try {
    await pipeline.humanMove(p, 'task-0001', 'Queue');
    await until(() => status(repo, 'task-0001') === 'Needs Human', { timeout: BUDGET.stage });
    const card = readCard(repo, 'task-0001');
    assert.equal(card.data.needs_human_reason, 'blocked_build');
    assert.ok(!card.data.verification.last_verdict, 'the empty candidate never reached the verifier');
    assert.match(card.raw, /blocked: no response and no worktree change/);
    await until(async () => (await pipeline.recoveryActions(p, 'task-0001')).resume_build,
      { label: 'Resume Build offered for the blocked candidate' });
    assert.equal((await pipeline.resumeBuild(p, 'task-0001')).ok, true, 'resume_build accepts a blocked_build card');
    await until(() => (readCard(repo, 'task-0001').raw.match(/blocked: no response and no worktree change/g) || []).length >= 2,
      { timeout: BUDGET.stage, label: 'resumed Build ran and parked again' });
  } finally {
    await pipeline.killAllChildren({ graceMs: 1000 });
    clearFakeAgent();
  }
});

test('a stage sandbox opt-out reaches the provider argv; every other stage keeps it', async () => {
  // The provider terminal sandbox cannot reach a worktree checkout's git
  // metadata, so a Build that must commit needs an explicit per-column
  // opt-out — never the provider's global skip-permissions flag.
  const runBuild = async (label, sandboxLine) => {
    isolateHome();
    useFakeAgent({ verdict: 'pass' });                       // Plan/Verify stay on the default agent
    const argvLog = path.join(tmp(label), 'argv.json');
    process.env.TODOMD_GEMINI_BIN = path.join(path.dirname(FAKE_CODEX), 'fake-gemini.js');
    process.env.FAKE_GEMINI_ARGV_LOG = argvLog;
    pipeline.init({ broadcast: noop });
    const repo = makeRepo();
    const p = project(repo);
    if (sandboxLine) {
      const cfg = path.join(repo, '.todomd/config.yml');
      const before = fs.readFileSync(cfg, 'utf8');
      const after = before.replace('  Build:\n', `  Build:\n${sandboxLine}`);
      assert.notEqual(after, before, 'the fixture config must carry a Build stage block');
      fs.writeFileSync(cfg, after);
    }
    // setStageRouting commits config.yml, and `stages` is an EXEC_KEY read from
    // HEAD — so the opt-out has to be committed to take effect.
    await setStageRouting(repo, 'Build', { agent: 'gemini', model: 'gemini-3.7-flash-high' });
    writeCard(repo, 'task-0001', { status: 'Planned' });
    await patchFrontmatter(repo, 'task-0001', { agent: 'gemini' });
    try {
      await pipeline.humanMove(p, 'task-0001', 'Queue');
      // the fixture also records the routing preflight (`agy models`), so wait
      // for the Build invocation itself — accept-edits is Build's mode alone
      return await until(() => {
        let argv;
        try { argv = JSON.parse(fs.readFileSync(argvLog, 'utf8')); } catch { return null; }
        return Array.isArray(argv) && argv.includes('accept-edits') ? argv : null;
      }, { timeout: BUDGET.stage, label: `${label} build argv` });
    } finally {
      delete process.env.TODOMD_GEMINI_BIN; delete process.env.FAKE_GEMINI_ARGV_LOG;
      await pipeline.killAllChildren({ graceMs: 1000 });
      clearFakeAgent();
    }
  };

  const confined = await runBuild('sandbox-default', '');
  assert.ok(confined.includes('--sandbox'), 'an unset stage sandbox stays ON');

  const opted = await runBuild('sandbox-off', '    sandbox: false\n');
  assert.equal(opted.includes('--sandbox'), false);
  assert.equal(opted.includes('--dangerously-skip-permissions'), false, 'never the global hatch');
  assert.deepEqual(opted.slice(opted.indexOf('--mode'), opted.indexOf('--mode') + 2), ['--mode', 'accept-edits']);
});

test('malformed approval reports its YAML location before the Planned status gate', async () => {
  isolateHome();
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  fs.writeFileSync(path.join(repo, '.todomd/tasks/task-0001-bad.md'),
    '---\nid: task-0001\ntitle: Broken: title\nstatus: Planned\n---\n');
  loadBoard(repo); // reproduce the prior failed-parse cache poisoning
  const eligibility = await pipeline.approvalEligibility(p, readCard(repo, 'task-0001'));
  assert.equal(eligibility.code, 'frontmatter_parse_error');
  const approved = await pipeline.humanMove(p, 'task-0001', 'Queue');
  assert.equal(approved.code, 'frontmatter_parse_error');
  assert.match(approved.error, /card task-0001.*line 3/);
  assert.equal(pipeline.hasLiveRun(p.name, 'task-0001'), false);
});

test('Queue admission explains malformed, unknown, waiting, paused and active cards', async () => {
  isolateHome();
  const marker = path.join(tmp('queue-diagnostics'), 'build');
  useFakeAgent({ build: 'good', verdict: 'pass', hang: 'build', hang_marker: marker });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Queue', deps: ['P1-01'] });
  writeCard(repo, 'task-0002', { status: 'Queue', deps: ['task-0003'] });
  writeCard(repo, 'task-0003', { status: 'Planned' });
  fs.writeFileSync(path.join(repo, '.todomd/tasks/task-0004-bad.md'), '---\ntitle: Bad: title\nstatus: Queue\n---\n');
  writeCard(repo, 'task-0005', { status: 'Queue' });
  try {
    pipeline.pauseQueue(p);
    let result = await pipeline.kickQueue(p);
    assert.equal(result.ok, false);
    assert.equal(result.enqueued, 0);
    const codes = Object.fromEntries(result.cards.map((c) => [c.id, c.code]));
    assert.deepEqual(codes, { 'task-0001': 'unknown_dependencies', 'task-0002': 'waiting_dependencies',
      'task-0004': 'frontmatter_parse_error', 'task-0005': 'paused' });
    assert.match(result.cards[0].reason, /no existing card/);
    pipeline.resumeQueue(p);
    await until(() => fs.existsSync(marker), { timeout: BUDGET.stage });
    result = await pipeline.kickQueue(p);
    assert.equal(result.cards.find((c) => c.id === 'task-0005').code, 'running');
    assert.equal(status(repo, 'task-0001'), 'Queue');
    assert.equal(status(repo, 'task-0002'), 'Queue');
    assert.equal(fs.existsSync(path.join(repo, '.todomd/worktrees/task-0001')), false);
    await patchFrontmatter(repo, 'task-0003', { status: 'Done', archived: true });
    result = await pipeline.kickQueue(p);
    assert.equal(result.cards.find((c) => c.id === 'task-0002').code, 'enqueued');
    const again = await pipeline.kickQueue(p);
    assert.equal(again.cards.find((c) => c.id === 'task-0002').code, 'already_queued');
  } finally {
    pipeline.forgetProject(p.name);
    await pipeline.killAllChildren({ graceMs: 1000 });
    clearFakeAgent();
  }
});


for (const stage of ['Plan', 'Triage']) {
  test(`${stage} refuses to finalize agent-written malformed frontmatter`, async () => {
    isolateHome();
    const log = path.join(tmp('malformed-agent'), 'argv.jsonl');
    useFakeAgent({ corrupt_card: '1', argv_log: log });
    pipeline.init({ broadcast: noop });
    const repo = makeRepo({ triage: true });
    const p = project(repo);
    writeCard(repo, 'task-0001');
    try {
      if (stage === 'Plan') await pipeline.humanMove(p, 'task-0001', 'Plan');
      else await pipeline.maybeTriage(p, 'task-0001');
      await until(() => readCard(repo, 'task-0001').parseError && !pipeline.hasLiveRun(p.name, 'task-0001'), { timeout: BUDGET.stage });
      assert.match(readCard(repo, 'task-0001').parseError, /frontmatter parse error at line 3/);
      assert.ok(pipeline.getBanners().some((b) => /task-0001.*frontmatter parse error/.test(b.text || b.message || '')));
      assert.deepEqual(pipeline.getRunStates(p.name), {});
      const args = JSON.parse(fs.readFileSync(log, 'utf8').trim());
      assert.match(args.join(' '), /[Pp]reserve.*title/);
      assert.match(args.join(' '), /[Vv]alidate.*frontmatter/);
    } finally { clearFakeAgent(); }
  });
}


test('a dependency introduced while Build waits for capacity prevents admission until fixed', async () => {
  isolateHome();
  useFakeAgent({ build: 'good', verdict: 'pass' });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Queue' });
  let release;
  const hold = scheduler.schedule(p, 'capacity-holder', 'Build', () => new Promise((resolve) => { release = resolve; }));
  try {
    assert.equal((await pipeline.kickQueue(p)).enqueued, 1);
    assert.equal(scheduler.isQueued(p.name, 'task-0001'), true);
    await patchFrontmatter(repo, 'task-0001', { dependencies: ['P1-01'] });
    release();
    await hold;
    scheduler.rescan();
    await sleep(100);
    assert.equal(status(repo, 'task-0001'), 'Queue');
    assert.equal(fs.existsSync(path.join(repo, '.todomd/worktrees/task-0001')), false);
    assert.equal((await pipeline.kickQueue(p)).cards[0].code, 'unknown_dependencies');
    await patchFrontmatter(repo, 'task-0001', { dependencies: [] });
    scheduler.rescan();
    await until(() => status(repo, 'task-0001') === 'Done', { timeout: BUDGET.chain });
  } finally {
    release?.();
    pipeline.forgetProject(p.name);
    await pipeline.killAllChildren({ graceMs: 1000 });
    clearFakeAgent();
  }
});

test('repairing malformed YAML clears its parse-error banner on the next sweep', () => {
  isolateHome();
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-9917', { title: 'Broken: title' });
  pipeline.triageSweep(p);
  assert.ok(pipeline.getBanners().some((b) => b.text.includes('task-9917') && b.text.includes('parse error')));
  writeCard(repo, 'task-9917', { title: 'Fixed title', status: 'Planned' });
  pipeline.triageSweep(p);
  assert.equal(pipeline.getBanners().some((b) => b.text.includes('task-9917') && b.text.includes('parse error')), false);
});


// ── Build routing by the Plan stage's difficulty rating ──

// `stages` is an EXEC_KEY (read from HEAD), so the map has to be committed.
function commitRouteMap(repo, map) {
  const file = path.join(repo, '.todomd', 'config.yml');
  const cfg = yaml.load(fs.readFileSync(file, 'utf8'));
  cfg.stages.Build.route_by_complexity = map;
  fs.writeFileSync(file, yaml.dump(cfg));
  git(repo, ['add', '.todomd/config.yml']);
  git(repo, ['commit', '-qm', 'route map']);
}

const FAKE_GEMINI_BIN = path.join(path.dirname(FAKE_CODEX), 'fake-gemini.js');
const LOW_TO_GEMINI = { low: { agent: 'gemini', model: 'gemini-3.7-flash-high' } };

async function buildOnce(repo, p) {
  await pipeline.humanMove(p, 'task-0001', 'Queue');
  await until(() => /Build attempt 1 · \d+ turns · /.test(readCard(repo, 'task-0001').raw), { timeout: BUDGET.stage });
  return readCard(repo, 'task-0001');
}

test('a low-complexity card with no pinned agent builds on the mapped provider and logs why', async () => {
  isolateHome();
  useFakeAgent();
  process.env.TODOMD_GEMINI_BIN = FAKE_GEMINI_BIN;
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  commitRouteMap(repo, LOW_TO_GEMINI);
  writeCard(repo, 'task-0001', { status: 'Planned', extra: 'complexity: low\nbuild_profile: standard\n' });
  await patchFrontmatter(repo, 'task-0001', { agent: '' });
  try {
    const card = await buildOnce(repo, p);
    assert.match(card.raw, /routed to gemini\/gemini-3\.7-flash-high by complexity: low/);
    assert.match(card.raw, /Build attempt 1 · \d+ turns · gemini\/gemini-3\.7-flash-high/);
  } finally {
    delete process.env.TODOMD_GEMINI_BIN;
    await pipeline.killAllChildren({ graceMs: 1000 });
    clearFakeAgent();
  }
});

test('an unmapped rating falls through to the column default', async () => {
  isolateHome();
  useFakeAgent();
  process.env.TODOMD_GEMINI_BIN = FAKE_GEMINI_BIN;
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  commitRouteMap(repo, LOW_TO_GEMINI);
  writeCard(repo, 'task-0001', { status: 'Planned', extra: 'complexity: medium\n' });
  await patchFrontmatter(repo, 'task-0001', { agent: '' });
  try {
    const card = await buildOnce(repo, p);
    assert.match(card.raw, /Build attempt 1 · \d+ turns · claude\//);
    assert.doesNotMatch(card.raw, /routed to/);
  } finally {
    delete process.env.TODOMD_GEMINI_BIN;
    await pipeline.killAllChildren({ graceMs: 1000 });
    clearFakeAgent();
  }
});

test('a pinned card agent beats the complexity map', async () => {
  isolateHome();
  useFakeAgent();
  process.env.TODOMD_GEMINI_BIN = FAKE_GEMINI_BIN;
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  commitRouteMap(repo, LOW_TO_GEMINI);
  // writeCard pins `agent: claude`; the map must not override a human pin
  writeCard(repo, 'task-0001', { status: 'Planned', extra: 'complexity: low\n' });
  try {
    const card = await buildOnce(repo, p);
    assert.match(card.raw, /Build attempt 1 · \d+ turns · claude\//);
    assert.doesNotMatch(card.raw, /routed to/);
  } finally {
    delete process.env.TODOMD_GEMINI_BIN;
    await pipeline.killAllChildren({ graceMs: 1000 });
    clearFakeAgent();
  }
});

test('long and split work is never routed by complexity', async () => {
  isolateHome();
  useFakeAgent();
  process.env.TODOMD_GEMINI_BIN = FAKE_GEMINI_BIN;
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  commitRouteMap(repo, LOW_TO_GEMINI);
  writeCard(repo, 'task-0001', { status: 'Planned', extra: 'complexity: low\nbuild_profile: long\n' });
  await patchFrontmatter(repo, 'task-0001', { agent: '' });
  try {
    const card = await buildOnce(repo, p);
    assert.match(card.raw, /Build attempt 1 · \d+ turns · claude\//);
    assert.doesNotMatch(card.raw, /routed to/);
  } finally {
    delete process.env.TODOMD_GEMINI_BIN;
    await pipeline.killAllChildren({ graceMs: 1000 });
    clearFakeAgent();
  }
});

test('Gemini Plan with workflow: teamwork omits disable-slash-commands and prefixes /teamwork-preview', async () => {
  isolateHome();
  process.env.TODOMD_GEMINI_BIN = FAKE_GEMINI_BIN;
  const dir = tmp('gemini-plan-tw');
  const argvLog = path.join(dir, 'argv.json');
  process.env.FAKE_GEMINI_ARGV_LOG = argvLog;
  process.env.FAKE_GEMINI_PLAN_COMPLEXITY = 'medium';
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  await setStageRouting(repo, 'Plan', { agent: 'gemini', model: 'gemini-3.7-flash-high', workflow: 'teamwork' });
  writeCard(repo, 'task-0001', {});
  try {
    await pipeline.humanMove(p, 'task-0001', 'Plan');
    await until(() => status(repo, 'task-0001') === 'Planned', { timeout: BUDGET.stage });
    assert.equal(readCard(repo, 'task-0001').data.complexity, 'medium');
    const argv = JSON.parse(fs.readFileSync(argvLog, 'utf8'));
    assert.equal(argv.includes('--disable-slash-commands'), false, 'teamwork allows slash commands');
    const sent = argv[argv.indexOf('-p') + 1];
    assert.ok(sent.startsWith('/teamwork-preview '), 'plan prompt prefixed with /teamwork-preview');
  } finally {
    delete process.env.TODOMD_GEMINI_BIN;
    delete process.env.FAKE_GEMINI_ARGV_LOG;
    delete process.env.FAKE_GEMINI_PLAN_COMPLEXITY;
    clearFakeAgent();
  }
});

test('Gemini Build with workflow: teamwork omits disable-slash-commands and prefixes /teamwork-preview', async () => {
  isolateHome();
  process.env.TODOMD_GEMINI_BIN = FAKE_GEMINI_BIN;
  const dir = tmp('gemini-build-tw');
  const argvLog = path.join(dir, 'argv.json');
  process.env.FAKE_GEMINI_ARGV_LOG = argvLog;
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  await setStageRouting(repo, 'Build', { agent: 'gemini', model: 'gemini-3.7-flash-high', workflow: 'teamwork' });
  writeCard(repo, 'task-0001', { status: 'Planned' });
  await patchFrontmatter(repo, 'task-0001', { agent: 'gemini' });
  try {
    await pipeline.humanMove(p, 'task-0001', 'Queue');
    await until(() => ['CI', 'Needs Human', 'Done'].includes(status(repo, 'task-0001')), { timeout: BUDGET.stage });
    const argv = JSON.parse(fs.readFileSync(argvLog, 'utf8'));
    assert.equal(argv.includes('--disable-slash-commands'), false, 'build teamwork allows slash commands');
    const sent = argv[argv.indexOf('-p') + 1];
    assert.ok(sent.startsWith('/teamwork-preview '), 'build prompt prefixed with /teamwork-preview');
  } finally {
    delete process.env.TODOMD_GEMINI_BIN;
    delete process.env.FAKE_GEMINI_ARGV_LOG;
    await pipeline.killAllChildren({ graceMs: 1000 });
    clearFakeAgent();
  }
});

test('Gemini Verify with workflow: teamwork omits disable-slash-commands and prefixes /teamwork-preview', async () => {
  isolateHome();
  useFakeAgent();
  process.env.TODOMD_GEMINI_BIN = FAKE_GEMINI_BIN;
  const dir = tmp('gemini-verify-tw');
  const argvLog = path.join(dir, 'argv.json');
  process.env.FAKE_GEMINI_ARGV_LOG = argvLog;
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  await setStageRouting(repo, 'Verify', { agent: 'gemini', model: 'gemini-3.7-flash-high', workflow: 'teamwork' });
  writeCard(repo, 'task-0001', { status: 'Planned' });
  try {
    await pipeline.humanMove(p, 'task-0001', 'Queue');
    await until(() => status(repo, 'task-0001') === 'Done', { timeout: BUDGET.stage });
    const argv = JSON.parse(fs.readFileSync(argvLog, 'utf8'));
    assert.equal(argv.includes('--disable-slash-commands'), false, 'verify teamwork allows slash commands');
    const sent = argv[argv.indexOf('-p') + 1];
    assert.ok(sent.startsWith('/teamwork-preview '), 'verify prompt prefixed with /teamwork-preview');
  } finally {
    delete process.env.TODOMD_GEMINI_BIN;
    delete process.env.FAKE_GEMINI_ARGV_LOG;
    await pipeline.killAllChildren({ graceMs: 1000 });
    clearFakeAgent();
  }
});

test('Plan with teamwork unifies chunks into multi-agent implementation plan without child-card fanout', async () => {
  isolateHome();
  useFakeAgent({ chunks: '2' });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Review', extra: 'teamwork: true\n' });
  try {
    await pipeline.humanMove(p, 'task-0001', 'Plan');
    await until(() => status(repo, 'task-0001') === 'Planned', { timeout: BUDGET.stage });
    const card = readCard(repo, 'task-0001');
    assert.equal(card.data.status, 'Planned');
    assert.equal(card.data.epic_build_mode, undefined, 'ordinary teamwork cards do not acquire epic-only metadata');
    assert.ok(card.body.includes('Milestone 1: Chunk 1'));
    assert.ok(card.body.includes('Milestone 2: Chunk 2'));
    const board = loadBoard(repo);
    const children = board.cards.filter((c) => c.parent === 'task-0001');
    assert.equal(children.length, 0, 'no child cards should be fanned out under teamwork');
  } finally {
    clearFakeAgent();
  }
});

test('Epic with teamwork build mode is approved and enqueued into Build directly', async () => {
  isolateHome();
  useFakeAgent({ verdict: 'pass', build: 'good' });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  writeCard(repo, 'task-0001', {
    status: 'Planned',
    title: 'Epic Teamwork Feature',
    extra: 'epic: true\nteamwork: true\nepic_build_mode: teamwork\n',
  });
  try {
    const moveRes = await pipeline.humanMove(p, 'task-0001', 'Queue');
    assert.equal(moveRes.ok, true, 'approval must succeed for teamwork epic');
    await until(() => status(repo, 'task-0001') === 'Done', { timeout: BUDGET.stage });
    assert.equal(status(repo, 'task-0001'), 'Done');
  } finally {
    await pipeline.killAllChildren({ graceMs: 1000 });
    clearFakeAgent();
  }
});

test('pinned base_branch is preserved and forked from, even if root checkout is on a peer branch', async () => {
  isolateHome();
  useFakeAgent({ verdict: 'pass', build: 'good' });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const base = git(repo, ['branch', '--show-current']);
  git(repo, ['checkout', '-b', 'peer-branch']);
  fs.writeFileSync(path.join(repo, 'peer-marker.txt'), 'peer');
  git(repo, ['add', 'peer-marker.txt']);
  git(repo, ['commit', '-m', 'peer commit']);

  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Planned', extra: `base_branch: ${base}\n` });

  await pipeline.humanMove(p, 'task-0001', 'Queue');
  await until(() => status(repo, 'task-0001') === 'Needs Human' || status(repo, 'task-0001') === 'Done', { timeout: BUDGET.stage });

  const card = readCard(repo, 'task-0001');
  assert.equal(card.data.base_branch, base, 'pinned base_branch must not be overwritten by root branch');
  const wt = path.join(repo, '.todomd/worktrees/task-0001');
  if (fs.existsSync(wt)) {
    assert.equal(fs.existsSync(path.join(wt, 'peer-marker.txt')), false, 'worktree must fork from base, not peer branch');
  }
  clearFakeAgent();
});

test('execConfig reads committed config from targetBase ref if provided, ignoring peer branch HEAD', async () => {
  const repo = makeRepo();
  const base = git(repo, ['branch', '--show-current']);
  fs.writeFileSync(path.join(repo, '.todomd/config.yml'), 'verify_command: npm test\n');
  git(repo, ['add', '.todomd/config.yml']);
  git(repo, ['commit', '-m', 'config on base']);

  git(repo, ['checkout', '-b', 'peer-branch']);
  fs.writeFileSync(path.join(repo, '.todomd/config.yml'), 'verify_command: echo peer-command\n');
  git(repo, ['add', '.todomd/config.yml']);
  git(repo, ['commit', '-m', 'config on peer']);

  const headCfg = await pipeline.execConfig(repo);
  assert.equal(headCfg.verify_command, 'echo peer-command');

  const baseCfg = await pipeline.execConfig(repo, base);
  assert.equal(baseCfg.verify_command, 'npm test');
});

