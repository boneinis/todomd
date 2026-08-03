import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmp } from './helpers.js';
import { sampleResources, sampleProjectResources, resourcesConfig, createGovernor, DEFAULT_RESOURCES_CONFIG } from '../src/resources.js';

const BYTES_PER_GB = 1024 ** 3;

test('sampleResources returns the documented shape and never throws, even for a missing path', () => {
  const repo = tmp('resources-sample');
  const sample = sampleResources(repo);
  assert.equal(typeof sample.sampledAt, 'number');
  for (const key of ['cpuLoad', 'memoryPressure', 'diskFreeBytes', 'diskFreePct']) {
    assert.ok(key in sample, `sample has ${key}`);
    assert.ok(sample[key] === null || typeof sample[key] === 'number', `${key} is a number or null`);
  }
  // an unsupported/missing root must degrade the disk metric to null, not throw
  assert.doesNotThrow(() => sampleResources('/path/does/not/exist/at/all'));
});

test('sampleResources: on win32, os.loadavg() always reads [0,0,0] — that is not a real reading, so cpuLoad is null there', () => {
  const repo = tmp('resources-sample-win32');
  const sample = sampleResources(repo, { platform: 'win32' });
  assert.equal(sample.cpuLoad, null, 'win32 must not report a fabricated 0 load');
  // other metrics are unaffected by the platform override
  assert.ok(sample.memoryPressure === null || typeof sample.memoryPressure === 'number');
});

test('sampleResources: macOS uses the native pressure reading instead of os.freemem', () => {
  const repo = tmp('resources-sample-darwin');
  const calls = [];
  const sample = sampleResources(repo, {
    platform: 'darwin',
    memoryPressureCommand: (...args) => {
      calls.push(args);
      return 'System-wide memory free percentage: 44%\n';
    },
  });
  assert.equal(sample.memoryPressure, 0.56);
  assert.deepEqual(calls[0].slice(0, 2), ['/usr/bin/memory_pressure', ['-Q']]);
});

test('sampleResources: unavailable or malformed macOS pressure data is unknown, never a false breach', () => {
  const repo = tmp('resources-sample-darwin-unknown');
  assert.equal(sampleResources(repo, {
    platform: 'darwin',
    memoryPressureCommand: () => { throw new Error('unavailable'); },
  }).memoryPressure, null);
  assert.equal(sampleResources(repo, {
    platform: 'darwin',
    memoryPressureCommand: () => 'unexpected output',
  }).memoryPressure, null);
});

test('sampleProjectResources uses the lowest free space across distinct project filesystems', () => {
  const calls = [];
  const snapshots = {
    '/volume-a/one': { cpuLoad: 0.2, memoryPressure: 0.3, diskFreeBytes: 20 * BYTES_PER_GB, diskFreePct: 0.5, sampledAt: 1 },
    '/volume-b/project': { cpuLoad: 0.2, memoryPressure: 0.3, diskFreeBytes: 1 * BYTES_PER_GB, diskFreePct: 0.01, sampledAt: 2 },
  };
  const result = sampleProjectResources(['/volume-a/one', '/volume-a/two', '/volume-b/project'], {
    deviceForPath: (rootPath) => rootPath.startsWith('/volume-a/') ? 10 : 20,
    sample: (rootPath) => { calls.push(rootPath); return snapshots[rootPath]; },
  });

  assert.deepEqual(calls, ['/volume-a/one', '/volume-b/project'],
    'projects on the same filesystem are sampled only once');
  assert.equal(result.diskFreeBytes, 1 * BYTES_PER_GB,
    'the nearly-full secondary filesystem governs admission');
  assert.equal(result.diskFreePct, 0.01);
  assert.equal(result.cpuLoad, 0.2, 'host-wide metrics remain available');
  assert.equal(result.sampledAt, 2, 'the aggregate records the newest component sample');
});

