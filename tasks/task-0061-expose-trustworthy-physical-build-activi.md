---
id: task-0061
title: Expose trustworthy physical build activity
status: Build
type: bug
priority: medium
labels: []
dependencies: [task-0060]
parent: task-0053
created_date: 2026-10-01
source: chunk
assignee:
agent:
triaged: n/a (chunk 2/2 of task-0053)
build_profile: standard
session_id:
worktree: todomd/task-0061
verification: { attempts: 1, max_attempts: 3, last_verdict:  }
base_branch: main
ci_evidence: {  }
ci_remote: {  }
build_limits: { max_slices: 3, budget_minutes: 60 }
---

## Description

Expose trustworthy physical build activity

## Acceptance Criteria

- [ ] A running single-unit card exposes observed commits and uncommitted paths without implying semantic completion.
- [ ] Commit counts use a stable admission baseline across checkpoints; committing dirty files does not erase the commit signal.
- [ ] Missing or failed observations display unavailable data rather than fabricated zero activity.
- [ ] Lifecycle coverage verifies accurate stage and activity presentation from Build through Done while preserving the criteria block.
- [ ] Build-agent board writes remain prohibited, and monitor telemetry exposes no internal filesystem paths or agent command details.

## Implementation Plan

1. Extend src/build-progress.js snapshots with a commit count relative to a fixed Build-admission HEAD. Keep dirty-path counts explicitly labeled as uncommitted paths; preserve the existing stall fingerprint behavior.
2. In src/pipeline.js, establish the baseline once per Build admission and reuse it across continuation slices. Update telemetry at admission, existing activity probes, and checkpoints. Publish safe numeric counts and observation timestamps through publicRunProgress; exclude internal paths and agent command details from monitor payloads.
3. In public/app.js, show compact physical activity on running Build cards and extend renderBuildProgress with commits, uncommitted paths, and observation freshness. Update public/index.html and public/style.css for the metrics. Render unavailable telemetry distinctly from zero; clear the active indicator when Build ends.
4. Add snapshot unit coverage in test/build-progress.test.js for unchanged worktrees, dirty edits, commits that clear dirty paths, and Git failures. Extend test/pipeline.test.js for initial telemetry, continuation updates, safe monitor payloads, and unchanged criteria through Build to Done; retain board-mutation rejection coverage.
5. Extend test/ui/ui-smoke.test.js to follow a single-unit card through Build, updated telemetry, Verify, and Done. Assert card and drawer agreement and removal of stale Build indicators. Run npm run test:unit and npm run test:ui.

## Run Log
