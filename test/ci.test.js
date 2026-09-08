import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, writeCard, isolateHome, useFakeAgent, clearFakeAgent, until, tmp, git, sleep, BUDGET } from './helpers.js';
import { readCard, normalizeConfig, patchFrontmatter } from '../src/board.js';
import { createGovernor, resourcesConfig } from '../src/resources.js';
import * as pipeline from '../src/pipeline.js';
import * as scheduler from '../src/scheduler.js';

const noop = () => {};
function project(repo) { return { name: path.basename(repo), path: repo }; }
const status = (repo, id) => readCard(repo, id).data.status;

// Rewrites the fixture's config.yml to add 'CI' between Build and Verify plus
// a ci: block, then commits — ci: (like verify_command) is an EXEC_KEY, read
// from HEAD, so an uncommitted edit would never actually arm it.
function configureCi(repo, { profile = 'quick', quick, full, enabled = true, maxAttempts, timeoutSeconds, execution, concurrency = 2 } = {}) {
  const cfgPath = path.join(repo, '.todomd/config.yml');
  let cfg = fs.readFileSync(cfgPath, 'utf8')
    .replace('columns: [Review, Plan, Planned, Queue, Build, Verify, Needs Human, Done]',
      'columns: [Review, Plan, Planned, Queue, Build, CI, Verify, Needs Human, Done]')
    .replace('concurrency: 1', `concurrency: ${concurrency}`);
  if (maxAttempts) cfg = cfg.replace('max_attempts: 3', `max_attempts: ${maxAttempts}`);
  cfg += `ci:\n  enabled: ${enabled}\n  profile: ${profile}\n`;
  if (execution !== undefined) cfg += `  execution: ${execution}\n`;
  if (quick !== undefined) cfg += `  quick: ${quick}\n`;
  if (full !== undefined) cfg += `  full: ${full}\n`;
  if (timeoutSeconds !== undefined) cfg += `  timeout_seconds: ${timeoutSeconds}\n`;
  fs.writeFileSync(cfgPath, cfg);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'configure CI column']);
}

function writeScript(repo, name, body) {
  fs.writeFileSync(path.join(repo, name), body);
}

test('normalizeConfig fills the ci: defaults for a board that never sets the key', () => {
  const cfg = normalizeConfig({ columns: ['Review', 'Queue', 'Build', 'CI', 'Verify', 'Needs Human', 'Done'] });
  assert.deepEqual(cfg.ci, {
    enabled: true,
    execution: 'local',
    profile: 'quick',
    quick: 'npm run typecheck',
    full: 'npm run typecheck && npm test && npm run e2e',
    timeoutSeconds: 0,
  });
});

test('normalizeConfig honors an explicit ci: block, including disabling it', () => {
  const cfg = normalizeConfig({
    ci: { enabled: false, profile: 'full', quick: 'npm run lint', full: 'npm run lint && npm test', timeout_seconds: 120 },
  });
  assert.deepEqual(cfg.ci, {
    enabled: false, execution: 'local', profile: 'full', quick: 'npm run lint', full: 'npm run lint && npm test', timeoutSeconds: 120,
  });
});

// A committed script that records it started (so a test can observe the
// transient CI state deterministically) and waits for a release marker,
// mirroring pipeline.test.js's seedCiGate for the same reason: a fast command
// completes before a poll loop can ever observe the board column it ran under.
function seedCiGate(repo, startedFile, releaseFile) {
  writeScript(repo, 'ci-gate.mjs',
    `import fs from 'node:fs';\n` +
    `fs.writeFileSync(${JSON.stringify(startedFile)}, '1');\n` +
    `const t = setInterval(() => {\n` +
    `  if (fs.existsSync(${JSON.stringify(releaseFile)})) { clearInterval(t); process.exit(0); }\n` +
    `}, 50);\n`);
}

test('CI board column: the quick profile command runs and a pass advances the card to Verify then Done', async () => {
  isolateHome();
  useFakeAgent({ build: 'good', verdict: 'pass' });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const gateDir = tmp('ci-quick-gate');
  const started = path.join(gateDir, 'started');
  const release = path.join(gateDir, 'release');
  seedCiGate(repo, started, release);
  writeScript(repo, 'ci-bad.mjs', `console.error('CI_SHOULD_NOT_RUN');\nprocess.exit(1);\n`);
  configureCi(repo, { profile: 'quick', quick: 'node ci-gate.mjs', full: 'node ci-bad.mjs' });
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Planned' });

  try {
    await pipeline.humanMove(p, 'task-0001', 'Queue');
    await until(() => fs.existsSync(started), { timeout: BUDGET.chain });
    assert.equal(status(repo, 'task-0001'), 'CI', 'the CI column is a real board column now');
    fs.writeFileSync(release, 'go');
    await until(() => status(repo, 'task-0001') === 'Done', { timeout: BUDGET.chain });
    assert.match(readCard(repo, 'task-0001').raw, /CI attempt 1 · [\d.]+s · `node ci-gate\.mjs` passed/);
  } finally {
    pipeline.forgetProject(p.name);
    await pipeline.killAllChildren({ graceMs: 1000 });
    clearFakeAgent();
  }
});