test('resourcesConfig: a config with no resources key loads the documented defaults', () => {
  assert.deepEqual(resourcesConfig({}), DEFAULT_RESOURCES_CONFIG);
  assert.deepEqual(resourcesConfig({ mode: 'launcher' }), DEFAULT_RESOURCES_CONFIG);
});

test('resourcesConfig: partial overrides merge over the defaults per-field', () => {
  // defer 0.75 still sits above the default resume of 0.65, so the merged pair
  // stays a valid hysteresis band and survives the ordering check below
  const cfg = resourcesConfig({ resources: { enabled: false, cpu: { defer: 0.75 }, recovery_samples: 5 } });
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.cpu.defer, 0.75);
  assert.equal(cfg.cpu.resume, DEFAULT_RESOURCES_CONFIG.cpu.resume); // untouched field keeps its default
  assert.equal(cfg.cpu.critical, DEFAULT_RESOURCES_CONFIG.cpu.critical);
  assert.equal(cfg.recoverySamples, 5);
  assert.deepEqual(cfg.memory, DEFAULT_RESOURCES_CONFIG.memory);
  assert.deepEqual(cfg.disk, DEFAULT_RESOURCES_CONFIG.disk);
});

test('resourcesConfig: a fully-specified valid custom band passes through untouched', () => {
  const cfg = resourcesConfig({ resources: {
    cpu: { defer: 0.6, resume: 0.4, critical: 2 },
    memory: { defer: 0.7, resume: 0.6, critical: 0.99 },
    disk: { min_free_gb: 10, resume_free_gb: 20 },
  } });
  assert.deepEqual(cfg.cpu, { defer: 0.6, resume: 0.4, critical: 2 });
  assert.deepEqual(cfg.memory, { defer: 0.7, resume: 0.6, critical: 0.99 });
  assert.deepEqual(cfg.disk, { minFreeGb: 10, resumeFreeGb: 20 });
});

test('resourcesConfig: equal thresholds have no hysteresis gap and fall back to documented defaults', () => {
  const cfg = resourcesConfig({ resources: {
    cpu: { defer: 0.7, resume: 0.7 },
    memory: { defer: 0.6, resume: 0.6 },
    disk: { min_free_gb: 4, resume_free_gb: 4 },
  } });
  assert.deepEqual(cfg.cpu, DEFAULT_RESOURCES_CONFIG.cpu);
  assert.deepEqual(cfg.memory, DEFAULT_RESOURCES_CONFIG.memory);
  assert.deepEqual(cfg.disk, DEFAULT_RESOURCES_CONFIG.disk);
});

test('resourcesConfig: an inverted cpu band (resume looser than defer) falls back to the documented cpu defaults', () => {
  // resume 0.9 > defer 0.8: a steady 0.85 load would breach defer AND count as
  // a recovery sample every tick, flapping the governor forever
  const cfg = resourcesConfig({ resources: { cpu: { defer: 0.8, resume: 0.9, critical: 1.2 } } });
  assert.deepEqual(cfg.cpu, DEFAULT_RESOURCES_CONFIG.cpu,
    'the whole cpu block is replaced — keeping one side can still leave an invalid pair');
  assert.deepEqual(cfg.memory, DEFAULT_RESOURCES_CONFIG.memory, 'other metrics are unaffected');
});

test('resourcesConfig: an inverted memory band falls back to the documented memory defaults', () => {
  const cfg = resourcesConfig({ resources: {
    memory: { defer: 0.6, resume: 0.8 },
    cpu: { defer: 0.6, resume: 0.4 },
  } });
  assert.deepEqual(cfg.memory, DEFAULT_RESOURCES_CONFIG.memory);
  assert.deepEqual(cfg.cpu, { defer: 0.6, resume: 0.4, critical: DEFAULT_RESOURCES_CONFIG.cpu.critical },
    'a valid cpu band alongside an invalid memory one is kept');
});

