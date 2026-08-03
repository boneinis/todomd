---
id: task-0040
title: Route work through a shared cross-project scheduler
status: Verify
type: improvement
priority: medium
labels: []
dependencies: [task-0039]
parent: task-0021
created_date: 2026-08-02
source: chunk
assignee: 
agent: claude
triaged: n/a (chunk 2/4 of task-0021)
session_id: 019fc59f-73cc-7fa2-9ad1-cb769f12062f
worktree: todomd/task-0040
verification: { attempts: 3, max_attempts: 3, last_verdict: fail }
base_branch: main
cost_usd: 113.7378
needs_human_reason:
recovery_stage:
---

## Description

Route work through a shared cross-project scheduler

## Acceptance Criteria

- [ ] A single scheduler enforces a configurable global concurrency limit across all registered projects, not per project.
- [ ] Per-column concurrency limits are configurable and enforced independently of the global limit.
- [ ] Existing boards that set only concurrency keep their current effective Build parallelism.
- [ ] When the governor reports pressure, new work stays queued with a deferredReason and no child is spawned.
- [ ] A deferred entry starts automatically on a later tick once the governor recovers, with no human action.
- [ ] A job that is already running is never signalled or suspended by resource pressure.
- [ ] npm test passes, including a new test/scheduler.test.js.

## Implementation Plan

1. Extract the per-project queue in `src/pipeline.js` (`queues` / `active` /
   `enqueueBuild` / `processQueue`, ~lines 1207-1254) into a new
   `src/scheduler.js` holding ONE module-level queue of
   `{ project, card, column }` entries spanning every registered project
   (`src/registry.js`), plus running counts keyed globally and per column.
2. Admission rule in `admit()`: start an entry only while
   `globalRunning < limits.global` AND `columnRunning[col] < limits.columns[col]`
   AND `governor.state().deferring` is false. Keep the project's own
   `config.concurrency` as a third project-level cap so existing single-project
   boards behave exactly as today.
3. Add a `scheduler:` block to `CONFIG_YML` in `src/templates.js`
   (`global`, `columns: { Build, CI, Verify }`), defaulting `columns.Build` to
   the project's existing `concurrency` value so no board changes behaviour on
   upgrade.
4. A blocked entry stays queued with `deferredReason` copied from
   `governor.state().reasons`. Add a `tick()` on `sample_interval_seconds`
   that re-runs `admit()`, so deferred work resumes by itself once the
   governor recovers. `admit()` gates only the START of work — it must never
   signal or suspend a live child, so a running Build is never frozen.
5. Repoint the existing callers in `pipeline.js` (`buildChain`'s `finally`
   re-drive, `revertPendingCancel`, the quota-pause resume path at
   `pipeline.js:1314`, and epic/chunk approval at ~line 669) at the scheduler.
   Preserve the current dedupe (`q.includes(id) || children.has(runKey(...))`)
   and the `bumpRunGeneration` call — double-queueing a card is a live bug
   class here.
6. Emit the new state through `sendState(project, id, 'deferred', column)`
   alongside the existing `queued` / `running`, and add `deferred` to the
   event vocabulary in `src/realtime.js` if it enumerates states.
7. Tests in `test/scheduler.test.js`: the global limit caps concurrent work
   across two registered projects; a per-column limit caps that column alone;
   an injected governor reporting pressure defers instead of starting; the
   next tick resumes it; and a running job is never cancelled by pressure.
   Update the concurrency assertions in `test/pipeline.test.js`.
Risk: budget mode (`mode: budget`) deliberately does not enqueue builds
(`pipeline.js:680`, `:1280`); the scheduler must keep that opt-out intact or
budget boards will start double-running work against the dispatcher.

## Recovery Requirements

The first implementation failed independent review. The fresh build must address all of these:

- Resolve one authoritative machine-wide global cap across differently configured projects; never select the global limit from whichever entry is being considered.
- Schedule Build, CI, and Verify as their actual columns. Do not hold a Build slot for the whole Build-to-Verify chain or leave CI/Verify limits inert.
- Construct the production governor from normalized configured resource thresholds, recovery samples, enabled state, and sampling interval—not hard-coded defaults.
- Carry `deferredReason` through live run-state broadcasts and render deferred state/reasons in the board UI.
- Catch scheduler job settlement failures and release counters without creating an unhandled rejection.
- Preserve the deployed persistent manual Queue Pause behavior: a manually paused project must admit no new scheduler work, pause state must survive restart, and explicit resume must rehydrate parked Queue cards. Keep the existing pause API/UI tests green.
- Add pipeline-level regression coverage for differing project global settings, real stage-column accounting, configured governor values, deferred WebSocket/UI state, rejected jobs, and manual pause integration.

