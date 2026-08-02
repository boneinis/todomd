---
id: task-0033
title: Synchronize team assignments through GitHub
status: Plan
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
session_id: 7c477ffc-a281-47ce-8c52-3b53c2c7bc68
worktree:
verification: { attempts: 0, max_attempts: 3, last_verdict: }
triaged: 2026-07-31
cost_usd: 0.1823
needs_human_reason:
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
- 2026-07-31 21:53Z · Triage · 4 turns · $0.182 · ok

## Triage

- **Decision:** Split into smaller cards.
- **Rationale:** This bundles several distinct concerns — a git-backed board-state branch/publish mechanism, a manual Sync-now action, automatic refresh/polling triggers, conflict handling for active worktrees, and a CI-exclusion guarantee for board-only commits. Each has its own design and failure modes and is independently testable.
- **Risks or questions:** Conflict-resolution strategy (what "defer sync" looks like) and the branch/commit scheme for board metadata are non-trivial design choices that should be settled before implementation; CI exclusion mechanism needs to match the existing workflow triggers in `.github/workflows/ci.yml`.
- **Next step:** Split into cards for (1) board-state git branch publish/fetch mechanism with CI exclusion, (2) Sync-now UI action, (3) auto-refresh/polling triggers with conflict-safe merge behavior.