test('resourcesConfig: partial overrides cannot move defer beyond the default critical threshold', () => {
  const cfg = resourcesConfig({ resources: {
    cpu: { defer: 2 },
    memory: { defer: 0.99 },
  } });
  assert.deepEqual(cfg.cpu, DEFAULT_RESOURCES_CONFIG.cpu,
    'cpu resume < defer < critical must still hold after merging a partial override');
  assert.deepEqual(cfg.memory, DEFAULT_RESOURCES_CONFIG.memory,
    'memory resume < defer < critical must still hold after merging a partial override');

  const gov = createGovernor({ thresholds: cfg, sample: queueSampler([{
    ...BASE_SNAPSHOT,
    cpuLoad: 1.6,
    memoryPressure: 0.96,
  }]) });
  const state = gov.check();
  assert.equal(state.deferring, true);
  assert.equal(state.critical, true, 'normalization must not make critical pressure unreachable');
  assert.deepEqual(state.reasons, [
    { metric: 'cpu', value: 1.6, threshold: 1.5, level: 'critical' },
    { metric: 'memory', value: 0.96, threshold: 0.95, level: 'critical' },
  ]);
});

test('resourcesConfig: a disk band whose resume_free_gb is below min_free_gb falls back to the disk defaults', () => {
  // disk is inverted (less free space is worse), so resume_free_gb must be the
  // LARGER number; 1 GB free would clear a deferral raised at 5 GB free
  const cfg = resourcesConfig({ resources: { disk: { min_free_gb: 5, resume_free_gb: 1 } } });
  assert.deepEqual(cfg.disk, DEFAULT_RESOURCES_CONFIG.disk);
});

test('resourcesConfig: an invalid band never throws — it runs on every board load', () => {
  assert.doesNotThrow(() => resourcesConfig({ resources: {
    cpu: { defer: 0.1, resume: 0.99 },
    memory: { defer: 0.1, resume: 0.99 },
    disk: { min_free_gb: 100, resume_free_gb: 0 },
  } }));
});

// A sampler whose queued snapshots feed createGovernor.check() one at a time,
// repeating the last entry once exhausted.
function queueSampler(snapshots) {
  let i = 0;
  return () => snapshots[Math.min(i++, snapshots.length - 1)];
}

const BASE_SNAPSHOT = { cpuLoad: 0.1, memoryPressure: 0.1, diskFreeBytes: 100 * BYTES_PER_GB, diskFreePct: 0.9, sampledAt: 0 };
const THRESHOLDS = resourcesConfig({ resources: {
  cpu: { defer: 0.8, resume: 0.5, critical: 1.5 },
  memory: { defer: 0.8, resume: 0.5, critical: 0.95 },
  disk: { min_free_gb: 2, resume_free_gb: 5 },
  recovery_samples: 3,
} });

test('governor: a sample below the defer threshold never defers', () => {
  const gov = createGovernor({ thresholds: THRESHOLDS, sample: queueSampler([BASE_SNAPSHOT]) });
  const s = gov.check();
  assert.equal(s.deferring, false);
  assert.deepEqual(s.reasons, []);
});

test('governor: a defer-threshold breach defers, and the reason is machine-readable', () => {
  const gov = createGovernor({ thresholds: THRESHOLDS, sample: queueSampler([{ ...BASE_SNAPSHOT, cpuLoad: 0.9 }]) });
  const s = gov.check();
  assert.equal(s.deferring, true);
  assert.equal(s.critical, false);
  assert.deepEqual(s.reasons, [{ metric: 'cpu', value: 0.9, threshold: 0.8, level: 'defer' }]);
});

test('governor hysteresis: one dip below resume does NOT clear the deferral', () => {
  const gov = createGovernor({ thresholds: THRESHOLDS, sample: queueSampler([
    { ...BASE_SNAPSHOT, cpuLoad: 0.9 },  // breach -> deferred
    { ...BASE_SNAPSHOT, cpuLoad: 0.3 },  // one good sample only
  ]) });
  gov.check();
  const s = gov.check();
  assert.equal(s.deferring, true, 'a single good sample must not clear a sticky deferral');
  assert.deepEqual(s.reasons, [{ metric: 'cpu', value: 0.9, threshold: 0.8, level: 'defer' }],
    'a recovery sample preserves the actual breach as the deferral explanation');
});

