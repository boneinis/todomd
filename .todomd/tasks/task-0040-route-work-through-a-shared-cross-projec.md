---
id: task-0040
title: Route work through a shared cross-project scheduler
status: Build
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
session_id:
worktree: todomd/task-0040
verification: { attempts: 1, max_attempts: 3, last_verdict:  }
base_branch: main
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

## Run Log
