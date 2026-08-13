import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeRepo, writeCard, isolateHome, useFakeAgent, clearFakeAgent, until, tmp, git, sleep, BUDGET } from './helpers.js';
import { readCard, loadBoard, setStageRouting, patchFrontmatter, withRepoLock } from '../src/board.js';
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
    assert.deepEqual(await pipeline.kickQueue(a), { ok: true, enqueued: 1 });
    assert.deepEqual(await pipeline.kickQueue(a), { ok: true, enqueued: 0 },
      'a repeated click cannot enqueue the same card twice');
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
  // claude Stop hook, so a codex build runs the same gate.
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
  assert.match(card.body, /checkpoint 1: no git-visible progress/, 'the checkpoint was recorded');
  assert.equal(card.data.needs_human_reason || '', '', 'a productive continuation does not need a human');
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
  assert.match(card.body, /checkpoint 2: no git-visible progress/);
  clearFakeAgent();
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
    assert.equal(readCard(repo, 'task-0001').data.session_id, 'fake-codex-session',
      'the explicit Verify route ran Codex despite the card-level Claude Build override');
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
  useFakeAgent({ verdict: 'fail', build: 'good', setup_error: 'Cannot find module "dotenv"' });
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
    assert.deepEqual(pipeline.cancel(p, 'task-0001'), { ok: true });

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

  // start the child build — it hangs until SIGTERM
  await pipeline.humanMove(p, 'chunk-001', 'Queue');
  await until(() => status(repo, 'chunk-001') === 'Build' && fs.existsSync(marker), { timeout: BUDGET.chain });

  // trigger cascade while the child run is live
  await pipeline.cascadeEpicCleanup(p, 'epic-001');

  // cancel handler archives asynchronously after cleanup
  await until(() => readCard(repo, 'chunk-001').data.archived, { timeout: BUDGET.stage });
  const child = readCard(repo, 'chunk-001');
  assert.ok(child.data.archived, 'child is archived');
  assert.notEqual(child.data.status, 'Review', 'child never entered Review');
  clearFakeAgent();
});

test('cascadeEpicCleanup immediately archives a repair child waiting for Build admission', async () => {
  isolateHome();
  await sleep(300);
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

  assert.equal(pipeline.cancel(p, 'task-0001').ok, true);
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

  assert.equal(pipeline.cancel(p, 'task-0001').ok, true);
  // the cancel reverts to Queue and re-enqueues (like the Verify cancel): build
  // #2 runs (the hang fired once), verify passes, Done with no human action
  await until(() => status(repo, 'task-0001') === 'Done', { timeout: BUDGET.chain });
  assert.equal(readCard(repo, 'task-0001').data.verification.attempts, 1,
    'the cancelled attempt was rolled back — the resumed build is attempt 1 again');
  clearFakeAgent();
});