test('governor hysteresis: equality at resume is not a strictly safe recovery sample', () => {
  const gov = createGovernor({ thresholds: THRESHOLDS, sample: queueSampler([
    { ...BASE_SNAPSHOT, cpuLoad: 0.9 },
    { ...BASE_SNAPSHOT, cpuLoad: 0.5 },
    { ...BASE_SNAPSHOT, cpuLoad: 0.5 },
    { ...BASE_SNAPSHOT, cpuLoad: 0.5 },
  ]) });
  gov.check(); gov.check(); gov.check();
  const s = gov.check();
  assert.equal(s.deferring, true, 'a value equal to resume must not advance recovery');
  assert.deepEqual(s.reasons, [{ metric: 'cpu', value: 0.9, threshold: 0.8, level: 'defer' }]);
});

test('governor hysteresis: recovery_samples consecutive good samples DO clear the deferral', () => {
  const gov = createGovernor({ thresholds: THRESHOLDS, sample: queueSampler([
    { ...BASE_SNAPSHOT, cpuLoad: 0.9 },  // breach -> deferred
    { ...BASE_SNAPSHOT, cpuLoad: 0.3 },  // good 1/3
    { ...BASE_SNAPSHOT, cpuLoad: 0.3 },  // good 2/3
    { ...BASE_SNAPSHOT, cpuLoad: 0.3 },  // good 3/3 -> clears
  ]) });
  gov.check(); gov.check(); gov.check();
  const s = gov.check();
  assert.equal(s.deferring, false);
  assert.deepEqual(s.reasons, []);
});

test('governor hysteresis: a broken streak restarts the recovery count from zero', () => {
  const gov = createGovernor({ thresholds: THRESHOLDS, sample: queueSampler([
    { ...BASE_SNAPSHOT, cpuLoad: 0.9 },  // breach -> deferred
    { ...BASE_SNAPSHOT, cpuLoad: 0.3 },  // good 1/3
    { ...BASE_SNAPSHOT, cpuLoad: 0.3 },  // good 2/3
    { ...BASE_SNAPSHOT, cpuLoad: 0.6 },  // in the dead zone (>= resume) -> streak resets
    { ...BASE_SNAPSHOT, cpuLoad: 0.3 },  // good 1/3 again
    { ...BASE_SNAPSHOT, cpuLoad: 0.3 },  // good 2/3 again
    { ...BASE_SNAPSHOT, cpuLoad: 0.3 },  // good 3/3 again -> clears
  ]) });
  for (let i = 0; i < 6; i++) gov.check();
  assert.equal(gov.state().deferring, true, 'still deferring — the reset streak has not reached 3 yet');
  const s = gov.check(); // good 3/3
  assert.equal(s.deferring, false);
});

test('governor: critical breach reports level=critical with the critical threshold', () => {
  const gov = createGovernor({ thresholds: THRESHOLDS, sample: queueSampler([{ ...BASE_SNAPSHOT, memoryPressure: 0.99 }]) });
  const s = gov.check();
  assert.equal(s.critical, true);
  assert.deepEqual(s.reasons, [{ metric: 'memory', value: 0.99, threshold: 0.95, level: 'critical' }]);
});

test('governor: improving samples never revive a previous critical-pressure signal', () => {
  const gov = createGovernor({ thresholds: THRESHOLDS, sample: queueSampler([
    { ...BASE_SNAPSHOT, cpuLoad: 1.6 },  // current critical pressure
    { ...BASE_SNAPSHOT, cpuLoad: 0.7 },  // dead band: still deferred, no longer critical
    { ...BASE_SNAPSHOT, cpuLoad: 0.3 },  // recovery 1/3: still deferred, no longer critical
  ]) });

  assert.equal(gov.check().critical, true);

  const deadBand = gov.check();
  assert.equal(deadBand.critical, false);
  assert.deepEqual(deadBand.reasons, [{ metric: 'cpu', value: 1.6, threshold: 1.5, level: 'critical' }],
    'the actual breach remains the sticky deferral explanation');

  const improving = gov.check();
  assert.equal(improving.critical, false, 'a safe sample must not revive stale critical pressure');
  assert.deepEqual(improving.reasons, deadBand.reasons);
});

