// Shared cross-project scheduler: ONE module-level queue of {project, card,
// column} work spanning every registered project, with running counts kept
// globally, per column (Build/CI/Verify) and per project. pipeline.js owns
// WHAT to run (buildChain/verify) and WHEN a card is allowed to leave a
// column at all (queue pause, quota pause); this module owns only WHETHER
// capacity currently exists to start the next unit of that work.
//
// Design notes that matter for review:
//  - The authoritative global/column caps are recomputed ONCE per scan() from
//    the COMPLETE project set (see allKnownProjects() below) — never read off
//    "whichever entry is being considered". Two differently-configured
//    projects therefore admit against the exact same numbers in the same
//    pass; the strictest configured value wins (Math.min), so no project can
//    unilaterally loosen a shared cap. Reading the full registry fresh on
//    every call (rather than caching a set built from schedule() calls) also
//    means a project that has never queued any work of its own still
//    contributes its configured caps, and reconcileOnBoot's sequential
//    per-project processing at startup can't admit work before a
//    later-processed project's stricter limit is known.
//  - Host resource thresholds are combined only across projects with queued
//    or running work. An idle registered board must not throttle an unrelated
//    active board with dormant/default thresholds. Global and column caps are
//    still combined across the complete registry as described above.
//  - admit() only ever gates the START of an entry. Nothing here ever touches
//    a `run()` that has already started — nothing to signal, nothing to kill.
import { loadConfig, withoutRepoLockContext } from './board.js';
import { createGovernor, sampleProjectResources, resourcesConfig } from './resources.js';
import { listProjects } from './registry.js';
import { legacyMutationGuard } from './delivery-runtime.js';
import { withAdmissionSync, onAdmissionRelease } from './delivery-admission.js';
import { projectAdmissionDirectory } from './delivery-paths.js';
onAdmissionRelease(() => scan());

const queue = [];                    // [{project, card, column, resourceClass, run, resolveFn, rejectFn, deferredReason, onDefer}]
const runningByColumn = new Map();   // column -> count
const runningByProject = new Map();  // project name -> count
let runningGlobal = 0;
// project name -> {name, path}, for a project scheduled work has been
// requested for but that isn't in the registry (every test in this repo's
// own suite builds projects this way; production always registers first —
// see server.js). Merged with the full registry below, registry wins on a
// name collision since it's the authoritative production source.
const adHocProjects = new Map();

let governor = null;
let tickTimer = null;
let tickIntervalMs = null;

function noteProject(project) {
  if (project?.name) adHocProjects.set(project.name, project);
}

// The complete set of projects to combine limits/thresholds over. Read fresh
// every call (registry.listProjects() re-reads projects.json, loadConfig()
// re-reads config.yml) so a later registration, removal, or config edit is
// picked up immediately — nothing here is cached across calls.
function allKnownProjects() {
  const byName = new Map();
  try {
    for (const p of listProjects()) byName.set(p.name, p);
  } catch { /* an unreadable registry contributes no extra opinions */ }
  for (const p of adHocProjects.values()) if (!byName.has(p.name)) byName.set(p.name, p);
  return [...byName.values()];
}

function projectConfigs() {
  const out = [];
  for (const p of allKnownProjects()) {
    try { out.push(loadConfig(p.path)); } catch { /* an unreadable project contributes no opinion */ }
  }
  return out;
}

function workloadProjectNames() {
  const names = new Set(queue.map((entry) => entry.project.name));
  for (const [name, count] of runningByProject) if (count > 0) names.add(name);
  return names;
}

function enabledResourceProjects() {
  const out = [];
  const active = workloadProjectNames();
  for (const project of allKnownProjects()) {
    if (!active.has(project.name)) continue;
    try {
      const resources = loadConfig(project.path).resources;
      if (resources?.enabled !== false) out.push({ project, resources });
    } catch { /* an unreadable project contributes no sample or threshold */ }
  }
  return out;
}

// Math.min/max across every known project's opinion — see the module-level
// note above on why this must be recomputed from the whole set, not per entry.
function combinedGlobalLimit() {
  const configs = projectConfigs();
  if (!configs.length) return Infinity;
  return Math.min(...configs.map((c) => c.scheduler.global));
}

