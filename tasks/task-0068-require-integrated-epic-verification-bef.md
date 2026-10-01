---
id: task-0068
title: Require integrated epic verification before completion
status: Planned
type: feature
priority: medium
labels: []
dependencies: [task-0067]
parent: task-0059
created_date: 2026-10-01
source: chunk
assignee:
agent:
triaged: n/a (chunk 3/5 of task-0059)
build_profile: standard
session_id:
worktree:
verification: { attempts: 0, max_attempts: 3, last_verdict: }
---

## Description

Require integrated epic verification before completion

## Acceptance Criteria

- [ ] All child cards passing still leaves an opted-in epic incomplete until its separate integrated browser check passes.
- [ ] Incomplete, archived-but-required, or unintegrated required cards and missing applicable review/CI evidence block epic completion.
- [ ] Fresh integrated evidence permits completion; relevant later changes invalidate it.
- [ ] UI, API, automated, recovery, and delivery paths enforce the same epic rules.
- [ ] Restart and concurrent-child tests produce one eligible integrated verification run.

## Implementation Plan

1. Extend src/browser-verification.js with an epic evaluator using explicit required-card membership, integrated child revisions, integrated application revision, and applicable review/CI evidence. Archived required children must not silently disappear from the gate.
2. Update src/chunks.js and src/pipeline.js so completion of required children schedules a distinct integrated browser verification run instead of immediately marking an opted-in epic Done. Support both chunk epics and unified epics.
3. Require all required cards complete and integrated, applicable review/CI gates passed, and fresh end-to-end browser evidence for the integrated revision. Reuse the shared evaluator across board, API, automated, recovery, and delivery completion paths; individual card passes cannot satisfy this gate.
4. Invalidate epic evidence when relevant integrated changes, required-card membership, scenarios, environment, or policy changes. Make scheduling idempotent across restarts and concurrent child completion, and preserve useful blockers and failed-run findings.
5. Extend public/app.js and src/templates.js with epic readiness and integrated evidence. Add test/chunks.test.js, test/pipeline.test.js, API/delivery tests, and browser UI coverage for incomplete or archived required children, unintegrated changes, missing review/CI, stale evidence, and successful completion.
Risks: Existing chunks.js treats all visible children Done as sufficient. Retain that behavior only for projects without the new policy and avoid duplicate verification scheduling.

## Run Log