test('clean exact-HEAD CI evidence reaches Verify and suppresses the duplicate full command', async () => {
  isolateHome();
  const argvLog = path.join(tmp('ci-evidence'), 'argv.jsonl');
  useFakeAgent({ build: 'good', verdict: 'pass', argv_log: argvLog });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  configureCi(repo, { profile: 'full', quick: 'node --version', full: 'node --version' });
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Planned' });

  try {
    await pipeline.humanMove(p, 'task-0001', 'Queue');
    await until(() => status(repo, 'task-0001') === 'Done', { timeout: BUDGET.chain });
    const card = readCard(repo, 'task-0001');
    assert.equal(card.data.ci_evidence.command, 'node --version');
    assert.equal(card.data.ci_evidence.clean, true);
    const calls = fs.readFileSync(argvLog, 'utf8').trim().split('\n').map(JSON.parse);
    const verifyPrompt = calls.flat().find((arg) => typeof arg === 'string' && arg.includes('Trusted CI evidence:'));
    assert.match(verifyPrompt, /Do not rerun that full command/);
    assert.match(verifyPrompt, new RegExp(card.data.ci_evidence.head));
  } finally {
    pipeline.forgetProject(p.name);
    await pipeline.killAllChildren({ graceMs: 1000 });
    clearFakeAgent();
  }
});

