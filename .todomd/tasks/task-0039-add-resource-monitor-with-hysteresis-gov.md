---
id: task-0039
title: Add resource monitor with hysteresis governor
status: Verify
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
session_id: b7cded7a-7e9e-4e4f-a0cf-c294258ec278
worktree: todomd/task-0039
verification: { attempts: 1, max_attempts: 3, last_verdict:  }
base_branch: main
cost_usd: 3.0185
needs_human_reason:
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
