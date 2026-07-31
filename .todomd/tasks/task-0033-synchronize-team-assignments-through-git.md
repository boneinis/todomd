---
id: task-0033
title: Synchronize team assignments through GitHub
status: Review
type: improvement
priority: high
labels: [sync, github, team]
dependencies: []
created_date: 2026-07-31
source: ui
assignee: 
agent: claude
model: claude-sonnet-5
effort: low
session_id:
worktree:
verification: { attempts: 0, max_attempts: 3, last_verdict: }
---

## Description

Enable separate To-do MD computers to share assignment updates through the tracked board metadata in GitHub without triggering normal code CI or overwriting active work.

## Acceptance Criteria

- [ ] Publish shared board task and configuration metadata to the dedicated GitHub board-state branch after local card updates and Git actions
- [ ] Provide a visible Sync now action that fetches remote board metadata safely
- [ ] Refresh the open board after local card updates, successful Git pulls, and successful Git pushes
- [ ] Check for remote board metadata changes every 10 minutes while the board is open, plus on start and reconnect
- [ ] Do not overwrite active worktrees or local in-progress card state; show conflicts or deferred sync clearly
- [ ] Board-only metadata updates do not trigger normal code CI
- [ ] Verify the existing Mine view reflects a newly synchronized assignee change

## Implementation Plan

## Run Log