test('governor: a null metric never defers, even when persistently null', () => {
  const gov = createGovernor({ thresholds: THRESHOLDS, sample: queueSampler([
    { ...BASE_SNAPSHOT, cpuLoad: null },
    { ...BASE_SNAPSHOT, cpuLoad: null },
    { ...BASE_SNAPSHOT, cpuLoad: null },
  ]) });
  for (let i = 0; i < 3; i++) {
    const s = gov.check();
    assert.equal(s.deferring, false);
    assert.ok(!s.reasons.some((r) => r.metric === 'cpu'));
  }
});

test('governor regression: a breach followed by an unknown (null) sample keeps the sticky deferral and its reason', () => {
  const gov = createGovernor({ thresholds: THRESHOLDS, sample: queueSampler([
    { ...BASE_SNAPSHOT, cpuLoad: 0.9 },   // breach -> deferred
    { ...BASE_SNAPSHOT, cpuLoad: null },  // platform stops reporting cpu this tick
  ]) });
  const breached = gov.check();
  assert.equal(breached.deferring, true);
  assert.deepEqual(breached.reasons, [{ metric: 'cpu', value: 0.9, threshold: 0.8, level: 'defer' }]);

  const afterNull = gov.check();
  assert.equal(afterNull.deferring, true, 'a null sample must not silently clear a sticky deferral');
  assert.deepEqual(afterNull.reasons, [{ metric: 'cpu', value: 0.9, threshold: 0.8, level: 'defer' }],
    'the last known reason is preserved so the board/scheduler can still explain the deferral');

  // and the null sample must not count toward the recovery streak either —
  // two real good samples afterward should still not be enough to clear it
  const gov2 = createGovernor({ thresholds: THRESHOLDS, sample: queueSampler([
    { ...BASE_SNAPSHOT, cpuLoad: 0.9 },   // breach
    { ...BASE_SNAPSHOT, cpuLoad: null },  // unknown — does not advance recovery
    { ...BASE_SNAPSHOT, cpuLoad: 0.3 },   // good 1/3
    { ...BASE_SNAPSHOT, cpuLoad: 0.3 },   // good 2/3
  ]) });
  gov2.check(); gov2.check(); gov2.check();
  assert.equal(gov2.check().deferring, true, 'only 2 real good samples observed — recovery_samples is 3');
});

test('governor regression: an unknown sample breaks an in-progress recovery streak', () => {
  const gov = createGovernor({ thresholds: THRESHOLDS, sample: queueSampler([
    { ...BASE_SNAPSHOT, cpuLoad: 0.9 },   // breach
    { ...BASE_SNAPSHOT, cpuLoad: 0.3 },   // good 1/3
    { ...BASE_SNAPSHOT, cpuLoad: 0.3 },   // good 2/3
    { ...BASE_SNAPSHOT, cpuLoad: null },  // unknown: streak must reset
    { ...BASE_SNAPSHOT, cpuLoad: 0.3 },   // good 1/3 again
    { ...BASE_SNAPSHOT, cpuLoad: 0.3 },   // good 2/3 again
    { ...BASE_SNAPSHOT, cpuLoad: 0.3 },   // good 3/3 -> clear
  ]) });
  for (let i = 0; i < 6; i++) gov.check();
  assert.equal(gov.state().deferring, true,
    'two good samples after an unknown reading must not complete a three-sample recovery');
  assert.equal(gov.check().deferring, false);
});

