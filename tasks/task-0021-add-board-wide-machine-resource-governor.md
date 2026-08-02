---
id: task-0021
title: Add board-wide machine resource governor and CI queue
status: Planned
type: improvement
priority: high
labels: [ci, scheduler, reliability]
dependencies: []
created_date: 2026-07-31
source: ui
assignee:
agent: claude
session_id: 5e969255-c859-4215-89af-e42920e888d7
worktree:
verification: { attempts: 0, max_attempts: 3, last_verdict: }
triaged: failed (agent)
needs_human_reason:
cost_usd: 0.8043
epic: true
children: [task-0039, task-0040, task-0041, task-0042]
---

## Description

Add board-wide resource governance so TODOMD does not overload the local machine. Introduce a CI column between Build and Verify for local validation jobs. Use a shared scheduler across all registered projects with configurable global and per-column concurrency limits. Monitor CPU load, memory pressure, and free disk before starting new work; defer new jobs when above thresholds and resume only after recovery with hysteresis. CI and end-to-end jobs must have stricter limits. Do not forcibly freeze coding agents mid-edit: allow the active safe step to complete, defer the next heavy step, and only gracefully cancel a CI job at critical pressure. Keep GitHub Actions as the external safety net.

## Acceptance Criteria

- [ ] A CI column exists between Build and Verify, with queued, running, deferred-for-load, passed, and failed states.
- [ ] The scheduler enforces configurable global and per-column concurrency across registered projects.
- [ ] New heavy work is deferred when CPU, memory pressure, or available disk breaches configured thresholds.
- [ ] The scheduler uses recovery hysteresis so jobs do not repeatedly start and stop around a threshold.
- [ ] CI can run quick and full profiles, including TypeScript checks and end-to-end tests.
- [ ] Running Build work is never forcibly frozen; only a critical CI job may be gracefully cancelled.
- [ ] The board displays current resource state and the reason a job is deferred.
- [ ] Unit, API, scheduler, and browser tests cover limits, deferral, recovery, and critical-pressure behavior.

## Implementation Plan

## Chunks

