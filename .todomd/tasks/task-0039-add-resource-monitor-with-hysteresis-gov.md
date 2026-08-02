---
id: task-0039
title: Add resource monitor with hysteresis governor
status: Needs Human
type: module
priority: medium
labels: []
dependencies: []
parent: task-0021
created_date: 2026-08-02
source: chunk
assignee: 
agent: claude
triaged: n/a (chunk 1/4 of task-0021)
session_id: 019fc431-89ed-7c00-a2c7-029ec7213eaa
worktree: todomd/task-0039
verification: { attempts: 3, max_attempts: 3, last_verdict: fail }
base_branch: main
cost_usd: 11.7717
needs_human_reason: attempts_exhausted
recovery_stage:
---

## Description

Add resource monitor with hysteresis governor

## Acceptance Criteria

- [ ] src/resources.js reports CPU load, memory pressure and free disk, returning null for metrics the platform cannot provide rather than throwing.
- [ ] The governor defers on a defer-threshold breach and only resumes after the resume threshold holds for the configured number of consecutive samples.
- [ ] state() exposes a per-metric machine-readable deferral reason including metric, value, threshold and level.
- [ ] A board whose config.yml has no resources key loads with the documented defaults.
- [ ] npm test passes, including a new test/resources.test.js.

## Implementation Plan

1. Create `src/resources.js` exporting `sampleResources(rootPath)` returning
   `{ cpuLoad, memoryPressure, diskFreeBytes, diskFreePct, sampledAt }`.
   Build it on `node:os` (`os.loadavg()[0]` normalised by `os.cpus().length`,
   `freemem()/totalmem()`) and `fs.statfsSync(rootPath)` for disk. Wrap each
   platform call in try/catch so an unsupported platform yields a `null`
   metric instead of throwing — a null metric must never cause a deferral.
2. In the same module add `createGovernor({ thresholds, sample })` returning
   `{ check(), state() }`. Two-level thresholds per metric: `defer` (breach →
   new heavy work is held) and `resume` (strictly looser than `defer`), plus
   a `critical` level used later for CI cancellation. Keep a sticky
   `deferred` flag per metric that only clears once the metric has held below
   `resume` for `recovery_samples` consecutive samples (default 3). That
   sticky flag + the resume gap IS the hysteresis — do not clear on a single
   good sample.
3. `state()` returns
   `{ deferring, critical, reasons: [{ metric, value, threshold, level }] }`
   so the scheduler and the board can render the reason verbatim rather than
   re-deriving it.
4. Add a `resources:` block to `CONFIG_YML` in `src/templates.js` (`enabled`,
   `cpu: {defer, resume, critical}`, `memory: {defer, resume, critical}`,
   `disk: {min_free_gb, resume_free_gb}`, `recovery_samples`,
   `sample_interval_seconds`). Existing boards have no such key, so make the
   config loader merge these defaults rather than requiring a rewrite of
   every `.todomd/config.yml`.
5. Write `test/resources.test.js` driving an injected fake sampler: below
   threshold, breach → deferring, one dip below `resume` does NOT clear,
   `recovery_samples` consecutive good samples DO clear, critical detection,
   and null metrics never defer. Also extend `test/templates.test.js` for the
   new config keys.
Risk: `fs.statfsSync` is Node 18.15+; guard it so older runtimes degrade to a
null disk metric instead of crashing the server at startup.

## Run Log
- 2026-08-02 15:51Z · Build attempt 1 · ? turns · $0.000 · cancelled
  - orphaned_run: server restarted during a run — unmerged work is PRESERVED in the worktree/branch
- 2026-08-02 15:57Z · Restart Build · preserved worktree unavailable; starting a fresh build
- 2026-08-02 16:19Z · Build attempt 1 · 12 turns · $3.019 · ok
- 2026-08-02 16:27Z · Verify attempt 1 · 1 turns · $0.000 · verdict: fail (unmet: 4)
  - retrying with findings (attempt 2/3)
- 2026-08-02 16:36Z · Build attempt 2 · 46 turns · $2.792 · ok
- 2026-08-02 16:45Z · Verify attempt 2 · 1 turns · $0.000 · verdict: fail (unmet: 1)
  - escalating after 2 failed reviews: Fable diagnosis → Opus repair → final Codex gate
- 2026-08-02 16:50Z · Escalate attempt 2 · 22 turns · $2.996 · diagnosis complete
- 2026-08-02 17:09Z · Build attempt 3 · 51 turns · $2.965 · ok (escalation repair)
- 2026-08-02 17:16Z · Verify attempt 3 · 1 turns · $0.000 · verdict: fail (unmet: 2)
  - attempts_exhausted: `npm test` passed: 487 unit and 28 UI tests. However, adversarial review found reachable defects:

1. In src/resources.js:109-115, a null sample leaves `goodStreak` unchanged. Sequence breach → good → good → null → good clears a 3-sample deferral, although three consecutive samples never held below the resume threshold. Reset the recovery streak when a deferred metric becomes unknown.

2. The thre
- 2026-08-02 20:40Z · Verify attempt 3 · 1 turns · $0.000 · verdict: fail
  - attempts_exhausted: `npm test` passed outside the restricted sandbox (493 unit/integration tests and 29 UI tests). However, adversarial review found reachable governor defects:

1. In src/resources.js:109-155, critical state can reappear on an improving sample. CPU samples 1.6 (critical), 0.7 (dead band), then 0.3 (recovery) produce `critical: true → false → true`, while retaining the same critical reason. `stickyHit
