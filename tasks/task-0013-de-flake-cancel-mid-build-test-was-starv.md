---
id: task-0013
title: De-flake cancel-mid-build test (was starving build-agent turns)
status: Done
type: fix
priority: medium
labels: []
dependencies: []
created_date: 2026-06-12
source: ui
assignee: 
agent: claude
session_id:
worktree:
verification: { attempts: 0, max_attempts: 3, last_verdict: }
---

## Description

The pre-existing flaky cancel-mid-build test (test/pipeline.test.js) failed ~1/3 under full-suite CPU load and was degrading the pipeline: build agents chase the intermittent failure and burn their turn budget, surfacing as spurious Needs Human (max_turns) on green work (hit task-0010). Fixed directly in commit 64a8f06 (generous timeouts + poll the async cancel cleanup) rather than via the pipeline, since building the flake-fix would itself be sabotaged by the flake. Verified with 10 clean full-suite runs.

## Acceptance Criteria

- [ ] cancel-mid-build test is stable under full-suite load
- [ ] no regression in pipeline tests

## Implementation Plan

## Run Log