function combinedColumnLimit(column) {
  const configs = projectConfigs();
  if (!configs.length) return Infinity;
  return Math.min(...configs.map((c) => c.scheduler.columns[column] ?? Infinity));
}

function projectConcurrencyLimit(project) {
  try {
    // The legacy queue compared `active < concurrency`, so JavaScript's
    // numeric coercion accepted a quoted YAML value such as `"3"`. Preserve
    // that behavior when routing the same setting through the scheduler.
    const c = Number(loadConfig(project.path).concurrency);
    return Number.isFinite(c) && c > 0 ? c : 1;
  } catch {
    return 1;
  }
}

// Combine every active project's resources: block into one set of governor
// thresholds. Each field is folded independently by "stricter wins" (lower
// defer/resume/critical, higher required-free-disk, more recovery samples,
// shorter sample interval), then re-run through resourcesConfig() — which is
// documented idempotent — so an accidental cross-project combination that
// breaks the resume<defer<critical ordering falls back to the safe default
// band for that metric instead of producing a broken hysteresis.
function combinedResourceThresholds() {
  // `enabled: false` opts that project out of the shared host governor. It
  // therefore contributes no threshold opinion when another project keeps
  // monitoring enabled; otherwise an opted-out board could still throttle
  // every enabled board with its dormant values.
  const configs = enabledResourceProjects().map(({ resources }) => resources);
  if (!configs.length) return resourcesConfig({ resources: { enabled: false } });
  const min = (get) => Math.min(...configs.map(get));
  const max = (get) => Math.max(...configs.map(get));
  return resourcesConfig({
    resources: {
      enabled: true,
      cpu: { defer: min((c) => c.cpu.defer), resume: min((c) => c.cpu.resume), critical: min((c) => c.cpu.critical) },
      memory: { defer: min((c) => c.memory.defer), resume: min((c) => c.memory.resume), critical: min((c) => c.memory.critical) },
      disk: { min_free_gb: max((c) => c.disk.minFreeGb), resume_free_gb: max((c) => c.disk.resumeFreeGb) },
      recovery_samples: max((c) => c.recoverySamples),
      sample_interval_seconds: min((c) => c.sampleIntervalSeconds),
    },
  });
}

let lastCheckAt = 0;
let lastCheckSignature = null;

// The governor object itself (hysteresis state) is a persistent singleton,
// but its thresholds and sample root are LIVE — resolved fresh on every
// check()/sample() call from the CURRENT active project set — so queued work,
// completion, and config changes take effect immediately, with no restart and
// no lost hysteresis history.
function ensureGovernor() {
  if (governor) return governor;
  governor = createGovernor({
    thresholds: combinedResourceThresholds,
    sample: () => sampleProjectResources(
      enabledResourceProjects().map(({ project }) => project.path)),
  });
  return governor;
}

function doCheck() {
  governor.check();
  lastCheckAt = Date.now();
  lastCheckSignature = JSON.stringify(combinedResourceThresholds());
}

// Re-sample only when it can actually matter: the configured sample interval
// has elapsed, OR the combined thresholds changed since the last check (a
// project registered/deregistered, or a config edit) — so a newly-registered
// project's tighter thresholds are observed on the very next scan() instead
// of waiting out however much of the OLD interval remains. Skips re-sampling
// (the whole point of sample_interval_seconds) when neither is true.
function maybeCheck() {
  ensureGovernor();
  const thresholds = combinedResourceThresholds();
  const signature = JSON.stringify(thresholds);
  const intervalMs = Math.max(1000, (Number(thresholds.sampleIntervalSeconds) || 30) * 1000);
  if (signature !== lastCheckSignature || Date.now() - lastCheckAt >= intervalMs) doCheck();
  scheduleTick(); // (re)arm the background timer at whatever interval is current now
}