```yaml
- title: Add resource monitor with hysteresis governor
  type: module
  needs: []
  plan: |
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
  criteria:
    - "src/resources.js reports CPU load, memory pressure and free disk, returning null for metrics the platform cannot provide rather than throwing."
    - "The governor defers on a defer-threshold breach and only resumes after the resume threshold holds for the configured number of consecutive samples."
    - "state() exposes a per-metric machine-readable deferral reason including metric, value, threshold and level."
    - "A board whose config.yml has no resources key loads with the documented defaults."
    - "npm test passes, including a new test/resources.test.js."

- title: Route work through a shared cross-project scheduler
  type: improvement
  plan: |
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
  criteria:
    - "A single scheduler enforces a configurable global concurrency limit across all registered projects, not per project."
    - "Per-column concurrency limits are configurable and enforced independently of the global limit."
    - "Existing boards that set only concurrency keep their current effective Build parallelism."
    - "When the governor reports pressure, new work stays queued with a deferredReason and no child is spawned."
    - "A deferred entry starts automatically on a later tick once the governor recovers, with no human action."
    - "A job that is already running is never signalled or suspended by resource pressure."
    - "npm test passes, including a new test/scheduler.test.js."

- title: Add the CI column with quick and full profiles
  type: module
  plan: |
    1. Insert `CI` between `Build` and `Verify` in `DEFAULT_COLUMNS`
       (`src/board.js:10`), `REQUIRED_COLUMNS` (`src/board.js:29`) and the
       `columns:` line of `CONFIG_YML` (`src/templates.js:5`). A board whose
       config.yml predates this must keep working: treat a missing CI column as
       "CI disabled, Build → Verify directly" rather than failing validation.
    2. Add a `ci:` config block: `enabled`, `profile: quick|full`,
       `quick:` (default a TypeScript check, e.g. `npm run typecheck`),
       `full:` (typecheck + `npm test` + the e2e command), `timeout_seconds`, and
       a stricter `scheduler.columns.CI` default than Build.
    3. Add `src/ci.js` that runs the selected profile's commands inside the card's
       EXISTING build worktree (reuse the `worktreeAbs` / `worktree_link` setup in
       `buildChain`, `pipeline.js:1327-1340`) and returns
       `{ state, log, profile, command }`. Per-job states: `queued`, `running`,
       `deferred-for-load`, `passed`, `failed`.
    4. Splice CI into the chain in `pipeline.js`: a successful Build moves the card
       to `CI` instead of `Verify`; CI pass moves it to `Verify`; CI fail routes
       through the existing verify-fail retry path so `verification.attempts` /
       `max_attempts` stay authoritative and a card cannot loop forever.
    5. Critical pressure: register the CI child with the scheduler so that when
       `governor.state().critical` is true it may SIGTERM ONLY CI children, requeue
       that card to `CI` as `deferred-for-load`, and roll the attempt back (a
       load-cancel is an abort, not a failed try — mirror `revertPendingCancel`).
       Build and Verify children must never be signalled by the governor.
    6. Tests in `test/ci.test.js` plus additions to `test/pipeline.test.js`:
       quick vs full profile command selection; pass → Verify; fail → retry with
       the attempt counted; CI queued-but-deferred under load; critical pressure
       cancels a running CI job while a concurrently running Build is untouched;
       and a board with no CI column still goes Build → Verify.
    Risk: adding a required column changes the board's shape for every existing
    project — the migration path in step 1 is the load-bearing part of this chunk.
  criteria:
    - "A CI column sits between Build and Verify and supports queued, running, deferred-for-load, passed and failed job states."
    - "CI runs a quick or full profile, with full covering TypeScript checks and end-to-end tests."
    - "A CI pass advances the card to Verify and a CI fail re-enters the existing retry path bounded by max_attempts."
    - "At critical pressure a running CI job is gracefully cancelled and requeued as deferred-for-load, while running Build work is left alone."
    - "A board whose config.yml has no CI column still runs Build then Verify without error."
    - "npm test passes, including a new test/ci.test.js."

- title: Surface resource state and deferral reasons on the board
  type: improvement
  plan: |
    1. In `src/server.js`, expose governor + scheduler state — either a new
       `GET /api/resources` or an addition to the existing board state payload —
       returning `{ metrics, deferring, critical, reasons, limits, running: { global, byColumn } }`,
       and include each deferred card's `deferredReason` in its card payload.
    2. Push the same state over the existing realtime channel (`src/realtime.js`)
       on each governor tick so the board updates without polling.
    3. Render in `public/app.js` + `public/style.css`: a board-level resource
       indicator (CPU / memory / disk with the current governor state) and, on any
       card in `deferred-for-load`, a badge showing the human-readable reason taken
       from `reasons`. Add the CI column to the board's column rendering and to the
       drag/drop rules so a human cannot drag a card into an invalid CI state.
    4. Tests: `test/server-routes.test.js` for the endpoint shape; a `test/ui/`
       unit test for the indicator and the deferral badge; and a browser test in
       `test/browser.js` asserting the CI column renders between Build and Verify
       and that a deferred card shows its reason text.
    Note: GitHub Actions stays the external safety net — this chunk adds no new
    remote CI. Only local job state is displayed.
  criteria:
    - "The board displays current CPU, memory and disk resource state from the governor."
    - "A card deferred for load shows the specific reason it was deferred, sourced from the governor reasons."
    - "The CI column renders between Build and Verify on the board."
    - "npm test passes, including new API, UI and browser coverage for the resource indicator and deferral badge."
```

## Run Log
- 2026-08-02 13:24Z · Plan · 12 turns · $0.804 · ok
- 2026-08-02 13:24Z · Plan · split into 4 chunks (DAG): task-0039 → task-0040 → task-0041 → task-0042
