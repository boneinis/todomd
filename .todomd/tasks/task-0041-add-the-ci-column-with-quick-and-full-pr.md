---
id: task-0041
title: Add the CI column with quick and full profiles
status: Planned
type: module
priority: medium
labels: []
dependencies: [task-0040]
parent: task-0021
created_date: 2026-08-02
source: chunk
assignee: 
agent: claude
triaged: n/a (chunk 3/4 of task-0021)
session_id:
worktree:
verification: { attempts: 0, max_attempts: 3, last_verdict: }
---

## Description

Add the CI column with quick and full profiles

## Acceptance Criteria

- [ ] A CI column sits between Build and Verify and supports queued, running, deferred-for-load, passed and failed job states.
- [ ] CI runs a quick or full profile, with full covering TypeScript checks and end-to-end tests.
- [ ] A CI pass advances the card to Verify and a CI fail re-enters the existing retry path bounded by max_attempts.
- [ ] At critical pressure a running CI job is gracefully cancelled and requeued as deferred-for-load, while running Build work is left alone.
- [ ] A board whose config.yml has no CI column still runs Build then Verify without error.
- [ ] npm test passes, including a new test/ci.test.js.

## Implementation Plan

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

## Run Log