// The background timer exists solely so a deferred entry resumes on its own
// even with no new schedule()/release() event to trigger a scan() — e.g. the
// queue is non-empty but idle, waiting purely on the governor to recover.
function scheduleTick() {
  const ms = Math.max(1000, (Number(combinedResourceThresholds().sampleIntervalSeconds) || 30) * 1000);
  if (tickTimer && tickIntervalMs === ms) return; // already ticking at the right cadence
  if (tickTimer) clearInterval(tickTimer);
  tickIntervalMs = ms;
  tickTimer = setInterval(() => {
    try { scan(); } catch { /* a sampler hiccup must not kill the loop */ }
  }, ms);
  tickTimer.unref?.();
}

function summarizeReasons(reasons) {
  if (!reasons?.length) return 'resource pressure';
  return reasons.map((r) => `${r.metric} ${r.level}`).join(', ');
}

function setDeferred(entry, reason, critical) {
  // `critical` is persisted on the entry (not just handed to onDefer) so a
  // SNAPSHOT reader — queuedEntries(), which pipeline.js's getRunStates()
  // polls on a fresh connection/reload — can also tell a CI entry deferred at
  // CRITICAL severity from an ordinary defer-level wait, not only a caller that
  // was subscribed to the live onDefer callback at the moment it changed.
  entry.critical = !!critical;
  if (entry.deferredReason === reason) return;
  entry.deferredReason = reason;
  entry.onDefer?.(reason, critical);
}

// A tool-less review is CPU-light: model inference is remote and the local
// process only submits a prepared diff bundle. Let that useful work proceed
// through CPU pressure, but never bypass memory or disk pressure — both can
// make even a small child/log write unsafe. Heavy entries (Build, CI, normal
// Verify, and focused-check continuations) retain the existing governor gate.
function pressureAllows(entry, state) {
  return entry.resourceClass === 'light' &&
    state.reasons?.length > 0 &&
    state.reasons.every((reason) => reason.metric === 'cpu');
}

// Subscribers notified with the governor's fresh state on every scan() — used
// by pipeline.js to gracefully cancel an already-RUNNING CI child at critical
// pressure. This is intentionally separate from admission: scan()/admitEntry()
// above never touch a run() that has already started (see the module note at
// the top of this file) — a subscriber here is the one place outside that
// invariant, and it only ever affects work its OWN caller tracks (pipeline.js's
// ciRuns), never anything this module schedules or signals itself.
const criticalListeners = new Set();
export function onCriticalTick(fn) {
  criticalListeners.add(fn);
  return () => criticalListeners.delete(fn);
}

// Re-evaluate the whole queue against the current caps. An entry blocked by
// its OWN gate (governor pressure aside) never blocks a later entry in a
// different column/project from starting — each is checked independently, so
// a full Build column can't stall a Verify slot that has room.
//
// deferredReason is reserved for GOVERNOR pressure specifically (the
// acceptance contract: "when the governor reports pressure ... a
// deferredReason"). An ordinary capacity wait — the global/column/project
// concurrency limits, all pre-existing or new administrative caps, not
// resource pressure — stays plainly 'queued', exactly as a full queue always
// has, so board/API consumers don't see a card's normal wait for its turn
// relabeled as if the machine were under load.
function scan() {
  // Nothing to admit AND nobody watching for critical pressure on already-
  // running work — bail before touching the governor at all. A rescan can
  // fire with an empty queue (e.g. resumeQueues() runs unconditionally at
  // boot, or the periodic tick fires with nothing pending) — no reason to pay
  // for a resource sample or (on a truly empty registry) fall back to
  // hard-coded defaults when there is nothing to admit either way. A live CI
  // child with an otherwise-empty queue is the one case that still needs the
  // periodic resample (see onCriticalTick's caller — it subscribes only while
  // at least one such child is running).
  if (!queue.length && !criticalListeners.size) return;
  maybeCheck();
  const g = governor.state();
  for (const fn of criticalListeners) {
    try { fn(g); } catch { /* a listener's own error must not break scheduling */ }
  }
  if (!queue.length) return;
  const globalLimit = combinedGlobalLimit();
  const columnLimitCache = new Map();
  for (const entry of [...queue]) {
    if (!queue.includes(entry)) continue; // admitted/dequeued earlier in this same pass
    const deliveryHold = legacyMutationGuard(entry.project.path, entry.card);
    if (deliveryHold) { setDeferred(entry, deliveryHold.error, false); continue; }
    // A caller-side gate (manual/quota pause) is orthogonal to capacity: it
    // stays plainly 'queued' rather than 'deferred', and — unlike governor
    // pressure — never applies to an in-flight chain's own later stages (only
    // schedule()'s enqueueBuild call ever sets this).
    if (entry.blocked?.()) { setDeferred(entry, null, false); continue; }
    if (g.deferring && !pressureAllows(entry, g)) {
      setDeferred(entry, summarizeReasons(g.reasons), g.critical);
      continue;
    }
    setDeferred(entry, null, false); // no longer governor-blocked — clear a stale reason before the capacity checks
    if (!columnLimitCache.has(entry.column)) columnLimitCache.set(entry.column, combinedColumnLimit(entry.column));
    const columnLimit = columnLimitCache.get(entry.column);
    const projectLimit = projectConcurrencyLimit(entry.project);
    const columnRunning = runningByColumn.get(entry.column) || 0;
    const projectRunning = runningByProject.get(entry.project.name) || 0;
    if (runningGlobal >= globalLimit) continue;
    if (columnRunning >= columnLimit) continue;
    if (projectRunning >= projectLimit) continue;
    admitEntry(entry, g);
  }
}