test('a passing CI command that leaves the candidate dirty is rejected before Verify', async () => {
  isolateHome();
  const argvLog = path.join(tmp('ci-dirty'), 'argv.jsonl');
  useFakeAgent({ build: 'good', verdict: 'pass', argv_log: argvLog });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  writeScript(repo, 'ci-dirty.mjs', `import fs from 'node:fs'; fs.writeFileSync('dirty.tmp', 'dirty');\n`);
  configureCi(repo, { profile: 'full', full: 'node ci-dirty.mjs' });
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Planned' });

  try {
    await pipeline.humanMove(p, 'task-0001', 'Queue');
    await until(() => status(repo, 'task-0001') === 'Needs Human', { timeout: BUDGET.chain });
    const card = readCard(repo, 'task-0001');
    assert.deepEqual(card.data.ci_evidence, {});
    assert.equal(card.data.needs_human_reason, 'ci_evidence_invalid');
    const calls = fs.readFileSync(argvLog, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(calls.flat().some((arg) => typeof arg === 'string' && arg.includes('Trusted CI evidence:')), false);
  } finally {
    pipeline.forgetProject(p.name);
    await pipeline.killAllChildren({ graceMs: 1000 });
    clearFakeAgent();
  }
});

test('CI board column: the full profile command runs instead of quick when configured', async () => {
  isolateHome();
  useFakeAgent({ build: 'good', verdict: 'pass' });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  writeScript(repo, 'ci-ok.mjs', `process.exit(0);\n`);
  writeScript(repo, 'ci-bad.mjs', `console.error('CI_SHOULD_NOT_RUN');\nprocess.exit(1);\n`);
  configureCi(repo, { profile: 'full', quick: 'node ci-bad.mjs', full: 'node ci-ok.mjs' });
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Planned' });

  try {
    await pipeline.humanMove(p, 'task-0001', 'Queue');
    await until(() => status(repo, 'task-0001') === 'Done', { timeout: BUDGET.chain });
    assert.match(readCard(repo, 'task-0001').raw, /`node ci-ok\.mjs` passed/,
      'the full profile command ran, not quick');
    assert.doesNotMatch(readCard(repo, 'task-0001').raw, /CI_SHOULD_NOT_RUN/);
  } finally {
    pipeline.forgetProject(p.name);
    await pipeline.killAllChildren({ graceMs: 1000 });
    clearFakeAgent();
  }
});

test('CI board column: a failing gate retries the build up to max_attempts, then lands on Needs Human', async () => {
  isolateHome();
  useFakeAgent({ build: 'good', verdict: 'pass' });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo(); // writeCard's fixture card has verification.max_attempts: 3
  writeScript(repo, 'ci-bad.mjs', `console.error('CI_ALWAYS_FAILS');\nprocess.exit(1);\n`);
  configureCi(repo, { profile: 'quick', quick: 'node ci-bad.mjs' });
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Planned' });

  try {
    await pipeline.humanMove(p, 'task-0001', 'Queue');
    await until(() => status(repo, 'task-0001') === 'Needs Human', { timeout: BUDGET.chain });
    await until(() => !pipeline.hasLiveRun(p.name, 'task-0001'), { timeout: BUDGET.stage });

    const card = readCard(repo, 'task-0001');
    assert.equal(card.data.needs_human_reason, 'ci_attempts_exhausted');
    assert.equal(card.data.verification.attempts, 3, 'every attempt was burned');
    assert.match(card.raw, /CI_ALWAYS_FAILS/);
    for (const n of [1, 2, 3]) {
      assert.equal(fs.existsSync(path.join(repo, `.todomd/runs/task-0001/build-${n}.jsonl`)), true,
        `a CI failure re-entered the retry path and ran build attempt ${n}`);
    }
    assert.equal(fs.existsSync(path.join(repo, '.todomd/runs/task-0001/verify-1.jsonl')), false,
      'the gate never passed, so Verify never ran');

    // The human repairs the preserved candidate directly after the automatic
    // Build/CI budget is exhausted. This must rerun CI on attempt 3, not force
    // a fourth Build/verification allowance merely to clear a stale terminal
    // flag (the live Phase-1 failure mode this guards).
    const worktree = path.join(repo, '.todomd/worktrees/task-0001');
    writeScript(worktree, 'ci-bad.mjs', `process.exit(0);\n`);
    git(worktree, ['add', 'ci-bad.mjs']);
    git(worktree, ['commit', '-qm', 'repair CI candidate outside the agent loop']);

    const recovery = await pipeline.recoveryActions(p, 'task-0001');
    assert.equal(recovery.retry_verification, true,
      'CI exhaustion exposes same-candidate CI/verification recovery');
    assert.equal(recovery.return_to_build, true,
      'a substantive failure can still choose a new repair Build instead');
    assert.deepEqual(await pipeline.retryVerification(p, 'task-0001'), { ok: true });
    await until(() => status(repo, 'task-0001') === 'Done', { timeout: BUDGET.chain });

    const recovered = readCard(repo, 'task-0001');
    assert.equal(recovered.data.verification.attempts, 3,
      'the repaired CI rerun reuses the approved attempt instead of extending the cap');
    assert.equal(fs.existsSync(path.join(repo, '.todomd/runs/task-0001/build-4.jsonl')), false,
      'same-candidate recovery never manufactures another Build');
    assert.match(recovered.raw, /CI attempt 3 · [\d.]+s · `node ci-bad\.mjs` passed/);
  } finally {
    pipeline.forgetProject(p.name);
    await pipeline.killAllChildren({ graceMs: 1000 });
    clearFakeAgent();
  }
});

test('CI board column: ci.enabled: false keeps the column but falls back to legacy verify_command behavior (no retry)', async () => {
  isolateHome();
  useFakeAgent({ build: 'good', verdict: 'pass' });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  writeScript(repo, 'ci-bad.mjs', `console.error('CI_ALWAYS_FAILS');\nprocess.exit(1);\n`);
  const cfgPath = path.join(repo, '.todomd/config.yml');
  // verify_command itself fails — if ci.enabled: false correctly falls back to
  // the legacy gate, this escalates immediately (no retry); if it were
  // wrongly still using ci.quick's retry path, attempts would climb instead.
  fs.writeFileSync(cfgPath, fs.readFileSync(cfgPath, 'utf8')
    .replace('verify_command: node --version', 'verify_command: node ci-bad.mjs'));
  configureCi(repo, { enabled: false, profile: 'quick', quick: 'node ci-should-not-run.mjs' });
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Planned' });

  try {
    await pipeline.humanMove(p, 'task-0001', 'Queue');
    await until(() => status(repo, 'task-0001') === 'Needs Human', { timeout: BUDGET.chain });

    const card = readCard(repo, 'task-0001');
    assert.equal(card.data.needs_human_reason, 'ci_failed',
      'ci.enabled: false uses the legacy immediate-escalate path, not the bounded-retry one');
    assert.equal(card.data.verification.attempts, 1, 'no retry happened — escalated on the first failure');
    assert.match(card.raw, /CI_ALWAYS_FAILS/);
  } finally {
    pipeline.forgetProject(p.name);
    await pipeline.killAllChildren({ graceMs: 1000 });
    clearFakeAgent();
  }
});

test('a board whose config.yml has no CI column still runs Build then Verify without error', async () => {
  isolateHome();
  useFakeAgent({ build: 'good', verdict: 'pass' });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo(); // columns: [... Build, Verify ...] — no CI
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Planned' });

  try {
    await pipeline.humanMove(p, 'task-0001', 'Queue');
    await until(() => status(repo, 'task-0001') === 'Done', { timeout: BUDGET.chain });
    assert.match(readCard(repo, 'task-0001').raw, /CI attempt 1 · [\d.]+s · `node --version` passed/,
      'the legacy scheduler-only CI gate still ran');
  } finally {
    pipeline.forgetProject(p.name);
    await pipeline.killAllChildren({ graceMs: 1000 });
    clearFakeAgent();
  }
});

test('critical resource pressure gracefully cancels a running CI job (including its compound-command descendant) and requeues it as deferred-for-load, while a running Build entry is left alone', async () => {
  isolateHome();
  await sleep(300); // let earlier tests' releases drain before resetting (see pipeline.test.js's governor tests)
  scheduler.resetState();
  useFakeAgent({ build: 'good', verdict: 'pass' });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  const startedDir = tmp('ci-critical');
  const started = path.join(startedDir, 'started');
  writeScript(repo, 'ci-a.mjs', `process.exit(0);\n`);
  // Writes its OWN pid (a real descendant of the shell `runVerifyCommand`
  // spawns, NOT the shell itself — see below) then hangs. A THIRD command
  // follows it in the chain (never reached, since this one never exits) so no
  // shell can "exec"-optimize this into the last command of the list and
  // collapse it onto the shell's own pid; the shell must fork a genuine child
  // to run this step while it still has ci-c.mjs left to run afterward.
  writeScript(repo, 'ci-hang.mjs',
    `import fs from 'node:fs';\n` +
    `fs.writeFileSync(${JSON.stringify(started)}, String(process.pid));\n` +
    `setInterval(() => {}, 1000);\n`);
  writeScript(repo, 'ci-c.mjs', `process.exit(0);\n`);
  // The default full profile's own shape (typecheck && test && e2e) — a
  // compound command is exactly where killing only the top-level shell PID
  // leaves an orphaned descendant running (the bug this test guards against).
  configureCi(repo, { profile: 'full', full: 'node ci-a.mjs && node ci-hang.mjs && node ci-c.mjs' });
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Planned' });

  let sample = { cpuLoad: 0.1 };
  scheduler.setGovernor(createGovernor({
    thresholds: resourcesConfig({ resources: { cpu: { defer: 0.8, resume: 0.5, critical: 1.0 }, recovery_samples: 1 } }),
    sample: () => sample,
  }));

  // Occupies a real 'Build' admission (never resolves until released) so the
  // test can prove critical pressure never touches it — the same synthetic-
  // blocker idiom pipeline.test.js's Retry Verification tests use to hold a
  // column open without a real agent.
  let releaseBuild;
  let buildSettled = false;
  const buildBlocker = scheduler.schedule(p, 'blocker-build', 'Build', () => new Promise((resolve) => { releaseBuild = resolve; }));
  buildBlocker.then(() => { buildSettled = true; });

  try {
    await pipeline.humanMove(p, 'task-0001', 'Queue');
    await until(() => fs.existsSync(started) && pipeline.getRunStates(p.name)['task-0001']?.stage === 'CI'
      && pipeline.getRunStates(p.name)['task-0001']?.state === 'running', { timeout: BUDGET.chain });
    const pid = Number(fs.readFileSync(started, 'utf8').trim());
    assert.doesNotThrow(() => process.kill(pid, 0), 'the compound command\'s descendant node process is alive before critical pressure hits');

    sample = { cpuLoad: 1.5 }; // breaches critical
    scheduler.tick();

    await until(() => readCard(repo, 'task-0001').raw.includes('cancelled (critical resource pressure)'),
      { timeout: BUDGET.stage, label: 'the run log records a graceful load-cancel' });
    await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } },
      { timeout: BUDGET.stage, label: 'the descendant node process (not just the top-level shell) actually exits' });

    assert.equal(readCard(repo, 'task-0001').data.verification.attempts, 1,
      'a load-cancel is not a failed attempt — nothing to roll back');
    // Fresh snapshot reads (queuedEntries/getRunStates), not just the live
    // broadcast — exercises the SAME path a client reconnecting/reloading
    // mid-deferral would hit.
    const state = pipeline.getRunStates(p.name)['task-0001'];
    assert.equal(state?.stage, 'CI', 'the card is back in the CI column, not reverted to Build/Queue/Review');
    assert.equal(state?.state, 'deferred-for-load',
      'a snapshot read reports deferred-for-load, not the generic deferred, while critical pressure persists');

    await sleep(200); // give any (incorrect) signal to the Build entry time to land
    assert.equal(buildSettled, false,
      'the Build entry admitted before the pressure hit was never signalled or suspended');
  } finally {
    releaseBuild?.();
    await buildBlocker;
    pipeline.forgetProject(p.name);
    await pipeline.killAllChildren({ graceMs: 1000 });
    clearFakeAgent();
    scheduler.resetState();
  }
});