test('cancel during a retry Build requeues the card instead of idling in Verify', async () => {
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

  assert.equal(pipeline.cancel(p, 'task-0001').ok, true);
  process.env.FAKE_VERDICT = 'pass'; // the resumed build verifies clean
  // a retry build's prevStatus is Verify — the cancel must still land it in
  // Queue and re-enqueue (a Verify revert would strand it with no live run)
  await until(() => status(repo, 'task-0001') === 'Done', { timeout: BUDGET.chain });
  assert.equal(readCard(repo, 'task-0001').data.verification.attempts, 2,
    'verify-fail attempt + rolled-back cancelled retry + resumed build = attempt 2');
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
  await patchFrontmatter(repo, 'task-0001', { agent: 'codex' });
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
    // No polling: the retry has returned but verify() may still be awaiting
    // config. Its synchronous claim must already be visible and protective.
    assert.equal(pipeline.hasLiveRun(p.name, 'task-0001'), true);
    assert.deepEqual(pipeline.getRunStates(p.name)['task-0001'], { state: 'running', stage: 'Verify' });
    assert.deepEqual(voice.buildVoiceSummary(p).activeRuns,
      [{ card: 'task-0001', state: 'running', stage: 'Verify', external: false }]);
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
  return { branch, worktree };
}
const spawnedAnything = (repo, id) => fs.existsSync(path.join(repo, '.todomd/runs', id));

test('Retry Verification is admitted through the scheduler: under pressure it stays queued and spawns nothing', async () => {
  isolateHome();
  await sleep(300); // let earlier tests' releases drain before resetting (see the governor test above)
  scheduler.resetState();
  useFakeAgent({ verdict: 'pass' });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const p = project(repo);
  seedPreservedVerification(repo, 'task-0001');

  let sample = { cpuLoad: 0.99 }; // breach — the governor defers
  scheduler.setGovernor(createGovernor({
    thresholds: resourcesConfig({ resources: { cpu: { defer: 0.8, resume: 0.5, critical: 1.5 }, recovery_samples: 1 } }),
    sample: () => sample,
  }));
  scheduler.tick(); // seed the deferring state

  try {
    // A human pressing Retry Verification is not a bypass: it asks for a
    // Verify-column admission like every other start point, so machine
    // pressure holds it exactly the same way.
    assert.deepEqual(await pipeline.retryVerification(p, 'task-0001'), { ok: true });
    const deferred = pipeline.getRunStates(p.name)['task-0001'];
    assert.equal(deferred?.state, 'deferred', 'the retry is held, not spawned');
    assert.equal(deferred.stage, 'Verify');
    assert.match(deferred.reason, /cpu/, 'the deferral carries the reason the governor gave');
    assert.equal(spawnedAnything(repo, 'task-0001'), false, 'no child was started while deferred');
    // the trigger claim spans the queued window, so the card still reads as live
    assert.equal(pipeline.hasLiveRun(p.name, 'task-0001'), true);
    assert.equal((await pipeline.retryVerification(p, 'task-0001')).ok, false);
    assert.equal(scheduler.queuedEntries(p.name).filter((e) => e.card === 'task-0001').length, 1,
      'a second press cannot double-queue the card');

    sample = { cpuLoad: 0.05 }; // recovered
    scheduler.tick();
    await until(() => status(repo, 'task-0001') === 'Done', { timeout: BUDGET.stage });
    await until(() => !pipeline.hasLiveRun(p.name, 'task-0001'), { timeout: BUDGET.quick });
    assert.equal(pipeline.hasLiveRun(p.name, 'task-0001'), false,
      'the persistent retry claim is released after terminal finalization settles');
  } finally {
    pipeline.forgetProject(p.name);
    await pipeline.killAllChildren({ graceMs: 1000 });
    clearFakeAgent();
    scheduler.resetState();
  }
});

test('manual queue pause parks a direct Retry Verification until resume', async () => {
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
      { state: 'queued', stage: 'Verify' });
    assert.equal(spawnedAnything(repo, 'task-0001'), false,
      'the paused retry does not start a verifier');
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
    await sleep(200);
    // An ordinary capacity wait is 'queued' — 'deferred' stays reserved for
    // resource pressure, so a board never shows a normal turn-wait as load.
    assert.deepEqual(pipeline.getRunStates(p.name)['task-0002'], { state: 'queued', stage: 'Verify' });
    assert.equal(spawnedAnything(repo, 'task-0002'), false, 'the retry spawned nothing while the column was full');
  } finally {
    pipeline.forgetProject(p.name);
    await pipeline.killAllChildren({ graceMs: 1000 });
    clearFakeAgent();
  }
});

test('cancelling a queued Retry Verification unwinds through its claim instead of running', async () => {
  isolateHome();
  await sleep(300);
  scheduler.resetState();
  useFakeAgent({ verdict: 'pass' });
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
    assert.equal(pipeline.getRunStates(p.name)['task-0001']?.state, 'deferred');
    // pause the queue first, so the cancel's Queue re-drive parks instead of
    // starting a fresh Build we would then have to chase
    pipeline.pauseQueue(p);
    assert.deepEqual(pipeline.cancel(p, 'task-0001'), { ok: true }, 'a queued retry is cancellable');

    // Cancellation does not wait for resource recovery: the queued admission
    // is removed and its preserved mid-flow state unwinds immediately.
    await until(() => status(repo, 'task-0001') === 'Queue' && !pipeline.hasLiveRun(p.name, 'task-0001'),
      { timeout: BUDGET.stage });
    assert.equal(readCard(repo, 'task-0001').data.verification.attempts, 1,
      'a queued re-verification has not opened an attempt to roll back');
    assert.equal(spawnedAnything(repo, 'task-0001'), false, 'the cancelled retry never spawned a verifier');
    assert.equal(fs.existsSync(worktree), false, 'the cancel released the preserved worktree');
    assert.ok(!readCard(repo, 'task-0001').data.worktree, 'the stale branch reference is cleared too');
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
  await setStageRouting(repo, 'Verify', { agent: 'codex' });
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