function bump(map, key, delta) {
  map.set(key, Math.max(0, (map.get(key) || 0) + delta));
}

function admitEntry(entry, resourceState = { deferring: false, critical: false, reasons: [] }) {
  let admitted;
  try {
    admitted = withAdmissionSync(projectAdmissionDirectory(entry.project.path), 'launch', entry.card, () => {
      const held = legacyMutationGuard(entry.project.path, entry.card);
      if (held) { setDeferred(entry, held.error, false); return; }
      startEntry(entry, resourceState);
    }, { existingOnly: true, borrow: false });
  } catch {
    setDeferred(entry, 'Project admission cannot be verified; reconcile its current owner.', false);
    return;
  }
  if (!admitted.ok) setDeferred(entry, admitted.message, false);
}

function startEntry(entry, resourceState) {
  const idx = queue.indexOf(entry);
  if (idx === -1) return;
  queue.splice(idx, 1);
  entry.deferredReason = null;
  runningGlobal++;
  bump(runningByColumn, entry.column, 1);
  bump(runningByProject, entry.project.name, 1);
  withoutRepoLockContext(() => {
    let result;
    try {
      result = entry.run({
        resourcePressure: !!resourceState.deferring,
        critical: !!resourceState.critical,
        reasons: resourceState.reasons || [],
      });
    }
    catch (err) { result = Promise.reject(err); }
    // Explicit onFulfilled/onRejected (not .finally()) so a rejection is
    // handled right here — release counters, then hand the error to
    // entry.rejectFn — instead of leaking a second, uncaught promise chain.
    Promise.resolve(result).then(
      (value) => { release(entry); entry.resolveFn(value); },
      (err) => { release(entry); entry.rejectFn(err); },
    );
  });
}

function release(entry) {
  runningGlobal = Math.max(0, runningGlobal - 1);
  bump(runningByColumn, entry.column, -1);
  bump(runningByProject, entry.project.name, -1);
  scan();
}

// Enqueue one unit of column-scoped work. `run()` is invoked synchronously at
// the moment of admission (so a caller doing `pending.set(...)` as run()'s
// first line sees it land in the same tick as admission, exactly like the
// synchronous queue-shift this replaces) and its outcome settles the returned
// promise. Never signals or suspends anything already running — admission
// only ever gates a START.
// opts.blocked(): optional per-call gate (e.g. manual/quota pause) checked
//   every scan(); true skips admission without affecting deferredReason.
// opts.onDefer(reason): called whenever deferredReason changes — a non-null
//   string on entering/changing governor deferral, or null when it clears
//   (back to plain queued, whether admitted next or merely off resource
//   pressure and now just waiting on ordinary capacity).
// opts.resourceClass: `heavy` (default) obeys every governor deferral. `light`
//   may start through CPU-only pressure, and receives the admission snapshot as
//   the argument to run(); it never bypasses memory or disk pressure.
export function schedule(project, card, column, run, opts = {}) {
  noteProject(project);
  let resolveFn, rejectFn;
  const promise = new Promise((resolve, reject) => { resolveFn = resolve; rejectFn = reject; });
  queue.push({
    project, card, column, run,
    resourceClass: opts.resourceClass === 'light' ? 'light' : 'heavy',
    deferredReason: null, resolveFn, rejectFn,
    onDefer: opts.onDefer, blocked: opts.blocked,
  });
  scan();
  return promise;
}

