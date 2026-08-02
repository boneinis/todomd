import os from 'node:os';
import fs from 'node:fs';

// Documented defaults for an existing board whose config.yml predates this
// feature and has no `resources:` key at all — see CONFIG_YML in templates.js,
// which must stay numerically in sync with this object.
export const DEFAULT_RESOURCES_CONFIG = {
  enabled: true,
  cpu: { defer: 0.85, resume: 0.65, critical: 1.5 },       // loadavg(1m) / cpu count
  memory: { defer: 0.85, resume: 0.70, critical: 0.95 },   // fraction of RAM used
  disk: { minFreeGb: 2, resumeFreeGb: 5 },
  recoverySamples: 3,
  sampleIntervalSeconds: 30,
};

// Merge a board's `resources:` config block (snake_case, as written in
// config.yml) with the documented defaults, the same "read the raw block,
// fill in the gaps" convention used elsewhere (see buildContinuationConfig
// in pipeline.js) rather than baking this into the generic loadConfig/
// normalizeConfig path in board.js.
export function resourcesConfig(config) {
  const c = (config && config.resources) || {};
  const cpu = c.cpu || {};
  const memory = c.memory || {};
  const disk = c.disk || {};
  const recoverySamples = Number(c.recovery_samples);
  const sampleIntervalSeconds = Number(c.sample_interval_seconds);
  return {
    enabled: c.enabled !== false,
    cpu: {
      defer: Number.isFinite(cpu.defer) ? cpu.defer : DEFAULT_RESOURCES_CONFIG.cpu.defer,
      resume: Number.isFinite(cpu.resume) ? cpu.resume : DEFAULT_RESOURCES_CONFIG.cpu.resume,
      critical: Number.isFinite(cpu.critical) ? cpu.critical : DEFAULT_RESOURCES_CONFIG.cpu.critical,
    },
    memory: {
      defer: Number.isFinite(memory.defer) ? memory.defer : DEFAULT_RESOURCES_CONFIG.memory.defer,
      resume: Number.isFinite(memory.resume) ? memory.resume : DEFAULT_RESOURCES_CONFIG.memory.resume,
      critical: Number.isFinite(memory.critical) ? memory.critical : DEFAULT_RESOURCES_CONFIG.memory.critical,
    },
    disk: {
      minFreeGb: Number.isFinite(disk.min_free_gb) ? disk.min_free_gb : DEFAULT_RESOURCES_CONFIG.disk.minFreeGb,
      resumeFreeGb: Number.isFinite(disk.resume_free_gb) ? disk.resume_free_gb : DEFAULT_RESOURCES_CONFIG.disk.resumeFreeGb,
    },
    recoverySamples: Number.isInteger(recoverySamples) && recoverySamples > 0
      ? recoverySamples : DEFAULT_RESOURCES_CONFIG.recoverySamples,
    sampleIntervalSeconds: Number.isFinite(sampleIntervalSeconds) && sampleIntervalSeconds > 0
      ? sampleIntervalSeconds : DEFAULT_RESOURCES_CONFIG.sampleIntervalSeconds,
  };
}

// Raw platform sample. Every metric is wrapped independently so an unsupported
// platform/runtime (no /proc, old Node without fs.statfsSync, a container with
// a locked-down statfs) degrades that one metric to null instead of throwing —
// callers (createGovernor) must treat a null metric as "unknown", never a breach.
export function sampleResources(rootPath = '.') {
  let cpuLoad = null;
  try {
    const cpuCount = os.cpus().length;
    if (cpuCount > 0) cpuLoad = os.loadavg()[0] / cpuCount;
  } catch { /* platform without loadavg/cpus (e.g. some Windows builds) */ }

  let memoryPressure = null;
  try {
    const total = os.totalmem();
    if (total > 0) memoryPressure = (total - os.freemem()) / total;
  } catch { /* unsupported platform */ }

  let diskFreeBytes = null;
  let diskFreePct = null;
  try {
    if (typeof fs.statfsSync === 'function') {
      const stats = fs.statfsSync(rootPath);
      const totalBytes = stats.blocks * stats.bsize;
      diskFreeBytes = stats.bavail * stats.bsize;
      if (totalBytes > 0) diskFreePct = diskFreeBytes / totalBytes;
    }
  } catch { /* Node < 18.15 (no statfsSync), or an fs that doesn't support it */ }

  return { cpuLoad, memoryPressure, diskFreeBytes, diskFreePct, sampledAt: Date.now() };
}

const BYTES_PER_GB = 1024 ** 3;

// A metric whose sticky `deferred` flag only clears after `recoverySamples`
// CONSECUTIVE samples held below `resume` — that gap between defer/resume plus
// the streak requirement IS the hysteresis; a single good sample must not clear it.
function evaluateMetric(state, value, { defer, resume, critical }, isWorse, recoverySamples) {
  if (value === null || value === undefined) return null; // unknown metric: never breaches, never clears

  if (!state.deferred) {
    if (defer !== undefined && isWorse(value, defer)) {
      state.deferred = true;
      state.goodStreak = 0;
    }
  } else if (resume !== undefined && !isWorse(value, resume)) {
    state.goodStreak += 1;
    if (state.goodStreak >= recoverySamples) {
      state.deferred = false;
      state.goodStreak = 0;
    }
  } else {
    state.goodStreak = 0; // dipped below resume then bounced back — streak must restart
  }

  const isCritical = critical !== undefined && isWorse(value, critical);
  if (isCritical) return { value, threshold: critical, level: 'critical' };
  if (state.deferred) return { value, threshold: defer, level: 'defer' };
  return null;
}

// thresholds: the shape returned by resourcesConfig() — cpu/memory/disk
// sub-objects plus recoverySamples. sample: () => sampleResources()-shaped
// object (injected so tests can drive a fake sampler without touching the OS).
export function createGovernor({ thresholds, sample }) {
  const t = thresholds || DEFAULT_RESOURCES_CONFIG;
  const recoverySamples = Number.isInteger(t.recoverySamples) && t.recoverySamples > 0
    ? t.recoverySamples : DEFAULT_RESOURCES_CONFIG.recoverySamples;

  const metricState = {
    cpu: { deferred: false, goodStreak: 0 },
    memory: { deferred: false, goodStreak: 0 },
    disk: { deferred: false, goodStreak: 0 },
  };

  let last = { deferring: false, critical: false, reasons: [] };

  function check() {
    const snapshot = sample();
    const higherIsWorse = (v, th) => v > th;
    const lowerIsWorse = (v, th) => v < th;
    const diskFreeGb = snapshot.diskFreeBytes == null ? null : snapshot.diskFreeBytes / BYTES_PER_GB;

    const results = [
      ['cpu', snapshot.cpuLoad, t.cpu || {}, higherIsWorse],
      ['memory', snapshot.memoryPressure, t.memory || {}, higherIsWorse],
      ['disk', diskFreeGb, { defer: (t.disk || {}).minFreeGb, resume: (t.disk || {}).resumeFreeGb }, lowerIsWorse],
    ];

    const reasons = [];
    let critical = false;
    for (const [metric, value, metricThresholds, isWorse] of results) {
      const hit = evaluateMetric(metricState[metric], value, metricThresholds, isWorse, recoverySamples);
      if (!hit) continue;
      reasons.push({ metric, ...hit });
      if (hit.level === 'critical') critical = true;
    }

    last = { deferring: reasons.length > 0, critical, reasons };
    return last;
  }

  function state() {
    return last;
  }

  return { check, state };
}