test('remote exit 2 holds the candidate without repair Build or trusted evidence', async () => {
  isolateHome(); scheduler.resetState();
  useFakeAgent({ build: 'good', verdict: 'pass' });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo();
  writeScript(repo, 'remote.mjs', "console.log('fleet prerequisite unavailable'); process.exit(2);\n");
  configureCi(repo, { execution: 'remote', quick: 'node remote.mjs' });
  const p = project(repo);
  writeCard(repo, 'task-0001', { status: 'Planned' });
  try {
    await pipeline.humanMove(p, 'task-0001', 'Queue');
    await until(() => status(repo, 'task-0001') === 'Needs Human', { timeout: BUDGET.chain });
    const card = readCard(repo, 'task-0001');
    assert.equal(card.data.needs_human_reason, 'ci_blocked');
    assert.equal(card.data.verification.attempts, 1);
    assert.deepEqual(card.data.ci_evidence, {});
    await sleep(300); scheduler.tick();
    assert.equal(status(repo, 'task-0001'), 'Needs Human');
    assert.equal(readCard(repo, 'task-0001').data.verification.attempts, 1);
  } finally {
    pipeline.forgetProject(p.name); await pipeline.killAllChildren({ graceMs: 1000 });
    clearFakeAgent(); scheduler.resetState();
  }
});

test('remote CI survives critical memory pressure without cancellation or resubmission', async () => {
  isolateHome(); await sleep(300); scheduler.resetState();
  useFakeAgent({ build: 'good', verdict: 'pass' });
  pipeline.init({ broadcast: noop });
  const repo = makeRepo(); const dir = tmp('remote-pressure');
  const started = path.join(dir, 'started'); const release = path.join(dir, 'release');
  writeScript(repo, 'remote.mjs', `import fs from 'node:fs';
    fs.appendFileSync(${JSON.stringify(started)}, String(process.pid)+'\\n');
    const t=setInterval(()=>{ if(fs.existsSync(${JSON.stringify(release)})){clearInterval(t);process.exit(0);} },50);
  `);
  configureCi(repo, { execution: 'remote', quick: 'node remote.mjs' });
  const p = project(repo); writeCard(repo, 'task-0001', { status: 'Planned' });
  let sample = { memoryPressure: 0.1, cpuLoad: 0.1 };
  scheduler.setGovernor(createGovernor({ thresholds: resourcesConfig({ resources: { recovery_samples: 1 } }), sample: () => sample }));
  try {
    await pipeline.humanMove(p, 'task-0001', 'Queue');
    await until(() => fs.existsSync(started), { timeout: BUDGET.chain });
    const pid = Number(fs.readFileSync(started, 'utf8').trim());
    sample = { memoryPressure: 0.99, cpuLoad: 0.1 }; scheduler.tick();
    await sleep(400);
    assert.doesNotThrow(() => process.kill(pid, 0));
    assert.equal(fs.readFileSync(started, 'utf8').trim().split('\n').length, 1);
    assert.equal(status(repo, 'task-0001'), 'CI');
    assert.doesNotMatch(readCard(repo, 'task-0001').raw, /cancelled \(critical resource pressure\)/);
    sample = { memoryPressure: 0.1, cpuLoad: 0.1 }; scheduler.tick();
    fs.writeFileSync(release, 'go');
    await until(() => status(repo, 'task-0001') === 'Done', { timeout: BUDGET.chain });
    assert.equal(readCard(repo, 'task-0001').data.ci_evidence.execution, 'remote');
  } finally {
    pipeline.forgetProject(p.name); await pipeline.killAllChildren({ graceMs: 1000 });
    clearFakeAgent(); scheduler.resetState();
  }
});

