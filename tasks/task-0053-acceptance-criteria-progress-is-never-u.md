---
id: task-0053
title: Acceptance-criteria progress is never updated, so the counter always reads zero
status: Review
type: bug
priority: medium
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
triaged:
---

## Description

The board parses the Acceptance Criteria section for checkbox items and reports
progress as completed against total. Nothing ever completes one.

The build agent is explicitly instructed never to modify anything under the board
directory, because its worktree copy is read-only context, and no code path in
the runtime marks a criterion complete either. So the counter is decorative: it
reads zero of N for the entire life of a card unless a person edits the file by
hand.

The consequence is that a card offers no way to follow a build in progress. What
the runtime does track is physical rather than semantic: each build checkpoint
snapshots the worktree head and changed paths, and several consecutive
checkpoints with no change trip a stall. That tells an operator the agent is
doing something, never which part of the plan it has finished.

Cards planned as a single unit are worst affected. A split epic at least gives
one completion signal per child card.

Decide the model rather than only fixing the symptom. Either criteria are
genuinely completable, in which case something trustworthy has to mark them and
the build agent's read-only rule needs a narrow, audited exception; or they are a
contract to be judged at review time, in which case the progress counter should
not present itself as live progress.

## Acceptance Criteria

- [ ] A decision is recorded on whether criteria are completable or are a review-time contract
- [ ] If completable, exactly one trusted actor marks them and the write is confined to the criteria block
- [ ] If not completable, the display no longer implies live progress
- [ ] A card planned as a single unit exposes some honest progress signal during a build
- [ ] The board's read-only rule for build agents remains enforced everywhere else
- [ ] Coverage proves a card's reported progress matches its real state at each stage

## Verification

Unit coverage of the progress computation and of whatever marks a criterion,
plus a board-level test following one card from build to done.
