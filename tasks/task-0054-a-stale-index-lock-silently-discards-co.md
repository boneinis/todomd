---
id: task-0054
title: A stale index.lock silently discards a completed build's work
status: Done
type: bug
priority: high
labels: []
dependencies: []
created_date: 2026-09-08
source: ui
assignee:
agent:
build_profile: standard
session_id:
worktree:
verification: { attempts: 0, max_attempts: 3, last_verdict: }
triaged: 2026-10-01
cost_usd: 0
---

## Description

A Build agent finishes its work, stages it, runs `git commit`, and the commit is
refused:

```
fatal: Unable to create '<gitdir>/worktrees/<task>/index.lock': File exists.
```

The run ends. The board reports `uncommitted_build`. The work is intact on disk
but unreachable to every later stage, and the agent is correctly unwilling to
delete a lock it did not create. Resuming does not help, because the race
recurs.

Observed three times in one session, and across four earlier sessions. In the
worst case the agent retried the commit eleven times before the run ended, on a
card that several other cards depended on. Each occurrence costs a whole build
and requires a human to notice the staged files and commit them by hand.

The cause appears to be the board's own progress tracking. Each build checkpoint
snapshots the worktree to decide whether progress was made, and those git
invocations take the index lock in the same gitdir the agent is committing into.
The board is competing with its own agent for the index.

Two directions, not exclusive. Make the progress snapshot avoid the index
entirely, since it only needs the head commit and a list of changed paths, both
obtainable without a lock-taking command. And make a commit refused by a lock a
retryable condition rather than a terminal one, so a transient collision costs
seconds instead of an entire build.

## Acceptance Criteria

- [ ] Progress snapshotting cannot take the index lock in a worktree an agent is building in
- [ ] A commit refused because the index is momentarily locked is retried rather than ending the run
- [ ] A build whose commit ultimately cannot succeed reports work as preserved and names the staged paths
- [ ] Resume after this failure commits the existing staged work instead of starting over
- [ ] A test drives a snapshot concurrently with a commit and shows neither is starved

## Verification

A concurrency test around the snapshot and commit paths, plus a board-level test
that a build completing during an active snapshot still lands its commit.

## Triage

- **Decision:** Actionable
- **Rationale:** The root cause of git lock contention between snapshots and commits is well-understood, and the acceptance criteria specify concrete failure handling and concurrency requirements.
- **Risks or questions:** none
- **Next step:** Plan

## Run Log

- 2026-10-01 00:57Z · Triage · 1 turns · gemini/gemini-3.7-flash-high · gateway · usage unavailable · $0.000 est · ok
- 2026-10-01 01:05Z · Review (devin) · Closed: already shipped in 3dd9c28 — progressSnapshot uses --no-optional-locks and diff.autoRefreshIndex=false so snapshots cannot take index.lock; retryStagedCommit + isIndexLockFailure retry transient lock refusals and preserve staged paths (src/build-progress.js, src/pipeline.js:3645,3772); test/build-progress.test.js covers contention. Stale card.
