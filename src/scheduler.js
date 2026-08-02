// Shared cross-project scheduler: ONE module-level queue of {project, card,
// column} work spanning every project the running server has touched, with
// running counts kept globally, per column (Build/CI/Verify) and per project.
// pipeline.js owns WHAT to run (buildChain/verify) and WHEN a card is allowed
// to leave a column at all (queue pause, quota pause); this module owns only
// WHETHER capacity currently exists to start the next unit of that work.
//
// Design notes that matter for review:
//  - The authoritative global/column caps are recomputed ONCE per scan() from
//    every project this scheduler currently knows about (see `knownProjects`,
//    populated by schedule()) — never read off "whichever entry is being
//    considered". Two differently-configured projects therefore admit against
//    the exact same numbers in the same pass; the strictest configured value
//    wins (Math.min), so no project can unilaterally loosen a shared cap.
//  - `knownProjects` is discovered from real schedule() calls rather than
//    read from src/registry.js on disk. Production always calls schedule()
//    with registry-backed projects (see server.js), so this converges to the
//    same set; tests that build ad-hoc {name, path} projects (never added to
//    the registry) keep working without a registry.json to match against.
//  - The governor is a persistent singleton (its hysteresis state must
//    survive across ticks) built once, lazily, from the FIRST project known
//    at that moment via resourcesConfig()'s normalized output — never a
//    hard-coded default. Later-known projects fold into the combined
//    global/column caps immediately (recomputed every scan), just not into
//    the already-constructed governor's thresholds.
//  - admit() only ever gates the START of an entry. Nothing here ever touches
//    a `run()` that has already started — nothing to signal, nothing to kill.
import { loadConfig, withoutRepoLockContext } from './board.js';
import { createGovernor, sampleResources, resourcesConfig } from './resources.js';

const queue = [];                    // [{project, card, column, run, resolveFn, rejectFn, deferredReason, onDefer}]
const runningByColumn = new Map();   // column -> count
const runningByProject = new Map();  // project name -> count
let runningGlobal = 0;
const knownProjects = new Map();     // project name -> {name, path}

let governor = null;
let tickTimer = null;

function noteProject(project) {
  if (project?.name) knownProjects.set(project.name, project);
}

function projectConfigs() {
  const out = [];
  for (const p of knownProjects.values()) {
    try { out.push(loadConfig(p.path)); } catch { /* an unreadable project contributes no opinion */ }
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
    const c = loadConfig(project.path).concurrency;
    return Number.isFinite(c) && c > 0 ? c : 1;
  } catch {
    return 1;
  }
}

// Combine every known project's resources: block into one set of governor
// thresholds. Each field is folded independently by "stricter wins" (lower
// defer/resume/critical, higher required-free-disk, more recovery samples,
// shorter sample interval), then re-run through resourcesConfig() — which is
// documented idempotent — so an accidental cross-project combination that
// breaks the resume<defer<critical ordering falls back to the safe default
// band for that metric instead of producing a broken hysteresis.
function combinedResourceThresholds() {
  const configs = projectConfigs().map((c) => c.resources).filter(Boolean);
  if (!configs.length) return resourcesConfig({});
  const min = (get) => Math.min(...configs.map(get));
  const max = (get) => Math.max(...configs.map(get));
  return resourcesConfig({
    resources: {
      enabled: configs.some((c) => c.enabled),
      cpu: { defer: min((c) => c.cpu.defer), resume: min((c) => c.cpu.resume), critical: min((c) => c.cpu.critical) },
      memory: { defer: min((c) => c.memory.defer), resume: min((c) => c.memory.resume), critical: min((c) => c.memory.critical) },
      disk: { min_free_gb: max((c) => c.disk.minFreeGb), resume_free_gb: max((c) => c.disk.resumeFreeGb) },
      recovery_samples: max((c) => c.recoverySamples),
      sample_interval_seconds: min((c) => c.sampleIntervalSeconds),
    },
  });
}

function ensureGovernor() {
  if (governor) return governor;
  const thresholds = combinedResourceThresholds();
  const rootPath = knownProjects.values().next().value?.path || '.';
  governor = createGovernor({ thresholds, sample: () => sampleResources(rootPath) });
  governor.check(); // seed real state now rather than waiting a full interval
  startTicking(thresholds.sampleIntervalSeconds);
  return governor;
}

