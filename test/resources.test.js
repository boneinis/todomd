import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmp } from './helpers.js';
import { sampleResources, resourcesConfig, createGovernor, DEFAULT_RESOURCES_CONFIG } from '../src/resources.js';

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

test('resourcesConfig: a config with no resources key loads the documented defaults', () => {
  assert.deepEqual(resourcesConfig({}), DEFAULT_RESOURCES_CONFIG);
  assert.deepEqual(resourcesConfig({ mode: 'launcher' }), DEFAULT_RESOURCES_CONFIG);
});

test('resourcesConfig: partial overrides merge over the defaults per-field', () => {
  const cfg = resourcesConfig({ resources: { enabled: false, cpu: { defer: 0.5 }, recovery_samples: 5 } });
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.cpu.defer, 0.5);
  assert.equal(cfg.cpu.resume, DEFAULT_RESOURCES_CONFIG.cpu.resume); // untouched field keeps its default
  assert.equal(cfg.recoverySamples, 5);
  assert.deepEqual(cfg.memory, DEFAULT_RESOURCES_CONFIG.memory);
  assert.deepEqual(cfg.disk, DEFAULT_RESOURCES_CONFIG.disk);
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

test('governor: disk uses the inverted (lower free = worse) comparison in GB', () => {
  const gov = createGovernor({ thresholds: THRESHOLDS, sample: queueSampler([
    { ...BASE_SNAPSHOT, diskFreeBytes: 1 * BYTES_PER_GB }, // below min_free_gb: 2 -> breach
  ]) });
  const s = gov.check();
  assert.equal(s.deferring, true);
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
