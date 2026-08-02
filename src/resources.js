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
// config.yml) with the documented defaults. board.js's normalizeConfig calls
// this so every loadConfig()/execConfig() result has a fully-defaulted
// `resources` key, even for a board whose config.yml predates this feature.
export function resourcesConfig(config) {
  const c = (config && config.resources) || {};
  const cpu = c.cpu || {};
  const memory = c.memory || {};
  const disk = c.disk || {};
  const recoverySamples = Number(c.recovery_samples);
  const sampleIntervalSeconds = Number(c.sample_interval_seconds);
  return {
    enabled: c.enabled !== false,
    cpu: validHysteresis({
      defer: Number.isFinite(cpu.defer) ? cpu.defer : DEFAULT_RESOURCES_CONFIG.cpu.defer,
      resume: Number.isFinite(cpu.resume) ? cpu.resume : DEFAULT_RESOURCES_CONFIG.cpu.resume,
      critical: Number.isFinite(cpu.critical) ? cpu.critical : DEFAULT_RESOURCES_CONFIG.cpu.critical,
    }, (b) => b.resume <= b.defer, DEFAULT_RESOURCES_CONFIG.cpu),
    memory: validHysteresis({
      defer: Number.isFinite(memory.defer) ? memory.defer : DEFAULT_RESOURCES_CONFIG.memory.defer,
      resume: Number.isFinite(memory.resume) ? memory.resume : DEFAULT_RESOURCES_CONFIG.memory.resume,
      critical: Number.isFinite(memory.critical) ? memory.critical : DEFAULT_RESOURCES_CONFIG.memory.critical,
    }, (b) => b.resume <= b.defer, DEFAULT_RESOURCES_CONFIG.memory),
    disk: validHysteresis({
      minFreeGb: Number.isFinite(disk.min_free_gb) ? disk.min_free_gb : DEFAULT_RESOURCES_CONFIG.disk.minFreeGb,
      resumeFreeGb: Number.isFinite(disk.resume_free_gb) ? disk.resume_free_gb : DEFAULT_RESOURCES_CONFIG.disk.resumeFreeGb,
    }, (b) => b.resumeFreeGb >= b.minFreeGb, DEFAULT_RESOURCES_CONFIG.disk),
    recoverySamples: Number.isInteger(recoverySamples) && recoverySamples > 0
      ? recoverySamples : DEFAULT_RESOURCES_CONFIG.recoverySamples,
    sampleIntervalSeconds: Number.isFinite(sampleIntervalSeconds) && sampleIntervalSeconds > 0
      ? sampleIntervalSeconds : DEFAULT_RESOURCES_CONFIG.sampleIntervalSeconds,
  };
}

// Hysteresis only exists when the resume threshold sits on the *safe* side of
// the defer threshold: for cpu/memory (higher is worse) resume <= defer, and for
// disk (less free space is worse) resume_free_gb >= min_free_gb. An inverted
// pair defeats the governor entirely — with cpu defer 0.8 / resume 0.9 a steady
// 0.85 load both breaches defer (0.85 > 0.8) and counts as a recovery sample
// (0.85 < 0.9), so the governor flaps defer -> clear -> defer forever.
//
// Fall back rather than throw: this runs inside normalizeConfig() on every board
// load, so a bad hand-edited config.yml must not take the board down — same
// fallback-to-default convention the per-field checks above use. The WHOLE block
// is replaced, because keeping one user value and defaulting the other can still
// leave an invalid pair (defer 0.5 + default resume 0.65 is inverted again).
function validHysteresis(block, isOrdered, defaults) {
  return isOrdered(block) ? block : { ...defaults };
}

// Raw platform sample. Every metric is wrapped independently so an unsupported
// platform/runtime (no /proc, old Node without fs.statfsSync, a container with
// a locked-down statfs) degrades that one metric to null instead of throwing —
// callers (createGovernor) must treat a null metric as "unknown", never a breach.
// `platform` is injectable (defaulting to process.platform, same convention as
// installLauncher in launcher.js) so this is testable without an actual Windows host.
export function sampleResources(rootPath = '.', { platform = process.platform } = {}) {
  let cpuLoad = null;
  try {
    // On Windows, os.loadavg() always returns [0, 0, 0] — load average isn't
    // available there, so that's not a real 0% reading. Treat it as unsupported.
    if (platform !== 'win32') {
      const cpuCount = os.cpus().length;
      if (cpuCount > 0) cpuLoad = os.loadavg()[0] / cpuCount;
    }
  } catch { /* platform without loadavg/cpus */ }

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
  if (value === null || value === undefined) {
    // Unknown sample this tick: it can neither trigger nor clear a deferral
    // (no data to judge), so leave the sticky flag and recovery streak alone.
    // If already deferred, re-report the last known reason — otherwise the
    // scheduler/board would see the metric silently drop out of `reasons`
    // and read that as "recovered" with zero recovery samples observed.
    return state.deferred ? state.lastReason : null;
  }

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
      state.lastReason = null;
      return null;
    }
  } else {
    state.goodStreak = 0; // dipped below resume then bounced back — streak must restart
  }

  const isCritical = critical !== undefined && isWorse(value, critical);
  const reason = isCritical
    ? { value, threshold: critical, level: 'critical' }
    : (state.deferred ? { value, threshold: defer, level: 'defer' } : null);
  state.lastReason = reason;
  return reason;
}

// thresholds: the shape returned by resourcesConfig() — cpu/memory/disk
// sub-objects plus recoverySamples. sample: () => sampleResources()-shaped
// object (injected so tests can drive a fake sampler without touching the OS).
export function createGovernor({ thresholds, sample }) {
  const t = thresholds || DEFAULT_RESOURCES_CONFIG;
  const recoverySamples = Number.isInteger(t.recoverySamples) && t.recoverySamples > 0
    ? t.recoverySamples : DEFAULT_RESOURCES_CONFIG.recoverySamples;

  const metricState = {
    cpu: { deferred: false, goodStreak: 0, lastReason: null },
    memory: { deferred: false, goodStreak: 0, lastReason: null },
    disk: { deferred: false, goodStreak: 0, lastReason: null },
  };

  let last = { deferring: false, critical: false, reasons: [] };

  function check() {
    // `enabled: false` turns the governor off entirely: no sampling at all (the
    // whole point is not paying for statfs/loadavg on a board that opted out),
    // and never a deferral. Compared against `=== false` so thresholds built by
    // hand — including every fixture in the tests — stay enabled by default.
    if (t.enabled === false) {
      last = { deferring: false, critical: false, reasons: [] };
      return last;
    }

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