function startTicking(intervalSeconds) {
  if (tickTimer) clearInterval(tickTimer);
  const ms = Math.max(1000, (Number(intervalSeconds) || 30) * 1000);
  tickTimer = setInterval(() => {
    try { governor.check(); scan(); } catch { /* a sampler hiccup must not kill the loop */ }
  }, ms);
  tickTimer.unref?.();
}

function summarizeReasons(reasons) {
  if (!reasons?.length) return 'resource pressure';
  return reasons.map((r) => `${r.metric} ${r.level}`).join(', ');
}

function setDeferred(entry, reason) {
  if (entry.deferredReason === reason) return;
  entry.deferredReason = reason;
  entry.onDefer?.(reason);
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
  // Nothing to admit — bail before touching the governor at all. A rescan can
  // fire with an empty queue (e.g. resumeQueues() runs unconditionally at
  // boot); constructing the governor here would seed it from whatever
  // projects happen to be known at that arbitrary moment — possibly none,
  // which falls back to hard-coded defaults instead of any real board's
  // configured (or disabled) resources. Deferring construction to the first
  // actual schedule() call guarantees at least that caller's project is known.
  if (!queue.length) return;
  ensureGovernor();
  const g = governor.state();
  const globalLimit = combinedGlobalLimit();
  const columnLimitCache = new Map();
  for (const entry of [...queue]) {
    if (!queue.includes(entry)) continue; // admitted/dequeued earlier in this same pass
    // A caller-side gate (manual/quota pause) is orthogonal to capacity: it
    // stays plainly 'queued' rather than 'deferred', and — unlike governor
    // pressure — never applies to an in-flight chain's own later stages (only
    // schedule()'s enqueueBuild call ever sets this).
    if (entry.blocked?.()) { setDeferred(entry, null); continue; }
    if (g.deferring) { setDeferred(entry, summarizeReasons(g.reasons)); continue; }
    setDeferred(entry, null); // no longer governor-blocked — clear a stale reason before the capacity checks
    if (!columnLimitCache.has(entry.column)) columnLimitCache.set(entry.column, combinedColumnLimit(entry.column));
    const columnLimit = columnLimitCache.get(entry.column);
    const projectLimit = projectConcurrencyLimit(entry.project);
    const columnRunning = runningByColumn.get(entry.column) || 0;
    const projectRunning = runningByProject.get(entry.project.name) || 0;
    if (runningGlobal >= globalLimit) continue;
    if (columnRunning >= columnLimit) continue;
    if (projectRunning >= projectLimit) continue;
    admitEntry(entry);
  }
}

function bump(map, key, delta) {
  map.set(key, Math.max(0, (map.get(key) || 0) + delta));
}

function admitEntry(entry) {
  const idx = queue.indexOf(entry);
  if (idx === -1) return;
  queue.splice(idx, 1);
  entry.deferredReason = null;
  runningGlobal++;
  bump(runningByColumn, entry.column, 1);
  bump(runningByProject, entry.project.name, 1);
  withoutRepoLockContext(() => {
    let result;
    try { result = entry.run(); }
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
export function schedule(project, card, column, run, opts = {}) {
  noteProject(project);
  let resolveFn, rejectFn;
  const promise = new Promise((resolve, reject) => { resolveFn = resolve; rejectFn = reject; });
  queue.push({ project, card, column, run, deferredReason: null, resolveFn, rejectFn, onDefer: opts.onDefer, blocked: opts.blocked });
  scan();
  return promise;
}

export function isQueued(projectName, card) {
  return queue.some((e) => e.project.name === projectName && e.card === card);
}

export function queuedEntries(projectName) {
  return queue
    .filter((e) => e.project.name === projectName)
    .map((e) => ({ card: e.card, column: e.column, deferredReason: e.deferredReason }));
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
  knownProjects.delete(projectName);
}

// Force a governor re-sample + rescan now, instead of waiting for the next
// timer tick. Used by the interval itself, and directly by tests.
export function tick() {
  ensureGovernor();
  governor.check();
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
}

// Test-only: drop every module-level scheduler state, including the tick
// timer, so test files don't leak queue/running state or timers across tests.
export function resetState() {
  queue.length = 0;
  runningByColumn.clear();
  runningByProject.clear();
  runningGlobal = 0;
  knownProjects.clear();
  governor = null;
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
}
