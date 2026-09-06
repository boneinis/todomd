import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, writeCard, isolateHome, useFakeAgent, clearFakeAgent, until, tmp, git, sleep, BUDGET } from './helpers.js';
import { readCard, normalizeConfig } from '../src/board.js';
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

test('a passing CI command that leaves the candidate dirty is not trusted by Verify', async () => {
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
    await until(() => status(repo, 'task-0001') === 'Done', { timeout: BUDGET.chain });
    assert.deepEqual(readCard(repo, 'task-0001').data.ci_evidence, {});
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