test('an uncommitted remote opt-in cannot change the committed local exit-2 policy', async () => {
  isolateHome(); scheduler.resetState(); useFakeAgent({ build: 'good', verdict: 'pass' });
  pipeline.init({ broadcast: noop });
  const repo=makeRepo();
  writeScript(repo,'gate.mjs',"process.exit(2);\n");
  configureCi(repo,{quick:'node gate.mjs', maxAttempts:1});
  const configPath=path.join(repo,'.todomd/config.yml');
  fs.appendFileSync(configPath,'  execution: remote\n');
  const p=project(repo); writeCard(repo,'task-0001',{status:'Planned'});
  try {
    await pipeline.humanMove(p,'task-0001','Queue');
    await until(()=>status(repo,'task-0001')==='Needs Human',{timeout:BUDGET.chain});
    assert.equal(readCard(repo,'task-0001').data.needs_human_reason,'ci_attempts_exhausted');
  } finally {
    pipeline.forgetProject(p.name); await pipeline.killAllChildren({graceMs:1000});
    clearFakeAgent(); scheduler.resetState();
  }
});

test('pausing before remote CI admission parks the submission until explicit resume', async () => {
  isolateHome(); scheduler.resetState();
  useFakeAgent({ build:'good', verdict:'pass', exit_delay_ms:500 }); pipeline.init({broadcast:noop});
  const repo=makeRepo();const marker=path.join(tmp('remote-paused'),'submitted');
  writeScript(repo,'remote.mjs',`import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)},'submitted');\n`);
  configureCi(repo,{execution:'remote',quick:'node remote.mjs'});
  const p=project(repo);writeCard(repo,'task-0001',{status:'Planned'});
  try {
    await pipeline.humanMove(p,'task-0001','Queue');
    await until(()=>status(repo,'task-0001')==='Build',{timeout:BUDGET.stage});
    pipeline.pauseQueue(p);
    await until(()=>status(repo,'task-0001')==='CI',{timeout:BUDGET.chain});
    await sleep(300);assert.equal(fs.existsSync(marker),false);
    pipeline.resumeQueue(p);
    await until(()=>status(repo,'task-0001')==='Done',{timeout:BUDGET.chain});
    assert.equal(fs.existsSync(marker),true);
  } finally {
    pipeline.resumeQueue(p);pipeline.forgetProject(p.name);await pipeline.killAllChildren({graceMs:1000});
    clearFakeAgent();scheduler.resetState();
  }
});

// Contract-compliant test adapter: journals the accepted canonical job before
// waiting/printing acknowledgement. The real fleet adapter must independently
// qualify this property; this fixture is not evidence that it already does.
function seedDurableRemote(repo, dir) {
  writeScript(repo, 'remote-worker.mjs', `import fs from 'node:fs';
    const dir=${JSON.stringify(dir)};
    fs.writeFileSync(dir+'/worker-pid', String(process.pid));
    const timer=setInterval(()=>{
      if(fs.existsSync(dir+'/release')) { fs.writeFileSync(dir+'/result','SUCCESS'); clearInterval(timer); }
    },30);
    setTimeout(()=>process.exit(0),30000).unref();
  `);
  writeScript(repo, 'remote-adapter.mjs', `import fs from 'node:fs'; import path from 'node:path';
    import {execFileSync,spawn} from 'node:child_process';
    const dir=${JSON.stringify(dir)}, id='0123456789abcdef0123456789abcdef';
    const gitdir=execFileSync('git',['rev-parse','--absolute-git-dir'],{encoding:'utf8'}).trim();
    const journal=path.join(gitdir,'fleet-fixture-run.json');
    if(!fs.existsSync(journal)) {
      fs.writeFileSync(journal,JSON.stringify({run_id:id, head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()}),{flag:'wx'});
      fs.appendFileSync(dir+'/submissions',id+'\\n');
      const worker=spawn(process.execPath,['remote-worker.mjs'],{detached:true,stdio:'ignore'}); worker.unref();
    }
    fs.appendFileSync(dir+'/waits',id+'\\n');
    const timer=setInterval(()=>{
      if(fs.existsSync(dir+'/result')) { clearInterval(timer); console.log(JSON.stringify({run_id:id})); process.exit(0); }
    },30);
  `);
}