export function isQueued(projectName, card) {
  return queue.some((e) => e.project.name === projectName && e.card === card);
}

export function queuedEntries(projectName) {
  return queue
    .filter((e) => e.project.name === projectName)
    .map((e) => ({ card: e.card, column: e.column, deferredReason: e.deferredReason, critical: !!e.critical }));
}

// Remove every queued (not yet admitted) entry for one card, settling its
// promise harmlessly instead of leaving it pending forever or rejecting into
// the caller's error-routing .catch(). Returns whether anything was removed.
export function dequeue(projectName, card) {
  let found = false;
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i].project.name === projectName && queue[i].card === card) {
      const [entry] = queue.splice(i, 1);
      entry.resolveFn(undefined);
      found = true;
    }
  }
  return found;
}

// Re-sort one project's queued entries in one column to match `order` (a list
// of card ids), preserving their interleaving with other projects'/columns'
// entries — mirrors the old per-project queue array reorder.
export function reorderQueue(projectName, column, order) {
  const rank = new Map(order.map((id, i) => [id, i]));
  const matching = queue.filter((e) => e.project.name === projectName && e.column === column);
  matching.sort((a, b) => (rank.get(a.card) ?? Infinity) - (rank.get(b.card) ?? Infinity));
  let mi = 0;
  for (let i = 0; i < queue.length; i++) {
    if (queue[i].project.name === projectName && queue[i].column === column) queue[i] = matching[mi++];
  }
}

// Drop all in-memory scheduler state for a removed project (queued entries are
// settled harmlessly; a currently-RUNNING entry's counters release normally
// through its own admitEntry() continuation when it finishes).
export function forgetProject(projectName) {
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i].project.name === projectName) {
      const [entry] = queue.splice(i, 1);
      entry.resolveFn(undefined);
    }
  }
  runningByProject.delete(projectName);
  adHocProjects.delete(projectName);
}

// Force a governor re-sample + rescan now, instead of waiting for the next
// timer tick. Used by the interval itself, and directly by tests.
export function tick() {
  ensureGovernor();
  doCheck(); // unconditional — bypasses maybeCheck()'s throttle to force a real re-sample now
  scan();
}

// Re-evaluate admission now without resampling resources — e.g. after a
// manual/quota pause lifts, so entries only held back by that pause gate
// (not by the governor or a capacity limit) start immediately rather than
// waiting for the next timer tick.
export function rescan() {
  scan();
}

// Test-only: inject a pre-built governor (e.g. resources.js's createGovernor
// with a fake sampler) so admission decisions are deterministic. Must be
// called before the first schedule()/tick(), or it won't replace a governor
// ensureGovernor() already constructed.
export function setGovernor(g) {
  governor = g;
  // Force the next scan()'s maybeCheck() to actually call check() on this
  // (possibly brand new) governor rather than skipping it because the
  // signature/interval bookkeeping looks fresh from a PRIOR governor.
  lastCheckAt = 0;
  lastCheckSignature = null;
}

// Test-only: drop every module-level scheduler state, including the tick
// timer, so test files don't leak queue/running state or timers across tests.
export function resetState() {
  queue.length = 0;
  runningByColumn.clear();
  runningByProject.clear();
  runningGlobal = 0;
  adHocProjects.clear();
  governor = null;
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
  tickIntervalMs = null;
  lastCheckAt = 0;
  lastCheckSignature = null;
  criticalListeners.clear();
}
