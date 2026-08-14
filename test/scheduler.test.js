import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmp, isolateHome } from './helpers.js';
import { createGovernor, resourcesConfig } from '../src/resources.js';
import { addProject } from '../src/registry.js';
import * as scheduler from '../src/scheduler.js';

// A minimal on-disk project scheduler.js can loadConfig() against — no git
// repo needed, since scheduler.js only ever reads .todomd/config.yml. Also
// creates .todomd/tasks so registry.listProjects() (which filters out any
// path lacking one) still finds it if the test registers it with addProject().
function makeProject(name, configYaml = '') {
  const dir = tmp(`sched-${name}`);
  fs.mkdirSync(path.join(dir, '.todomd', 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.todomd', 'config.yml'), configYaml);
  return { name, path: dir };
}

// A queued entry that never resolves on its own — the test controls exactly
// when (and whether) it settles, so admission timing is observable.
function deferredRun() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { run: () => promise, resolve };
}

// isolateHome() also isolates the project registry (~/.todomd/projects.json)
// that allKnownProjects() reads — without it these tests would read whatever
// registry.json happens to exist on the machine actually running them.
test.beforeEach(() => { isolateHome(); scheduler.resetState(); });

test('global limit is one authoritative number across differently-configured projects, not read per entry', async () => {
  const a = makeProject('a', 'concurrency: 5\nscheduler:\n  global: 2\n');
  const b = makeProject('b', 'concurrency: 5\nscheduler:\n  global: 5\n');
  scheduler.setGovernor(createGovernor({ thresholds: resourcesConfig({}), sample: () => ({}) }));

  const jobs = [
    { project: a, ...deferredRun() },
    { project: a, ...deferredRun() },
    { project: b, ...deferredRun() },
    { project: b, ...deferredRun() },
  ];
  let admitted = 0;
  for (const j of jobs) {
    scheduler.schedule(j.project, `card-${admitted}-${j.project.name}`, 'Build', () => { admitted++; return j.run(); });
  }
  // The min of the two projects' configured globals (2) governs BOTH
  // projects' entries together — never project b's own looser value of 5,
  // regardless of which entry the scan happens to be looking at.
  assert.equal(admitted, 2, 'only the stricter authoritative global cap (2) admits, across both projects combined');

  // Freeing one running slot lets exactly one more start — the cap stays 2,
  // it is not silently relaxed to project b's own configured value.
  jobs[0].resolve();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(admitted, 3);
});

test('a per-column limit caps that column alone, independent of the global cap', async () => {
  const p = makeProject('col', 'concurrency: 10\nscheduler:\n  columns:\n    Verify: 1\n');
  scheduler.setGovernor(createGovernor({ thresholds: resourcesConfig({}), sample: () => ({}) }));

  let buildsStarted = 0;
  let verifiesStarted = 0;
  const verifyJobs = [deferredRun(), deferredRun()];
  for (const j of verifyJobs) {
    scheduler.schedule(p, `verify-${verifiesStarted}`, 'Verify', () => { verifiesStarted++; return j.run(); });
  }
  const buildJobs = [deferredRun(), deferredRun(), deferredRun()];
  for (const j of buildJobs) {
    scheduler.schedule(p, `build-${buildsStarted}`, 'Build', () => { buildsStarted++; return j.run(); });
  }

  // Verify's own column limit (1) caps Verify alone...
  assert.equal(verifiesStarted, 1, 'Verify column limit holds the second Verify entry back');
  // ...while a full Verify column never blocks Build, which has its own
  // (much looser) column limit — the two columns are gated independently.
  assert.equal(buildsStarted, 3, 'a saturated Verify column does not stall unrelated Build entries');
});

// CI is a fully real, independently-enforced admission column — the scheduler
// treats it identically to Build/Verify (nothing here special-cases any of the
// names). pipeline.js's buildChain requests a 'CI' admission for the board's
// verify_command between Build and Verify; the end-to-end chain is covered in
// pipeline.test.js. This is the unit-level proof of the column itself.
test('the CI column is enforced independently, exactly like Build/Verify', () => {
  const p = makeProject('ci', 'concurrency: 10\nscheduler:\n  columns:\n    CI: 1\n');
  scheduler.setGovernor(createGovernor({ thresholds: resourcesConfig({}), sample: () => ({}) }));

  let ciStarted = 0;
  let buildsStarted = 0;
  for (let i = 0; i < 2; i++) {
    const j = deferredRun();
    scheduler.schedule(p, `ci-${i}`, 'CI', () => { ciStarted++; return j.run(); });
  }
  for (let i = 0; i < 3; i++) {
    const j = deferredRun();
    scheduler.schedule(p, `build-${i}`, 'Build', () => { buildsStarted++; return j.run(); });
  }
  assert.equal(ciStarted, 1, "CI's own column limit (1) caps CI alone");
  assert.equal(buildsStarted, 3, "a saturated CI column does not stall Build, which has its own looser limit");
});

test('a board that only ever configured concurrency keeps that exact effective Build parallelism', () => {
  const p = makeProject('legacy', 'concurrency: 3\n'); // no scheduler: block at all
  scheduler.setGovernor(createGovernor({ thresholds: resourcesConfig({}), sample: () => ({}) }));

  let started = 0;
  for (let i = 0; i < 5; i++) {
    const j = deferredRun();
    scheduler.schedule(p, `card-${i}`, 'Build', () => { started++; return j.run(); });
  }
  assert.equal(started, 3, 'exactly `concurrency` cards start, unchanged from before the scheduler existed');
});

test('a quoted legacy concurrency value keeps its previous numeric coercion', () => {
  const p = makeProject('legacy-quoted', 'concurrency: "3"\n');
  scheduler.setGovernor(createGovernor({ thresholds: resourcesConfig({}), sample: () => ({}) }));

  let started = 0;
  for (let i = 0; i < 5; i++) {
    const j = deferredRun();
    scheduler.schedule(p, `card-${i}`, 'Build', () => { started++; return j.run(); });
  }
  assert.equal(started, 3, 'quoted YAML concurrency retains the old queue\'s numeric coercion');
});

test('an unrelated project\'s default concurrency never throttles another project\'s Build column', () => {
  // Regression: columns.Build must NOT default to a project's own
  // `concurrency` — that value is combined via Math.min across every known
  // project, so two boards each left at the default concurrency: 1 would
  // otherwise crush the shared Build column to 1, even though neither ever
  // configured a machine-wide cap.
  const busy = makeProject('busy', 'concurrency: 1\n');
  const other = makeProject('other', 'concurrency: 1\n');
  scheduler.setGovernor(createGovernor({ thresholds: resourcesConfig({}), sample: () => ({}) }));

  const busyJob = deferredRun();
  scheduler.schedule(busy, 'busy-card', 'Build', () => busyJob.run()); // occupies busy's own slot

  let otherStarted = false;
  scheduler.schedule(other, 'other-card', 'Build', () => { otherStarted = true; return Promise.resolve(); });
  assert.equal(otherStarted, true, "busy's in-flight Build must not throttle an unrelated project's Build column");
  busyJob.resolve();
});

test('a registered project with no queued work of its own still contributes its configured global limit', () => {
  // Regression: the combined caps must come from the COMPLETE registered
  // project set, not just projects that have scheduled something themselves —
  // otherwise a stricter project sitting idle (or processed later during
  // reconcileOnBoot's sequential per-project sweep) would silently have no
  // say over another project's admissions.
  const strict = makeProject('strict', 'scheduler:\n  global: 1\n');
  addProject(strict.path); // registered, but never calls schedule() itself
  const busy = makeProject('busy', ''); // no explicit global — unlimited on its own
  scheduler.setGovernor(createGovernor({ thresholds: resourcesConfig({}), sample: () => ({}) }));

  let started = 0;
  for (let i = 0; i < 3; i++) {
    const j = deferredRun();
    scheduler.schedule(busy, `card-${i}`, 'Build', () => { started++; return j.run(); });
  }
  assert.equal(started, 1, "strict's registered-but-idle global cap of 1 still governs busy's admissions");
});

test('a resource-disabled project contributes no thresholds to enabled projects', () => {
  const enabled = makeProject('enabled', [
    'concurrency: 2',
    'resources:',
    '  enabled: true',
    '  cpu: { resume: 99, defer: 100, critical: 101 }',
    '  memory: { resume: 0.98, defer: 0.99, critical: 1.1 }',
    '  disk: { min_free_gb: 0, resume_free_gb: 0.1 }',
    '  recovery_samples: 1',
  ].join('\n'));
  const disabled = makeProject('disabled', [
    'resources:',
    '  enabled: false',
    '  memory: { resume: 0.0001, defer: 0.001, critical: 1.1 }',
  ].join('\n'));
  addProject(disabled.path);

  let started = false;
  scheduler.schedule(enabled, 'card', 'Build', () => {
    started = true;
    return Promise.resolve();
  });

  assert.equal(started, true,
    'an opted-out board cannot defer enabled work with its dormant thresholds');
  assert.deepEqual(scheduler.queuedEntries(enabled.name), []);
});

test('all resource-disabled projects leave shared admission monitoring off', () => {
  const disabled = makeProject('only-disabled', [
    'resources:',
    '  enabled: false',
    '  memory: { resume: 0.0001, defer: 0.001, critical: 1.1 }',
  ].join('\n'));

  let started = false;
  scheduler.schedule(disabled, 'card', 'Build', () => {
    started = true;
    return Promise.resolve();
  });
  assert.equal(started, true);
});

test('a rejected scheduled job releases its counters and settles without an unhandled rejection', async () => {
  const p = makeProject('reject', 'concurrency: 1\n');
  scheduler.setGovernor(createGovernor({ thresholds: resourcesConfig({}), sample: () => ({}) }));

  const failing = scheduler.schedule(p, 'bad', 'Build', () => Promise.reject(new Error('boom')));
  await assert.rejects(failing, /boom/);

  // Counters released despite the rejection: under concurrency: 1, a
  // follower can only start if `bad`'s slot was actually freed.
  let followerRan = false;
  await scheduler.schedule(p, 'ok', 'Build', () => { followerRan = true; return Promise.resolve(); });
  assert.equal(followerRan, true, 'a rejected job frees its slot for the next one, same as a resolved job');
});

test('governor pressure defers admission with a reason and spawns nothing; a later tick resumes it once recovered', async () => {
  const p = makeProject('gov', '');
  let sample = { cpuLoad: 0.99 }; // breach — will defer
  const thresholds = resourcesConfig({ resources: { cpu: { defer: 0.8, resume: 0.5, critical: 1.5 }, recovery_samples: 1 } });
  scheduler.setGovernor(createGovernor({ thresholds, sample: () => sample }));
  scheduler.tick(); // seed the deferring state

  let started = false;
  const reasons = [];
  scheduler.schedule(p, 'card-1', 'Build', () => { started = true; return Promise.resolve(); },
    { onDefer: (reason) => reasons.push(reason) });

  assert.equal(started, false, 'no child is spawned while the governor reports pressure');
  assert.ok(reasons.length && reasons[reasons.length - 1], 'a deferredReason is recorded');
  assert.deepEqual(scheduler.queuedEntries(p.name),
    [{ card: 'card-1', column: 'Build', deferredReason: reasons.at(-1), critical: false }]);

  sample = { cpuLoad: 0.1 }; // a later sample recovers
  scheduler.tick();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(started, true, 'the deferred entry starts on its own once a later tick observes recovery — no human action');
});

test('a light entry starts through CPU-only pressure while heavy work remains deferred', async () => {
  const p = makeProject('light-cpu', 'concurrency: 3\n');
  const thresholds = resourcesConfig({
    resources: { cpu: { defer: 0.8, resume: 0.5, critical: 1.5 }, recovery_samples: 1 },
  });
  scheduler.setGovernor(createGovernor({ thresholds, sample: () => ({ cpuLoad: 0.99 }) }));
  scheduler.tick();

  let heavyStarted = false;
  let lightAdmission = null;
  scheduler.schedule(p, 'heavy', 'Build', () => { heavyStarted = true; return Promise.resolve(); });
  await scheduler.schedule(p, 'light', 'Verify', (admission) => {
    lightAdmission = admission;
    return Promise.resolve();
  }, { resourceClass: 'light' });

  assert.equal(heavyStarted, false, 'ordinary Build/CI/Verify work still obeys CPU deferral');
  assert.equal(lightAdmission.resourcePressure, true);
  assert.deepEqual(lightAdmission.reasons.map((reason) => reason.metric), ['cpu']);
  assert.deepEqual(scheduler.queuedEntries(p.name).map((entry) => entry.card), ['heavy']);
});

test('a light entry never bypasses memory or disk pressure', () => {
  const p = makeProject('light-memory', 'concurrency: 2\n');
  const thresholds = resourcesConfig({
    resources: { memory: { defer: 0.8, resume: 0.5, critical: 0.95 }, recovery_samples: 1 },
  });
  scheduler.setGovernor(createGovernor({ thresholds, sample: () => ({ memoryPressure: 0.9 }) }));
  scheduler.tick();

  let started = false;
  scheduler.schedule(p, 'light', 'Verify', () => { started = true; return Promise.resolve(); },
    { resourceClass: 'light' });
  assert.equal(started, false);
  assert.match(scheduler.queuedEntries(p.name)[0].deferredReason, /memory/);
});

// pipeline.js's getRunStates() reads queuedEntries() as a SNAPSHOT (e.g. for a
// client that just reconnected or reloaded mid-deferral) to tell a CI entry
// held at CRITICAL severity apart from an ordinary defer-level wait. That
// distinction has to survive on the entry itself, not just as an argument
// passed to a live onDefer callback at the moment severity changed.
test('queuedEntries reports critical severity as a persisted snapshot field, not only via the live onDefer callback', async () => {
  const p = makeProject('crit', '');
  let sample = { cpuLoad: 0.9 }; // breaches defer (0.8) but not critical (1.5) yet
  const thresholds = resourcesConfig({ resources: { cpu: { defer: 0.8, resume: 0.5, critical: 1.5 }, recovery_samples: 1 } });
  scheduler.setGovernor(createGovernor({ thresholds, sample: () => sample }));
  scheduler.tick();

  const criticalArgs = [];
  scheduler.schedule(p, 'ci-card', 'CI', () => new Promise(() => {}),
    { onDefer: (reason, critical) => criticalArgs.push(critical) });
  assert.deepEqual(scheduler.queuedEntries(p.name).map((e) => e.critical), [false],
    'defer-level pressure alone is not critical');
  assert.deepEqual(criticalArgs.at(-1), false, 'the live callback agrees');

  sample = { cpuLoad: 1.6 }; // now breaches critical
  scheduler.tick();
  assert.deepEqual(scheduler.queuedEntries(p.name).map((e) => e.critical), [true],
    'a fresh snapshot read reflects critical severity, independent of the onDefer callback');
  assert.deepEqual(criticalArgs.at(-1), true);
});

test('a job that already started is never signalled or suspended when pressure appears afterward', async () => {
  const p = makeProject('running', '');
  let sample = { cpuLoad: 0.1 };
  const thresholds = resourcesConfig({ resources: { cpu: { defer: 0.8, resume: 0.5, critical: 1.5 } } });
  scheduler.setGovernor(createGovernor({ thresholds, sample: () => sample }));

  const job = deferredRun();
  let settled = false;
  const running = scheduler.schedule(p, 'live', 'Build', () => job.run()).then(() => { settled = true; });

  // Pressure appears AFTER admission — a fresh entry defers...
  sample = { cpuLoad: 0.99 };
  const follower = deferredRun();
  let followerStarted = false;
  scheduler.schedule(p, 'follower', 'Build', () => { followerStarted = true; return follower.run(); });
  scheduler.tick();
  assert.equal(followerStarted, false, 'new work is held back under pressure');

  // ...but the already-running job is left completely alone: nothing in the
  // scheduler ever touches `job` — it only settles because the test resolves
  // it directly, proving admission is the only thing pressure ever gates.
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(settled, false, 'still running, untouched by the pressure tick above');
  job.resolve();
  await running;
  assert.equal(settled, true, 'the running job completed normally on its own terms');
});

test('dequeue removes a not-yet-admitted entry and settles it harmlessly (no rejection)', async () => {
  const p = makeProject('dequeue', 'concurrency: 1\n');
  scheduler.setGovernor(createGovernor({ thresholds: resourcesConfig({}), sample: () => ({}) }));
  const first = deferredRun();
  scheduler.schedule(p, 'first', 'Build', () => first.run());
  let secondRan = false;
  const secondPromise = scheduler.schedule(p, 'second', 'Build', () => { secondRan = true; return Promise.resolve(); });

  assert.equal(scheduler.isQueued(p.name, 'second'), true);
  assert.equal(scheduler.dequeue(p.name, 'second'), true);
  await assert.doesNotReject(secondPromise);
  assert.equal(secondRan, false, 'a dequeued entry never runs');
  assert.equal(scheduler.isQueued(p.name, 'second'), false);
  first.resolve();
});

test('reorderQueue changes admission order to match the requested priority', () => {
  const p = makeProject('reorder', 'concurrency: 1\n');
  scheduler.setGovernor(createGovernor({ thresholds: resourcesConfig({}), sample: () => ({}) }));
  const held = deferredRun();
  scheduler.schedule(p, 'holder', 'Build', () => held.run()); // occupies the only slot
  scheduler.schedule(p, 'a', 'Build', () => Promise.resolve());
  scheduler.schedule(p, 'b', 'Build', () => Promise.resolve());
  assert.deepEqual(scheduler.queuedEntries(p.name).map((e) => e.card), ['a', 'b']);

  scheduler.reorderQueue(p.name, 'Build', ['b', 'a']);
  assert.deepEqual(scheduler.queuedEntries(p.name).map((e) => e.card), ['b', 'a']);
  held.resolve();
});
