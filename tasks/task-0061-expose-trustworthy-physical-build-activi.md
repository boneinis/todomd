---
id: task-0061
title: Expose trustworthy physical build activity
status: Verify
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
session_id: 2b477399-5385-43f9-a3b7-7296342d2e23
worktree: todomd/task-0061
verification: { attempts: 3, max_attempts: 3, last_verdict: fail }
base_branch: main
ci_evidence: { head: 6ed47391760d48e9ea681e307c2ffc27c26736b0, command: npm test, execution: local, passed_at: '2026-10-01T05:43:15.220Z', clean: true }
ci_remote: {  }
build_limits: { max_slices: 3, budget_minutes: 60 }
cost_usd: 26.1872
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
- 2026-10-01 04:14Z · Build attempt 1 · 101 turns · claude/claude-sonnet-5 · subscription CLI · 200 input, 11.51M cached, 64.5K output · $3.536 est · checkpoint 1/3 (standard): worktree progress detected; continuing
- 2026-10-01 04:18Z · Build attempt 1 · 20 turns · claude/claude-sonnet-5 · subscription CLI · 40 input, 3.63M cached, 4.4K output · $4.381 est · ok
- 2026-10-01 04:29Z · CI attempt 1 · 188.2s · `npm test` passed
- 2026-10-01 04:31Z · Verify attempt 1 · 1 turns · codex/gpt-6.1-sol · subscription CLI · 36.9K input, 0 cached, 2.2K output · $0.000 est · verdict: fail (unmet: 2)
  - retrying with findings (attempt 2/3)
- 2026-10-01 04:49Z · Build attempt 2 · 43 turns · claude/claude-sonnet-5 · subscription CLI · 86 input, 9.61M cached, 30.6K output · $6.815 est · ok
- 2026-10-01 04:57Z · CI attempt 2 · 278.0s · `npm test` failed
  - retrying after a failed CI gate (attempt 3/3)
- 2026-10-01 05:22Z · Build attempt 3 · 69 turns · claude/claude-sonnet-5 · subscription CLI · 138 input, 19.65M cached, 42.4K output · $11.455 est · ok
- 2026-10-01 05:24Z · CI attempt 3 · cancelled (critical resource pressure) — requeued
- 2026-10-01 05:43Z · CI attempt 3 · 223.1s · `npm test` passed
