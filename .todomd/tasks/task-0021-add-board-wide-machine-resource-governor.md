---
id: task-0021
title: Add board-wide machine resource governor and CI queue
status: Review
type: improvement
priority: high
labels: [ci, scheduler, reliability]
dependencies: []
created_date: 2026-07-31
source: ui
assignee: 
agent: claude
session_id:
worktree:
verification: { attempts: 0, max_attempts: 3, last_verdict: }
triaged: failed (agent)
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

## Run Log
