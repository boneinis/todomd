---
id: task-0040
title: Route work through a shared cross-project scheduler
status: Needs Human
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
session_id: 019fc533-15d7-7f43-b201-67117f8d301d
worktree: todomd/task-0040
verification: { attempts: 3, max_attempts: 3, last_verdict: fail }
base_branch: main
cost_usd: 113.7378
needs_human_reason: attempts_exhausted
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