for (const interruption of ['cancel', 'shutdown', 'timeout']) {
  test(`remote ${interruption} preserves the candidate and reconciles one accepted job on explicit retry`, async () => {
    isolateHome(); scheduler.resetState(); useFakeAgent({ build: 'good', verdict: 'pass' });
    pipeline.init({ broadcast: noop });
    const repo=makeRepo(), dir=tmp('remote-recovery');
    seedDurableRemote(repo,dir);
    configureCi(repo,{execution:'remote',quick:'node remote-adapter.mjs',timeoutSeconds:interruption==='timeout'?1:10});
    const p=project(repo); writeCard(repo,'task-0001',{status:'Planned'});
    const wt=path.join(repo,'.todomd/worktrees/task-0001');
    try {
      await pipeline.humanMove(p,'task-0001','Queue');
      await until(()=>fs.existsSync(path.join(dir,'waits')) && fs.existsSync(path.join(dir,'worker-pid')),{timeout:BUDGET.chain});
      const head=git(wt,['rev-parse','HEAD']);
      const journal=path.join(git(wt,['rev-parse','--absolute-git-dir']),'fleet-fixture-run.json');
      const originalJournal=fs.readFileSync(journal,'utf8');
      pipeline.pauseQueue(p);
      if(interruption==='cancel') await pipeline.cancel(p,'task-0001');
      if(interruption==='shutdown') await pipeline.killAllChildren({preserveWorktrees:true,graceMs:1000});
      await until(()=>status(repo,'task-0001')==='Needs Human',{timeout:BUDGET.stage});
      const held=readCard(repo,'task-0001');
      assert.equal(held.data.needs_human_reason,'ci_blocked');
      assert.equal(held.data.recovery_stage,'CI');
      assert.deepEqual(held.data.ci_evidence,{});
      assert.equal(held.data.verification.attempts,1);
      assert.equal(git(wt,['rev-parse','HEAD']),head);
      assert.equal(fs.readFileSync(journal,'utf8'),originalJournal);
      assert.doesNotThrow(()=>process.kill(Number(fs.readFileSync(path.join(dir,'worker-pid'))),0), 'accepted remote worker survived the local waiter');
      assert.equal(fs.existsSync(path.join(repo,'.todomd/runs/task-0001/build-2.jsonl')),false);
      if(interruption==='shutdown') {
        const {addProject}=await import('../src/registry.js'); addProject(repo);
        pipeline.forgetProject(p.name); pipeline.init({broadcast:noop}); await pipeline.reconcileOnBoot();
        assert.equal(status(repo,'task-0001'),'Needs Human');
      }
      fs.writeFileSync(path.join(dir,'release'),'complete remotely');
      await until(()=>fs.existsSync(path.join(dir,'result')));
      // The parked card is visible before its cancellation finalizer drops
      // the run claim. Recovery is available only after that owner settles.
      await until(()=>!pipeline.hasLiveRun(p.name,'task-0001'),{timeout:BUDGET.stage});
      const retries=await Promise.all([pipeline.retryVerification(p,'task-0001'),pipeline.retryVerification(p,'task-0001')]);
      assert.equal(retries.filter((r)=>r.ok).length,1, 'simultaneous recovery cannot start two CI waiters');
      await sleep(150);
      assert.equal(fs.readFileSync(path.join(dir,'waits'),'utf8').trim().split('\n').length,1,'pause still gates recovery admission');
      pipeline.resumeQueue(p);
      await until(()=>status(repo,'task-0001')==='Done',{timeout:BUDGET.chain});
      assert.equal(fs.readFileSync(path.join(dir,'submissions'),'utf8').trim().split('\n').length,1);
      assert.equal(fs.readFileSync(path.join(dir,'waits'),'utf8').trim().split('\n').length,2);
      assert.equal(readCard(repo,'task-0001').data.verification.attempts,1);
      assert.equal(readCard(repo,'task-0001').data.ci_evidence.execution,'remote');
    } finally {
      fs.writeFileSync(path.join(dir,'release'),'cleanup fixture worker');
      pipeline.forgetProject(p.name); await pipeline.killAllChildren({graceMs:1000});
      clearFakeAgent(); scheduler.resetState();
    }
  });
}

test('local evidence cannot bypass a newly committed remote gate on verification retry', async () => {
  isolateHome(); scheduler.resetState(); useFakeAgent({build:'good',verdict:'pass',hang:'verify'});
  pipeline.init({broadcast:noop}); const repo=makeRepo(), dir=tmp('mode-cutover'), marker=path.join(dir,'remote');
  writeScript(repo,'remote.mjs',`import fs from 'node:fs';fs.appendFileSync(${JSON.stringify(marker)},'remote\\n');process.exit(2);\n`);
  configureCi(repo,{quick:'node --version'}); const p=project(repo);writeCard(repo,'task-0001',{status:'Planned'});
  try {
    await pipeline.humanMove(p,'task-0001','Queue');
    await until(()=>pipeline.getRunStates(p.name)['task-0001']?.stage==='Verify' && readCard(repo,'task-0001').data.ci_evidence?.clean,{timeout:BUDGET.chain});
    await pipeline.killAllChildren({preserveWorktrees:true,graceMs:1000});
    await until(()=>status(repo,'task-0001')==='Needs Human' && !pipeline.hasLiveRun(p.name,'task-0001'));
    const cfg=path.join(repo,'.todomd/config.yml');
    fs.writeFileSync(cfg,fs.readFileSync(cfg,'utf8').replace('quick: node --version','quick: node remote.mjs')+'  execution: remote\n');
    git(repo,['add','.todomd/config.yml']);git(repo,['commit','-qm','explicit remote cutover']);
    delete process.env.FAKE_HANG;
    await pipeline.retryVerification(p,'task-0001');
    await until(()=>fs.existsSync(marker) && status(repo,'task-0001')==='Needs Human',{timeout:BUDGET.chain});
    assert.equal(readCard(repo,'task-0001').data.needs_human_reason,'ci_blocked');
    assert.deepEqual(readCard(repo,'task-0001').data.ci_evidence,{});
  } finally { pipeline.forgetProject(p.name);await pipeline.killAllChildren({graceMs:1000});clearFakeAgent();scheduler.resetState(); }
});