test('governor: disk uses the inverted (lower free = worse) comparison in GB', () => {
  const gov = createGovernor({ thresholds: THRESHOLDS, sample: queueSampler([
    { ...BASE_SNAPSHOT, diskFreeBytes: 1 * BYTES_PER_GB }, // below min_free_gb: 2 -> breach
  ]) });
  const s = gov.check();
  assert.equal(s.deferring, true);
  assert.deepEqual(s.reasons, [{ metric: 'disk', value: 1, threshold: 2, level: 'defer' }]);
});

test('governor hysteresis: disk equality at resume is not a strictly safe recovery sample', () => {
  const gov = createGovernor({ thresholds: THRESHOLDS, sample: queueSampler([
    { ...BASE_SNAPSHOT, diskFreeBytes: 1 * BYTES_PER_GB },
    { ...BASE_SNAPSHOT, diskFreeBytes: 5 * BYTES_PER_GB },
    { ...BASE_SNAPSHOT, diskFreeBytes: 5 * BYTES_PER_GB },
    { ...BASE_SNAPSHOT, diskFreeBytes: 5 * BYTES_PER_GB },
  ]) });
  gov.check(); gov.check(); gov.check();
  const s = gov.check();
  assert.equal(s.deferring, true, 'free space equal to resume must not advance recovery');
  assert.deepEqual(s.reasons, [{ metric: 'disk', value: 1, threshold: 2, level: 'defer' }]);
});

test('governor: state() reflects the last check() without re-sampling', () => {
  let calls = 0;
  const sample = () => { calls++; return BASE_SNAPSHOT; };
  const gov = createGovernor({ thresholds: THRESHOLDS, sample });
  gov.check();
  gov.state();
  gov.state();
  assert.equal(calls, 1);
});

test('governor: `resources.enabled: false` never defers and never even samples the host', () => {
  let calls = 0;
  const sample = () => { calls++; return { ...BASE_SNAPSHOT, cpuLoad: 9, memoryPressure: 0.99, diskFreeBytes: 0 }; };
  const gov = createGovernor({
    thresholds: resourcesConfig({ resources: { enabled: false } }),
    sample, // would breach every metric, including critical, if it were consulted
  });
  for (let i = 0; i < 3; i++) {
    const s = gov.check();
    assert.deepEqual(s, { deferring: false, critical: false, reasons: [] },
      'an opted-out board is never held back by the governor');
  }
  assert.equal(calls, 0, 'a disabled governor must not pay for statfs/loadavg at all');
  assert.deepEqual(gov.state(), { deferring: false, critical: false, reasons: [] });
});

test('governor: thresholds built by hand (no enabled key) stay enabled', () => {
  // guards the `=== false` check against a truthiness regression, since the
  // in-repo fixtures and any hand-built threshold object omit `enabled`
  const gov = createGovernor({
    thresholds: { cpu: { defer: 0.8, resume: 0.5 }, recoverySamples: 3 },
    sample: queueSampler([{ ...BASE_SNAPSHOT, cpuLoad: 0.9 }]),
  });
  assert.equal(gov.check().deferring, true);
});

test('governor regression: an inverted configured band cannot make a steady load flap defer -> clear -> defer', () => {
  // the exact repro: cpu defer 0.8 / resume 0.9 with a sustained 0.85 load.
  // resourcesConfig rejects the band, so 0.85 stays a breach of the default
  // 0.85/0.65 pair... and, crucially, never counts as a recovery sample.
  const thresholds = resourcesConfig({ resources: { cpu: { defer: 0.8, resume: 0.9 }, recovery_samples: 3 } });
  const gov = createGovernor({
    thresholds,
    sample: queueSampler([{ ...BASE_SNAPSHOT, cpuLoad: 0.851 }]),
  });
  const states = [];
  for (let i = 0; i < 12; i++) states.push(gov.check().deferring);
  assert.deepEqual(states, new Array(12).fill(true),
    'a load that never recovered must stay deferred for every sample — no oscillation');
});