## Run Log
- 2026-08-02 21:24Z · Build attempt 1 · 101 turns · $9.357 · checkpoint 1: progress detected; continuing
- 2026-08-02 21:29Z · Build attempt 1 · 17 turns · $3.150 · ok
- 2026-08-02 21:34Z · Verify attempt 1 · 1 turns · $0.000 · verdict: fail (unmet: 2)
  - retrying with findings (attempt 2/3)
- 2026-08-02 22:02Z · Build attempt 2 · 88 turns · $14.932 · cancelled
  - orphaned_run: server restarted during a run — unmerged work is PRESERVED in the worktree/branch
- 2026-08-02 22:27Z · Restart Build · preserved worktree unavailable; starting a fresh build (prior branch kept as todomd/task-0040-preserved-b54fbdf4)
- 2026-08-02 22:58Z · Build attempt 1 · 101 turns · $11.604 · checkpoint 1: progress detected; continuing
- 2026-08-02 23:26Z · Build attempt 1 · 101 turns · $17.016 · checkpoint 2: progress detected; continuing
- 2026-08-02 23:51Z · Build attempt 1 · 81 turns · $17.082 · ok
- 2026-08-02 23:56Z · Verify attempt 1 · 1 turns · $0.000 · verdict: fail (unmet: 2)
  - retrying with findings (attempt 2/3)
- 2026-08-03 00:19Z · Build attempt 2 · 85 turns · $19.852 · ok
- 2026-08-03 00:27Z · Verify attempt 2 · 1 turns · $0.000 · verdict: fail (unmet: 4)
  - escalating after 2 failed reviews: Fable diagnosis → Opus repair → final Codex gate
- 2026-08-03 00:32Z · Escalate attempt 2 · 32 turns · $3.403 · diagnosis complete
- 2026-08-03 01:08Z · Build attempt 3 · 101 turns · $12.881 · checkpoint 1: progress detected; continuing
- 2026-08-03 01:11Z · Build attempt 3 · 8 turns · $3.149 · cancelled
  - orphaned_run: server stopped during Build — unmerged work is preserved in the worktree/branch
- 2026-08-03 01:14Z · Resume Build · continuing attempt 3 in preserved worktree todomd/task-0040
- 2026-08-03 01:18Z · Build attempt 3 · 3 turns · $1.313 · ok
- 2026-08-03 01:23Z · Verify attempt 3 · 1 turns · $0.000 · verdict: fail (unmet: 1)
  - attempts_exhausted: 1. `src/scheduler.js:89-90` breaks backward compatibility for numeric-string concurrency values. A legacy `concurrency: "3"` reproducibly starts only one Build because `Number.isFinite("3")` is false. The previous comparison coerced the value and admitted three. Normalize with `Number(...)` and add a quoted-YAML regression test.

2. `src/pipeline.js:1454-1455` claims to retain a bounded output tai
- 2026-08-03 01:35Z · Verify attempt 3 · 1 turns · $0.000 · verdict: fail
  - attempts_exhausted: The adversarial review found a reachable pending-claim leak in src/pipeline.js. The old processQueue(...).finally() always removed its exact pending entry, including abnormal terminal paths. That guarantee was replaced with cleanup only when sendState(..., 'idle') executes. However, buildChain returns directly when readCard() finds the card missing (line 1534), and pipelineError swallows a failed 
- 2026-08-03 01:50Z · Verify attempt 3 · 1 turns · $0.000 · verdict: fail
  - attempts_exhausted: Real cross-project governor bug in src/scheduler.js:107-118: combinedResourceThresholds() folds thresholds from every project, including projects with resources.enabled:false, then enables the shared governor if any project is enabled. Thus a disabled project's stricter thresholds can defer work globally. Reproduced with an enabled project using safe memory.defer=0.99 and a disabled project using 