test('a remote adapter cannot attest source that it modified during the run', async () => {
  isolateHome();scheduler.resetState();const argvLog=path.join(tmp('remote-source-change'),'argv.jsonl');
  useFakeAgent({build:'good',verdict:'pass',argv_log:argvLog});pipeline.init({broadcast:noop});
  const repo=makeRepo();
  writeScript(repo,'remote.mjs',"import fs from 'node:fs';fs.appendFileSync('src/calc.js','\\n// changed during CI');process.exit(0);\n");
  configureCi(repo,{execution:'remote',quick:'node remote.mjs'});const p=project(repo);writeCard(repo,'task-0001',{status:'Planned'});
  try {
    await pipeline.humanMove(p,'task-0001','Queue');await until(()=>status(repo,'task-0001')==='Needs Human',{timeout:BUDGET.chain});
    assert.equal(readCard(repo,'task-0001').data.needs_human_reason,'ci_evidence_invalid');
    assert.deepEqual(readCard(repo,'task-0001').data.ci_evidence,{});
    assert.equal(fs.readFileSync(argvLog,'utf8').trim().split('\n').some(line=>JSON.parse(line).some(arg=>arg.includes('todomd-verify'))),false);
  } finally {pipeline.forgetProject(p.name);await pipeline.killAllChildren({graceMs:1000});clearFakeAgent();scheduler.resetState();}
});

for (const committedConfig of ['absent', 'malformed']) {
  test(`${committedConfig} committed config cannot enable remote handling from a working edit`, async () => {
    isolateHome(); scheduler.resetState(); useFakeAgent({build:'good',verdict:'pass'}); pipeline.init({broadcast:noop});
    const repo=makeRepo(); writeScript(repo,'gate.mjs','process.exit(2);\n');
    configureCi(repo,{execution:'remote',quick:'node gate.mjs',maxAttempts:1});
    const cfg=path.join(repo,'.todomd/config.yml'), working=fs.readFileSync(cfg,'utf8');
    if(committedConfig==='absent') git(repo,['rm','--cached','.todomd/config.yml']);
    else { fs.writeFileSync(cfg,'ci: [unterminated\n');git(repo,['add','.todomd/config.yml']); }
    git(repo,['commit','-qm','remove valid committed opt-in']); fs.writeFileSync(cfg,working);
    const p=project(repo);writeCard(repo,'task-0001',{status:'Planned'});
    try {
      await pipeline.humanMove(p,'task-0001','Queue');
      await until(()=>status(repo,'task-0001')==='Needs Human',{timeout:BUDGET.chain});
      assert.equal(readCard(repo,'task-0001').data.needs_human_reason,'ci_attempts_exhausted');
    } finally {pipeline.forgetProject(p.name);await pipeline.killAllChildren({graceMs:1000});clearFakeAgent();scheduler.resetState();}
  });
}

test('an actual remote check failure retains the bounded repair policy', async () => {
  isolateHome();scheduler.resetState();useFakeAgent({build:'good',verdict:'pass'});pipeline.init({broadcast:noop});
  const repo=makeRepo();writeScript(repo,'remote.mjs',"console.error('FAIL calc.test.js: expected 4, got 3'); process.exit(1);\n");
  configureCi(repo,{execution:'remote',quick:'node remote.mjs',maxAttempts:2});
  const p=project(repo);writeCard(repo,'task-0001',{status:'Planned'});
  await patchFrontmatter(repo,'task-0001',{verification:{attempts:0,max_attempts:2,last_verdict:''}});
  try {
    await pipeline.humanMove(p,'task-0001','Queue');await until(()=>status(repo,'task-0001')==='Needs Human',{timeout:BUDGET.chain});
    assert.equal(readCard(repo,'task-0001').data.needs_human_reason,'ci_attempts_exhausted');
    assert.equal(readCard(repo,'task-0001').data.verification.attempts,2);
    assert.deepEqual(readCard(repo,'task-0001').data.ci_evidence,{});
  } finally {pipeline.forgetProject(p.name);await pipeline.killAllChildren({graceMs:1000});clearFakeAgent();scheduler.resetState();}
});

for(const pressure of ['cpu','memory','disk']) {
  test(`remote CI admission ${pressure==='cpu'?'passes':'waits'} under ${pressure} pressure`,async()=>{
    isolateHome();scheduler.resetState();useFakeAgent({build:'good',verdict:'pass',exit_delay_ms:500});pipeline.init({broadcast:noop});
    const repo=makeRepo(),dir=tmp('remote-admission'),marker=path.join(dir,'submitted');
    writeScript(repo,'remote.mjs',`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'submitted');\n`);
    configureCi(repo,{execution:'remote',quick:'node remote.mjs'});const p=project(repo);writeCard(repo,'task-0001',{status:'Planned'});
    const safe={cpuLoad:0.1,memoryPressure:0.1,diskFreeBytes:10*1024**3,diskFreePct:0.5};let sample=safe;
    scheduler.setGovernor(createGovernor({thresholds:resourcesConfig({resources:{recovery_samples:1}}),sample:()=>sample}));
    try {
      await pipeline.humanMove(p,'task-0001','Queue');await until(()=>status(repo,'task-0001')==='Build');
      sample={...safe,...({cpu:{cpuLoad:2},memory:{memoryPressure:0.99},disk:{diskFreeBytes:1024**3,diskFreePct:0.01}}[pressure])};scheduler.tick();
      await until(()=>status(repo,'task-0001')==='CI'||fs.existsSync(marker),{timeout:BUDGET.chain});
      if(pressure==='cpu') await until(()=>fs.existsSync(marker));
      else {await sleep(250);assert.equal(fs.existsSync(marker),false);}
      sample=safe;scheduler.tick();await until(()=>status(repo,'task-0001')==='Done',{timeout:BUDGET.chain});
      assert.equal(fs.existsSync(marker),true);
    } finally {pipeline.forgetProject(p.name);await pipeline.killAllChildren({graceMs:1000});clearFakeAgent();scheduler.resetState();}
  });
}

for(const orphanStage of ['CI','Verify']) {
  test(`boot preserves an orphaned remote ${orphanStage} candidate even when its branch is already an ancestor`,async()=>{
    isolateHome();scheduler.resetState();useFakeAgent({build:'good',verdict:'pass'});pipeline.init({broadcast:noop});
    const repo=makeRepo();configureCi(repo,{execution:'remote',quick:'node --version'});
    const p=project(repo),wt=path.join(repo,'.todomd/worktrees/task-0001'),branch='todomd/task-0001';
    git(repo,['worktree','add','-q','-b',branch,wt]);
    const head=git(wt,['rev-parse','HEAD']);
    writeCard(repo,'task-0001',{status:orphanStage,extra:`worktree: ${branch}\nci_evidence: {head: ${head}, command: node --version, execution: local, clean: true}\n`});
    try {
      const {addProject}=await import('../src/registry.js');addProject(repo);
      await pipeline.reconcileOnBoot();
      assert.equal(status(repo,'task-0001'),'Needs Human');
      assert.equal(readCard(repo,'task-0001').data.needs_human_reason,'ci_blocked');
      assert.deepEqual(readCard(repo,'task-0001').data.ci_evidence,{});
      assert.equal(fs.existsSync(wt),true);
    } finally {pipeline.forgetProject(p.name);await pipeline.killAllChildren({graceMs:1000});clearFakeAgent();scheduler.resetState();}
  });
}

test('source changed during Verify cannot merge using earlier remote evidence',async()=>{
  isolateHome();scheduler.resetState();const dir=tmp('verify-source-change'),argvLog=path.join(dir,'argv.jsonl'),release=path.join(dir,'release');
  useFakeAgent({build:'good',verdict:'pass',verify_release:release,argv_log:argvLog});pipeline.init({broadcast:noop});
  const repo=makeRepo();configureCi(repo,{execution:'remote',quick:'node --version'});
  const p=project(repo);writeCard(repo,'task-0001',{status:'Planned'});const wt=path.join(repo,'.todomd/worktrees/task-0001');
  try {
    await pipeline.humanMove(p,'task-0001','Queue');
    await until(()=>fs.existsSync(argvLog)&&fs.readFileSync(argvLog,'utf8').trim().split('\n').some(line=>JSON.parse(line).some(arg=>arg.includes('todomd-verify'))),{timeout:BUDGET.chain});
    fs.appendFileSync(path.join(wt,'src/calc.js'),'\n// after CI\n');git(wt,['add','src/calc.js']);git(wt,['commit','-qm','source changed after CI']);
    const changed=git(wt,['rev-parse','HEAD']);
    fs.writeFileSync(release,'complete review');
    await until(()=>status(repo,'task-0001')==='Needs Human',{timeout:BUDGET.chain});
    assert.equal(readCard(repo,'task-0001').data.needs_human_reason,'ci_evidence_invalid');
    assert.notEqual(git(repo,['rev-parse','HEAD']),changed);
    assert.deepEqual(readCard(repo,'task-0001').data.ci_evidence,{});
  } finally {pipeline.forgetProject(p.name);await pipeline.killAllChildren({graceMs:1000});clearFakeAgent();scheduler.resetState();}
});

test('passing remote CI and Verify preserve the Board Agent publication review hold',async()=>{
  const home=isolateHome();scheduler.resetState();useFakeAgent({build:'good',verdict:'pass'});pipeline.init({broadcast:noop});
  const repo=makeRepo();configureCi(repo,{execution:'remote',quick:'node --version'});
  const p=project(repo);writeCard(repo,'task-0001',{status:'Planned'});
  const {savePublicationPolicies}=await import('../src/board-agent-policy.js');
  savePublicationPolicies(path.join(home,'.todomd/board-agent'),[{
    path:fs.realpathSync(repo),worktreeRoot:path.join(fs.realpathSync(repo),'.todomd/worktrees'),
    policy:{publication:'review_required',protectedBranches:['main','master']},
  }]);
  const originalSource=git(repo,['show','HEAD:src/calc.js']);
  try {
    await pipeline.humanMove(p,'task-0001','Queue');await until(()=>status(repo,'task-0001')==='Needs Human',{timeout:BUDGET.chain});
    const card=readCard(repo,'task-0001');
    assert.equal(card.data.needs_human_reason,'publication_review_required');
    assert.equal(card.data.ci_evidence.execution,'remote');
    assert.equal(card.data.verification.last_verdict,'pass');
    assert.equal(git(repo,['show','HEAD:src/calc.js']),originalSource);
    assert.equal(fs.existsSync(path.join(repo,'.todomd/worktrees/task-0001')),true);
  } finally {pipeline.forgetProject(p.name);await pipeline.killAllChildren({graceMs:1000});clearFakeAgent();scheduler.resetState();}
});