- 2026-08-03 01:59Z · Verify attempt 3 · 1 turns · $0.000 · verdict: fail
  - attempts_exhausted: The full suite passed with local-socket permission: 529 unit/integration tests and 30 UI tests. However, adversarial review found two reachable ownership bugs:

1. A queued/deferred initial Build is not claimed until scheduler admission. `humanMove(..., 'Review')` checks tracked/pending/trigger claims but not `scheduler.isQueued()`. Reproduced by pausing the queue, approving a Planned card, and re
- 2026-08-03 02:13Z · Verify attempt 3 · 1 turns · $0.000 · verdict: fail
  - attempts_exhausted: Adversarial bug: cancelling or retriaging mid-flow work that is waiting for scheduler admission can hang indefinitely. In src/pipeline.js:699-705 and 1038-1054, a pending claim is marked cancelled but its scheduler entry is deliberately not dequeued. Cleanup only happens when the blocked entry is eventually admitted and reaches pendingCancelled(). If governor pressure never recovers, a column/glob
- 2026-08-03 02:22Z · Verify attempt 3 · 1 turns · $0.000 · verdict: pass
  - merge_conflict: merge conflict
- 2026-08-03 02:27Z · merge conflict resolved in preserved worktree; ready for Verify-only retry
- 2026-08-03 02:31Z · Verify attempt 3 · 1 turns · $0.000 · verdict: fail
  - attempts_exhausted: The unrestricted full suite passed: 532 unit/integration tests and 30 UI tests. However, the adversarial review found a reachable CI-diagnostics bug. In src/pipeline.js, the capture function near line 1493 stops collecting after the buffer first exceeds CI_OUTPUT_MAX, so it retains the beginning of verbose output rather than the promised tail. ciStage then takes the last 2,000 characters of that s
- 2026-08-03 02:43Z · Verify attempt 3 · 1 turns · $0.000 · verdict: fail
  - attempts_exhausted: The full suite passed with local-socket permission: 532 unit/integration tests and 30 UI tests. However, a reachable deletion race remains. `scheduleVerify` and `scheduleCi` can wait indefinitely for scheduler admission, but their admitted functions (`verify` and `ciStage`) do not re-check that the task card still exists. If a card is deleted externally after Build completes while CI/Verify is que
- 2026-08-03 02:56Z · Verify attempt 3 · 1 turns · $0.000 · verdict: fail
  - attempts_exhausted: `npm test` passed with local-socket permission: 534 unit/integration tests and 30 UI tests. However, adversarial review found a reachable cross-project disk-pressure bug: `src/scheduler.js:140` samples resources using only `allKnownProjects()[0].path`, while `src/resources.js:119` measures disk space for that specific filesystem. Thresholds are combined from every enabled project, but a project on
- 2026-08-03 03:04Z · Verify attempt 3 · 1 turns · $0.000 · verdict: fail
  - attempts_exhausted: All acceptance criteria are met and the unrestricted suite passed: 535 unit/integration tests and 30 UI tests. However, adversarial review found a reachable cancellation bug. In src/pipeline.js:706, humanMove(..., 'Review') handles a pending CI flow by merely marking the pending owner cancelled; unlike cancel() at lines 1063-1064, it never signals the live CI child in ciRuns. Reproduction with a 3
- 2026-08-03 03:11Z · Verify attempt 3 · 1 turns · $0.000 · verdict: fail
  - attempts_exhausted: The full suite passed with local-socket access: 536 unit/integration tests and 30 UI tests. However, adversarial review found a reachable PID-safety regression in bin/todomd.js:59-60. The new isTodomdServerCommand matcher rejects a normal npm/symlink launch represented as `node /.../.npm-global/bin/todomd serve`, so `todomd stop` can refuse its own live server and a second serve may miss it. It is
- 2026-08-03 03:23Z · Verify attempt 3 · 1 turns · $0.000 · verdict: fail
  - attempts_exhausted: The full suite passed: 539 unit/integration tests and 30 UI tests. However, the adversarial review found a reachable manual-pause bypass. In src/pipeline.js:1011-1014, retryVerification() schedules a new Verify run without the manual-pause blocked gate used by enqueueBuild() at lines 1392-1395. A focused reproduction set the persistent Queue Pause, invoked Retry Verification on an idle Needs Human
